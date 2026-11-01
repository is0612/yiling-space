/**
 * 「她的朋友」：某个角色认识的某个人。
 *
 * 关系直接落在 `EXTERNAL_IDENTITY` 记忆范围上（`scopeKey` 里带 characterId），所以这里只做
 * 三件事：认人（upsert 外部身份）、开范围、记一次互动。**不为「朋友」新建关系表** ——
 * 新建就得跟记忆范围两头同步，而这张范围本来就唯一对应「某角色 × 某个人」。
 *
 * 另有一张 `group_members`，它记的**不是关系**，是「谁在哪个群说过话」：有了它，
 * 熟人才分得清「A 群的小肥鱼」和「B 群的小肥鱼」，群聊时也不会把别群的熟人当成屋里的人。
 * 两张表各管一件事：这里管「她回过谁」，那里管「谁在这个屋里」。
 *
 * 计数口径（和产品对齐过）：
 * - 私聊：对方发来消息就 +1。
 * - 群聊：只有她真的回了谁才 +1（`pipeline.ts` 用 `replyToMessageId`/`atMessageId` 反查作者）。
 *   群里没被搭理的发言不算认识，否则一个活跃群几天就攒出几百个"朋友"。
 *
 * 注意：这里只解决「谁」，不解决「她记得什么」。外部身份范围的记忆提炼由
 * `memory-scheduler.ts` 按周期排（`listFriendScopesWithActivity`），所以关系行和记忆是两条线：
 * 关系行记「聊过几次」，记忆记「聊过什么」。
 */

import type { Prisma } from "../../src/generated/prisma/client";
import { getPrisma } from "./prisma";
import { ensureExternalIdentityScope } from "./identity-scope";

export type FriendSource = "PRIVATE" | "GROUP";

export type FriendTouch = {
  identityId: string;
  scopeId: string;
};

/**
 * 记一次互动。调用方一律 `catch` 掉 —— 记朋友这件事绝不能挡住她已生成的那句话。
 */
export async function recordFriendInteraction(input: {
  characterId: string;
  platform: string;
  platformUid: string;
  displayName?: string | null;
  source: FriendSource;
  at?: Date;
}): Promise<FriendTouch | null> {
  const platformUid = (input.platformUid ?? "").trim();
  if (!platformUid) return null;

  const prisma = getPrisma();
  const at = input.at ?? new Date();

  const identity = await prisma.externalIdentity.upsert({
    where: { platform_platformUid: { platform: input.platform, platformUid } },
    create: {
      platform: input.platform,
      platformUid,
      displayName: input.displayName?.slice(0, 255) || null,
      status: "UNVERIFIED",
    },
    // 昵称会改（改一次群名片就变一次），每次遇到都刷成最新的。
    update: {
      ...(input.displayName ? { displayName: input.displayName.slice(0, 255) } : {}),
    },
    select: { id: true },
  });

  const scope = await ensureExternalIdentityScope(input.characterId, input.platform, platformUid, identity.id);

  await prisma.$transaction([
    // 只在还没记过时写来源：群里认识、后来私聊的人，来源仍然是 GROUP。
    prisma.memoryScope.updateMany({
      where: { id: scope.scopeId, firstSource: null },
      data: { firstSource: input.source },
    }),
    prisma.memoryScope.update({
      where: { id: scope.scopeId },
      data: {
        interactionCount: { increment: 1 },
        lastInteractedAt: at,
      },
    }),
  ]);

  return { identityId: identity.id, scopeId: scope.scopeId };
}

/**
 * 单个周期最多给多少个朋友排快照。
 *
 * 与主人私人范围不同，这些范围的数量随朋友数增长，每一个都要单独调一次模型提炼。
 * 宁可让排在后面的晚一轮总结，也不能让一个几百人的群把账单顶上去。
 */
export const MAX_FRIEND_SCOPES_PER_CYCLE = 50;

/** 熟客榜取几个：够回答「跟谁最熟」，又不至于把上百个朋友塞进提示词。 */
export const CLOSE_FRIEND_LIMIT = 8;

export type CloseFriend = {
  name: string;
  times: number;
  lastSeenAt: Date | null;
  via: FriendSource | null;
  /**
   * 她跟这个人同处过、而且这个人在里面说过话的群号（按群内发言量排序，最多 2 个）。
   *
   * 只有跨群总榜填这个字段。**它是「按群分」的落地方式**：两个群各有一个「小肥鱼」，
   * 名字一样、人不一样，带上群号她才分得清，不会把 A 群的梗说给 B 群的人听。
   * 用群号而不是群名：`Conversation.title` 存的是首条消息片段，拿来当群名只会添乱。
   */
  groups?: string[];
};

