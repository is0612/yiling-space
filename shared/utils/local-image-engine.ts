/**
 * 本地生图引擎（ComfyUI + Anima）的公共约定：地址、默认模型文件名、出图档位。
 *
 * 前后端都要用同一份：
 *   - 服务端要按档位挑模型文件、拼工作流；
 *   - 设置页要在下拉里列出这两个默认文件名，且「留空 = 按档位自动选」得和
 *     服务端的判断一模一样 —— 两处各写一份名字，改一处就会对不上。
 *
 * 这里只放**常量与纯函数**，不碰 fs / fetch，客户端也能安全 import。
 */

/** 服务商标识。存进 `modelConfig.imageProvider`，也出现在日志与消息 metadata 里。 */
export const LOCAL_IMAGE_PROVIDER = "comfyui";

export type ImageModelPreset = "auto" | "anima" | "moss";
export type ImageModelProfile = {
  id: string; provider: "" | "comfyui" | "minimax" | "openai";
  apiBaseUrl: string; apiKey: string; model: string;
  size: "square" | "portrait" | "landscape"; quality: "fast" | "quality"; preset: ImageModelPreset;
};
/** Credentials never participate in connection identity. */
export function imageConnectionKey(provider: string, address: string): string {
  if (!address.trim()) return `${provider}|`;
  const url = new URL(address.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("画图连接地址无效。");
  return `${provider}|${url.toString().replace(/\/+$/u, "")}`;
}
/** Validate all retained drafts using a strict field allowlist. */
export function readImageProfiles(value: unknown): ImageModelProfile[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error("画图预设必须是最多40项的数组。");
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("画图预设格式无效。");
    const row = item as Record<string, unknown>;
    const text = (key: string, max: number) => {
      if (typeof row[key] !== "string" || (row[key] as string).length > max) throw new Error("画图预设字段无效。");
      return (row[key] as string).trim();
    };
    const id = text("id", 120), provider = text("provider", 20), apiBaseUrl = text("apiBaseUrl", 500), apiKey = text("apiKey", 8192), model = text("model", 120);
    const size = text("size", 20), quality = text("quality", 20), preset = text("preset", 20);
    if (!id || ids.has(id) || !["", "comfyui", "minimax", "openai"].includes(provider) || !["square", "portrait", "landscape"].includes(size) || !["fast", "quality"].includes(quality) || !["auto", "anima", "moss"].includes(preset)) throw new Error("画图预设包含重复标识或无效选项。");
    imageConnectionKey(provider, apiBaseUrl); ids.add(id);
    return { id, provider, apiBaseUrl, apiKey, model, size, quality, preset } as ImageModelProfile;
  });
}
/** Unknown non-empty weights require an explicit compatible preset. */
export function resolveLocalImagePreset(model: string, preset: ImageModelPreset = "auto"): LocalImageFamily | null {
  if (preset === "anima" || preset === "moss") return preset;
  if (!model.trim() || /(^|[/\\])anima[-_]/i.test(model)) return "anima";
  return /(^|[/\\])moss[_-]?image/i.test(model) ? "moss" : null;
}

/** ComfyUI 默认端口 8188；和 `启动Anima.bat` 里那条命令一致。 */
export const LOCAL_IMAGE_DEFAULT_BASE_URL = "http://127.0.0.1:8188";

/**
 * 两个档位对应的默认模型文件。
 *
 * Turbo 是蒸馏版，8~12 步、CFG 1，一张十几秒，用来刷图；
 * Aesthetic 是精修版，30 步、CFG 4.5，慢四倍但细节和光影更好。
 * 文件名带 `.safetensors`，因为它们是要填进 ComfyUI `UNETLoader.unet_name` 的值。
 */
export const LOCAL_IMAGE_MODELS = {
  fast: "anima-turbo-v1.1.safetensors",
  quality: "anima-aesthetic-v1.1.safetensors",
} as const;

/** 出图档位：只影响本地引擎（云端服务商不看这个字段）。 */
export type LocalImageQuality = keyof typeof LOCAL_IMAGE_MODELS;

/**
 * 读档位。默认 `fast`：本地出图慢，默认值要选那个「点了就有反应」的。
 * 只认 `quality`，其它一切（含 undefined、旧数据）都当 `fast`。
 */
export function resolveLocalImageQuality(value: unknown): LocalImageQuality {
  return value === "quality" ? "quality" : "fast";
}

/** 档位 → 模型文件名。`model` 非空（用户手填/引擎里挑的）时以它为准。 */
export function resolveLocalImageModel(quality: LocalImageQuality, model?: string): string {
  const explicit = (model ?? "").trim();
  return explicit || LOCAL_IMAGE_MODELS[quality];
}

/**
 * 给人看的档位说明，设置页和测试结果共用一套说法。
 *
 * 这份是 **anima 的**（默认档位模型就是它那两版权重）。MOSS 的步数与耗时完全不同，
 * 见 `localImageQualityLabels()`。文案里的秒数是 8G 卡上的经验值，不是承诺值 ——
 * 首次出图还要加载权重，会比之后慢一截。
 */
export const LOCAL_IMAGE_QUALITY_LABELS: Record<LocalImageQuality, string> = {
  fast: "快速（Turbo，12 步，约 10~15 秒）",
  quality: "精修（Aesthetic，30 步，约 40~60 秒）",
};

