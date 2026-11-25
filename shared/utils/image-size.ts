/**
 * 画面尺寸：比例 + 像素预算。
 *
 * 本地（ComfyUI）那套尺寸不是我们说了算的 —— 工作流里通常挂着一个
 * `ResolutionSelector`（分辨率选择器），它吃的是「比例 + 百万像素 + 倍数」，
 * 自己算宽高。所以设置页不能再写「896 × 1152」这种假像素：同一个 9:16，
 * 1 MP 和 2 MP 出来的宽度差一倍。
 *
 * 这里把节点的公式照抄一份，页面显示的宽高就是引擎真正会用的宽高：
 *   total = megapixels × 1024 × 1024
 *   scale = sqrt(total / (w × h))
 *   宽 = round(w × scale / multiple) × multiple
 *   高 = round(h × scale / multiple) × multiple
 *
 * 倍数固定 64：Anima 的 latent 只要求 8、MOSS 的 Flux2 latent 要求 16，
 * 64 同时是两者的倍数，还能对上用户手动选 9:16 时看到的 1088 × 1920。
 *
 * 云端服务商（MiniMax / OpenAI）仍然是三档固定像素 —— 它们不认比例，
 * 只认自己那几个尺寸，硬塞 21:9 只会换回一个 400。
 */

import { resolveLocalImagePreset, type ImageModelPreset } from "./local-image-engine";

/** 工作流「分辨率选择器」里真正存在的八档比例；名字必须和节点枚举一字不差。 */
export const IMAGE_SIZE_RATIOS = [
  { value: "1:1", width: 1, height: 1, name: "方图", node: "1:1 (Square)" },
  { value: "2:3", width: 2, height: 3, name: "竖图", node: "2:3 (Portrait Photo)" },
  { value: "3:2", width: 3, height: 2, name: "横图", node: "3:2 (Photo)" },
  { value: "3:4", width: 3, height: 4, name: "竖图", node: "3:4 (Portrait Standard)" },
  { value: "4:3", width: 4, height: 3, name: "横图", node: "4:3 (Standard)" },
  { value: "9:16", width: 9, height: 16, name: "竖图", node: "9:16 (Portrait Widescreen)" },
  { value: "16:9", width: 16, height: 9, name: "横图", node: "16:9 (Widescreen)" },
  { value: "21:9", width: 21, height: 9, name: "超宽", node: "21:9 (Ultrawide)" },
] as const;

export type ImageSizeRatio = typeof IMAGE_SIZE_RATIOS[number]["value"];
/** 老数据里的三个语义名，云端服务商现在也还用它。 */
export type ImageSizeSemantic = "square" | "portrait" | "landscape";
export type ImageSizePreset = ImageSizeRatio | ImageSizeSemantic;

export type ImageSizeOption = {
  value: ImageSizePreset;
  /** 给下拉框看的文案，带比例和实际像素。 */
  label: string;
  /** 真正发给服务商的 `宽x高`。 */
  pixels: string;
};

/** 本地尺寸按 64 取整：8、16、64 的倍数都满足，MOSS 的 Flux2 latent 也不会报错。 */
export const LOCAL_SIZE_MULTIPLE = 64;

/** 像素预算。默认 1 MP（和原来 Anima 那三档面积相当），想要 1088×1920 就选 2 MP。 */
export const DEFAULT_IMAGE_MEGAPIXELS = 1;
/**
 * 只给三档，2 MP 封顶：再往上 21:9 的宽边会超过 `MAX_EDGE`（见 comfyui-image.ts），
 * 引擎会把宽高裁掉一截，页面显示的尺寸就不作数了。
 */
export const IMAGE_MEGAPIXEL_OPTIONS = [1, 1.5, 2] as const;

const RATIO_BY_VALUE = new Map<string, typeof IMAGE_SIZE_RATIOS[number]>(
  IMAGE_SIZE_RATIOS.map(item => [item.value, item]),
);

export function isImageSizeRatio(value: unknown): value is ImageSizeRatio {
  return typeof value === "string" && RATIO_BY_VALUE.has(value);
}

/** 语义档位 ↔ 比例。`portrait` 在 Anima 那边一直是 3:4（896×1152），MOSS 那边是 2:3。 */
function semanticToRatio(value: ImageSizeSemantic, provider: string, model: string, modelPreset: ImageModelPreset): ImageSizeRatio {
  if (value === "square") return "1:1";
  const moss = provider === "comfyui" && resolveLocalImagePreset(model, modelPreset) === "moss";
  if (value === "portrait") return moss ? "2:3" : "3:4";
  return moss ? "3:2" : "4:3";
}

/** 比例 → 方/竖/横：云端只有这三档，切换服务商时靠它落回合法值。 */
export function imageSizeKind(value: ImageSizePreset): ImageSizeSemantic {
  if (value === "square" || value === "portrait" || value === "landscape") return value;
  const ratio = RATIO_BY_VALUE.get(value);
  if (!ratio) return "square";
  const value_ = ratio.width / ratio.height;
  return value_ < 0.95 ? "portrait" : value_ > 1.05 ? "landscape" : "square";
}

/**
 * 把存下来的值翻译成当前服务商认得的那一套。
 *
 * 本地要比例（下拉里是 8 档），云端要三个语义名（服务商只有三种尺寸）。
 * 老角色存的是 `portrait`，换到本地时按 3:4 / 2:3 落位，不会因为下拉里没有 `portrait`
 * 就显示成空白。
 */
export function normalizeImageSize(
  value: unknown,
  provider: string,
  model = "",
  modelPreset: ImageModelPreset = "auto",
): ImageSizePreset {
  const local = provider === "comfyui";
  if (isImageSizeRatio(value)) return local ? value : imageSizeKind(value);
  if (value === "square" || value === "portrait" || value === "landscape") {
    return local ? semanticToRatio(value, provider, model, modelPreset) : value;
  }
  return local ? "1:1" : "square";
}

