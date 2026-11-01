import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { biliOptions, loadBiliConnectionById } from "../../../utils/channel-adapter/bili/configure";
import { runBili } from "../../../utils/channel-adapter/bili/runner";
import { parseBiliOwner, readBiliError } from "../../../utils/channel-adapter/bili/cards";

/**
 * 读「当前主人」（bili CLI 的 owner）。
 *
 * 主人存在 bili CLI 自己的配置里（跟登录凭证同一个 dataHome），不落我们的库，
 * 所以每次打开值班设置都现读一次 —— 否则换号登录后这里会一直显示上一个人的昵称。
 * 用 `owner show` 而不是 `owner set`：show 只读，还会顺手刷新昵称。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const connectionId = typeof query.connectionId === "string" ? query.connectionId : "";

  const connection = await loadBiliConnectionById(connectionId);
  if (!connection) throw createError({ statusCode: 404, statusMessage: "找不到该 B站 连接。" });

  const result = await runBili(["owner", "show"], { ...biliOptions(connection), timeoutMs: 30_000 });
  const error = readBiliError(result.json);
  if (error) {
    return { ok: false, owner: null, error: `${error.code}${error.message ? `：${error.message}` : ""}` };
  }

  const owner = parseBiliOwner(result.json);
  if (!owner) {
    return {
      ok: false,
      owner: null,
      error: result.stderr.slice(0, 160) || "还没设置主人，填个 UID 设一下。",
    };
  }
  return { ok: true, owner };
});
