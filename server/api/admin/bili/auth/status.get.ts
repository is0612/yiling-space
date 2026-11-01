import { requireAdminActor } from "../../../../utils/auth";
import { biliJson } from "../../../../utils/channel-adapter/bili/runner";

/**
 * 查询 B站登录状态：调 `bili auth status`，归一化为 { ok, user, error }。
 * 前端轮询此接口，`ok` 变 true 即扫码成功。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const result = (await biliJson(["auth", "status"], { timeoutMs: 40_000 })) as
    | { ok?: boolean; data?: { user?: unknown }; error?: unknown }
    | null;
  const data = (result?.data ?? {}) as { user?: unknown };
  return {
    ok: Boolean(result?.ok),
    user: data.user ?? null,
    error: result?.error ?? null,
  };
});
