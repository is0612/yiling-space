import { getQuery } from "h3";
import type { Prisma } from "../../../../src/generated/prisma/client";
import { requireAdminActor } from "../../../utils/auth";
import { buildPage, readPageQuery } from "../../../utils/pagination";
import { getPrisma } from "../../../utils/prisma";

/**
 * 「她的朋友」：某个角色遇到过的某个人。
 *
 * **一行 = 一条关系**，不是一个账号。同一个 QQ 号在两个角色的群里出现，会有两行；
 * 平台身份类型是账号级共享的，交流权限和互动次数则按角色分开。
 *
 * 群成员第一次发言就会建立「遇到过」记录（interactionCount = 0），方便提前标记 AI / 禁止交流；
 * 只有她真的回复了对方，互动次数才会增加。这里只返回关系元信息，不返回对话或记忆正文。
 *
 * 分页在这儿做，因为名单会一直长（群里认人会一直往上加）：
 * `?characterId=&q=&source=ALL|PRIVATE|GROUP&sort=recent|count|closeness|known&dir=asc|desc&page=1&pageSize=12`
 * 统计带与来源计数始终按「这个角色的全部朋友」算，不受关键词和来源筛选影响 ——
 * 否则筛一下来源，上面「认识的人」的数字跟着变小，就没法当参照了。
 */

const SOURCES = ["ALL", "PRIVATE", "GROUP"] as const;
type SourceFilter = (typeof SOURCES)[number];

const SORTS = ["recent", "count", "closeness", "known"] as const;
type SortBy = (typeof SORTS)[number];

/** 一页 12 个＝四列三行，正好铺满不剩半行。 */
const DEFAULT_PAGE_SIZE = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 名单包括已互动朋友和群里遇到过、但还没来往的人。
 * 零互动的群成员也要能被提前标记身份/交流权限；互动次数仍用于区分熟悉程度。
 */
const FRIEND_BASE: Prisma.MemoryScopeWhereInput = {
  scopeType: "EXTERNAL_IDENTITY",
  externalIdentityId: { not: null },
};

/** 库里存 bili / qq-onebot / wechat，页面显示 B站 / QQ / 微信；搜「QQ」也得能搜到。 */
const PLATFORM_LABELS: Record<string, string> = {
  bili: "B站",
  "qq-onebot": "QQ",
  wechat: "微信",
};

/**
 * 排序。末尾一定补一个唯一列 `id`：只按时间/次数排，同分的人顺序由数据库自由决定，
 * 翻页时同一条会重复出现或被跳过。
 */
