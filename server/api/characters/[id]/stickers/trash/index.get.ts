import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import {
  STICKER_TRASH_RETENTION_DAYS,
  purgeTrashedStickers,
  toStickerDto,
  trashExpiredBefore,
} from "../../../../../utils/stickers";

/**
 * 回收站。
 *
 * 打开时顺手把超过 `STICKER_TRASH_RETENTION_DAYS` 的清掉 —— 不挂定时任务：
 * 回收站是低频页面，为删几张图常驻一个调度器不划算，而没人打开的时候那些文件也不碍事。
 * 这个副作用是刻意的，响应里带 `purged` 说明这次清掉了几条。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const purged = await purgeTrashedStickers(id, trashExpiredBefore());

  const rows = await prisma.characterSticker.findMany({
    where: { characterId: id, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
  });

  return {
    items: rows.map(toStickerDto),
    purged,
    retentionDays: STICKER_TRASH_RETENTION_DAYS,
  };
});
