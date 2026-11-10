import { getQuery } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { getPrisma } from "../../../../utils/prisma";
import { pendingFriendAliasWhere, toSuggestionDto } from "../../../../utils/friend-alias-suggestions";

/**
 * 待审备注列表：她（在快照提炼时）想给朋友起的叫法，等用户点头。
 *
 * `?characterId=` 过滤角色，不传就返回全部待审。PENDING 之外的都不在列表里 ——
 * 已同意/已否掉的由唯一约束挡着不会再回来，这里只关心「还没处理」的。
 *
 * 每条带上人物（friendName / platform / platformUid），让弹窗直接念「想给 XXX 起名」，
 * 而不是甩一个光秃秃的别名让用户猜是谁。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const characterId = typeof query.characterId === "string" && query.characterId ? query.characterId : undefined;

  const prisma = getPrisma();
  const rows = await prisma.friendAliasSuggestion.findMany({
    where: pendingFriendAliasWhere(characterId),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 100,
    select: {
      id: true,
      scopeId: true,
      alias: true,
      reason: true,
      status: true,
      createdAt: true,
      scope: {
        select: {
          externalIdentity: { select: { displayName: true, platform: true, platformUid: true } },
        },
      },
    },
  });

  return { items: rows.map(toSuggestionDto) };
});
