import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { biliOptions, loadBiliConnectionById } from "../../../utils/channel-adapter/bili/configure";
import { runBili } from "../../../utils/channel-adapter/bili/runner";
import { parseBiliOwner, readBiliError } from "../../../utils/channel-adapter/bili/cards";

/**
 * 设置主人（`bili owner set <UID / 昵称>`）。
 *
 * 这是**真写**：改的是 bili CLI 自己的配置，之后 `dm send owner` 和 `--at owner`
 * 都会认这个人。所以放在值班设置里要用户点「设为主人」才动，不随表单保存一起提交。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<{ connectionId?: unknown; uid?: unknown }>(event);

  const connectionId = typeof body?.connectionId === "string" ? body.connectionId.trim() : "";
  const uid = typeof body?.uid === "string" ? body.uid.trim() : "";
  if (!connectionId) throw createError({ statusCode: 400, statusMessage: "缺少连接 ID。" });
  if (!uid) throw createError({ statusCode: 400, statusMessage: "填个 UID 或昵称。" });
  if (uid.length > 40) throw createError({ statusCode: 400, statusMessage: "UID / 昵称太长了。" });

  const connection = await loadBiliConnectionById(connectionId);
  if (!connection) throw createError({ statusCode: 404, statusMessage: "找不到该 B站 连接。" });

  const options = { ...biliOptions(connection), timeoutMs: 60_000 };
  const result = await runBili(["owner", "set", uid], options);
  const error = readBiliError(result.json);
  if (error || result.code !== 0) {
    const detail = error
      ? `${error.code}${error.message ? `：${error.message}` : ""}`
      : result.stderr.slice(0, 160) || `退出码 ${result.code}`;
    return { ok: false, owner: null, error: detail };
  }

  // set 只回「设好了」，昵称和 mid 以 show 为准（昵称可能刚改过）
  const shown = await runBili(["owner", "show"], options);
  return { ok: true, owner: parseBiliOwner(shown.json) ?? parseBiliOwner(result.json) };
});
