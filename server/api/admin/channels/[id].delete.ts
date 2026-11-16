import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { deleteChannelConnectionCompletely } from "../../../utils/channel-connection-delete";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

/**
 * 删掉一个渠道连接（「删除这个号」）。
 *
 * 真正的删除语义（先清绑定、哪些表没有外键要手删、哪些行故意保留）都在
 * `server/utils/channel-connection-delete.ts` 里。这里只做鉴权、参数校验和存在性检查。
 *
 * 之前这里只有一句 `platformConnection.delete`：号上只要挂过角色，就会被
 * `character_channel_bindings.connectionId` 的 Restrict 外键挡下来，
 * 页面只能回一句「删除失败，请稍后重试」—— 看起来就像「加了角色之后删不掉了」。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const connectionId = requireUuid(getRouterParam(event, "id") ?? "", "渠道连接");

  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findUnique({
    where: { id: connectionId },
    select: { id: true },
  });
  if (!connection) throw createError({ statusCode: 404, statusMessage: "渠道连接不存在。" });

  const purged = await deleteChannelConnectionCompletely({ connectionId });
  return { deleted: true, purged };
});
