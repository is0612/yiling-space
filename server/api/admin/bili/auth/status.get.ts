import { requireAdminActor } from "../../../../utils/auth";
import { biliJson, biliMissingMessage, probeBiliBin } from "../../../../utils/channel-adapter/bili/runner";

/**
 * 查询 B站登录状态：调 `bili auth status`，归一化为 { ok, user, error }。
 * 前端轮询此接口，`ok` 变 true 即扫码成功。
 *
 * 缺 CLI 时 biliJson 只会拿到 null，和「没登录」长得一模一样，前端就会一直转圈等扫码。
 * 所以先探一次可执行文件，缺了直接给 cliMissing，让界面说清是没装而不是没扫。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const probe = probeBiliBin();
  if (!probe.found) {
    return { ok: false, user: null, error: null, cliMissing: true, detail: biliMissingMessage(probe.bin) };
  }

  const result = (await biliJson(["auth", "status"], { timeoutMs: 40_000, bin: probe.bin })) as
    | { ok?: boolean; data?: { user?: unknown }; error?: unknown }
    | null;
  const data = (result?.data ?? {}) as { user?: unknown };
  return {
    ok: Boolean(result?.ok),
    user: data.user ?? null,
    error: result?.error ?? null,
    cliMissing: false,
    detail: null,
  };
});
