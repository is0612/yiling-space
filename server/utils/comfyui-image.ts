/**
 * 本机 ComfyUI + Anima 生图客户端。
 *
 * 为什么不走 OpenAI 兼容接口：ComfyUI 是「提交工作流 → 轮询历史 → 取结果图」三段式，
 * 没有 `/v1/images/generations` 这种同步接口。所以这里单独封装，云端服务商那套逻辑
 * (`image-generation.ts` 的 `/images/generations`) 完全不受影响。
 *
 * **地址不是常量，也不再只从环境变量读**：设置页里有「引擎地址」这一栏，
 * 换端口、换机器（ComfyUI 装在别处）都要能用。所以每个入口都接受 `baseUrl`，
 * 没给时才回落到 `COMFYUI_BASE_URL` 或默认的 `http://127.0.0.1:8188`。
 *
 * 注意：Anima 只认英文与 Danbooru 标签，中文提示词基本无效。调用方负责把中文转成标签，
 * 本文件不替你做翻译（`image-generation.ts` 那边会把中文分段标签剥掉并留一条警告）。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp from "sharp";

import {
  LOCAL_IMAGE_DEFAULT_BASE_URL,
  LOCAL_IMAGE_FAMILY,
  LOCAL_IMAGE_MODELS,

  resolveLocalImagePreset,
  type ImageModelPreset,
  resolveLocalImageModel,
  type LocalImageFamily,
  type LocalImageQuality,
} from "../../shared/utils/local-image-engine";
import { LOCAL_SIZE_MULTIPLE } from "../../shared/utils/image-size";
import { loadWorkflowTemplate } from "./comfy-workflow-template";

/**
 * CLIP / VAE 按**引擎族**取，不再是一个全局常量。
 *
 * Anima 与 MOSS 的文本编码器和 VAE 完全不同，混用不会「画得差」，而是直接报维度错：
 * MOSS 的 latent 是 128 通道，给 `qwen_image_vae`（认 64 通道）就是今天早上那个
 * `expected 64 channels, got 128`。
 *
 * 环境变量只覆盖 anima（老部署可能设过 `COMFYUI_CLIP_NAME`）；MOSS 用独立的变量名，
 * 否则一个变量会把两族同时改错。
 */
const clipNameFor = (family: LocalImageFamily): string =>
  family === "moss"
    ? process.env.COMFYUI_MOSS_CLIP_NAME?.trim() || LOCAL_IMAGE_FAMILY.moss.clip
    : process.env.COMFYUI_CLIP_NAME?.trim() || LOCAL_IMAGE_FAMILY.anima.clip;

const vaeNameFor = (family: LocalImageFamily): string =>
  family === "moss"
    ? process.env.COMFYUI_MOSS_VAE_NAME?.trim() || LOCAL_IMAGE_FAMILY.moss.vae
    : process.env.COMFYUI_VAE_NAME?.trim() || LOCAL_IMAGE_FAMILY.anima.vae;

/**
 * 质量词。Turbo 与 Aesthetic 的推荐前缀不同：
 * 官方文档说 Aesthetic 已经把低质图剔干净了，`score_*` 反而会把画面推得太腻，
 * 所以精修只用 `masterpiece, best quality, safe`，不带分数标签。
 */
const QUALITY_PREFIX_BASE = "masterpiece, best quality, safe.";
const QUALITY_PREFIX_SCORE = "masterpiece, best quality, score_7, safe.";
const DEFAULT_NEGATIVE =
  "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia, text, watermark";

/**
 * MOSS 的默认负向，取自官方 T2I 模板。
 *
 * 和 anima 那串的区别是**不带 `score_*`**：那是 Danbooru 评分体系的标签，MOSS 的
 * Qwen3.5 编码器没见过这套约定，写进去只是噪声。`text` 也不带 —— MOSS 的强项恰恰
 * 是图里写字，禁掉等于自废武功。
 */
const MOSS_DEFAULT_NEGATIVE = "worst quality, bad anatomy, watermark, jpeg artifact";

/**
 * 单张图最长等多久。
 * 质量版首次要加载 4G 模型留余量；MOSS 在 8G 卡上跑 832×1216 / 25 步会更久，
 * 加上首次要把 9.75G 的文本编码器读进内存，240 秒不够。
 */
