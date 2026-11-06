import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { runBili } from "../../../utils/channel-adapter/bili/runner";
import { BiliCommandRequestError, prepareBiliCommandInvocation } from "../../../utils/channel-adapter/bili/catalog";
import { loadBiliCatalog } from "../../../utils/channel-adapter/bili/schema-catalog";

/**
 * 执行一条 bili 命令。
 *
 * itemId 和 argv 必须与服务端可信命令目录一致；未知或缺失 itemId 一律拒绝。
 * 写操作默认追加 --dry-run，只有管理员显式确认 allowWrite 才执行真实写入。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<{ argv?: unknown; itemId?: unknown; allowWrite?: unknown }>(event);

  const { groups } = await loadBiliCatalog();
  let invocation: ReturnType<typeof prepareBiliCommandInvocation>;
  try {
    invocation = prepareBiliCommandInvocation(groups, body ?? {});
  } catch (error) {
    if (error instanceof BiliCommandRequestError) {
      throw createError({ statusCode: 400, statusMessage: error.message });
    }
    throw error;
  }

  const result = await runBili(invocation.argv, { timeoutMs: 240_000 });
  return {
    code: result.code,
    json: result.json,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsed: result.elapsed,
    argv: result.argv,
    timedOut: result.timedOut,
  };
});
