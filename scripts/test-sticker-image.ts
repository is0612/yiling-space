import assert from "node:assert/strict";
import sharp from "sharp";
import { STICKER_MAX_WIDTH, normalizeStickerImage } from "../server/utils/sticker-image";

/**
 * 贴图尺寸规范化（宽 200、高度等比）的回归测试。
 *
 * 图不落盘，全部用 sharp 现造 —— 这个工具本身只做「读尺寸 → 缩 → 按原格式输出」，
 * 用造出来的图就能覆盖边界，不需要 fixture 文件。
 *
 * 动图（gif/webp）不在这里断言：造一个多帧 gif 需要 libvips 的多页输入，
 * 测试里写起来比被测代码还长。动图那一段是手工验的（300×1800 / 6 帧的 gif
 * 缩成 200×1200 后仍是 6 帧），以后改 `animated` 分支时要重新跑一次。
 */

const solidPng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: "#3b82f6" } }).png().toBuffer();

// 1. 宽图等比缩小：宽被定到 200，高度按原比例，输出仍是能解码的 PNG。
const wide = await solidPng(800, 400);
const shrunk = await normalizeStickerImage(wide, "image/png");
assert(shrunk, "宽图必须缩得动。");
assert.equal(shrunk.resized, true);
assert.equal(shrunk.width, STICKER_MAX_WIDTH);
assert.equal(shrunk.height, 100, "800×400 缩到宽 200 应该是 200×100（等比）。");
const shrunkMeta = await sharp(shrunk.buffer).metadata();
assert.equal(shrunkMeta.format, "png", "输出格式必须跟输入一致，否则扩展名撒谎。");
assert.equal(shrunkMeta.width, 200);
assert.equal(shrunkMeta.height, 100);

// 2. 竖长图只定宽、高度等比 —— 不裁不拉伸。
const tall = await solidPng(300, 1800);
const tallOut = await normalizeStickerImage(tall, "image/png");
assert(tallOut?.resized);
assert.equal(tallOut.width, 200);
assert.equal(tallOut.height, 1200, "300×1800 应该缩成 200×1200，不能裁成方图。");

// 3. 本来就不比 200 宽：原样返回，**不重编码**（重编码只会掉画质）。
const small = await solidPng(120, 90);
const untouched = await normalizeStickerImage(small, "image/png");
assert(untouched);
assert.equal(untouched.resized, false);
assert.equal(untouched.buffer, small, "没缩的时候必须把同一个 buffer 原样交回去。");
assert.equal(untouched.width, 120);
assert.equal(untouched.height, 90);

// 4. 正好 200 宽也不动（边界值不能被当成「宽了 1px」）。
const exact = await solidPng(200, 150);
const exactOut = await normalizeStickerImage(exact, "image/png");
assert.equal(exactOut?.resized, false, "正好 200 宽不该重编码。");

// 5. JPEG 缩完还得是 JPEG —— 扩展名是按原 mime 定的。
const jpeg = await sharp({ create: { width: 1000, height: 500, channels: 3, background: "#123456" } })
  .jpeg()
  .toBuffer();
const jpegOut = await normalizeStickerImage(jpeg, "image/jpeg");
assert(jpegOut?.resized);
const jpegMeta = await sharp(jpegOut.buffer).metadata();
assert.equal(jpegMeta.format, "jpeg");
assert.equal(jpegMeta.width, 200);
assert.equal(jpegMeta.height, 100);

// 6. 解不开的字节返回 null：调用方存原件，上传 / 收图不该因为「图坏了」整条失败。
assert.equal(await normalizeStickerImage(Buffer.from("这不是图片"), "image/png"), null);

console.log("贴图尺寸规范化：全部通过（宽 200、高度等比、只缩不放、格式不变）");