const POLL_TIMEOUT_MS = 360_000;
const POLL_INTERVAL_MS = 800;
/**
 * 单边像素上限。原来是 1280，只够放 1 MP 的三档；现在设置页按「比例 + 预算」选，
 * 2 MP 的 21:9 宽边就是 2240，1290 这种旧上限会把宽高裁掉一截，
 * 页面显示的尺寸就和实际出的图对不上了。2304 刚好盖住 2240，也仍是 64 的倍数。
 */
const MAX_EDGE = 2304;
const MIN_EDGE = 512;

export type ComfyImageInput = {
  /** 引擎地址，如 `http://127.0.0.1:8188`；省略则用环境变量或默认值。 */
  baseUrl?: string;
  /** 英文 / Danbooru 标签。中文无效。 */
  prompt: string;
  negative?: string;
  /** fast = Turbo 12 步（约 12 秒）；quality = Aesthetic 30 步（约 50 秒）。默认 fast。 */
  quality?: boolean;
  /** 指定模型文件；省略按档位取 `LOCAL_IMAGE_MODELS`。 */
  model?: string;
  preset?: ImageModelPreset;
  width?: number;
  height?: number;
  /**
   * 工作流 `ResolutionSelector` 的比例枚举名（`9:16 (Portrait Widescreen)`）与百万像素。
   *
   * 有这两个就优先用它们：节点的宽高是自己算的，从 `width/height` 反推比例会丢精度
   * （896×1152 会被归到 3:4、1 MP），页面写的尺寸和实际出的图就对不上了。
   */
  aspectRatio?: string;
  megapixels?: number;
  /** 图生图：本机绝对路径。给了就走 LoadImage + VAEEncode，尺寸由原图决定。 */
  referencePath?: string;
  /** 图生图：也可以直接给内存里的图（比如角色立绘）。 */
  referenceBuffer?: { buffer: Buffer; filename?: string };
  /** 改动幅度：0.3 只重绘细节，0.75 重新构图。仅在带参考图时生效。 */
  denoise?: number;
  seed?: number;
  /**
   * 本机 LoRA（比如给她自己训的角色模型）。
   *
   * `name` 是引擎 `models/loras` 下的文件名；空 = 不用。`strength` 省略按 1。
   * 触发词不在这里处理 —— 那是提示词的事，由调用方决定放哪、放几个。
   */
  lora?: { name: string; strength?: number };
};

export type ComfyImageOk = {
  ok: true;
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
  seed: number;
  elapsedMs: number;
  mode: "text_to_image" | "image_to_image";
};

export type ComfyImageFail = { ok: false; reason: string };

/**
 * 引擎地址归一。**这里故意不走 `validateChatApiBaseUrl`**：
 * 那个函数为了不把 API Key 送去内网，在生产环境下拒绝一切本机/私有地址 ——
 * 而本地引擎恰恰就是本机地址，而且它没有 Key 可泄露。所以单独一套规则：
 * 只要求是个 http(s) 地址、不带凭据和查询串，端口和局域网随便填。
 */
