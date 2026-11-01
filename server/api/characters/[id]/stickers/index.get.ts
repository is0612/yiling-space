import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { toStickerDto } from "../../../../utils/stickers";

/** 这个角色的表情包清单。图片本体走 `/stickers/<id>/image` 单独取。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const rows = await prisma.characterSticker.findMany({
    // 回收站里的不返回：删掉的表情不该还占着列表，翻回收站走 `/stickers/trash`。
    where: { characterId: id, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toStickerDto);
});