/**
 * 她的熟人分档 —— 私聊的、群里的、还有当前这个屋里的。
 *
 * 为什么分三档而不是一张总榜：这张表现在有两个完全不同的用途。
 *
 * 1. **群聊时判断语气**：她需要知道「这个屋里谁跟我聊过、谁是生面孔」。这必须限定在当前群，
 *    拿别群的熟人凑数，她会冲着第一次见的人叫老朋友。
 * 2. **私聊时回答「你跟谁最好」**：这时候要的是全部，而且必须私聊的和群里的分开说 ——
 *    群里天天见的人次数天然高，混成一张榜念出来，私聊里真正亲近的人反而排不上号。
 *
 * `totals` 是「她到底认识多少人」的量级，给私聊用：榜只有 8 个位置，她不该以为
 * 自己全世界的朋友就这么几个。
 */
export type Acquaintances = {
  /** 私聊里往来最多的人。 */
  fromPrivate: CloseFriend[];
  /** 群里往来最多的人（跨群总榜），每条带 `groups`。 */
  fromGroups: CloseFriend[];
  /** 仅群聊：就在当前这个群里、她又有过来往的人。私聊会话这里是空数组。 */
  inThisGroup: CloseFriend[];
  /** 认识的总人数（不含榜的截断），用来给她一个量级。 */
  totals: { private: number; group: number };
};

/** 排序：她回过这个人多少次 → 最近一次 → id 定死顺序。 */
const FRIEND_ORDER = [
  { interactionCount: "desc" },
  { lastInteractedAt: { sort: "desc", nulls: "last" } },
  { id: "asc" },
] satisfies Prisma.MemoryScopeOrderByWithRelationInput[];

const FRIEND_SELECT = {
  interactionCount: true,
  lastInteractedAt: true,
  firstSource: true,
  externalIdentity: { select: { displayName: true, platformUid: true } },
} satisfies Prisma.MemoryScopeSelect;

type FriendRow = Prisma.MemoryScopeGetPayload<{ select: typeof FRIEND_SELECT }>;

/** 一个群最多读多少个成员做交集。几百人的群够用，也挡住异常数据把 `in` 撑爆。 */
const ROOM_MEMBER_SCAN_LIMIT = 800;

/** 跨群总榜里，每个人最多标几个群 —— 标太多等于没标。 */
const GROUP_LABEL_LIMIT = 2;

function friendRowToEntry(row: FriendRow): CloseFriend {
  return {
    name: (row.externalIdentity?.displayName ?? "").trim() || row.externalIdentity?.platformUid || "?",
    times: row.interactionCount,
    lastSeenAt: row.lastInteractedAt,
    via: row.firstSource === "PRIVATE" || row.firstSource === "GROUP" ? row.firstSource : null,
  };
}

/**
 * 跨群总榜的「这人跟我在哪些群见过」。
 *
 * 走 `group_members`：那张表记的是**谁在哪个群说过话**，跟「她回过谁」是两条线 ——
 * 一个人可以在群里很活跃但她一次都没搭理过，那种人不该进熟人榜，但同一批数据
 * 正好能告诉她「这个熟人在哪个群」。
 *
 * 标签用群号（`群123456781`）而不是 `Conversation.title`：那张表的 title 是**首条消息的
 * 片段**（实测有「@self 起床没」「欢迎鱼宝宝」这种），拿来当群名只会给她一堆噪声。
 * 群号是唯一稳定、唯一不会骗人的标识 —— 它唯一的作用就是让两个同名的人别被读成一个人。
 */
async function loadGroupLabels(characterId: string, platformUids: string[]): Promise<Map<string, string[]>> {
  const labels = new Map<string, string[]>();
  if (!platformUids.length) return labels;
  const rows = await getPrisma().groupMember.findMany({
    where: { characterId, platformUid: { in: platformUids } },
    orderBy: { messageCount: "desc" },
    select: {
      platformUid: true,
      conversation: { select: { externalConversationId: true } },
    },
  });
  for (const row of rows) {
    const groupNo = (row.conversation.externalConversationId ?? "").replace(/^g:/, "").trim();
    if (!groupNo) continue;
    const bucket = labels.get(row.platformUid) ?? [];
    if (bucket.includes(groupNo) || bucket.length >= GROUP_LABEL_LIMIT) continue;
    bucket.push(groupNo);
    labels.set(row.platformUid, bucket);
  }
  return labels;
}

/** 当前这个群里她认识的人：先取群成员，再跟「她回过的人」取交集。 */
async function loadRoomFriends(
  base: Prisma.MemoryScopeWhereInput,
  conversationId: string,
  limit: number,
): Promise<FriendRow[]> {
  const prisma = getPrisma();
  const members = await prisma.groupMember.findMany({
    where: { conversationId },
    orderBy: { messageCount: "desc" },
    take: ROOM_MEMBER_SCAN_LIMIT,
    select: { platformUid: true },
  });
  if (!members.length) return [];
  return prisma.memoryScope.findMany({
    where: {
      ...base,
      // 这里**不筛 firstSource**：先在私聊认识、后来又在这个群里聊过的人，
      // 在这个屋里同样是熟人。筛 firstSource 会让她对聊过很多次的人说「我们没见过」。
      externalIdentity: { is: { platformUid: { in: members.map((member) => member.platformUid) } } },
    },
    orderBy: FRIEND_ORDER,
    take: limit,
    select: FRIEND_SELECT,
  });
}