export function normalizeComfyBaseUrl(value?: string): string {
  const input = (value ?? "").trim() || process.env.COMFYUI_BASE_URL?.trim() || LOCAL_IMAGE_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("引擎地址格式无效，例如 http://127.0.0.1:8188。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("引擎地址只支持 http 或 https。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("引擎地址不要带用户名、密码、查询参数或片段。");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  return url.origin + (pathname === "/" ? "" : pathname);
}

const clampEdge = (value: number | undefined, fallback: number, step = 8): number => {
  if (!Number.isFinite(value)) return fallback;
  const edge = Math.round(value as number);
  const bounded = Math.min(MAX_EDGE, Math.max(MIN_EDGE, edge));
  // VAE 对尺寸有倍数要求，否则编解码直接报错。
  // anima 是 8（qwen_image_vae），MOSS 是 16（EmptyFlux2LatentImage 按 16 下采样）。
  const safeStep = step > 0 ? Math.floor(step) : 8;
  return Math.floor(bounded / safeStep) * safeStep;
};

type PromptBlock = { class_type: string; inputs: Record<string, unknown> };

function buildGraph(input: {
  prompt: string;
  negative: string;
  model: string;
  /** 引擎族：决定 CLIP 类型、VAE 和 latent 节点。由 `resolveImageFamily(model)` 得出。 */
  family: LocalImageFamily;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  imageName?: string;
  denoise?: number;
  /** 给了就插一个 LoraLoaderModelOnly；采样器的 model 改接它。 */
  lora?: { name: string; strength: number };
}): Record<string, PromptBlock> {
  const profile = LOCAL_IMAGE_FAMILY[input.family];
  /**
   * LoRA 接在 UNETLoader 和采样器之间：1 → 12 → KSampler。
   * 用 `LoraLoaderModelOnly` 而不是 `LoraLoader` —— 它只改 UNet，不碰 CLIP，
   * 所以不用去猜这个 LoRA 训练时用的是哪套文本编码器。
   */
  const modelRef: [string, number] = input.lora ? ["12", 0] : ["1", 0];
  const graph: Record<string, PromptBlock> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: input.model, weight_dtype: "default" } },
    /**
     * `type` 是最容易漏的一处：MOSS 必须走 `moss_image`，它会同时决定 tokenizer 和
     * 聊天模板。填 `stable_diffusion` 能加载、能出图，但文本条件格式是错的 ——
     * 表现为不服从提示词、图里文字全乱，且**不报错**。
     */
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: clipNameFor(input.family), type: profile.clipType, device: profile.clipDevice },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: vaeNameFor(input.family) } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: input.prompt, clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: input.negative, clip: ["2", 0] } },
    "8": {
      class_type: "KSampler",
      inputs: {
        seed: input.seed,
        steps: input.steps,
        cfg: input.cfg,
        sampler_name: "er_sde",
        scheduler: "simple",
        denoise: input.denoise ?? 1,
        model: modelRef,
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: [input.imageName ? "7" : "6", 0],
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    /**
     * 前缀跟族走，出图落在 `output/YilingSpace/<族>/` 下。
     * 混在一个目录里就分不清哪张是哪个模型画的 —— 而调参时恰恰要看这个。
     */
    "10": {
      class_type: "SaveImage",
      inputs: { images: ["9", 0], filename_prefix: `YilingSpace/${input.family}` },
    },
  };

  if (input.lora) {
    graph["12"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["1", 0], lora_name: input.lora.name, strength_model: input.lora.strength },
    };
  }

  if (input.imageName) {
    graph["6"] = { class_type: "LoadImage", inputs: { image: input.imageName, upload: "image" } };
    // 参考图原尺寸可能是 1440×1920 这种：直接编码会吃掉大半显存还慢。
    // 按「总像素」缩到约 1MP，长宽比不变，resolution_steps 跟族走（MOSS 要 16）。
    graph["11"] = {
      class_type: "ImageScaleToTotalPixels",
      inputs: {
        image: ["6", 0],
        upscale_method: "lanczos",
        megapixels: 1.0,
        resolution_steps: profile.edgeStep,
      },
    };
    graph["7"] = { class_type: "VAEEncode", inputs: { pixels: ["11", 0], vae: ["3", 0] } };
  } else if (profile.latent === "flux2") {
    /**
     * MOSS 的 latent 是 128 通道、16 倍下采样，必须用 Flux2 的空 latent。
     * 给 `EmptyLatentImage`（4 通道）会在 KSampler 里报形状错。
     */
    graph["6"] = {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width: input.width, height: input.height, batch_size: 1 },
    };
  } else {
    graph["6"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: input.width, height: input.height, batch_size: 1 },
    };
  }
  return graph;
}

/* ────────────────────────── 工作流模板 ────────────────────────── */

/**
 * 用户自己调好的 ComfyUI 工作流（API 格式）。
 *
 * 默认现拼的图只有 10 个节点、步数和采样器全写在代码里；但调过工作流的人手里那套
 * （画风 LoRA 配比、采样器、shift、分辨率选择器）是反复试出来的，代码猜不到。
 * 模板模式把「工序单」交还给用户：项目只注入提示词、负向词和种子，其余原样提交。
 *
 * 模板是**本地数据**，读写都在 `comfy-workflow-template.ts`：路径走数据目录
 * （`COMFYUI_TEMPLATE_PATH` 可指定别处），接口能取能存，文件删掉就自动回到现拼。
 * 缓存按 mtime 失效，所以接口保存后下一次出图就生效，不需要重启进程。
 *
 * 为什么不直接读 ComfyUI 的 `user/default/workflows`：那边的 json 是 UI 格式
 * （带坐标、颜色、节点尺寸），引擎的 `/prompt` 不认；而且用户在界面上的临时实验
 * 会立刻改变她出图的结果，风险不可控。所以这里存一份独立的 API 格式快照。
 */

