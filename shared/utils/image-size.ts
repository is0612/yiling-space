/**
 * 画面尺寸档位：语义名固定为方 / 竖 / 横，具体像素按服务商与模型挑。
 *
 * 为什么不在前端写死三组像素：`864x1152` 是照着 MiniMax 的面积下限定的，
 * 换到 OpenAI 那几家就是 400 —— 它只认 1024x1024 / 1536x1024 / 1024x1536。
 * 存储永远存语义名，像素在发请求前才算，换模型时老角色不会存着一个非法尺寸。
 */

import { resolveLocalImagePreset, type ImageModelPreset } from "./local-image-engine";

export type ImageSizePreset = "square" | "portrait" | "landscape";

export type ImageSizeOption = {
  value: ImageSizePreset;
  /** 给下拉框看的文案，带比例和实际像素。 */
  label: string;
  /** 真正发给服务商的 `宽x高`。 */
  pixels: string;
};

type SizeSet = Record<ImageSizePreset, string>;

/**
 * 四家画图服务的合法尺寸。
 *
 * - MiniMax：三个值都 ≥ 655,360 px 的面积下限，低于下限直接 400。
 * - gpt-image 系列（1 / 2 / 2.5 flare / 2.5 sunburst）：推荐尺寸一致，
 *   都是 1024x1024 / 1536x1024 / 1024x1536。2.5 虽然允许自定义尺寸（16 的倍数、
 *   1:3~3:1、面积 655,360~8,294,400），但推荐值仍是这三个。
 * - dall-e-3：横竖都是 1792，比 gpt-image 更方。
 * - dall-e-2：只支持方图，竖横一律降成 1024x1024（宁可画成方图，也不要报错）。
 * - 本机 Anima：官方给的范围是 512²~1536²，但 8G 显存实际天花板在 1MP 附近，
 *   所以竖横都用 896×1152 这一组（约 1.03MP），别给 1536 那种会 OOM 的值。
 */
export const IMAGE_SIZE_SETS = {
  minimax: { square: "1024x1024", portrait: "864x1152", landscape: "1152x864" },
  gptImage: { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" },
  dalle3: { square: "1024x1024", portrait: "1024x1792", landscape: "1792x1024" },
  squareOnly: { square: "1024x1024", portrait: "1024x1024", landscape: "1024x1024" },
  localAnima: { square: "1024x1024", portrait: "896x1152", landscape: "1152x896" },
  /**
   * 本机 MOSS：竖图用 2:3。
   *
   * 不是审美偏好 —— MOSS 的 Flux2 latent 按 16 倍下采样，832 和 1248 都是 16 的倍数；
   * 而且 2:3 是实测下来全身立绘最舒服的比例（896×1152 的 7:9 太方，人物显得挤）。
   */
  localMoss: { square: "1024x1024", portrait: "832x1248", landscape: "1248x832" },
} as const satisfies Record<string, SizeSet>;

const SIZE_NAME: Record<ImageSizePreset, string> = { square: "方图", portrait: "竖图", landscape: "横图" };

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function ratioLabel(pixels: string): string {
  const [width, height] = pixels.split("x").map(Number);
  if (!width || !height) return "";
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** 服务商 + 模型名 → 用哪一套尺寸。模型名是手填的，认不出就按主流 OpenAI 那套。 */
export function imageSizeSetFor(provider: string, model: string, modelPreset: ImageModelPreset = "auto"): SizeSet {
  if (provider === "minimax") return IMAGE_SIZE_SETS.minimax;
  if (provider === "comfyui") {
    // 同是本机引擎，MOSS 和 Anima 的竖幅比例不同（见 localMoss 的注释）。
    return resolveLocalImagePreset(model, modelPreset) === "moss" ? IMAGE_SIZE_SETS.localMoss : IMAGE_SIZE_SETS.localAnima;
  }
  if (/dall-?e-?3/i.test(model)) return IMAGE_SIZE_SETS.dalle3;
  if (/dall-?e-?2/i.test(model)) return IMAGE_SIZE_SETS.squareOnly;
  // gpt-image-1 / 2 / 2.5-flare / 2.5-sunburst 与未知模型都走这一套。
  return IMAGE_SIZE_SETS.gptImage;
}

/** 语义档位 → 实际像素。永远返回合法值，老数据里的 `portrait` 也不会变成 400。 */
export function resolveImagePixels(provider: string, model: string, preset: ImageSizePreset, modelPreset: ImageModelPreset = "auto"): string {
  return imageSizeSetFor(provider, model, modelPreset)[preset] ?? IMAGE_SIZE_SETS.gptImage.square;
}

/**
 * 下拉框选项。像素重复的档位合并掉（dall-e-2 只剩方图一个），
 * 数量因此会随模型变化 —— 这是有意的，别把不可用的档位摆出来让人选。
 */
export function imageSizeOptions(provider: string, model: string, modelPreset: ImageModelPreset = "auto"): ImageSizeOption[] {
  const set = imageSizeSetFor(provider, model, modelPreset);
  const ordered: ImageSizePreset[] = ["square", "portrait", "landscape"];
  const seen = new Set<string>();
  const options: ImageSizeOption[] = [];
  for (const value of ordered) {
    const pixels = set[value];
    if (seen.has(pixels)) continue;
    seen.add(pixels);
    options.push({
      value,
      pixels,
      label: `${SIZE_NAME[value]} ${ratioLabel(pixels)}（${pixels.replace("x", " × ")}）`,
    });
  }
  return options;
}