function buildOrderBy(sortBy: SortBy, dir: "asc" | "desc"): Prisma.MemoryScopeOrderByWithRelationInput[] {
  const tiebreak: Prisma.MemoryScopeOrderByWithRelationInput = { id: "asc" };
  if (sortBy === "count") {
    // 次数相同的，主方向反着看最近互动：降序时「最近聊过的」在前。
    return [
      { interactionCount: dir },
      { lastInteractedAt: { sort: dir === "asc" ? "desc" : "asc", nulls: "last" } },
      tiebreak,
    ];
  }
  if (sortBy === "known") return [{ createdAt: dir }, tiebreak];
  if (sortBy === "closeness") {
    // 私聊是对方主动找上来的，比在群里被回一句更近。字符串比较下 GROUP < PRIVATE，
    // 所以 desc 正好是「私聊优先」。
    return [
      { firstSource: { sort: dir, nulls: "last" } },
      { interactionCount: dir },
      { lastInteractedAt: { sort: dir === "asc" ? "asc" : "desc", nulls: "last" } },
      tiebreak,
    ];
  }
  return [{ lastInteractedAt: { sort: dir, nulls: "last" } }, { createdAt: "asc" }, tiebreak];
}

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const { page, pageSize, skip } = readPageQuery(query, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: 100,
  });

  // 非法筛选值当「没传」处理，不报 400：筛选器手滑打错一个字不该整页空白。
  const sourceRaw = typeof query.source === "string" ? query.source.toUpperCase() : "ALL";
  const source: SourceFilter = (SOURCES as readonly string[]).includes(sourceRaw)
    ? (sourceRaw as SourceFilter)
    : "ALL";

  const sortRaw = typeof query.sort === "string" ? query.sort.toLowerCase() : "recent";
  const sortBy: SortBy = (SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as SortBy) : "recent";

  const dirRaw = typeof query.dir === "string" ? query.dir.toLowerCase() : "";
  const dir: "asc" | "desc" = dirRaw === "asc" || dirRaw === "desc"
    ? dirRaw
    : sortBy === "known" ? "asc" : "desc";

  const keyword = typeof query.q === "string" ? query.q.trim().slice(0, 60) : "";

  const prisma = getPrisma();
  const [characters, friendCounts] = await Promise.all([
    prisma.character.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, status: true } }),
    prisma.memoryScope.groupBy({ by: ["characterId"], where: FRIEND_BASE, _count: { _all: true } }),
  ]);
  const countByCharacter = new Map(friendCounts.map((row) => [row.characterId, row._count._all]));

  // 默认落在「朋友最多的那个角色」上，而不是列表第一个 —— 空名单开局只会让人以为没数据。
  const requested = typeof query.characterId === "string" ? query.characterId : "";
  const activeCharacterId = characters.some((item) => item.id === requested)
    ? requested
    : [...characters]
      .sort((a, b) => (countByCharacter.get(b.id) ?? 0) - (countByCharacter.get(a.id) ?? 0))[0]?.id ?? "";

  const emptySourceCounts = { all: 0, private: 0, group: 0 };
  if (!activeCharacterId) {
    return {
      characters: [],
      activeCharacterId: "",
      ...buildPage([], 0, page, pageSize),
      stats: { total: 0, familiar: 0, recent: 0 },
      sourceCounts: emptySourceCounts,
      pendingSuggestions: 0,
    };
  }

  const baseWhere: Prisma.MemoryScopeWhereInput = { ...FRIEND_BASE, characterId: activeCharacterId };
  const pageWhere: Prisma.MemoryScopeWhereInput = { ...baseWhere };
  if (source !== "ALL") pageWhere.firstSource = source;
  if (keyword) {
    const lowered = keyword.toLowerCase();
    const platformMatches = Object.entries(PLATFORM_LABELS)
      .filter(([, label]) => label.toLowerCase().includes(lowered))
      .map(([value]) => value);
    const identityFilters: Prisma.ExternalIdentityWhereInput[] = [
      { displayName: { contains: keyword, mode: "insensitive" } },
      { platformUid: { contains: keyword, mode: "insensitive" } },
      // platform 列本身也搜一遍，这样输入 "qq" / "bili" 同样命中。
      { platform: { contains: keyword, mode: "insensitive" } },
      ...(platformMatches.length ? [{ platform: { in: platformMatches } }] : []),
    ];
    // 备注也参与搜索：用户记得住「她怎么叫那人」，未必记得住 QQ 昵称。
    // `has` 是数组精确元素匹配（不带 insensitivity），输完整的那个叫法才命中 ——
    // 够用，而且不会把分页口径搅乱。
    pageWhere.OR = [
      { externalIdentity: { is: { OR: identityFilters } } },
      { aliases: { has: keyword } },
    ];
  }

  const [total, rows, familiar, recent, sourceGroups, pendingSuggestions] = await Promise.all([
    prisma.memoryScope.count({ where: pageWhere }),
    prisma.memoryScope.findMany({
      where: pageWhere,
      orderBy: buildOrderBy(sortBy, dir),
      skip,
      take: pageSize,
      select: {
        id: true,
        characterId: true,
        createdAt: true,
        firstSource: true,
        interactionCount: true,
        lastInteractedAt: true,
        aliases: true,
        friendChatPolicy: true,
        proactiveContactEnabled: true,
        socialProactiveContactAttempts: {
          orderBy: { attemptedAt: "desc" },
          take: 1,
          select: { status: true, reason: true, attemptedAt: true, sentAt: true },
        },
        character: { select: { name: true } },
        externalIdentity: {
          select: { id: true, platform: true, platformUid: true, displayName: true, status: true, linkedUserId: true, kind: true, kindSource: true },
        },
        _count: { select: { conversations: true } },
      },
    }),
    prisma.memoryScope.count({ where: { ...baseWhere, interactionCount: { gte: 2 } } }),
    prisma.memoryScope.count({
      where: { ...baseWhere, lastInteractedAt: { gte: new Date(Date.now() - WEEK_MS) } },
    }),
    prisma.memoryScope.groupBy({ by: ["firstSource"], where: baseWhere, _count: { _all: true } }),
    prisma.friendAliasSuggestion.count({ where: { status: "PENDING", scope: { characterId: activeCharacterId } } }),
  ]);

  const totalForCharacter = countByCharacter.get(activeCharacterId) ?? 0;
  const countFor = (value: string) =>
    sourceGroups.find((group) => group.firstSource === value)?._count._all ?? 0;

  return {
    characters: characters.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      friendCount: countByCharacter.get(item.id) ?? 0,
    })),
    activeCharacterId,
    ...buildPage(
      rows.flatMap((scope) => {
        const identity = scope.externalIdentity;
        if (!identity) return [];
        return [{
          scopeId: scope.id,
          characterId: scope.characterId,
          characterName: scope.character.name,
          identityId: identity.id,
          platform: identity.platform,
          platformUid: identity.platformUid,
          displayName: identity.displayName,
          status: identity.status,
          linkedUserId: identity.linkedUserId,
          identityKind: identity.kind,
          identityKindSource: identity.kindSource,
          friendChatPolicy: scope.friendChatPolicy,
          proactiveContactEnabled: scope.proactiveContactEnabled,
          lastProactiveContactAttempt: scope.socialProactiveContactAttempts[0]
            ? {
                status: scope.socialProactiveContactAttempts[0].status,
                reason: scope.socialProactiveContactAttempts[0].reason,
                attemptedAt: scope.socialProactiveContactAttempts[0].attemptedAt.toISOString(),
                sentAt: scope.socialProactiveContactAttempts[0].sentAt?.toISOString() ?? null,
              }
            : null,
          interactionCount: scope.interactionCount,
          lastInteractedAt: scope.lastInteractedAt?.toISOString() ?? null,
          // 认识的时间＝这条关系建立的时间，也就是第一次遇到这个人。
          knownSince: scope.createdAt.toISOString(),
          firstSource: scope.firstSource,
          // 她私下的叫法。空数组 = 没设过，页面上显示「加备注」。
          aliases: scope.aliases,
          conversationCount: scope._count.conversations,
        }];
      }),
      total,
      page,
      pageSize,
    ),
    stats: { total: totalForCharacter, familiar, recent },
    sourceCounts: {
      all: totalForCharacter,
      private: countFor("PRIVATE"),
      group: countFor("GROUP"),
    },
    pendingSuggestions,
  };
});
