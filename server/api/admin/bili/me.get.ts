import { requireAdminActor } from "../../../utils/auth";
import { biliJson } from "../../../utils/channel-adapter/bili/runner";
import { parseBiliMe, readBiliError } from "../../../utils/channel-adapter/bili/cards";

/**
 * 读「现在扫码登录的是谁」：`bili me show`。
 *
 * 和 `auth/login`、`auth/status` 一样**不接 connectionId** —— 扫码登录写的是 bili CLI
 * 默认数据目录（`%APPDATA%\bili-cli`，或环境里的 `BILI_CLI_HOME`）。拿某个账号的 dataHome
 * 去读会读到另一份凭证，反而和刚扫的那个号对不上。
 *
 * 没登录时 CLI 会以 ok:false 返回（code 通常是 not_logged_in），这里原样透出，
 * 前端据此决定显示「登录 B站」还是用户头像。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const json = await biliJson(["me", "show"], { timeoutMs: 30_000 });
  const error = readBiliError(json);
  if (error) {
    return {
      ok: false,
      me: null,
      error: `${error.code}${error.message ? `：${error.message}` : ""}`,
    };
  }

  const me = parseBiliMe(json);
  if (!me) {
    return { ok: false, me: null, error: "没读到账号资料，确认 bili CLI 已登录。" };
  }
  return { ok: true, me, error: null };
});
