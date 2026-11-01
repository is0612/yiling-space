import sharp from "sharp";

/**
 * 贴图（表情包）的尺寸规范化。
 *
 * 为什么要做：QQ 按图片的**原始像素**显示，群里偷来的图动辄 1000~1500px 宽，
 * 发出去在聊天窗里就是一张占满屏的巨图，完全不像「表情」。统一压到宽 200 ——
 * 比 QQ / 微信里常见表情（240 上下）再小一圈，在 125% 缩放的屏幕上观感更接近「表情」。
 *
 * 三条边界：
 *   1. **只缩不放**：本来就不比 200 宽的图原样返回，不重编码（重编码只会掉画质）；
 *   2. **只定宽，高度等比**：竖长图（比如 300×1800 的条漫表情）缩完是 200×1200，
 *      不裁不拉伸 —— 裁掉内容比显示得大更糟；
 *   3. 不认识 / 解不开的图返回 null，调用方存原件。表情包不是主流程，
 *      解码失败不该让「上传」或「收图」整条失败。
 *
 * 动图（gif / webp）按帧缩放：`animated: true` 时 sharp 会保留所有帧与每帧延迟，
 * 不用 `animated` 会把动图变成只有第一帧的静图 —— 那是用户最不能接受的降级。
 */

/** 发到 QQ 的贴图最大宽度（像素）。改这里之前先想清楚：这个值直接决定聊天窗里的观感。 */
export const STICKER_MAX_WIDTH = 200;

export type NormalizedStickerImage = {
  buffer: Buffer;
  mimeType: string;
  /** 缩完之后（没缩时就是原图）的尺寸。动图时 height 是**所有帧叠起来的总高**。 */
  width: number;
  height: number;
  /** 原图尺寸。日志 / 迁移脚本要看「从多大缩到多大」，光看结果分不出缩没缩。 */
  sourceWidth: number;
  sourceHeight: number;
  /**
   * 帧数。动图的 `height` 是总高（帧数 × 每帧高），不看这个数会把
   * 「500×500 的 19 帧动图」误读成「500×9500 的长图」。
   */
  pages: number;
  /** 单帧高度（静图等于 height）。 */
  frameHeight: number;
  /** 真的缩过没有。false 时 `buffer` 就是传进来的原件。 */
  resized: boolean;
};

/** gif / webp 要按动图处理，否则只剩第一帧。 */
const ANIMATED_MIME_TYPES = new Set(["image/gif", "image/webp"]);

/**
 * 宽于 `STICKER_MAX_WIDTH` 就等比缩小，否则原样返回。
 * 解码失败返回 `null` —— 由调用方决定退回原件。
 */
export async function normalizeStickerImage(
  buffer: Buffer,
  mimeType: string,
): Promise<NormalizedStickerImage | null> {
  const animated = ANIMATED_MIME_TYPES.has(mimeType);
  try {
    const meta = await sharp(buffer, { animated }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const pages = meta.pages ?? 1;
    const frameHeight = meta.pageHeight ?? height;
    if (!width || !height || width <= STICKER_MAX_WIDTH) {
      return {
        buffer,
        mimeType,
        width,
        height,
        sourceWidth: width,
        sourceHeight: height,
        pages,
        frameHeight,
        resized: false,
      };
    }

    // `.rotate()` 放在 resize 前：手机拍的 jpg 带 EXIF 方向，不先摆正会按「躺着」的
    // 宽高算比例，缩完变成一张横着的图。
    let pipeline = sharp(buffer, { animated })
      .rotate()
      .resize({ width: STICKER_MAX_WIDTH, withoutEnlargement: true });

    // 输出格式必须与输入一致：扩展名是按原 mime 定的，换成别的格式文件名就撒了谎。
    switch (mimeType) {
      case "image/jpeg":
        pipeline = pipeline.jpeg({ quality: 88 });
        break;
      case "image/webp":
        pipeline = pipeline.webp({ quality: 88 });
        break;
      case "image/gif":
        pipeline = pipeline.gif();
        break;
      default:
        pipeline = pipeline.png({ compressionLevel: 9 });
        break;
    }

    const output = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer: output.data,
      mimeType,
      width: output.info.width,
      height: output.info.height,
      sourceWidth: width,
      sourceHeight: height,
      // 缩放不改帧数：动图缩完还是原来那么多帧（sharp 按页处理，不是只留第一帧）。
      pages: output.info.pages ?? pages,
      frameHeight: output.info.pageHeight ?? output.info.height,
      resized: true,
    };
  } catch {
    return null;
  }
}