/** 服务商对应的默认档位：本地是方图比例，云端是 `square`。 */
export function defaultImageSize(provider: string): ImageSizePreset {
  return provider === "comfyui" ? "1:1" : "square";
}

/** 本地引擎：比例 + 百万像素 → 引擎真正会用的宽高（照抄 ResolutionSelector 的算法）。 */
export function localImagePixels(
  ratio: ImageSizePreset,
  megapixels: number,
  multiple = LOCAL_SIZE_MULTIPLE,
): string {
  const item = RATIO_BY_VALUE.get(ratio) ?? RATIO_BY_VALUE.get("1:1")!;
  const total = Math.max(0.05, megapixels) * 1024 * 1024;
  const scale = Math.sqrt(total / (item.width * item.height));
  const step = Math.max(1, Math.round(multiple));
  const width = Math.max(step, Math.round(item.width * scale / step) * step);
  const height = Math.max(step, Math.round(item.height * scale / step) * step);
  return `${width}x${height}`;
}

/**
 * 工作流里 `aspect_ratio` 要填的那个枚举名。
 * 老值（portrait 之类）先归一成比例，再查名字。
 */
export function imageAspectRatioName(value: ImageSizePreset, provider: string, model = "", modelPreset: ImageModelPreset = "auto"): string {
  const normalized = normalizeImageSize(value, provider, model, modelPreset);
  return (RATIO_BY_VALUE.get(normalized) ?? RATIO_BY_VALUE.get("1:1")!).node;
}

/** 云端服务商的合法尺寸。 */
type SizeSet = Record<ImageSizeSemantic, string>;

/**
 * 四家画图服务的合法尺寸。
 *
 * - MiniMax：三个值都 ≥ 655,360 px 的面积下限，低于下限直接 400。
 * - gpt-image 系列（1 / 2 / 2.5 flare / 2.5 sunburst）：推荐尺寸一致，
 *   都是 1024x1024 / 1536x1024 / 1024x1536。2.5 虽然允许自定义尺寸（16 的倍数、
 *   1:3~3:1、面积 655,360~8,294,400），但推荐值仍是这三个。
 * - dall-e-3：横竖都是 1792，比 gpt-image 更方。
 * - dall-e-2：只支持方图，竖横一律降成 1024x1024（宁可画成方图，也不要报错）。
 */
export const IMAGE_SIZE_SETS = {
  minimax: { square: "1024x1024", portrait: "864x1152", landscape: "1152x864" },
  gptImage: { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" },
  dalle3: { square: "1024x1024", portrait: "1024x1792", landscape: "1792x1024" },
  squareOnly: { square: "1024x1024", portrait: "1024x1024", landscape: "1024x1024" },
} as const satisfies Record<string, SizeSet>;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function ratioLabel(pixels: string): string {
  const [width, height] = pixels.split("x").map(Number);
  if (!width || !height) return "";
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** 服务商 + 模型名 → 用哪一套云端尺寸。模型名是手填的，认不出就按主流 OpenAI 那套。 */
export function imageSizeSetFor(provider: string, model: string): SizeSet {
  if (provider === "minimax") return IMAGE_SIZE_SETS.minimax;
  if (/dall-?e-?3/i.test(model)) return IMAGE_SIZE_SETS.dalle3;
  if (/dall-?e-?2/i.test(model)) return IMAGE_SIZE_SETS.squareOnly;
  return IMAGE_SIZE_SETS.gptImage;
}

/**
 * 语义档位 → 实际像素。
 *
 * 本地走比例公式；云端按方/竖/横查表。永远返回合法值，
 * 老数据里的 `portrait`、或者从本地切过来还带着 `9:16` 的情况都不会变成 400。
 */
export function resolveImagePixels(
  provider: string,
  model: string,
  preset: ImageSizePreset,
  modelPreset: ImageModelPreset = "auto",
  megapixels = DEFAULT_IMAGE_MEGAPIXELS,
): string {
  if (provider === "comfyui") return localImagePixels(normalizeImageSize(preset, provider, model, modelPreset), megapixels);
  const set = imageSizeSetFor(provider, model);
  return set[imageSizeKind(preset)] ?? IMAGE_SIZE_SETS.gptImage.square;
}

/**
 * 下拉框选项。
 *
 * - 本地：工作流那 8 档比例，每档都标出「这个预算下引擎真正会出的宽高」；
 * - 云端：只有服务商认的档位，像素重复的合并掉（dall-e-2 只剩方图一个）。
 */
export function imageSizeOptions(
  provider: string,
  model: string,
  modelPreset: ImageModelPreset = "auto",
  megapixels = DEFAULT_IMAGE_MEGAPIXELS,
): ImageSizeOption[] {
  if (provider === "comfyui") {
    return IMAGE_SIZE_RATIOS.map(item => {
      const pixels = localImagePixels(item.value, megapixels);
      return {
        value: item.value,
        pixels,
        label: `${item.name} ${item.value}（${pixels.replace("x", " × ")}）`,
      };
    });
  }

  const set = imageSizeSetFor(provider, model);
  const ordered: ImageSizeSemantic[] = ["square", "portrait", "landscape"];
  const seen = new Set<string>();
  const options: ImageSizeOption[] = [];
  for (const value of ordered) {
    const pixels = set[value];
    if (seen.has(pixels)) continue;
    seen.add(pixels);
    const name = value === "square" ? "方图" : value === "portrait" ? "竖图" : "横图";
    options.push({
      value,
      pixels,
      label: `${name} ${ratioLabel(pixels)}（${pixels.replace("x", " × ")}）`,
    });
  }
  return options;
}
