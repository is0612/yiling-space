/**
 * 角色卡的读写（导出查询 + 导入落库）。
 *
 * 单独一层的原因：这两段逻辑既要被 HTTP 接口调用，也要能被脚本直接测。
 * 放在 endpoint 里就只能起一个 Nuxt 才能验证「别人的私人记忆不会进包」这种安全属性，
 * 而那正是最该有测试的地方。
 */

import { createHash, randomUUID } from "node:crypto";
import { createError } from "h3";
import type { Prisma } from "../../src/generated/prisma/client";
import {
  CHARACTER_BUNDLE_LIMITS,
  buildCharacterBundle,
  computeImportedCharacterName,
  parseCharacterBundle,
  type BundleJournalSource,
  type CharacterBundle,
  type CharacterBundleCatchphrase,
  type CharacterBundleCounts,
  type CharacterBundleEventDay,
  type CharacterBundleJournal,
  type CharacterBundleMemoryBody,
  type CharacterBundleSnapshotBody,
  type ParsedCharacterBundle,
} from "./character-portable";
import { buildExternalIdentityScopeKey } from "./identity-scope";
import { normalizeFriendAliases } from "./friend-aliases";
import { buildUserPrivateScopeKey } from "./memory-scope-access";
import { getPrisma } from "./prisma";

export type CharacterExportResult = {
  bundle: CharacterBundle;
  characterName: string;
};

/**
 * 读出导出包。角色不属于该用户时返回 null（而不是抛错），由调用方决定回 404。
 *
 * 角色自身的范围过滤在 SQL 里：`CHARACTER_GLOBAL` + `userId = 当前用户` 的 `USER_PRIVATE`。
 * `EXTERNAL_IDENTITY` 是「她的朋友」，只有 `includeFriends` 为真时才单独查一段 ——
 * 它既是她的人际关系，也是别人的 QQ 号和「她怎么看他们」，所以由导出者当场决定带不带。
 */
export async function loadCharacterExportBundle(input: {
  characterId: string;
  ownerId: string;
  now?: Date;
  /** 默认带朋友：换电脑继续养需要它；发给别人时调用方传 false。 */
  includeFriends?: boolean;
}): Promise<CharacterExportResult | null> {
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: input.characterId, ownerId: input.ownerId },
    select: {
      id: true,
      originCharacterId: true,
      name: true,
      basePrompt: true,
      styleExamples: true,
      userAddress: true,
      modelConfig: true,
      memorySetting: {
        select: { snapshotIntervalDays: true, timezone: true, autoSnapshotEnabled: true },
      },
      memoryScopes: {
        where: {
          OR: [
            { scopeType: "CHARACTER_GLOBAL" },
            { scopeType: "USER_PRIVATE", userId: input.ownerId },
          ],
        },
        select: {
          scopeType: true,
          userId: true,
          memoryItems: {
            where: { status: "ACTIVE" },
            orderBy: { createdAt: "asc" },
            select: {
              originId: true,
              category: true,
              content: true,
              confidence: true,
              importance: true,
              validFrom: true,
              validTo: true,
              dedupeKey: true,
            },
          },
          events: {
            where: { status: "ACTIVE" },
            orderBy: { occurredAt: "asc" },
            select: {
              originId: true,
              dayKey: true,
              state: true,
              occurredAt: true,
              timeOfDay: true,
              precision: true,
              place: true,
              title: true,
              detail: true,
              keywords: true,
              participants: true,
              confidence: true,
            },
          },
          snapshots: {
            where: { status: "CURRENT" },
            orderBy: { periodEnd: "asc" },
            select: {
              originId: true,
              kind: true,
              periodStart: true,
              periodEnd: true,
              summary: true,
              structuredContent: true,
              generatedAt: true,
              createdAt: true,
            },
          },
          /**
           * 忆泡日历的进度行。日历页读的是这张表而不是从忆泡反推，
           * 所以「忆泡带走、进度行没带走」的结果就是一个空日历。
           * 倒序取再翻回来：撞上限时留下的是最近的日子，而不是五年前那些。
           */
          eventDays: {
            orderBy: { dayKey: "desc" },
            take: CHARACTER_BUNDLE_LIMITS.eventDays,
            select: { dayKey: true, state: true, eventCount: true, extractedAt: true },
          },
        },
      },
      catchphrases: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: { phrase: true, usage: true, enabled: true, source: true },
      },
    },
  });

  if (!character) return null;

  const includeFriends = input.includeFriends !== false;
  const now = input.now ?? new Date();
  const bundle = buildCharacterBundle({
    // 血缘优先取角色行上记着的 origin：本机原生角色还没有，就用它自己的 id ——
    // 这次导出的卡片从此成为「这一份数据」的身份证。
    character: { ...character, originCharacterId: character.originCharacterId ?? character.id },
    memorySetting: character.memorySetting,
    // 查询条件已经排除他人范围，这里再按同一规则筛一次：将来若有人把 where 放宽，
    // 泄出去的是别人的私聊记忆，这种错误不该有第二次机会。
    scopes: character.memoryScopes
      .filter((scope) => scope.scopeType === "CHARACTER_GLOBAL" || scope.userId === input.ownerId)
      .map((scope) => ({
        ...scope,
        // 上面按倒序取了最近的 N 天，包里仍按日期升序排，方便人和 diff 看。
        eventDays: [...scope.eventDays].sort((left, right) => left.dayKey.localeCompare(right.dayKey)),
      })),
    journals: await loadCharacterJournals(input.characterId),
    friends: includeFriends ? await loadCharacterFriends(input.characterId) : [],
    catchphrases: character.catchphrases,
    now,
  });

  await prisma.auditLog.create({
    data: {
      actorType: "USER",
      actorId: input.ownerId,
      characterId: input.characterId,
      action: "character.exported",
      entityType: "Character",
      entityId: input.characterId,
      details: {
        memories: bundle.counts.memories,
        privateMemories: bundle.counts.privateMemories,
        events: bundle.counts.events,
        eventDays: bundle.counts.eventDays,
        snapshots: bundle.counts.snapshots,
        journals: bundle.counts.journals,
        journalRevisions: bundle.counts.journalRevisions,
        catchphrases: bundle.counts.catchphrases,
        friends: bundle.counts.friends,
        friendMemories: bundle.counts.friendMemories,
        friendAliases: bundle.counts.friendAliases,
      },
    },
  }).catch(() => undefined);

  return { bundle, characterName: character.name };
}

