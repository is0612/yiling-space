/**
 * 忆泡参与者的「当前叫法」。
 *
 * 库里 `participants` 存的是**记那一刻**的名字（「旧名」），而 QQ 群名片随时会改 ——
 * 实测 134 个账号里 17 个两天内就改过（有人两天内从「小明」改成「小刚」）。
 * 历史记录不改写（那是当时的事实），但**注入提示词时要换成现在的名字**：否则她说出的
 * 名字对方未必认识，按名字检索也会漏。
 *
 * 锚点是 `participantRefs` 里的 `platform + externalId`（平台账号，例如 QQ 号）：
 * 名字只是展示层，改一百次也不影响「这是同一个人」。
 *
 * 为什么不直接用 `external_identities.displayName`：那张表只在「她真的回过这个人」时
 * 才刷新（见 `friends.ts` 的 `recordFriendInteraction`）。实测某条 identity 停在
 * 03:59，而他在 04:06 之后的消息里已经用了新名字。原始消息的 `metadata` 才是
 * 每个时间点都准的来源。
 */

import { Prisma } from "../../src/generated/prisma/client";
import type { PrismaClient } from "../../src/generated/prisma/client";

type ParticipantRefLike = {
  kind?: unknown;
  platform?: unknown;
  externalId?: unknown;
  displayName?: unknown;
};

export type ExternalParticipantRef = {
  platform: string;
  externalId: string;
  /** 记那一刻的名字。用来在 `participants` 里认出「这一项指的是他」。 */
  displayName?: string;
};

/** 从 JSON 列里读出外部身份引用。结构不对的项直接丢，不猜。 */
export function readExternalParticipantRefs(value: unknown): ExternalParticipantRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ExternalParticipantRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as ParticipantRefLike;
    if (record.kind !== "external") continue;
    const externalId = typeof record.externalId === "string" ? record.externalId.trim() : "";
    if (!externalId) continue;
    const platform = typeof record.platform === "string" ? record.platform.trim() : "unknown";
    const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
    refs.push({
      platform,
      externalId,
      ...(displayName ? { displayName } : {}),
    });
  }
  return refs;
}

/**
 * 把 `participants` 里的旧名字换成本人名册里的当前名字。
 *
 * 匹配顺序：先精确相等，再「包含」（模型偶尔写「小刚」而引用里是「小刚同学」）。
 * 只换认得出的那几项，认不出的原样保留 —— 换错名字比留着旧名更糟，
 * 和参与者清洗那边「多于一个候选就不猜」是同一条原则。
 */
export function applyCurrentParticipantNames(
  participants: readonly string[],
  refs: unknown,
  currentNames: ReadonlyMap<string, string>,
): string[] {
  const renames: Array<{ was: string; now: string }> = [];
  for (const ref of readExternalParticipantRefs(refs)) {
    const was = ref.displayName;
    const now = currentNames.get(ref.externalId);
    if (!was || !now || was === now) continue;
    if (!renames.some((entry) => entry.was === was && entry.now === now)) {
      renames.push({ was, now });
    }
  }
  if (!renames.length) return [...participants];

  const result: string[] = [];
  for (const person of participants) {
    const exact = renames.find((entry) => entry.was === person);
    // 包含匹配只用于 2 字以上的名字，否则「青」会命中「青衫」这种无关项。
    const loose = exact ?? renames.find((entry) =>
      entry.was.length >= 2 && (person.includes(entry.was) || entry.was.includes(person)),
    );
    const next = loose?.now ?? person;
    if (!result.includes(next)) result.push(next);
  }
  return result;
}

/**
 * 批量取这些账号**最近一次**发言用的名字。
 *
 * 用原始 SQL 是因为要 `DISTINCT ON`：「每个账号的最新一条」用 Prisma 的 findMany
 * 得把全部消息拉回来再分组。量级小（几万条以内）够用；真到十万条再加
 * `(metadata->>'authorOpenId', "occurredAt")` 的表达式索引。
 */