/**
 * `ResolutionSelector` 认的八个比例名。必须和节点枚举一字不差，否则 ComfyUI 回
 * `value not in list`，报错里还看不出是拼错了哪个字。
 */
const RESOLUTION_ASPECTS: { name: string; value: number }[] = [
  { name: "1:1 (Square)", value: 1 },
  { name: "2:3 (Portrait Photo)", value: 2 / 3 },
  { name: "3:2 (Photo)", value: 3 / 2 },
  { name: "3:4 (Portrait Standard)", value: 3 / 4 },
  { name: "4:3 (Standard)", value: 4 / 3 },
  { name: "9:16 (Portrait Widescreen)", value: 9 / 16 },
  { name: "16:9 (Widescreen)", value: 16 / 9 },
  { name: "21:9 (Ultrawide)", value: 21 / 9 },
];

/**
 * 交给 `ResolutionSelector` 的三个值：比例、百万像素、倍数。
 *
 * 比例和预算优先用调用方给的值 —— 设置页的宽高就是按这同一组参数算出来的，
 * 从这里反推反而会把 896×1152 归到 3:4、把 1.99 MP 抹成 2.0，页面和实际就对不上。
 * 没给才回退到「按宽高反推」，那是给老调用方留的路。
 */
export function resolutionSelectorTargets(input: {
  aspectRatio?: string;
  megapixels?: number;
  width: number;
  height: number;
}): { aspectRatio: string; megapixels: number; multiple: number } {
  const ratio = input.height > 0 ? input.width / input.height : 1;
  const closest = RESOLUTION_ASPECTS.reduce(
    (best, item) => (Math.abs(item.value - ratio) < Math.abs(best.value - ratio) ? item : best),
    RESOLUTION_ASPECTS[0]!,
  );
  return {
    aspectRatio: RESOLUTION_ASPECTS.some(item => item.name === input.aspectRatio) ? input.aspectRatio! : closest.name,
    megapixels: input.megapixels && Number.isFinite(input.megapixels)
      ? Math.min(2, Math.max(0.5, input.megapixels))
      // 节点按 1024×1024 = 1 MP 折算，这里也得用同一个基准（以前除以 100,000，会多算 5%）
      : Math.max(0.5, Math.round((input.width * input.height) / 1_048_576 * 10) / 10),
    // 64：Anima 的 VAE 要 8、MOSS 的 Flux2 latent 要 16，64 是公倍数，
    // 也让页面按同一个公式算出来的宽高就是引擎实际用的宽高。
    multiple: LOCAL_SIZE_MULTIPLE,
  };
}

/**
 * 模板注入：只改提示词、负向词、种子、尺寸和存图前缀，其余保持用户工作流原样。
 *
 * 定位不写死节点 id —— 重新排过节点、加过中间层都会让 id 变，所以按**引用关系**找：
 * KSampler 的 positive / negative 各自指向哪个节点。
 */
