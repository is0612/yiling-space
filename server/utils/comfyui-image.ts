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
  LOCAL_IMAGE_MODELS,
  resolveLocalImageModel,
  type LocalImageQuality,
} from "../../shared/utils/local-image-engine";

const CLIP_NAME = () => process.env.COMFYUI_CLIP_NAME || "qwen_3_06b_base.safetensors";
const VAE_NAME = () => process.env.COMFYUI_VAE_NAME || "qwen_image_vae.safetensors";

/**
 * 质量词。Turbo 与 Aesthetic 的推荐前缀不同：
 * 官方文档说 Aesthetic 已经把低质图剔干净了，`score_*` 反而会把画面推得太腻，
 * 所以精修只用 `masterpiece, best quality, safe`，不带分数标签。
 */
const QUALITY_PREFIX_BASE = "masterpiece, best quality, safe.";
const QUALITY_PREFIX_SCORE = "masterpiece, best quality, score_7, safe.";
const DEFAULT_NEGATIVE =
  "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia, text, watermark";

/** 单张图最长等多久。质量版首次要加载 4G 模型，留足余量。 */
const POLL_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 800;
const MAX_EDGE = 1280;
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
  width?: number;
  height?: number;
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

const clampEdge = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  const edge = Math.round(value as number);
  const bounded = Math.min(MAX_EDGE, Math.max(MIN_EDGE, edge));
  // VAE 要求 8 的倍数，否则编解码直接报错。
  return Math.floor(bounded / 8) * 8;
};

type PromptBlock = { class_type: string; inputs: Record<string, unknown> };

function buildGraph(input: {
  prompt: string;
  negative: string;
  model: string;
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
  /**
   * LoRA 接在 UNETLoader 和采样器之间：1 → 12 → KSampler。
   * 用 `LoraLoaderModelOnly` 而不是 `LoraLoader` —— 它只改 UNet，不碰 CLIP，
   * 所以不用去猜这个 LoRA 训练时用的是哪套文本编码器。
   */
  const modelRef: [string, number] = input.lora ? ["12", 0] : ["1", 0];
  const graph: Record<string, PromptBlock> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: input.model, weight_dtype: "default" } },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: CLIP_NAME(), type: "stable_diffusion", device: "default" },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: VAE_NAME() } },
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
    "10": {
      class_type: "SaveImage",
      inputs: { images: ["9", 0], filename_prefix: "YilingSpace/anima" },
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
    // 按「总像素」缩到约 1MP，长宽比不变，resolution_steps=8 保证是 8 的倍数。
    graph["11"] = {
      class_type: "ImageScaleToTotalPixels",
      inputs: { image: ["6", 0], upscale_method: "lanczos", megapixels: 1.0, resolution_steps: 8 },
    };
    graph["7"] = { class_type: "VAEEncode", inputs: { pixels: ["11", 0], vae: ["3", 0] } };
  } else {
    graph["6"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: input.width, height: input.height, batch_size: 1 },
    };
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
  let imageName: string | undefined;
  const width = clampEdge(input.width, quality ? 832 : 896);
  const height = clampEdge(input.height, quality ? 1216 : 1152);

  // 有参考图就走图生图；尺寸交给原图，这里的 width/height 会被忽略。
  const reference = input.referenceBuffer
    ?? (input.referencePath
      ? { buffer: await readFile(input.referencePath).catch(() => null), filename: basename(input.referencePath) }
      : null);

  if (reference) {
    if (!reference.buffer) return { ok: false, reason: "参考图读不出来（路径不对或没权限）" };
    const uploaded = await uploadImage(base, { buffer: reference.buffer, filename: reference.filename });
    if (!uploaded.name) return { ok: false, reason: uploaded.reason ?? "参考图上传失败" };
    imageName = uploaded.name;
  }

  // 档案里的负面提示词追加在官方那一串后面：中文对它无效，但英文是有效的补充。
  const negative = [DEFAULT_NEGATIVE, input.negative?.trim()].filter(Boolean).join(", ");

  const seed = Number.isFinite(input.seed) ? Math.floor(input.seed as number) : Math.floor(Math.random() * 1e15);
  // LoRA 文件名只认末段，挡掉 `../` 这类穿越；强度收口到 0–2（超过 2 基本只会糊）。
  const loraName = input.lora?.name?.trim().split(/[/\\]/u).pop() ?? "";
  const lora = loraName
    ? { name: loraName, strength: Math.min(2, Math.max(0, Number.isFinite(input.lora?.strength) ? input.lora!.strength as number : 1)) }
    : undefined;
  const graph = buildGraph({
    prompt: `${quality ? QUALITY_PREFIX_BASE : QUALITY_PREFIX_SCORE} ${prompt}`,
    negative,
    model,
    width,
    height,
    seed,
    steps: quality ? 30 : 12,
    cfg: quality ? 4.5 : 1.0,
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