/**
 * 按模型选档位说明。
 *
 * 步数写死在文案里，所以文案必须跟族走：给 MOSS 显示「Turbo 12 步」会让用户
 * 以为自己选错了模型，或者以为参数没生效。
 *
 * MOSS 的秒数是 4060 8G 上的**实测值**（768×1024，int8 权重 + CPU 编码器）：
 * 15 步 / CFG 2.2 热态约 45 秒；引擎刚启动、或模型被换下去之后的首次要 100 秒
 * （要重新读 5.4G DiT + 9.75G 编码器）。25 步 / CFG 2.5 按前向次数线性外推，
 * 热态约 80 秒、冷态约 160 秒。
 *
 * 比 anima 慢一个量级，主因是 CFG > 1 每步跑两次前向（15 步 = 30 次前向）。
 * 想压到 30 秒只有挂 8 步 DMD 加速 LoRA + cfg 1。
 */
export function localImageQualityLabels(model: string | undefined): Record<LocalImageQuality, string> {
  if (resolveImageFamily(model ?? "") !== "moss") return LOCAL_IMAGE_QUALITY_LABELS;
  return {
    fast: "快速（15 步，约 45~100 秒）",
    quality: "精修（25 步，约 80~160 秒）",
  };
}

/* ────────────────────────── 引擎族（节点组合） ────────────────────────── */

/**
 * 引擎族。同一族共用一整套 ComfyUI 节点组合：
 * CLIP 的 `type`、VAE 文件、latent 节点类型都必须跟着族走，**不是只换 unet_name 就行**。
 *
 * 两族的硬差异（配错会直接报错，而不是画得差）：
 *   - anima：CLIP type `stable_diffusion`，`EmptyLatentImage`（4 通道 latent）
 *   - moss ：CLIP type `moss_image`，`EmptyFlux2LatentImage`（128 通道 latent）
 *
 * 新加一个模型族时，要同步改三处：这里的 profile、`buildGraph` 的 latent 分支、
 * 以及 `comfyui-image.ts` 里按族取 CLIP/VAE 的那两个函数。
 */
export type LocalImageFamily = "anima" | "moss";

/**
 * 从模型文件名推断引擎族。
 *
 * 用文件名而不是配置项，是因为设置页的模型下拉本来就来自引擎的 `UNETLoader` 列表，
 * 用户选中的那个名字里已经带着族信息 —— 多一个配置项只会多一处能配错的地方。
 *
 * 要容忍 `moss\moss_image_sft.safetensors` 这种带子目录的写法：ComfyUI 的
 * `extra_model_paths.yaml` 会把子目录名一起返回，用户从下拉里挑到的可能就是它。
 */
export function resolveImageFamily(model: string): LocalImageFamily {
  return /(^|[/\\])moss[_-]?image/i.test((model ?? "").trim()) ? "moss" : "anima";
}

export type LocalImageFamilyProfile = {
  /** 文本编码器文件名（也可能是引擎里的相对路径）。 */
  clip: string;
  /** `CLIPLoader.type`。MOSS 必须是 `moss_image`，否则 tokenizer 和模板都是错的。 */
  clipType: string;
  /**
   * `CLIPLoader.device`。
   *
   * MOSS 的编码器是 9.75G，8G 卡上**必须** `cpu`：它和 DiT（5.4G）不能同时待在显存里，
   * 放 `default`（= 优先 GPU）会立刻 OOM，或者被引擎降级成极慢的分块搬运。
   * anima 的编码器只有 1.1G，放显存更快，保持 `default`。
   */
  clipDevice: "default" | "cpu";
  vae: string;
  /** latent 节点：`sd` = EmptyLatentImage，`flux2` = EmptyFlux2LatentImage。 */
  latent: "sd" | "flux2";
  /**
   * 宽高必须是它的倍数。MOSS 的 `EmptyFlux2LatentImage` 按 16 下采样，
   * 给 8 的倍数会报尺寸错；anima 那边 VAE 只要求 8。
   */
  edgeStep: number;
  steps: Record<LocalImageQuality, number>;
  cfg: Record<LocalImageQuality, number>;
  defaultEdges: Record<LocalImageQuality, { width: number; height: number }>;
};

/**
 * 一族的全部默认值。
 *
 * MOSS 的档位不是「快/精」两种蒸馏版，而是同一套权重用不同步数：
 * `fast` 15 步 / cfg 2.2（约 100 秒，8G 上的日常）；`quality` 25 步 / cfg 2.5（约 160 秒，官方推荐 cfg 的八折）。
 * 官方 T2I 基准是 50 步 / cfg 3，本地 8G 跑不起，25 步是质量与时间的折中。
 *
 * 注：装了 8 步 DMD 加速 LoRA 时可以把 fast 压到 8 步 / cfg 1，但那个 LoRA 需要用户
 * 在形象档案里手动挂 —— 代码不替用户决定挂不挂，也不假设那个文件一定在。
 */
export const LOCAL_IMAGE_FAMILY: Record<LocalImageFamily, LocalImageFamilyProfile> = {
  anima: {
    clip: "qwen_3_06b_base.safetensors",
    clipType: "stable_diffusion",
    clipDevice: "default",
    vae: "qwen_image_vae.safetensors",
    latent: "sd",
    edgeStep: 8,
    steps: { fast: 12, quality: 30 },
    cfg: { fast: 1, quality: 4.5 },
    defaultEdges: { fast: { width: 896, height: 1152 }, quality: { width: 832, height: 1216 } },
  },
  moss: {
    clip: "qwen3.5_9b_int8_convrot.safetensors",
    clipType: "moss_image",
    clipDevice: "cpu",
    vae: "flux2-vae_small.safetensors",
    latent: "flux2",
    edgeStep: 16,
    steps: { fast: 15, quality: 25 },
    cfg: { fast: 2.2, quality: 2.5 },
    defaultEdges: { fast: { width: 832, height: 1248 }, quality: { width: 896, height: 1344 } },
  },
};