function applyWorkflowTemplate(
  template: Record<string, PromptBlock>,
  input: {
    prompt: string;
    negative: string;
    seed: number;
    width: number;
    height: number;
    /** 设置页选的比例枚举名与像素预算；给了就以它们为准（见 `ComfyImageInput` 的说明）。 */
    aspectRatio?: string;
    megapixels?: number;
    /** 角色 LoRA。给了就插在 KSampler 之前。 */
    lora?: { name: string; strength: number };
  },
): Record<string, PromptBlock> {
  const graph = JSON.parse(JSON.stringify(template)) as Record<string, PromptBlock>;
  const samplerIds: string[] = [];
  let positiveId = "";
  let negativeId = "";

  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type !== "KSampler" && node.class_type !== "KSamplerAdvanced") continue;
    samplerIds.push(id);
    const positive = node.inputs.positive;
    const negative = node.inputs.negative;
    if (Array.isArray(positive)) positiveId = String(positive[0]);
    if (Array.isArray(negative)) negativeId = String(negative[0]);
  }

  if (positiveId && graph[positiveId]) graph[positiveId]!.inputs.text = input.prompt;
  else console.warn("[image] 模板里找不到正向提示词节点，这次没用上她的描述");
  if (negativeId && graph[negativeId]) graph[negativeId]!.inputs.text = input.negative;

  // 种子：有 SeedNode 就改它；KSampler 自己写的是字面值也一并改掉
  for (const node of Object.values(graph)) {
    if (node.class_type === "SeedNode") node.inputs.seed = input.seed;
    const sampler = node.class_type === "KSampler" || node.class_type === "KSamplerAdvanced";
    if (sampler && !Array.isArray(node.inputs.seed)) node.inputs.seed = input.seed;
  }

  /**
   * 尺寸：优先改 `ResolutionSelector`（按比例 + 百万像素推算），
   * 没有就退回 latent 节点的宽高。**连线驱动的跳过** —— 那种要尊重用户的设计。
   */
  const target = resolutionSelectorTargets(input);
  let sized = false;
  for (const node of Object.values(graph)) {
    if (node.class_type === "ResolutionSelector") {
      node.inputs.aspect_ratio = target.aspectRatio;
      node.inputs.megapixels = target.megapixels;
      if (!Array.isArray(node.inputs.multiple)) node.inputs.multiple = target.multiple;
      sized = true;
    }
  }
  if (!sized) {
    for (const node of Object.values(graph)) {
      if (!/EmptyLatentImage|EmptyFlux2LatentImage/.test(node.class_type)) continue;
      if (Array.isArray(node.inputs.width) || Array.isArray(node.inputs.height)) continue;
      node.inputs.width = input.width;
      node.inputs.height = input.height;
    }
  }

  // 存图前缀跟现拼模式一致，落在 output/YilingSpace/ 下，不跟用户手跑的图混在一起
  for (const node of Object.values(graph)) {
    if (node.class_type === "SaveImage" && typeof node.inputs.filename_prefix === "string") {
      node.inputs.filename_prefix = "YilingSpace/moss";
    }
  }

  /**
   * 角色 LoRA 接在 KSampler 之前。选链尾而不是链头，是为了不打乱用户调好的
   * 那几层画风 LoRA 之间的相对顺序 —— 他只是想加一层，不是想重排。
   */
  if (input.lora?.name && samplerIds.length) {
    const nextId = String(
      Math.max(0, ...Object.keys(graph).map(key => Number(key) || 0)) + 1,
    );
    for (const id of samplerIds) {
      const node = graph[id]!;
      const upstream = node.inputs.model;
      if (!Array.isArray(upstream)) continue;
      graph[nextId] = {
        class_type: "LoraLoaderModelOnly",
        inputs: { model: upstream, lora_name: input.lora.name, strength_model: input.lora.strength },
      };
      node.inputs.model = [nextId, 0];
    }
  }

  return graph;
}

/**
 * 每次上传都用一个全新的文件名。
 *
 * 这里曾经固定写 `reference.png` 再配 `overwrite=true`，并发下会串图：
 * 两个角色同时图生图，后一次上传直接盖掉前一次的文件；而 ComfyUI 的任务是排队执行的，
 * 排在前面的那项真正走到 LoadImage 时，读到的可能已经是另一个角色的参考图。
 *
 * 名字带固定前缀是为了引擎侧的 input 目录将来好清 —— ComfyUI 没有公开的删除接口，
 * 这些临时图只能靠人工或脚本按前缀回收。
 */
function uploadName(filename?: string): string {
  const extension = extname(filename ?? "").toLowerCase();
  const safeExtension = extension === ".jpg" || extension === ".jpeg" || extension === ".webp" ? extension : ".png";
  return `yiling-reference-${randomUUID()}${safeExtension}`;
}

async function uploadImage(base: string, reference: {
  buffer: Buffer;
  filename?: string;
}): Promise<{ name?: string; reason?: string }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(reference.buffer)], { type: "image/png" });
  form.append("image", blob, uploadName(reference.filename));
  // 不再给 overwrite：文件名已经唯一，留着它只会把「覆盖别人文件」这条路径保留下来。
  form.append("type", "input");
  try {
    const response = await fetch(`${base}/upload/image`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { reason: `参考图上传失败：HTTP ${response.status}` };
    const payload = (await response.json()) as { name?: string };
    if (!payload?.name) return { reason: "参考图上传后没拿到文件名" };
    return { name: payload.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: `参考图上传失败：${message}` };
  }
}

