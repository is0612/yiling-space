import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { purgeTrashedStickers } from "../../../../../utils/stickers";

/**
 * 清空回收站：把这个角色回收站里的行和文件一起彻底删掉。
 *
 * 与打开回收站时「顺手清掉超过 30 天的」是同一条清理路径，区别只是不限过期时间 ——
 * 用户点「清空」的意思就是一张都别留。不可恢复，页面那边必须过二次确认。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const purged = await purgeTrashedStickers(id);
  return { ok: true, purged };
});
