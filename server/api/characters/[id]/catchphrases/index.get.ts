import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { CATCHPHRASE_STATUS, toCatchphraseDto } from "../../../../utils/catchphrases";

/**
 * 这个角色的梗清单。
 *
 * 默认只返回**可用的**（ACTIVE，含被停用的 —— 页面要能重新打开）。
 * `?status=pending` 单独取待确认那批：它们只在弹窗里出现，混进主列表会让人
 * 以为已经在用了。REJECTED 永不返回 —— 那是用户否掉的，列出来只会碍事。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const pendingOnly = getQuery(event).status === "pending";
  const now = Date.now();
  const rows = await prisma.characterCatchphrase.findMany({
    where: {
      characterId: id,
      status: pendingOnly ? CATCHPHRASE_STATUS.pending : CATCHPHRASE_STATUS.active,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => toCatchphraseDto(row, now));
});