/**
 * 她最常来往的几个人 —— 给对话提示词用。
 *
 * 为什么需要：她原本没有任何「我认识谁」的概念。2026-11-01 12:20 有人问「你跟谁关系最好」，
 * 她答了「跟小肥鱼呗」—— 那名字来自群聊里别的 bot 的昵称，不是任何一种关系记录。
 *
 * 排序是 `interactionCount`（她回过这个人多少次），**它不是亲密度的判据** ——
 * 群里天天见的人次数天然高，所以三档分开给，让她自己按场景取用。
 *
 * @param conversationId 群聊传当前会话 id；传了就多返回 `inThisGroup`。
 */
export async function listAcquaintances(input: {
  characterId: string;
  conversationId?: string | null;
  limit?: number;
}): Promise<Acquaintances> {
  const prisma = getPrisma();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? CLOSE_FRIEND_LIMIT), 1), 20);
  const conversationId = (input.conversationId ?? "").trim() || null;
  const base: Prisma.MemoryScopeWhereInput = {
    characterId: input.characterId,
    scopeType: "EXTERNAL_IDENTITY",
    externalIdentityId: { not: null },
    interactionCount: { gt: 0 },
  };

  const [privateRows, groupRows, tally, roomRows] = await Promise.all([
    prisma.memoryScope.findMany({
      where: { ...base, firstSource: "PRIVATE" },
      orderBy: FRIEND_ORDER,
      take: limit,
      select: FRIEND_SELECT,
    }),
    prisma.memoryScope.findMany({
      where: { ...base, firstSource: "GROUP" },
      orderBy: FRIEND_ORDER,
      take: limit,
      select: FRIEND_SELECT,
    }),
    // 一次 groupBy 同时拿两个总数，比两次 count 少一个往返。
    prisma.memoryScope.groupBy({
      by: ["firstSource"],
      where: { ...base, firstSource: { in: ["PRIVATE", "GROUP"] } },
      _count: { _all: true },
    }),
    conversationId ? loadRoomFriends(base, conversationId, limit) : Promise.resolve([] as FriendRow[]),
  ]);

  const groupUids = groupRows
    .map((row) => row.externalIdentity?.platformUid ?? "")
    .filter(Boolean);
  const labels = groupUids.length
    ? await loadGroupLabels(input.characterId, groupUids).catch(() => new Map<string, string[]>())
    : new Map<string, string[]>();

  const totals = { private: 0, group: 0 };
  for (const row of tally) {
    if (row.firstSource === "PRIVATE") totals.private = row._count._all;
    else if (row.firstSource === "GROUP") totals.group = row._count._all;
  }

  return {
    fromPrivate: privateRows.map(friendRowToEntry),
    fromGroups: groupRows.map((row) => {
      const entry = friendRowToEntry(row);
      const uid = row.externalIdentity?.platformUid ?? "";
      const groups = labels.get(uid);
      return groups?.length ? { ...entry, groups } : entry;
    }),
    inThisGroup: roomRows.map(friendRowToEntry),
    totals,
  };
}

/** 她认得多少个人。没有任何分档时用得上，也方便测试。 */
export function isEmptyAcquaintances(value: Acquaintances): boolean {
  return !value.fromPrivate.length && !value.fromGroups.length && !value.inThisGroup.length;
}

/**
 * 本周期内需要补排快照的朋友范围。
 *
 * 只挑「这段时间真的说过话」的：没聊过的范围排了也会被 worker 判成 SKIPPED，白占队列。
 * 排序按最近互动倒序 —— 名额有限时先给还在来往的人。
 */
export async function listFriendScopesWithActivity(input: {
  characterId: string;
  since: Date;
  until: Date;
}): Promise<string[]> {
  const prisma = getPrisma();
  const scopes = await prisma.memoryScope.findMany({
    where: {
      characterId: input.characterId,
      scopeType: "EXTERNAL_IDENTITY",
      interactionCount: { gt: 0 },
      conversations: {
        some: {
          OR: [
            { lastMessageAt: { gte: input.since, lte: input.until } },
            { lastMessageAt: null, updatedAt: { gte: input.since, lte: input.until } },
          ],
        },
      },
    },
    orderBy: { lastInteractedAt: "desc" },
    take: MAX_FRIEND_SCOPES_PER_CYCLE,
    select: { id: true },
  });
  return scopes.map((scope) => scope.id);
}