/**
 * 日记 / 手账。生成代码只往角色全局范围写（私聊的手账并不存在），所以只查这一份。
 *
 * 版本单独一次查询再按日分组：用嵌套的 `take` 会在「日记改了几十版」的日子里
 * 把同一天的手账挤掉（关系级 take 是加在整个集合上的，不按 kind 分配）。
 * 分组后每种文本各留最新 `journalRevisions` 版，再按版本升序放回包里。
 */
async function loadCharacterJournals(characterId: string): Promise<BundleJournalSource[]> {
  const prisma = getPrisma();
  const journals = await prisma.characterJournal.findMany({
    where: { memoryScope: { is: { characterId, scopeType: "CHARACTER_GLOBAL" } } },
    // 倒序取再翻回来：撞上限时保住最近这些天，而不是三年前那批。
    orderBy: { dayKey: "desc" },
    take: CHARACTER_BUNDLE_LIMITS.journals,
    select: {
      id: true,
      dayKey: true,
      status: true,
      skipReason: true,
      diaryState: true,
      handbookState: true,
      diaryDecidedAt: true,
      handbookDecidedAt: true,
      createdAt: true,
    },
  });
  if (!journals.length) return [];

  const revisions = await prisma.journalRevision.findMany({
    where: { journalId: { in: journals.map((journal) => journal.id) } },
    // 撞上限时优先留最近写的那几版，而不是按 uuid 随机截断。
    orderBy: { createdAt: "desc" },
    take: CHARACTER_BUNDLE_LIMITS.journalRevisionsTotal,
    select: {
      id: true,
      journalId: true,
      kind: true,
      version: true,
      title: true,
      content: true,
      thought: true,
      quote: true,
      tags: true,
      revisionType: true,
      promptVersion: true,
      model: true,
      sourceDiaryRevisionId: true,
      createdAt: true,
    },
  });

  const byJournal = new Map<string, typeof revisions>();
  for (const revision of revisions) {
    const list = byJournal.get(revision.journalId) ?? [];
    list.push(revision);
    byJournal.set(revision.journalId, list);
  }

  // 查询按日期倒序取了最近 N 天，包里翻回升序，方便人和 diff 看。
  const ordered = [...journals].sort((left, right) => left.dayKey.localeCompare(right.dayKey));
  return ordered.map((journal) => {
    const rows = byJournal.get(journal.id) ?? [];
    // 「今日一句」的来源是日记版本的 id；包里只带版本号，导入端才好重映射到新 id。
    const diaryVersionById = new Map(
      rows.filter((row) => row.kind === "DIARY").map((row) => [row.id, row.version] as const),
    );
    const kept: typeof rows = [];
    const keptPerKind = new Map<string, number>();
    for (const row of rows) {
      // 空正文的版本导不出去也导不回来（解析器会拒绝），直接跳过而不是让整张卡白导。
      if (!row.content.trim()) continue;
      const used = keptPerKind.get(row.kind) ?? 0;
      if (used >= CHARACTER_BUNDLE_LIMITS.journalRevisions) continue;
      keptPerKind.set(row.kind, used + 1);
      kept.push(row);
    }
    kept.sort((left, right) => (left.kind === right.kind
      ? left.version - right.version
      : left.kind.localeCompare(right.kind)));
    // 没带走任何一版正文却写着 GENERATED，导入后会变成「有状态、没内容」的一天。
    const stateOf = (kind: string, state: string) => (
      kept.some((row) => row.kind === kind) ? state : (state === "GENERATED" ? "PENDING" : state)
    );
    return {
      dayKey: journal.dayKey,
      status: journal.status,
      skipReason: journal.skipReason,
      diaryState: stateOf("DIARY", journal.diaryState),
      handbookState: stateOf("HANDBOOK", journal.handbookState),
      diaryDecidedAt: journal.diaryDecidedAt,
      handbookDecidedAt: journal.handbookDecidedAt,
      createdAt: journal.createdAt,
      revisions: kept.map((row) => ({
        kind: row.kind,
        version: row.version,
        title: row.title,
        content: row.content,
        thought: row.thought,
        quote: row.quote,
        tags: row.tags,
        revisionType: row.revisionType,
        promptVersion: row.promptVersion,
        model: row.model,
        sourceDiaryVersion: row.sourceDiaryRevisionId
          ? diaryVersionById.get(row.sourceDiaryRevisionId) ?? null
          : null,
        createdAt: row.createdAt,
      })),
    };
  });
}

/**
 * 她的朋友：`interactionCount > 0` 的关系，和「她的朋友」页面同一套口径。
 * 0 次的行是「在群里出现过但没被搭理」的残留，不是朋友，也不该跟着卡走。
 */
async function loadCharacterFriends(characterId: string) {
  const prisma = getPrisma();
  const scopes = await prisma.memoryScope.findMany({
    where: {
      characterId,
      scopeType: "EXTERNAL_IDENTITY",
      externalIdentityId: { not: null },
      interactionCount: { gt: 0 },
    },
    orderBy: [{ lastInteractedAt: "desc" }, { createdAt: "desc" }],
    take: CHARACTER_BUNDLE_LIMITS.friends,
    select: {
      createdAt: true,
      firstSource: true,
      interactionCount: true,
      lastInteractedAt: true,
      /** 她私底下怎么叫这个人。少了它，导入后每个人都会被喊回平台昵称。 */
      aliases: true,
      externalIdentity: {
        select: { platform: true, platformUid: true, displayName: true },
      },
      memoryItems: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.friendMemories,
        select: {
          originId: true,
          category: true,
          content: true,
          confidence: true,
          importance: true,
          validFrom: true,
          validTo: true,
          dedupeKey: true,
        },
      },
      snapshots: {
        where: { status: "CURRENT" },
        orderBy: { periodEnd: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.friendSnapshots,
        select: {
          originId: true,
          kind: true,
          periodStart: true,
          periodEnd: true,
          summary: true,
          structuredContent: true,
          generatedAt: true,
          createdAt: true,
        },
      },
    },
  });

  return scopes.flatMap((scope) => {
    const identity = scope.externalIdentity;
    if (!identity) return [];
    return [{
      platform: identity.platform,
      platformUid: identity.platformUid,
      displayName: identity.displayName,
      aliases: scope.aliases,
      firstSource: scope.firstSource,
      interactionCount: scope.interactionCount,
      lastInteractedAt: scope.lastInteractedAt,
      knownSince: scope.createdAt,
      memoryItems: scope.memoryItems,
      snapshots: scope.snapshots,
    }];
  });
}
const DEFAULT_RAW_MESSAGE_RETENTION_DAYS = 30;