async function submit(base: string, graph: Record<string, PromptBlock>): Promise<{ promptId?: string; reason?: string }> {
  try {
    const response = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { reason: `ComfyUI 拒绝任务：HTTP ${response.status} ${detail.slice(0, 200)}` };
    }
    const payload = (await response.json()) as { prompt_id?: string };
    if (!payload?.prompt_id) return { reason: "ComfyUI 没返回任务号" };
    return { promptId: payload.prompt_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 连不上几乎都是引擎没开——这句话直接写进日志，省得再去猜。
    return { reason: `连不上 ComfyUI（${base}），确认 启动Anima.bat 跑着：${message}` };
  }
}

type ComfyOutputImage = { filename: string; subfolder?: string; type?: string };

async function waitForResult(base: string, promptId: string): Promise<{
  image?: ComfyOutputImage;
  elapsedMs?: number;
  reason?: string;
}> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    let history: Record<
      string,
      { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, { images?: ComfyOutputImage[] }> }
    >;
    try {
      const response = await fetch(`${base}/history/${promptId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      history = (await response.json()) as typeof history;
    } catch {
      continue;
    }
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      return { reason: "ComfyUI 执行报错（常见原因：显存不足，把尺寸调小）" };
    }
    if (!entry.status?.completed) continue;
    for (const output of Object.values(entry.outputs ?? {})) {
      const image = output.images?.[0];
      if (image) return { image, elapsedMs: Date.now() - startedAt };
    }
    return { reason: "任务完成了但没有产出图" };
  }
  return { reason: `等了 ${POLL_TIMEOUT_MS / 1000} 秒还没出图` };
}

/**
 * 画一张图。
 *
 * 和 image-generation.ts 的 generateImage 一样：失败一律返回 `{ ok: false, reason }`，
 * 不抛异常。原因要能直接看懂，因为每一种修法都不同。
 */
export async function generateImageWithComfy(input: ComfyImageInput): Promise<ComfyImageOk | ComfyImageFail> {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, reason: "画面描述为空" };

  let base: string;
  try {
    base = normalizeComfyBaseUrl(input.baseUrl);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "引擎地址无效" };
  }

  const quality = input.quality === true;
  const qualityKey: LocalImageQuality = quality ? "quality" : "fast";
  const model = resolveLocalImageModel(qualityKey, input.model);
  /**
   * 族由模型名推断 —— 这是整套改动的枢纽：
   * 用户只管在设置页选模型，CLIP 类型、VAE、latent 节点由这里决定。
   */
  const family = resolveLocalImagePreset(model, input.preset);
  if (!family) return { ok: false, reason: "未识别的本地模型，请选择兼容的 Anima 或 MOSS 预设。" };
  const profile = LOCAL_IMAGE_FAMILY[family];
  let imageName: string | undefined;
  const fallbackEdges = profile.defaultEdges[qualityKey];
  const width = clampEdge(input.width, fallbackEdges.width, profile.edgeStep);
  const height = clampEdge(input.height, fallbackEdges.height, profile.edgeStep);

  /**
   * 参考图对 MOSS 族一律不启用。
   *
   * 官方模板写得很明确：`ref_image` 只喂给 LLM 做 prompt 增强，**模型本身没有图像输入通道**。
   * 这里能"用"参考图，靠的是 VAEEncode 之后按 denoise 重绘（图生图），拿一张旧立绘去重绘
   * 会把那张图的体型比例、构图和画风原样带回来 —— 换了引擎族之后这等于反向污染：
   * 用 Q 版三视图做参考，出来必然是 Q 版，提示词写什么都没用。
   */
  const reference = family === "moss"
    ? null
    : (input.referenceBuffer
      ?? (input.referencePath
        ? { buffer: await readFile(input.referencePath).catch(() => null), filename: basename(input.referencePath) }
        : null));

  if (reference) {
    if (!reference.buffer) return { ok: false, reason: "参考图读不出来（路径不对或没权限）" };
    const uploaded = await uploadImage(base, { buffer: reference.buffer, filename: reference.filename });
    if (!uploaded.name) return { ok: false, reason: uploaded.reason ?? "参考图上传失败" };
    imageName = uploaded.name;
  }

  // 档案里的负面提示词追加在官方那一串后面：中文对它无效，但英文是有效的补充。
  const baseNegative = family === "moss" ? MOSS_DEFAULT_NEGATIVE : DEFAULT_NEGATIVE;
  const negative = [baseNegative, input.negative?.trim()].filter(Boolean).join(", ");

  const seed = Number.isFinite(input.seed) ? Math.floor(input.seed as number) : Math.floor(Math.random() * 1e15);
  /**
   * LoRA 的名字要**保留相对路径**（例如 `moss/加速2/xxx.safetensors`）。
   *
   * 这里曾经只取末段文件名：引擎里的 LoRA 是按目录组织的，截断之后 ComfyUI 会回
   * `value not in list`，而且报错信息里看不出是路径被截了。仍然挡 `..`，避免穿出 models/loras。
   */
  const rawLoraName = (input.lora?.name ?? "").trim();
  const loraName = rawLoraName && !rawLoraName.includes("..") ? rawLoraName : "";
  const lora = loraName
    ? { name: loraName, strength: Math.min(2, Math.max(0, Number.isFinite(input.lora?.strength) ? input.lora!.strength as number : 1)) }
    : undefined;
  /**
   * 质量前缀只有 anima 加。
   *
   * `masterpiece, best quality, score_7, safe` 是 Danbooru 标签体系，MOSS 的编码器吃的是
   * 自然语言长描述，硬塞评分标签不会提升画质，只会挤占它理解主体描述的注意力。
   */
  const qualityPrefix = family === "moss" ? "" : (quality ? QUALITY_PREFIX_BASE : QUALITY_PREFIX_SCORE);
  const finalPrompt = `${qualityPrefix} ${prompt}`.trim();

  /**
   * 走模板还是现拼。
   *
   * 模板存在 = 用户调好的那套工序单（画风 LoRA、采样器、shift 全在里面），
   * 项目只负责把提示词、负向词和种子塞进正确的节点。
   * 模板不存在 = 回到原来的现拼逻辑，行为完全不变。
   */
  const template = family === "moss" ? (await loadWorkflowTemplate())?.template ?? null : null;
  const graph = template
    ? applyWorkflowTemplate(template, {
      prompt: finalPrompt,
      negative,
      seed,
      width,
      height,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio, megapixels: input.megapixels } : {}),
      ...(lora ? { lora } : {}),
    })
    : buildGraph({
      prompt: finalPrompt,
      negative,
      model,
      family,
      width,
      height,
      seed,
      steps: profile.steps[qualityKey],
      cfg: profile.cfg[qualityKey],
      imageName,
      // 不带参考图时 denoise 必须是 1，否则等于只画一半。
      denoise: imageName ? Math.min(0.9, Math.max(0.2, input.denoise ?? 0.6)) : 1,
      lora,
  });

  const submitted = await submit(base, graph);
  if (!submitted.promptId) {
    const reason = submitted.reason ?? "任务提交失败";
    return {
      ok: false,
      reason: lora && /lora|value not in list|invalid/i.test(reason)
        ? `${reason}（LoRA「${lora.name}」可能不在引擎的 models/loras 目录里）`
        : reason,
    };
  }

  const finished = await waitForResult(base, submitted.promptId);
  if (!finished.image) return { ok: false, reason: finished.reason ?? "没有拿到结果图" };

  const { filename, subfolder = "", type = "output" } = finished.image;
  const query = new URLSearchParams({ filename, subfolder, type });
  try {
    const response = await fetch(`${base}/view?${query.toString()}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return { ok: false, reason: `取图失败：HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { ok: false, reason: "取到的图是空的" };
    // 图生图时请求里的 width/height 会被工作流丢掉（ImageScaleToTotalPixels 按约 1MP
    // 重算尺寸），所以返回真实像素，而不是把请求值当成结果告诉调用方。
    const metadata = await sharp(buffer).metadata().catch(() => null);
    return {
      ok: true,
      buffer,
      mime: "image/png",
      width: metadata?.width ?? width,
      height: metadata?.height ?? height,
      seed,
      elapsedMs: finished.elapsedMs ?? 0,
      mode: imageName ? "image_to_image" : "text_to_image",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `取图失败：${message}` };
  }
}

/** 引擎在不在。给健康检查用，不画图。 */
export async function pingComfy(baseUrl?: string): Promise<boolean> {
  let base: string;
  try {
    base = normalizeComfyBaseUrl(baseUrl);
  } catch {
    return false;
  }
  try {
    const response = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

export type ComfyEngineStatus = {
  running: boolean;
  /** 显卡名与显存（MB），用来判断「8G 是不是又不够了」。拿不到就不给。 */
  devices: { name: string; vramTotalMb: number; vramFreeMb: number }[];
};

/** 引擎状态：开着没有、跑在哪张卡上。设置页「测试」和平台状态都靠它。 */
export async function readComfyEngineStatus(baseUrl?: string): Promise<ComfyEngineStatus> {
  let base: string;
  try {
    base = normalizeComfyBaseUrl(baseUrl);
  } catch {
    return { running: false, devices: [] };
  }
  try {
    const response = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { running: false, devices: [] };
    const payload = await response.json() as { devices?: unknown };
    const devices: ComfyEngineStatus["devices"] = [];
    for (const item of Array.isArray(payload.devices) ? payload.devices : []) {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
      if (!record) continue;
      const mb = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value / 1024 / 1024) : 0);
      devices.push({
        name: typeof record.name === "string" ? record.name : "GPU",
        vramTotalMb: mb(record.vram_total),
        vramFreeMb: mb(record.vram_free),
      });
    }
    return { running: true, devices };
  } catch {
    return { running: false, devices: [] };
  }
}

/**
 * 引擎里装了哪些主模型。
 *
 * 读的是 `UNETLoader` 节点的可选值 —— 那正是工作流要填的字段，比扫目录可靠：
 * `extra_model_paths.yaml` 里挂的多个目录都会被列出来（Anima 就是靠这个挂进原生 ComfyUI 的）。
 */
export async function listComfyCheckpoints(baseUrl?: string): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
  let base: string;
  try {
    base = normalizeComfyBaseUrl(baseUrl);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "引擎地址无效" };
  }
  try {
    const response = await fetch(`${base}/object_info/UNETLoader`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const payload = await response.json() as Record<string, unknown>;
    const node = payload.UNETLoader && typeof payload.UNETLoader === "object"
      ? payload.UNETLoader as Record<string, unknown>
      : {};
    const input = node.input && typeof node.input === "object" ? node.input as Record<string, unknown> : {};
    const required = input.required && typeof input.required === "object" ? input.required as Record<string, unknown> : {};
    const unet = required.unet_name;
    const list = Array.isArray(unet) && Array.isArray(unet[0]) ? unet[0] : [];
    const models = list.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim());
    return { ok: true, models };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 设置页/接口里那句「默认模型是什么」，避免各写一遍。 */
export function defaultComfyModelName(quality: boolean): string {
  return LOCAL_IMAGE_MODELS[quality ? "quality" : "fast"];
}

/**
 * 引擎里装了哪些 LoRA。
 *
 * 和主模型同一个理由：读 `LoraLoaderModelOnly` 的可选值，而不是扫目录 ——
 * `extra_model_paths.yaml` 挂进来的目录也会被列出来。
 * 引擎没开时返回 `ok: false`，页面据此提示「先启动 Anima」，而不是给一个空列表让人以为一个都没有。
 */
export async function listComfyLoras(baseUrl?: string): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
  let base: string;
  try {
    base = normalizeComfyBaseUrl(baseUrl);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "引擎地址无效" };
  }
  try {
    const response = await fetch(`${base}/object_info/LoraLoaderModelOnly`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const payload = await response.json() as Record<string, unknown>;
    const node = payload.LoraLoaderModelOnly && typeof payload.LoraLoaderModelOnly === "object"
      ? payload.LoraLoaderModelOnly as Record<string, unknown>
      : {};
    const input = node.input && typeof node.input === "object" ? node.input as Record<string, unknown> : {};
    const required = input.required && typeof input.required === "object" ? input.required as Record<string, unknown> : {};
    const loraName = required.lora_name;
    const list = Array.isArray(loraName) && Array.isArray(loraName[0]) ? loraName[0] : [];
    const models = list.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim());
    return { ok: true, models };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
