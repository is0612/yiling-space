import { readFile } from "node:fs/promises";
import { createError } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { biliQrPath } from "./login.post";

/**
 * 返回 B站扫码登录二维码图片（base64 data URL）。二维码由 login 接口生成到临时文件。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const qrPath = await biliQrPath();
  let bytes: Buffer;
  try {
    bytes = await readFile(qrPath);
  } catch {
    throw createError({ statusCode: 404, statusMessage: "还没有二维码，请先发起登录。" });
  }
  return { dataUrl: "data:image/png;base64," + bytes.toString("base64") };
});