export type CharacterImportAdded = {
  memories: number;
  events: number;
  eventDays: number;
  snapshots: number;
  /** 新建到本机的天数（合并时，已有那一天只追加版本，不计在这里）。 */
  journals: number;
  journalRevisions: number;
  catchphrases: number;
  friends: number;
};

export type CharacterImportResult = {
  characterId: string;
  name: string;
  /** new = 新建了一个角色；merge = 并进了已有角色。 */
  mode: "new" | "merge";
  counts: CharacterBundleCounts;
  /** 实际写进库的条数。新建时等于 counts；合并时是新增量，0 表示「这份卡里没有新东西」。 */
  added: CharacterImportAdded;
};

/** 事务里的 Prisma 客户端。新建与合并共用同一批写入函数，避免两套去重规则长歪。 */
type Tx = Prisma.TransactionClient;

/** 合并去重键：同样的内容再导一次不会多出一条。 */
function mergeKey(prefix: string, payload: string): string {
  return `${prefix}:${createHash("sha1").update(payload).digest("hex")}`.slice(0, 255);
}

function emptyAdded(): CharacterImportAdded {
  return {
    memories: 0,
    events: 0,
    eventDays: 0,
    snapshots: 0,
    journals: 0,
    journalRevisions: 0,
    catchphrases: 0,
    friends: 0,
  };
}

/**
 * 写记忆。
 *
 * 合并时优先按跨设备 `originId` 识别同一条记忆；旧卡没有 originId 时回退到正文去重。
 * 本地已有同一身份的记忆即使正文不同也保留本地版本，避免把分叉改写追加成重复项。
 */
