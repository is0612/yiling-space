import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireAdminActor } from "../../../../utils/auth";
import { runBili } from "../../../../utils/channel-adapter/bili/runner";

/**
 * 发起 B站扫码登录：调 `bili auth login --qr-out <路径>` 生成二维码图片到临时文件，
 * 返回二维码文件路径（供后续 qr 接口读取）。二维码生成后由前端轮询 status 判断是否扫了。
 */

export const BILI_QR_DIR = join(tmpdir(), "yiling-hub-bili-qr");

export async function biliQrPath(): Promise<string> {
  await mkdir(BILI_QR_DIR, { recursive: true });
  return join(BILI_QR_DIR, "login-qr.png");
}

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const qrPath = await biliQrPath();
  const result = await runBili(["auth", "login", "--qr-out", qrPath], { timeoutMs: 60_000 });
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    qrReady: result.code === 0,
  };
});