async function loadCurrentDisplayNames(
  prisma: PrismaClient,
  externalIds: readonly string[],
): Promise<Map<string, string>> {
  if (!externalIds.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ uid: string; name: string }>>(Prisma.sql`
    SELECT DISTINCT ON (metadata->>'authorOpenId')
      metadata->>'authorOpenId' AS uid,
      metadata->>'authorDisplayName' AS name
    FROM messages
    WHERE metadata->>'authorOpenId' IN (${Prisma.join([...externalIds])})
      AND COALESCE(metadata->>'authorDisplayName', '') <> ''
    ORDER BY metadata->>'authorOpenId', "occurredAt" DESC
  `);
  return new Map(rows.map((row) => [row.uid, row.name]));
}

/**
 * 一组忆泡 → 刷新后的参与者名字（顺序与输入一一对应）。
 *
 * 调用点是「拼提示词之前」：`events` 和 `recentEvents` 一起传进来，只查一次库。
 */
export async function resolveEventParticipantNames(
  prisma: PrismaClient,
  events: ReadonlyArray<{ participants: readonly string[]; participantRefs?: unknown }>,
): Promise<string[][]> {
  if (!events.length) return [];

  const ids = new Set<string>();
  for (const event of events) {
    for (const ref of readExternalParticipantRefs(event.participantRefs)) ids.add(ref.externalId);
  }
  // 没有引用列就没什么可刷新的：老忆泡本来就没记账号，保持原样。
  if (!ids.size) return events.map((event) => [...event.participants]);

  const currentNames = await loadCurrentDisplayNames(prisma, [...ids]);
  return events.map((event) => applyCurrentParticipantNames(
    event.participants,
    event.participantRefs,
    currentNames,
  ));
}

/**
 * 问句里那个人 → 平台账号。
 *
 * 这是「名字只是入口、账号才是身份」的入口那一半：用户问「小刚最近说了什么」，
 * 忆泡里存的却是旧名「小明」。只比字符串查不到，先把名字换成账号，再用账号去
 * 检索 `participantRefs` —— 改多少次名都还认得是同一个人。
 *
 * 两个来源：
 *  1. 原始消息里的 `authorDisplayName`（每个时间点都准，包含所有历史写法）；
 *  2. `MemoryScope.aliases`（她私下的叫法，如「小七」）。
 *
 * 返回空数组表示「认不出是谁」，调用方就只按名字做字符串匹配，不猜。
 */
export async function resolveParticipantAccounts(
  prisma: PrismaClient,
  name: string,
): Promise<string[]> {
  const wanted = name.trim();
  if (!wanted) return [];

  const ids = new Set<string>();

  /**
   * 两个字以上才做模糊匹配；单字只比精确相等。
   * 「青」搜「青衫」是错配，而群里单字昵称并不少见，不能一刀切拒绝。
   */
  const escaped = wanted.replace(/[\\%_]/gu, (char) => `\\${char}`);
  const fuzzy = wanted.length >= 2
    ? Prisma.sql`OR metadata->>'authorDisplayName' LIKE ${`%${escaped}%`}`
    : Prisma.empty;
  const byDisplayName = await prisma.$queryRaw<Array<{ uid: string }>>(Prisma.sql`
    SELECT DISTINCT metadata->>'authorOpenId' AS uid
    FROM messages
    WHERE COALESCE(metadata->>'authorOpenId', '') <> ''
      AND (metadata->>'authorDisplayName' = ${wanted} ${fuzzy})
    LIMIT 20
  `);
  for (const row of byDisplayName) if (row.uid) ids.add(row.uid);

  // 她私下的叫法不在消息 metadata 里，存在 scope 上。
  const byAlias = await prisma.$queryRaw<Array<{ uid: string }>>(Prisma.sql`
    SELECT DISTINCT ei."platformUid" AS uid
    FROM memory_scopes s
    JOIN external_identities ei ON ei.id = s."externalIdentityId"
    WHERE ${wanted} = ANY(s.aliases)
    LIMIT 20
  `);
  for (const row of byAlias) if (row.uid) ids.add(row.uid);

  return [...ids];
}