async function insertMemories(
  tx: Tx,
  memoryScopeId: string,
  items: CharacterBundleMemoryBody[],
  existingContents?: Set<string>,
): Promise<number> {
  const rows: Prisma.MemoryItemCreateManyInput[] = [];
  for (const item of items) {
    const content = item.content.trim();
    if (existingContents) {
      const originKey = item.originId ? `origin:${item.originId}` : null;
      if ((originKey && existingContents.has(originKey)) || existingContents.has(`content:${content}`)) continue;
      if (originKey) existingContents.add(originKey);
      existingContents.add(`content:${content}`);
    }
    rows.push({
      memoryScopeId,
      originId: item.originId ?? randomUUID(),
      category: item.category,
      content: item.content,
      confidence: item.confidence,
      importance: item.importance,
      status: "ACTIVE",
      validFrom: item.validFrom ? new Date(item.validFrom) : null,
      validTo: item.validTo ? new Date(item.validTo) : null,
      dedupeKey: item.dedupeKey ?? (existingContents ? mergeKey("merge-memory", content) : null),
    });
  }
  if (!rows.length) return 0;
  const result = await tx.memoryItem.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/**
 * 写忆泡。合并优先使用跨设备 originId；旧卡缺少身份时回退到「日期 + 标题」。
 */
async function insertEvents(
  tx: Tx,
  memoryScopeId: string,
  items: ParsedCharacterBundle["events"],
  existingSignatures?: Set<string>,
): Promise<number> {
  const rows: Prisma.MemoryEventCreateManyInput[] = [];
  for (const item of items) {
    const signature = `event:${item.dayKey}|${item.title.trim()}`;
    const originKey = item.originId ? `origin:${item.originId}` : null;
    if (existingSignatures) {
      if ((originKey && existingSignatures.has(originKey)) || existingSignatures.has(signature)) continue;
      if (originKey) existingSignatures.add(originKey);
      existingSignatures.add(signature);
    }
    rows.push({
      memoryScopeId,
      originId: item.originId ?? randomUUID(),
      dayKey: item.dayKey,
      state: item.state,
      occurredAt: new Date(item.occurredAt),
      timeOfDay: item.timeOfDay,
      precision: item.precision,
      place: item.place,
      title: item.title,
      detail: item.detail,
      keywords: item.keywords,
      participants: item.participants,
      confidence: item.confidence,
      status: "ACTIVE",
      // 原文不随包走：指向不存在的消息比没有来源更糟。
      sourceMessageId: null,
      sourceMessageIds: [],
      sourceSnapshotId: null,
      dedupeKey: existingSignatures ? mergeKey("merge-event", signature) : `imported:${randomUUID()}`,
    });
  }
  if (!rows.length) return 0;
  const result = await tx.memoryEvent.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/**
 * 写忆泡日历：一天一行进度。
 *
 * 两路合流：包里带来的进度行（保住「哪天整理过、整理到哪一刻」），
 * 以及从忆泡反推出来的日子 —— v1 的老卡没有日历段，只补前一路会让那些回忆
 * 「忆泡在、日历上找不到」。反推的条数按导入的忆泡数算，状态记 FINAL：
 * 这些事已经是过去式，没有新原文要再抽了。
 *
 * 合并时本地那天的状态不动（本地已收口就还是收口），只把条数取大、整理时间取晚。
 */
async function insertEventDays(
  tx: Tx,
  memoryScopeId: string,
  items: CharacterBundleEventDay[],
  eventsForScope: ParsedCharacterBundle["events"],
  merge: boolean,
): Promise<number> {
  const byDay = new Map<string, { state: "DRAFT" | "FINAL"; eventCount: number; extractedAt: Date | null }>();
  for (const item of items) {
    byDay.set(item.dayKey, {
      state: item.state,
      eventCount: item.eventCount,
      extractedAt: item.extractedAt ? new Date(item.extractedAt) : null,
    });
  }
  const counted = new Map<string, number>();
  for (const event of eventsForScope) {
    counted.set(event.dayKey, (counted.get(event.dayKey) ?? 0) + 1);
  }
  for (const [dayKey, count] of counted) {
    if (byDay.has(dayKey)) continue;
    byDay.set(dayKey, { state: "FINAL", eventCount: count, extractedAt: null });
  }
  if (!byDay.size) return 0;

  if (!merge) {
    await tx.memoryEventDay.createMany({
      data: [...byDay.entries()].map(([dayKey, day]) => ({
        memoryScopeId,
        dayKey,
        state: day.state,
        eventCount: day.eventCount,
        extractedAt: day.extractedAt,
      })),
    });
    return byDay.size;
  }

  const existing = await tx.memoryEventDay.findMany({
    where: { memoryScopeId, dayKey: { in: [...byDay.keys()] } },
    select: { id: true, dayKey: true, state: true, eventCount: true, extractedAt: true },
  });
  const existingByDay = new Map(existing.map((row) => [row.dayKey, row]));
  let added = 0;
  for (const [dayKey, day] of byDay) {
    const previous = existingByDay.get(dayKey);
    if (!previous) {
      await tx.memoryEventDay.create({
        data: {
          memoryScopeId,
          dayKey,
          state: day.state,
          eventCount: day.eventCount,
          extractedAt: day.extractedAt,
        },
      });
      added += 1;
      continue;
    }
    const eventCount = Math.max(previous.eventCount, day.eventCount);
    const extractedAt = day.extractedAt && (!previous.extractedAt || day.extractedAt > previous.extractedAt)
      ? day.extractedAt
      : previous.extractedAt;
    if (eventCount !== previous.eventCount || extractedAt?.getTime() !== previous.extractedAt?.getTime()) {
      await tx.memoryEventDay.update({
        where: { id: previous.id },
        data: { eventCount, extractedAt },
      });
    }
  }
  return added;
}

/**
 * 写阶段总结。
 *
 * 包里只带 CURRENT 版本，导入后统一记为第 1 版，避免出现「第 3 版但没有 1、2」的断号。
 * 合并优先使用跨设备 originId；旧卡缺少身份时回退到周期起止时间。
 */
async function insertSnapshots(
  tx: Tx,
  memoryScopeId: string,
  items: CharacterBundleSnapshotBody[],
  merge: boolean,
): Promise<number> {
  const seen = new Set<string>();
  const data: Array<{
    snapshotKey: string;
    originId: string;
    memoryScopeId: string;
    kind: "AUTOMATIC" | "MANUAL";
    version: number;
    periodStart: Date;
    periodEnd: Date;
    summary: string;
    structuredContent: unknown;
    status: "CURRENT";
    generatedAt: Date | null;
    createdAt: Date;
  }> = [];

  const existingPeriods = merge
    ? new Set(
      (await tx.memorySnapshot.findMany({
        where: { memoryScopeId },
        select: { originId: true, periodStart: true, periodEnd: true },
      })).flatMap((row) => [`origin:${row.originId}`, `period:${row.periodStart.toISOString()}|${row.periodEnd.toISOString()}`]),
    )
    : null;

  for (const item of items) {
    const period = `${new Date(item.periodStart).toISOString()}|${new Date(item.periodEnd).toISOString()}`;
    const periodKey = `period:${period}`;
    const originKey = item.originId ? `origin:${item.originId}` : null;
    if (existingPeriods) {
      if ((originKey && existingPeriods.has(originKey)) || existingPeriods.has(periodKey)) continue;
      if (originKey) existingPeriods.add(originKey);
      existingPeriods.add(periodKey);
    }
    const key = merge
      ? mergeKey("merge-snapshot", `${memoryScopeId}:${period}`)
      : `imported-snapshot:${memoryScopeId}:${item.periodStart}:${item.periodEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    data.push({
      snapshotKey: key,
      memoryScopeId,
      originId: item.originId ?? randomUUID(),
      kind: item.kind,
      version: 1,
      periodStart: new Date(item.periodStart),
      periodEnd: new Date(item.periodEnd),
      summary: item.summary,
      structuredContent: item.structuredContent,
      status: "CURRENT",
      generatedAt: item.generatedAt ? new Date(item.generatedAt) : null,
      createdAt: new Date(item.createdAt),
    });
  }
  if (!data.length) return 0;
  const result = await tx.memorySnapshot.createMany({ data: data as never, skipDuplicates: true });
  return result.count;
}

/**
 * 写日记 / 手账：主体 + 版本。
 *
 * 新建：版本号原样保留（「第 3 版」在旧机器上就是第 3 版，重编号会让历史对不上），
 * 手账「今日一句」的来源按 `sourceDiaryVersion` 重映射到本机新建的那一版日记。
 *
 * 合并：本地这一天一条都不动，导入的**接在后面**成为新版本 —— 版本号从本地最大值继续排。
 * 内容完全相同的版本跳过，所以同一张卡重复合并只会「没有新内容」，不会堆出一串重复历史。
 */
async function insertJournals(
  tx: Tx,
  memoryScopeId: string,
  items: CharacterBundleJournal[],
  merge: boolean,
): Promise<{ journals: number; revisions: number }> {
  let journals = 0;
  let revisions = 0;

  for (const item of items) {
    const existing = merge
      ? await tx.characterJournal.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId, dayKey: item.dayKey } },
        select: {
          id: true,
          status: true,
          skipReason: true,
          diaryState: true,
          handbookState: true,
          diaryDecidedAt: true,
          handbookDecidedAt: true,
          revisions: { select: { id: true, kind: true, version: true, content: true } },
        },
      })
      : null;

    if (!existing) {
      const journalId = randomUUID();
      await tx.characterJournal.create({
        data: {
          id: journalId,
          memoryScopeId,
          dayKey: item.dayKey,
          status: item.status,
          skipReason: item.skipReason,
          diaryState: item.diaryState,
          handbookState: item.handbookState,
          diaryDecidedAt: item.diaryDecidedAt ? new Date(item.diaryDecidedAt) : null,
          handbookDecidedAt: item.handbookDecidedAt ? new Date(item.handbookDecidedAt) : null,
          ...(item.createdAt ? { createdAt: new Date(item.createdAt) } : {}),
        },
      });
      journals += 1;
      if (!item.revisions.length) continue;

      // 先给每版分配 id，才能在这一批里把「今日一句」指回正确的日记版本。
      const idByVersion = new Map<string, string>();
      for (const revision of item.revisions) {
        idByVersion.set(`${revision.kind}:${revision.version}`, randomUUID());
      }
      await tx.journalRevision.createMany({
        data: item.revisions.map((revision) => ({
          id: idByVersion.get(`${revision.kind}:${revision.version}`) as string,
          journalId,
          kind: revision.kind,
          version: revision.version,
          title: revision.title || null,
          content: revision.content,
          thought: revision.thought || null,
          quote: revision.quote || null,
          tags: revision.tags,
          sourceDiaryRevisionId: revision.sourceDiaryVersion
            ? idByVersion.get(`DIARY:${revision.sourceDiaryVersion}`) ?? null
            : null,
          // 原文与忆泡的 id 都是旧机器上的，带过来只会是死指针。
          sourceMessageIds: [],
          sourceEventIds: [],
          revisionType: revision.revisionType,
          promptVersion: revision.promptVersion,
          model: revision.model,
          editedByUserId: null,
          ...(revision.createdAt ? { createdAt: new Date(revision.createdAt) } : {}),
        })),
      });
      revisions += item.revisions.length;
      continue;
    }

    // ── 合并：本地那天不动，导入的接成新版本 ──
    const maxVersion: Record<string, number> = { DIARY: 0, HANDBOOK: 0 };
    /** `kind|内容` → 已有的版本号：导入版被去重时，用它把「今日一句」指回本地那一版。 */
    const versionByContent = new Map<string, number>();
    const diaryIdByVersion = new Map<number, string>();
    for (const revision of existing.revisions) {
      maxVersion[revision.kind] = Math.max(maxVersion[revision.kind] ?? 0, revision.version);
      versionByContent.set(`${revision.kind}|${revision.content.trim()}`, revision.version);
      if (revision.kind === "DIARY") diaryIdByVersion.set(revision.version, revision.id);
    }

    const imported = [...item.revisions].sort((left, right) => left.version - right.version);
    const importedDiaryByVersion = new Map(
      imported.filter((revision) => revision.kind === "DIARY").map((revision) => [revision.version, revision] as const),
    );
    const rows: Array<{
      id: string;
      kind: "DIARY" | "HANDBOOK";
      version: number;
      sourceDiaryVersion: number | null;
      payload: CharacterBundleJournal["revisions"][number];
    }> = [];
    for (const revision of imported) {
      const content = revision.content.trim();
      const signature = `${revision.kind}|${content}`;
      if (versionByContent.has(signature)) continue;
      const version = (maxVersion[revision.kind] ?? 0) + 1;
      maxVersion[revision.kind] = version;
      versionByContent.set(signature, version);
      const id = randomUUID();
      if (revision.kind === "DIARY") diaryIdByVersion.set(version, id);
      rows.push({ id, kind: revision.kind, version, sourceDiaryVersion: revision.sourceDiaryVersion, payload: revision });
    }

    if (rows.length) {
      await tx.journalRevision.createMany({
        data: rows.map((row) => {
          // 先按「导入时的版本号」找本地对应的那一版；那一版被去重了就顺着内容找回本地原有的版本号。
          let diaryVersion = row.sourceDiaryVersion;
          if (diaryVersion) {
            const importedDiary = importedDiaryByVersion.get(diaryVersion);
            if (importedDiary) {
              diaryVersion = versionByContent.get(`DIARY|${importedDiary.content.trim()}`) ?? diaryVersion;
            }
          }
          const sourceDiaryRevisionId = row.kind === "HANDBOOK" && diaryVersion
            ? diaryIdByVersion.get(diaryVersion) ?? null
            : null;
          return {
            id: row.id,
            journalId: existing.id,
            kind: row.kind,
            version: row.version,
            title: row.payload.title || null,
            content: row.payload.content,
            thought: row.payload.thought || null,
            quote: row.payload.quote || null,
            tags: row.payload.tags,
            sourceDiaryRevisionId,
            sourceMessageIds: [],
            sourceEventIds: [],
            revisionType: row.payload.revisionType,
            promptVersion: row.payload.promptVersion,
            model: row.payload.model,
            editedByUserId: null,
            ...(row.payload.createdAt ? { createdAt: new Date(row.payload.createdAt) } : {}),
          };
        }),
      });
      revisions += rows.length;

      const addedDiary = rows.some((row) => row.kind === "DIARY");
      const addedHandbook = rows.some((row) => row.kind === "HANDBOOK");
      const now = new Date();
      await tx.characterJournal.update({
        where: { id: existing.id },
        data: {
          // 有了新正文，这一天就不再是「写了但没什么可记」。
          status: "ACTIVE",
          skipReason: null,
          diaryState: addedDiary ? "GENERATED" : existing.diaryState,
          handbookState: addedHandbook ? "GENERATED" : existing.handbookState,
          diaryDecidedAt: addedDiary ? now : existing.diaryDecidedAt,
          handbookDecidedAt: addedHandbook ? now : existing.handbookDecidedAt,
        },
      });
    }
  }

  return { journals, revisions };
}

/** 写梗语录。合并时同一句台词只留一条（本地那条的开关与使用次数不动）。 */
async function insertCatchphrases(
  tx: Tx,
  characterId: string,
  items: CharacterBundleCatchphrase[],
  existingPhrases?: Set<string>,
): Promise<number> {
  const rows: Prisma.CharacterCatchphraseCreateManyInput[] = [];
  for (const item of items) {
    const phrase = item.phrase.trim();
    if (existingPhrases) {
      if (existingPhrases.has(phrase)) continue;
      existingPhrases.add(phrase);
    }
    rows.push({
      characterId,
      phrase: item.phrase,
      usage: item.usage,
      enabled: item.enabled,
      status: "ACTIVE",
      source: item.source,
    });
  }
  if (!rows.length) return 0;
  await tx.characterCatchphrase.createMany({ data: rows });
  return rows.length;
}

/** 合并用：读某个范围已有的记忆正文，用来判断「这句话本机已经有了」。 */
async function loadMemoryContents(tx: Tx, memoryScopeId: string): Promise<Set<string>> {
  const rows = await tx.memoryItem.findMany({
    where: { memoryScopeId },
    select: { originId: true, content: true },
  });
  return new Set(rows.flatMap((row) => [`origin:${row.originId}`, `content:${row.content.trim()}`]));
}

/** 合并用：读某个范围已有的忆泡「日期 + 标题」签名。 */
async function loadEventSignatures(tx: Tx, memoryScopeId: string): Promise<Set<string>> {
  const rows = await tx.memoryEvent.findMany({
    where: { memoryScopeId },
    select: { originId: true, dayKey: true, title: true },
  });
  return new Set(rows.flatMap((row) => [`origin:${row.originId}`, `event:${row.dayKey}|${row.title.trim()}`]));
}

/**
 * 导入一张角色卡。
 *
 * 不带 `targetCharacterId` 时**总是新建角色**：不合并、不覆盖、不动已有角色的任何一条数据。
 * 带 `targetCharacterId` 时把它并进那个角色（见 `mergeCharacterCard`），本地内容一律保留。
 *
 * 原文不随包走，所以记忆与忆泡的来源字段一律置空，阶段总结也只留正文 ——
 * 宁可显示「来源不在本机」，也不指到一个别的角色的消息上。
 * 日记/手账同理：只保留正文与版本，`sourceMessageIds` / `sourceEventIds` 清空，
 * 「今日一句」改按版本号重新指向本机新建的那一版日记。
 */
export async function importCharacterCard(input: {
  raw: unknown;
  ownerId: string;
  now?: Date;
  /** 合并目标角色。必须是同一个血缘（卡片 `origin.characterId` 对得上）。 */
  targetCharacterId?: string | null;
}): Promise<CharacterImportResult> {
  const bundle = parseCharacterBundle(input.raw);
  const now = input.now ?? new Date();
  if (input.targetCharacterId) {
    return mergeCharacterCard({ bundle, ownerId: input.ownerId, targetCharacterId: input.targetCharacterId, now });
  }
  return createCharacterFromBundle({ bundle, ownerId: input.ownerId, now });
}

/** 新建角色：整包落库，等价于「另起一份」。 */
async function createCharacterFromBundle(input: {
  bundle: ParsedCharacterBundle;
  ownerId: string;
  now: Date;
}): Promise<CharacterImportResult> {
  const { bundle, ownerId, now } = input;
  const prisma = getPrisma();

  const existing = await prisma.character.findMany({
    where: { ownerId },
    select: { name: true },
  });
  const name = computeImportedCharacterName(
    bundle.character.name,
    existing.map((item) => item.name),
  );

  const characterId = randomUUID();
  const globalScopeId = randomUUID();
  const globalMemories = bundle.memories.filter((item) => item.scope === "character");
  const privateMemories = bundle.memories.filter((item) => item.scope === "private");
  const globalEvents = bundle.events.filter((item) => item.scope === "character");
  const privateEvents = bundle.events.filter((item) => item.scope === "private");
  const globalEventDays = bundle.eventDays.filter((item) => item.scope === "character");
  const privateEventDays = bundle.eventDays.filter((item) => item.scope === "private");
  const globalSnapshots = bundle.snapshots.filter((item) => item.scope === "character");
  const added = emptyAdded();

  /**
   * 超时放宽：一张满配卡要写几千条记忆、几百位朋友（每位几次往返），
   * Prisma 默认 5 秒的交互事务很容易在慢一点的机器上直接回滚。
   * 导入是低频操作，宁可多等，也不要写到一半全部回滚。
   */
  await prisma.$transaction(async (tx) => {
    await tx.character.create({
      data: {
        id: characterId,
        ownerId,
        name,
        avatar: name.slice(0, 1),
        basePrompt: bundle.character.basePrompt || "请补充角色的人设与行为规则。",
        styleExamples: bundle.character.styleExamples,
        userAddress: bundle.character.userAddress || "主人",
        // 导入即用：卡上写着「已暂停」的话，换机器后第一件事是找不到人。
        status: "ACTIVE",
        // 血缘跟过来：这张卡下次再被导出时仍指向最初的 origin，A→B→C 才不会断线。
        originCharacterId: bundle.originId,
        modelConfig: {
          alias: bundle.character.alias || "导入角色",
          description: bundle.character.description,
          avatarTone: bundle.character.avatarTone,
          ...bundle.modelConfig,
        },
        memorySetting: {
          create: {
            snapshotIntervalDays: bundle.memorySetting.snapshotIntervalDays,
            timezone: bundle.memorySetting.timezone,
            // 周期从导入时刻重新起算，不继承旧机器上算好的边界。
            anchorAt: now,
            nextSnapshotAt: null,
            autoSnapshotEnabled: bundle.memorySetting.autoSnapshotEnabled,
            rawMessageRetentionDays: DEFAULT_RAW_MESSAGE_RETENTION_DAYS,
            rawMessageCleanupEnabled: false,
          },
        },
      },
      select: { id: true },
    });

    await tx.memoryScope.create({
      data: {
        id: globalScopeId,
        characterId,
        scopeType: "CHARACTER_GLOBAL",
        scopeKey: `character:${characterId}:global`,
      },
      select: { id: true },
    });

    added.memories += await insertMemories(tx, globalScopeId, globalMemories);
    added.events += await insertEvents(tx, globalScopeId, globalEvents);
    added.snapshots += await insertSnapshots(tx, globalScopeId, globalSnapshots, false);
    added.eventDays += await insertEventDays(tx, globalScopeId, globalEventDays, globalEvents, false);
    const globalJournalStats = await insertJournals(tx, globalScopeId, bundle.journals, false);
    added.journals += globalJournalStats.journals;
    added.journalRevisions += globalJournalStats.revisions;

    if (privateMemories.length || privateEvents.length || privateEventDays.length) {
      const scopeKey = buildUserPrivateScopeKey(characterId, ownerId);
      const privateScope = await tx.memoryScope.create({
        data: {
          characterId,
          scopeType: "USER_PRIVATE",
          scopeKey,
          userId: ownerId,
        },
        select: { id: true },
      });
      added.memories += await insertMemories(tx, privateScope.id, privateMemories);
      added.events += await insertEvents(tx, privateScope.id, privateEvents);
      added.eventDays += await insertEventDays(tx, privateScope.id, privateEventDays, privateEvents, false);
    }

    added.catchphrases += await insertCatchphrases(tx, characterId, bundle.catchphrases);

    // 她的朋友：身份按 (platform, platformUid) 全局唯一，所以是 upsert 而不是新建 ——
    // 这台机器上同一个人可能已经跟另一个角色聊过，不能给他开出第二个身份。
    for (const friend of bundle.friends) {
      const identity = await tx.externalIdentity.upsert({
        where: {
          platform_platformUid: { platform: friend.platform, platformUid: friend.platformUid },
        },
        create: {
          platform: friend.platform,
          platformUid: friend.platformUid,
          displayName: friend.displayName || null,
          status: "UNVERIFIED",
        },
        // 已经存在就不动：昵称以本机 QQ 上看到的为准，验证绑定更不该被一张角色卡改写。
        update: {},
        select: { id: true },
      });

      const friendScope = await tx.memoryScope.create({
        data: {
          characterId,
          scopeType: "EXTERNAL_IDENTITY",
          scopeKey: buildExternalIdentityScopeKey(characterId, friend.platform, friend.platformUid),
          externalIdentityId: identity.id,
          // 备注是「她怎么叫他」，跟着关系走而不是跟着身份走：同一个 QQ 号跟两个角色
          // 聊过，两边叫法可以完全不一样。
          aliases: friend.aliases,
          firstSource: friend.firstSource,
          interactionCount: friend.interactionCount,
          lastInteractedAt: friend.lastInteractedAt ? new Date(friend.lastInteractedAt) : null,
        },
        select: { id: true },
      });
      added.friends += 1;

      added.memories += await insertMemories(tx, friendScope.id, friend.memories);
      added.snapshots += await insertSnapshots(tx, friendScope.id, friend.snapshots, false);
    }

    await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId,
        action: "character.imported",
        entityType: "Character",
        entityId: characterId,
        details: {
          sourceCharacterName: bundle.character.name,
          originCharacterId: bundle.originId,
          bundleVersion: bundle.formatVersion,
          memories: bundle.counts.memories,
          privateMemories: bundle.counts.privateMemories,
          events: bundle.counts.events,
          eventDays: bundle.counts.eventDays,
          snapshots: bundle.counts.snapshots,
          journals: bundle.counts.journals,
          journalRevisions: bundle.counts.journalRevisions,
          catchphrases: bundle.counts.catchphrases,
          friends: bundle.counts.friends,
          friendMemories: bundle.counts.friendMemories,
          friendAliases: bundle.counts.friendAliases,
        },
      },
    });
  }, { timeout: 180_000, maxWait: 15_000 });

  return { characterId, name, mode: "new", counts: bundle.counts, added };
}

/**
 * 把一张卡并进已有角色。
 *
 * 前置条件：卡片带 `origin.characterId`，且目标角色就是「同一个她」——
 * 要么目标自己的 id 就是 origin（同一台机器 / 恢复过整库），要么目标的 `originCharacterId` 是它
 * （从同一份数据导出来过，之后各自长了一段时间）。**不按名字猜**：两张都叫「一只鱼」的卡
 * 是两个不同的人，名字撞上了也不该合并。
 *
 * 冲突口径（用户选定）：**本地保留，导入的追加**。
 *   - 人设、模型参数、记忆设置：完全不动（合并是补数据，不是覆盖设置）
 *   - 记忆 / 忆泡 / 阶段总结 / 梗：按内容去重后追加
 *   - 忆泡日历：本地那天的状态不动，条数取大、整理时间取晚
 *   - 日记 / 手账：本地版本一版都不删，导入的接在最大版本号后面成为新版本
 *   - 朋友：沿用已有关系，只把记忆、总结、互动次数并进去
 */
async function mergeCharacterCard(input: {
  bundle: ParsedCharacterBundle;
  ownerId: string;
  targetCharacterId: string;
  now: Date;
}): Promise<CharacterImportResult> {
  const { bundle, ownerId, targetCharacterId, now } = input;
  const prisma = getPrisma();

  const target = await prisma.character.findFirst({
    where: { id: targetCharacterId, ownerId },
    select: { id: true, name: true, originCharacterId: true },
  });
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: "要合并进去的角色不存在。" });
  }
  if (!bundle.originId) {
    throw createError({
      statusCode: 400,
      statusMessage: "这张角色卡没有来源角色信息（多半是老版本导出的），认不出是不是同一个她。请改用「新建副本」。",
    });
  }
  if (target.id !== bundle.originId && target.originCharacterId !== bundle.originId) {
    throw createError({
      statusCode: 400,
      statusMessage: "这张角色卡和本机这个角色不是同一份数据来的，不能合并。要保留两边就选「新建副本」。",
    });
  }

  const globalMemories = bundle.memories.filter((item) => item.scope === "character");
  const privateMemories = bundle.memories.filter((item) => item.scope === "private");
  const globalEvents = bundle.events.filter((item) => item.scope === "character");
  const privateEvents = bundle.events.filter((item) => item.scope === "private");
  const globalEventDays = bundle.eventDays.filter((item) => item.scope === "character");
  const privateEventDays = bundle.eventDays.filter((item) => item.scope === "private");
  const globalSnapshots = bundle.snapshots.filter((item) => item.scope === "character");
  const added = emptyAdded();

  await prisma.$transaction(async (tx) => {
    // 目标自己没有血缘记录时补上：它以后被导出就能认出更多同源的卡。
    if (!target.originCharacterId) {
      await tx.character.update({
        where: { id: target.id },
        data: { originCharacterId: bundle.originId as string },
      });
    }

    const globalScope = await tx.memoryScope.findFirst({
      where: { characterId: target.id, scopeType: "CHARACTER_GLOBAL" },
      select: { id: true },
    });
    const globalScopeId = globalScope?.id ?? randomUUID();
    if (!globalScope) {
      await tx.memoryScope.create({
        data: {
          id: globalScopeId,
          characterId: target.id,
          scopeType: "CHARACTER_GLOBAL",
          scopeKey: `character:${target.id}:global`,
        },
      });
    }

    added.memories += await insertMemories(
      tx,
      globalScopeId,
      globalMemories,
      await loadMemoryContents(tx, globalScopeId),
    );
    added.events += await insertEvents(
      tx,
      globalScopeId,
      globalEvents,
      await loadEventSignatures(tx, globalScopeId),
    );
    added.snapshots += await insertSnapshots(tx, globalScopeId, globalSnapshots, true);
    added.eventDays += await insertEventDays(tx, globalScopeId, globalEventDays, globalEvents, true);
    const globalJournalStats = await insertJournals(tx, globalScopeId, bundle.journals, true);
    added.journals += globalJournalStats.journals;
    added.journalRevisions += globalJournalStats.revisions;

    if (privateMemories.length || privateEvents.length || privateEventDays.length) {
      const scopeKey = buildUserPrivateScopeKey(target.id, ownerId);
      const privateScope = await tx.memoryScope.upsert({
        where: { scopeKey },
        // 目标角色可能还没有私人范围（没和本用户私聊过）：补一个，别把私人记忆塞进全局。
        create: {
          characterId: target.id,
          scopeType: "USER_PRIVATE",
          scopeKey,
          userId: ownerId,
        },
        update: {},
        select: { id: true },
      });
      added.memories += await insertMemories(
        tx,
        privateScope.id,
        privateMemories,
        await loadMemoryContents(tx, privateScope.id),
      );
      added.events += await insertEvents(
        tx,
        privateScope.id,
        privateEvents,
        await loadEventSignatures(tx, privateScope.id),
      );
      added.eventDays += await insertEventDays(tx, privateScope.id, privateEventDays, privateEvents, true);
    }

    const existingPhrases = new Set(
      (await tx.characterCatchphrase.findMany({
        where: { characterId: target.id },
        select: { phrase: true },
      })).map((row) => row.phrase.trim()),
    );
    added.catchphrases += await insertCatchphrases(tx, target.id, bundle.catchphrases, existingPhrases);

    for (const friend of bundle.friends) {
      const identity = await tx.externalIdentity.upsert({
        where: {
          platform_platformUid: { platform: friend.platform, platformUid: friend.platformUid },
        },
        create: {
          platform: friend.platform,
          platformUid: friend.platformUid,
          displayName: friend.displayName || null,
          status: "UNVERIFIED",
        },
        update: {},
        select: { id: true },
      });

      const existingFriendScope = await tx.memoryScope.findFirst({
        where: {
          characterId: target.id,
          scopeType: "EXTERNAL_IDENTITY",
          externalIdentityId: identity.id,
        },
        select: { id: true, firstSource: true, interactionCount: true, lastInteractedAt: true, aliases: true },
      });

      const friendScopeId = existingFriendScope?.id ?? randomUUID();
      if (existingFriendScope) {
        // 关系本身按「更熟的那一边」对齐：次数取大、最后互动取晚，从哪认识保留本地说法。
        const lastInteractedAt = friend.lastInteractedAt && (
          !existingFriendScope.lastInteractedAt
          || new Date(friend.lastInteractedAt) > existingFriendScope.lastInteractedAt
        )
          ? new Date(friend.lastInteractedAt)
          : existingFriendScope.lastInteractedAt;
        /**
         * 备注取并集，本地在前 —— 她在这台机器上亲手起的叫法最该留住，
         * 导入的叫法只补那些本机没有的。上限（8 个）由 `normalizeFriendAliases` 统一卡。
         */
        const mergedAliases = normalizeFriendAliases([
          ...(existingFriendScope.aliases ?? []),
          ...friend.aliases,
        ]).aliases;
        await tx.memoryScope.update({
          where: { id: existingFriendScope.id },
          data: {
            interactionCount: Math.max(existingFriendScope.interactionCount, friend.interactionCount),
            lastInteractedAt,
            firstSource: existingFriendScope.firstSource ?? friend.firstSource,
            aliases: mergedAliases,
          },
        });
      } else {
        await tx.memoryScope.create({
          data: {
            id: friendScopeId,
            characterId: target.id,
            scopeType: "EXTERNAL_IDENTITY",
            scopeKey: buildExternalIdentityScopeKey(target.id, friend.platform, friend.platformUid),
            externalIdentityId: identity.id,
            aliases: friend.aliases,
            firstSource: friend.firstSource,
            interactionCount: friend.interactionCount,
            lastInteractedAt: friend.lastInteractedAt ? new Date(friend.lastInteractedAt) : null,
          },
        });
        added.friends += 1;
      }

      added.memories += await insertMemories(
        tx,
        friendScopeId,
        friend.memories,
        await loadMemoryContents(tx, friendScopeId),
      );
      added.snapshots += await insertSnapshots(tx, friendScopeId, friend.snapshots, true);
    }

    await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId: target.id,
        action: "character.merged",
        entityType: "Character",
        entityId: target.id,
        details: {
          sourceCharacterName: bundle.character.name,
          originCharacterId: bundle.originId,
          bundleVersion: bundle.formatVersion,
          exportedAt: bundle.exportedAt,
          added,
        },
      },
    });
  }, { timeout: 180_000, maxWait: 15_000 });

  return { characterId: target.id, name: target.name, mode: "merge", counts: bundle.counts, added };
}
