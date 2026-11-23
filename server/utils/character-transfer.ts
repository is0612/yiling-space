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
  type CharacterBundleChannelPolicy,
  type CharacterBundleCounts,
  type CharacterBundleEventDay,
  type CharacterBundleExpressionHabit,
  type CharacterBundleGoal,
  type CharacterBundleInteractionGuidance,
  type CharacterBundleJournal,
  type CharacterBundleMemoryBody,
  type CharacterBundlePreference,
  type CharacterBundleSnapshotBody,
  type CharacterBundleSticker,
  type CharacterBundleVisualProfile,
  type ParsedCharacterBundle,
} from "./character-portable";
import { buildExternalIdentityScopeKey } from "./identity-scope";
import { normalizeFriendAliases } from "./friend-aliases";
import { buildUserPrivateScopeKey } from "./memory-scope-access";
import { getPrisma } from "./prisma";
import { loadCharacterGrowth, importCharacterGrowth } from "./character-growth-transfer";
import { emptyCharacterGrowthBundle, growthCounts } from "./character-growth-portable";

export type CharacterExportResult = {
  bundle: CharacterBundle;
  characterName: string;
};

/**
 * 聊天范围收口。
 *
 * 库里那一列只是个 VARCHAR（没有 CHECK），理论上可能是空串或历史遗留值；
 * 导入端的白名单只认 ALL / GROUP / PRIVATE，所以导出时就得收口 ——
 * 否则一条脏数据会让整张卡在新机器上「聊天范围无法识别」，一个字段毁掉整次搬家。
 */
function asChatScope(value: string): "ALL" | "GROUP" | "PRIVATE" {
  return value === "GROUP" || value === "PRIVATE" ? value : "ALL";
}

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
        select: {
          snapshotIntervalDays: true,
          timezone: true,
          autoSnapshotEnabled: true,
          // v7：原文保留策略是用户设定，不随卡走就得在新机器上重新想一遍
          rawMessageRetentionDays: true,
          rawMessageCleanupEnabled: true,
        },
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
      /**
       * 互动经验只带 ACTIVE：候选（PENDING）和已否决（REJECTED）是本机的决策现场，
       * 搬过去只会变成一堆要重新处理的待办。
       */
      interactionGuidance: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.interactionGuidance,
        select: { kind: true, content: true, context: true, chatScope: true },
      },
      /** 渠道策略同理，只带生效中的那一条。 */
      channelPolicies: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.channelPolicies,
        select: { kind: true, content: true, chatScope: true },
      },
      /**
       * 表达习惯（v7）：ACTIVE 是她现在的说法，DISABLED 是她**明确关掉过**的说法。
       * 关掉也是选择，带过去不该又变回开着；PENDING / REJECTED 是本机的决策现场，不带。
       */
      expressionHabits: {
        where: { status: { in: ["ACTIVE", "DISABLED"] } },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.expressionHabits,
        select: { kind: true, content: true, context: true, chatScope: true, status: true, reason: true },
      },
      /**
       * 目标（v7）：只排除待确认与否决过的。PAUSED / COMPLETED / ABANDONED 都要带 ——
       * 「她放弃过一个目标」和「她实现过一个目标」都是她经历过的事，不是待办。
       */
      goals: {
        where: { status: { in: ["ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"] } },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.goals,
        select: { kind: true, title: true, description: true, reason: true, status: true },
      },
      /** 口味偏好（v7）：口径同表达习惯。 */
      preferences: {
        where: { status: { in: ["ACTIVE", "DISABLED"] } },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.preferences,
        select: { kind: true, topic: true, reason: true, status: true },
      },
      /**
       * 形象档案（v8）。文字、装扮、版本、参考图清单都带走；图片本体留在 .data 里 ——
       * 包里是纯 JSON，把图 base64 塞进来只会让一张卡几十兆。
       */
      visualProfile: {
        select: {
          coreAppearance: true,
          corePrompt: true,
          negativePrompt: true,
          currentPublishedRevision: true,
          outfits: {
            orderBy: { sortOrder: "asc" },
            take: CHARACTER_BUNDLE_LIMITS.visualOutfits,
            select: { name: true, prompt: true, isDefault: true, sortOrder: true },
          },
          versions: {
            orderBy: { revision: "asc" },
            take: CHARACTER_BUNDLE_LIMITS.visualVersions,
            select: { revision: true, status: true, note: true, snapshot: true, createdAt: true, publishedAt: true },
          },
          assets: {
            orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
            take: CHARACTER_BUNDLE_LIMITS.visualAssets,
            select: { kind: true, label: true, width: true, height: true, sortOrder: true },
          },
        },
      },
      /** 表情包清单（v8）：回收站里的不带，图片不带。 */
      stickers: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.stickers,
        select: { name: true, usage: true, enabled: true, source: true },
      },
    },
  });

  if (!character) return null;

  const includeFriends = input.includeFriends !== false;
  const now = input.now ?? new Date();
  const bundle = buildCharacterBundle({
    // 使用稳定同步根；兼容迁移前的旧行时，空值回退到本机实例 id。
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
    interactionGuidance: character.interactionGuidance.map((item) => ({
      kind: item.kind as CharacterBundleInteractionGuidance["kind"],
      content: item.content,
      context: item.context,
      chatScope: asChatScope(item.chatScope),
    })),
    channelPolicies: character.channelPolicies.map((item) => ({
      kind: item.kind as CharacterBundleChannelPolicy["kind"],
      content: item.content,
      chatScope: "GROUP" as const,
    })),
    expressionHabits: character.expressionHabits.map((item) => ({
      kind: item.kind as CharacterBundleExpressionHabit["kind"],
      content: item.content,
      context: item.context,
      chatScope: asChatScope(item.chatScope),
      status: item.status as CharacterBundleExpressionHabit["status"],
      reason: item.reason,
    })),
    goals: character.goals.map((item) => ({
      kind: item.kind as CharacterBundleGoal["kind"],
      title: item.title,
      description: item.description,
      reason: item.reason,
      status: item.status as CharacterBundleGoal["status"],
    })),
    preferences: character.preferences.map((item) => ({
      kind: item.kind as CharacterBundlePreference["kind"],
      topic: item.topic,
      reason: item.reason,
      status: item.status as CharacterBundlePreference["status"],
    })),
    visualProfile: character.visualProfile,
    stickers: character.stickers,
    now,
  });

  bundle.growth = await loadCharacterGrowth({ characterId: input.characterId, ownerId: input.ownerId, includeFriends,
    eventIds: new Set(bundle.events.filter(row => row.scope === "character").flatMap(row => row.originId ? [row.originId] : [])),
    snapshotIds: new Set(bundle.snapshots.filter(row => row.scope === "character").flatMap(row => row.originId ? [row.originId] : [])),
    friends: bundle.friends,
  });
  bundle.counts.growth = growthCounts(bundle.growth);

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
        interactionGuidance: bundle.counts.interactionGuidance,
        channelPolicies: bundle.counts.channelPolicies,
        expressionHabits: bundle.counts.expressionHabits,
        goals: bundle.counts.goals,
        preferences: bundle.counts.preferences,
        visualOutfits: bundle.counts.visualOutfits,
        visualVersions: bundle.counts.visualVersions,
        visualAssets: bundle.counts.visualAssets,
        stickers: bundle.counts.stickers,
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
  /** 新增的互动经验条数。 */
  interactionGuidance: number;
  /** 新增的渠道行为策略条数。 */
  channelPolicies: number;
  /** 新增的表达习惯条数（v7）。 */
  expressionHabits: number;
  /** 新增的目标条数（v7）。 */
  goals: number;
  /** 新增的偏好条数（v7）。 */
  preferences: number;
  /** 导入的形象档案：写了几套装扮 / 几版历史（v8）。文字本身不算条数。 */
  visualOutfits: number;
  visualVersions: number;
  /** 建成的「缺图」表情包条目数（v8）。 */
  stickers: number;
  growth?: ReturnType<typeof growthCounts>;
};

export type CharacterImportResult = {
  characterId: string;
  name: string;
  /** new = 新建了一个角色；merge = 并进了已有角色。 */
  mode: "new" | "merge";
  counts: CharacterBundleCounts;
  /** 实际写进库的条数。新建时等于 counts；合并时是新增量，0 表示「这份卡里没有新东西」。 */
  added: CharacterImportAdded;
  warnings: string[];
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
    interactionGuidance: 0,
    channelPolicies: 0,
    expressionHabits: 0,
    goals: 0,
    preferences: 0,
    visualOutfits: 0,
    visualVersions: 0,
    stickers: 0,
    growth: growthCounts(emptyCharacterGrowthBundle()),
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
      // 外来 key 属于导出机器的命名空间，不能挤掉本机或同包中不同内容的记忆。
      // 合并幂等由 originId / 正文判断负责；PostgreSQL 允许多个 NULL。
      dedupeKey: null,
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
        // 角色卡不携带本机消息游标；时间变化时必须清掉旧 id，安全重读边界。
        data: { eventCount, extractedAt, extractedMessageId: null },
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

/**
 * 导入时给条目盖的来源。
 *
 * 真实的 sourceRefs 指向本机的教育证据（哪句话、哪个群、谁授权的），换台机器全是悬空 id。
 * 这里盖一个自解释的标记，页面和排查都能看出「这条是从角色卡搬来的」。
 * 长度必须在 1–30 之间（数据库有 CHECK），所以永远是单个元素。
 */
function characterCardSource(importedAt: Date): Prisma.InputJsonValue {
  return [{ version: 1, type: "characterCard", importedAt: importedAt.toISOString() }];
}

const IMPORTED_GUIDANCE_REASON = "从角色卡导入的互动经验；原始教育来源没有随卡转移。";
const IMPORTED_POLICY_SOURCE = [{ version: 1, type: "characterCard" }];

/**
 * 写互动经验。
 *
 * 直接落 ACTIVE：包里带的本来就是主人已经采纳的条目，导入再走一遍「待确认」
 * 等于让用户把审批重做一遍。`revision` 从 1 开始并补一条 CREATE 历史，
 * 否则后面第一次编辑会出现「版本 2 但没有版本 1」的断链。
 */
async function insertInteractionGuidance(
  tx: Tx,
  characterId: string,
  items: CharacterBundleInteractionGuidance[],
  actorId: string,
  existingGuidance?: Set<string>,
): Promise<number> {
  let added = 0;
  const importedAt = new Date();
  for (const item of items) {
    const key = `${item.kind}|${item.chatScope}|${item.content}`;
    if (existingGuidance) {
      if (existingGuidance.has(key)) continue;
      existingGuidance.add(key);
    }
    const row = await tx.characterInteractionGuidance.create({
      data: {
        characterId,
        kind: item.kind,
        content: item.content,
        context: item.context,
        chatScope: item.chatScope,
        status: "ACTIVE",
        revision: 1,
        sourceRefs: characterCardSource(importedAt),
        reason: IMPORTED_GUIDANCE_REASON,
      },
    });
    await tx.characterInteractionGuidanceRevision.create({
      data: {
        guidanceId: row.id,
        revision: 1,
        action: "CREATE",
        kind: row.kind,
        content: row.content,
        context: row.context,
        chatScope: row.chatScope,
        status: row.status,
        sourceRefs: row.sourceRefs as Prisma.InputJsonValue,
        reason: row.reason,
        actorId,
      },
    });
    added += 1;
  }
  return added;
}

/**
 * 写渠道行为策略。
 *
 * 内容用程序里的常量而不是包里的字符串：这张表的 CHECK 约束认的就是那一句，
 * 跨版本带来一句改过措辞的文本只会让整张卡导不进来。
 */
async function insertChannelPolicies(
  tx: Tx,
  characterId: string,
  items: CharacterBundleChannelPolicy[],
  actorId: string,
  existingKinds?: Set<string>,
): Promise<number> {
  let added = 0;
  for (const item of items) {
    if (existingKinds) {
      if (existingKinds.has(item.kind)) continue;
      existingKinds.add(item.kind);
    }
    const row = await tx.channelBehaviorPolicy.create({
      data: {
        characterId,
        kind: "GROUP_AT_DISABLED",
        content: "被动群聊回复不发送 @ 提醒，引用仍保留。",
        chatScope: "GROUP",
        status: "ACTIVE",
        revision: 1,
        sourceRefs: IMPORTED_POLICY_SOURCE as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.channelBehaviorPolicyRevision.create({
      data: {
        policyId: row.id,
        revision: 1,
        action: "CREATE",
        kind: row.kind,
        content: row.content,
        chatScope: row.chatScope,
        status: row.status,
        sourceRefs: row.sourceRefs as Prisma.InputJsonValue,
        actorId,
      },
    });
    added += 1;
  }
  return added;
}

/**
 * 写表达习惯 / 目标 / 偏好（v7）。
 *
 * 与互动经验同一套口径：包里带的都是她自己已经在用的条目，导入直接落原状态
 * （ACTIVE / DISABLED / PAUSED / COMPLETED …），不再让用户把确认重做一遍；
 * `revision` 从 1 开始并补一条 CREATE 历史，否则第一次编辑会出现「版本 2 但没有版本 1」的断链。
 *
 * 本机的历史版本不跟卡走：revision 表记的是「谁在什么时候改的」，
 * 跨机器复制那些行等于伪造审计。所以这里只补自己这一条 CREATE。
 */
async function insertExpressionHabits(
  tx: Tx,
  characterId: string,
  items: CharacterBundleExpressionHabit[],
  actorId: string,
  existingKeys?: Set<string>,
): Promise<number> {
  let added = 0;
  const importedAt = new Date();
  for (const item of items) {
    const key = `${item.kind}|${item.content}`;
    if (existingKeys) {
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
    }
    const row = await tx.characterExpressionHabit.create({
      data: {
        characterId,
        kind: item.kind,
        content: item.content,
        context: item.context,
        chatScope: item.chatScope,
        status: item.status,
        revision: 1,
        // 库里的 CHECK 只认 MANUAL（来源为空）和 SOURCES（1–5 条）：带来源就必须声明 SOURCES
        sourceType: "SOURCES",
        sourceRefs: characterCardSource(importedAt),
        reason: item.reason || IMPORTED_GUIDANCE_REASON,
      },
    });
    await tx.characterExpressionHabitRevision.create({
      data: {
        habitId: row.id,
        revision: 1,
        action: "CREATE",
        kind: row.kind,
        content: row.content,
        context: row.context,
        chatScope: row.chatScope,
        status: row.status,
        sourceType: "SOURCES",
        sourceRefs: row.sourceRefs as Prisma.InputJsonValue,
        reason: row.reason,
        actorId,
      },
    });
    added += 1;
  }
  return added;
}

async function insertGoals(
  tx: Tx,
  characterId: string,
  items: CharacterBundleGoal[],
  actorId: string,
  existingKeys?: Set<string>,
): Promise<number> {
  let added = 0;
  const importedAt = new Date();
  for (const item of items) {
    const key = `${item.kind}|${item.title}`;
    if (existingKeys) {
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
    }
    const row = await tx.characterGoal.create({
      data: {
        characterId,
        kind: item.kind,
        title: item.title,
        description: item.description,
        reason: item.reason,
        status: item.status,
        revision: 1,
        sourceType: "SOURCES",
        sourceRefs: characterCardSource(importedAt),
      },
    });
    await tx.characterGoalRevision.create({
      data: {
        goalId: row.id,
        revision: 1,
        action: "CREATE",
        kind: row.kind,
        title: row.title,
        description: row.description,
        reason: row.reason,
        status: row.status,
        sourceType: "SOURCES",
        sourceRefs: row.sourceRefs as Prisma.InputJsonValue,
        actorId,
      },
    });
    added += 1;
  }
  return added;
}

async function insertPreferences(
  tx: Tx,
  characterId: string,
  items: CharacterBundlePreference[],
  actorId: string,
  existingKeys?: Set<string>,
): Promise<number> {
  let added = 0;
  const importedAt = new Date();
  for (const item of items) {
    const key = `${item.kind}|${item.topic}`;
    if (existingKeys) {
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
    }
    const row = await tx.characterPreference.create({
      data: {
        characterId,
        kind: item.kind,
        topic: item.topic,
        reason: item.reason,
        status: item.status,
        revision: 1,
        sourceType: "SOURCES",
        sourceRefs: characterCardSource(importedAt),
      },
    });
    await tx.characterPreferenceRevision.create({
      data: {
        preferenceId: row.id,
        revision: 1,
        action: "CREATE",
        kind: row.kind,
        topic: row.topic,
        reason: row.reason,
        status: row.status,
        sourceType: "SOURCES",
        sourceRefs: row.sourceRefs as Prisma.InputJsonValue,
        actorId,
      },
    });
    added += 1;
  }
  return added;
}

/**
 * 写形象档案（v8）。
 *
 * 只写「文字 + 装扮 + 版本记录」：参考图清单里的图**没有跟着卡走**，所以一张素材行都不建。
 * 建一行 `relativePath` 为空的素材，页面上就是一张永远加载失败的图 —— 那比一句
 * 「照清单重新上传」更让人困惑。
 *
 * 版本快照在包里已经剥掉素材 id 与磁盘路径，这里原样写入即可；它只用于「回看当时长什么样」，
 * 不会被当作参考图去读。
 */
async function insertVisualProfile(
  tx: Tx,
  characterId: string,
  profile: CharacterBundleVisualProfile | null,
  added: CharacterImportAdded,
): Promise<void> {
  if (!profile) return;
  const created = await tx.characterVisualProfile.create({
    data: {
      characterId,
      coreAppearance: profile.coreAppearance,
      corePrompt: profile.corePrompt,
      negativePrompt: profile.negativePrompt,
      // 只有包里真的有那一版，才把它标成「当前正式版本」（parse 已经收口过）。
      currentPublishedRevision: profile.currentPublishedRevision,
    },
    select: { id: true },
  });
  if (profile.outfits.length) {
    await tx.characterVisualOutfit.createMany({
      data: profile.outfits.map(outfit => ({
        profileId: created.id,
        name: outfit.name,
        prompt: outfit.prompt,
        isDefault: outfit.isDefault,
        sortOrder: outfit.sortOrder,
      })),
    });
    added.visualOutfits += profile.outfits.length;
  }
  if (profile.versions.length) {
    await tx.characterVisualVersion.createMany({
      data: profile.versions.map(version => ({
        profileId: created.id,
        revision: version.revision,
        status: version.status,
        note: version.note,
        snapshot: version.snapshot as Prisma.InputJsonValue,
        createdAt: version.createdAt ? new Date(version.createdAt) : new Date(),
        publishedAt: version.publishedAt ? new Date(version.publishedAt) : null,
      })),
    });
    added.visualVersions += profile.versions.length;
  }
}

/**
 * 把形象档案并进已有角色。
 *
 * 和设置同一个口径：**本地保留，导入的只补空缺**。
 *   - 文字（形象描述 / 提示词 / 负面提示）：本地已有就一个字都不动 —— 那是刚调好的东西
 *   - 装扮：按名字补缺，同名的保留本地那套
 *   - 版本历史：不合并。它是「这台机器上发布过哪几版」的账，两边的修订号会撞，
 *     混在一起就再也说不清哪一版是哪一版；导入的版本只在「新建角色」那条路上落库
 */
async function mergeVisualProfile(
  tx: Tx,
  characterId: string,
  profile: CharacterBundleVisualProfile | null,
  added: CharacterImportAdded,
  warnings: string[],
): Promise<void> {
  if (!profile) return;
  const local = await tx.characterVisualProfile.findUnique({
    where: { characterId },
    select: { id: true, outfits: { select: { name: true } } },
  });
  if (!local) {
    await insertVisualProfile(tx, characterId, profile, added);
    return;
  }
  if (profile.versions.length) {
    warnings.push("本机已有形象档案，导入的版本历史没有合并（两边的版本号会撞）；形象文字与装扮按本地保留、缺的补上。");
  }
  const existing = new Set(local.outfits.map(outfit => outfit.name));
  const missing = profile.outfits.filter(outfit => !existing.has(outfit.name));
  if (!missing.length) return;
  await tx.characterVisualOutfit.createMany({
    data: missing.map(outfit => ({
      profileId: local.id,
      name: outfit.name,
      prompt: outfit.prompt,
      // 一个角色只能有一套默认装扮，本地已经有一套了就别再抢这个位置。
      isDefault: false,
      sortOrder: outfit.sortOrder,
    })),
  });
  added.visualOutfits += missing.length;
}

/**
 * 写表情包清单（v8）。
 *
 * 一律建成「缺图」条目：`fileName` 空、`sizeBytes` 0、**默认停用**。
 * 停用不是小气 —— 缺图的条目一旦进入选图，她发出去就是一条发送失败，
 * 主人还看不出为什么。名字和用途留下，补上图之后自己打开就行。
 */
async function insertStickerPlaceholders(
  tx: Tx,
  characterId: string,
  stickers: CharacterBundleSticker[],
  added: CharacterImportAdded,
): Promise<void> {
  if (!stickers.length) return;
  const existing = await tx.characterSticker.findMany({
    where: { characterId, deletedAt: null },
    select: { name: true },
  });
  // 库里名字没有唯一约束，但同一份卡导两次不该多出一批一模一样的空条目。
  const taken = new Set(existing.map(item => item.name));
  const rows = stickers
    .filter(item => !taken.has(item.name))
    .map(item => ({
      characterId,
      name: item.name,
      usage: item.usage,
      fileName: "",
      mimeType: "",
      sizeBytes: 0,
      enabled: false,
      source: item.source,
    }));
  if (!rows.length) return;
  await tx.characterSticker.createMany({ data: rows });
  added.stickers += rows.length;
}

/** 合并用：读某个范围已有的记忆正文，用来判断「这句话本机已经有了」。 */async function loadMemoryContents(tx: Tx, memoryScopeId: string): Promise<Set<string>> {
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
  /** 合并目标角色。必须与卡片的稳定同步根 ID 一致。 */
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
  const privateSnapshots = bundle.snapshots.filter((item) => item.scope === "private");
  const added = emptyAdded();
  const warnings: string[] = [];

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
        // 带 origin 的卡继承原同步根；老卡没有 origin 时，以新实例自己的 ID 建立独立同步根。
        originCharacterId: bundle.originId ?? characterId,
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
            // 原文保留策略是用户设定（v7 起随卡走）。`parse` 已经把「老卡没这一格」收口成 30 天，
            // 这里的 null 是用户明确选的「永久保留」，不能再兜成默认值。
            rawMessageRetentionDays: bundle.memorySetting.rawMessageRetentionDays === undefined
              ? DEFAULT_RAW_MESSAGE_RETENTION_DAYS
              : bundle.memorySetting.rawMessageRetentionDays,
            rawMessageCleanupEnabled: bundle.memorySetting.rawMessageCleanupEnabled === true,
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

    if (privateMemories.length || privateEvents.length || privateEventDays.length || privateSnapshots.length) {
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
      added.snapshots += await insertSnapshots(tx, privateScope.id, privateSnapshots, false);
      added.eventDays += await insertEventDays(tx, privateScope.id, privateEventDays, privateEvents, false);
    }

    added.catchphrases += await insertCatchphrases(tx, characterId, bundle.catchphrases);
    added.interactionGuidance += await insertInteractionGuidance(
      tx,
      characterId,
      bundle.interactionGuidance,
      ownerId,
    );
    added.channelPolicies += await insertChannelPolicies(tx, characterId, bundle.channelPolicies, ownerId);
    added.expressionHabits += await insertExpressionHabits(tx, characterId, bundle.expressionHabits, ownerId);
    added.goals += await insertGoals(tx, characterId, bundle.goals, ownerId);
    added.preferences += await insertPreferences(tx, characterId, bundle.preferences, ownerId);
    await insertVisualProfile(tx, characterId, bundle.visualProfile, added);
    await insertStickerPlaceholders(tx, characterId, bundle.stickers, added);
    /**
     * 这两句提示必须给：形象档案看起来「导进来了」（文字和装扮都在），
     * 但参考图其实还在旧机器上；表情包则是一批缺图的空壳。
     * 不说清楚，主人会以为搬家完成，直到她画不出图、发不出表情才发现。
     */
    const assetCount = bundle.visualProfile?.assets.length ?? 0;
    if (assetCount > 0) {
      warnings.push(`形象档案按清单带了 ${assetCount} 张参考图的名称与用途，图片本身不随卡走，到「形象档案」重新上传后才会生效。`);
    }
    if (added.stickers > 0) {
      warnings.push(`表情包带了 ${added.stickers} 个名字与用途，图片不随卡走，已先停用；补图后再打开。`);
    }

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

    const growthResult = await importCharacterGrowth(tx, { characterId, ownerId, bundle: bundle.growth, mode: "new", friends: bundle.friends });
    added.growth = growthResult.added;
    warnings.push(...growthResult.warnings);

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
          interactionGuidance: bundle.counts.interactionGuidance,
          channelPolicies: bundle.counts.channelPolicies,
          expressionHabits: bundle.counts.expressionHabits,
          goals: bundle.counts.goals,
          preferences: bundle.counts.preferences,
          visualOutfits: bundle.counts.visualOutfits,
          visualVersions: bundle.counts.visualVersions,
          visualAssets: bundle.counts.visualAssets,
          stickers: bundle.counts.stickers,
        },
      },
    });
  }, { timeout: 180_000, maxWait: 15_000 });

  return { characterId, name, mode: "new", counts: bundle.counts, added, warnings };
}

/**
 * 把一张卡并进已有角色。
 *
 * 前置条件：卡片带 `origin.characterId`，且目标角色的同步根与之相同——
 * 目标自己的 id 就是根（根实例），或目标的 `originCharacterId` 就是该根（导入副本）。
 * 同一个根可以对应多个本地实例，因此调用方必须明确指定目标。**不按名字猜**：两张都叫「一只鱼」的卡
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
  const privateSnapshots = bundle.snapshots.filter((item) => item.scope === "private");
  const added = emptyAdded();
  const warnings: string[] = [];

  await prisma.$transaction(async (tx) => {
    // 兼容迁移前创建的原生角色：若它本身就是同步根，补齐为自己的实例 ID。
    // 正常迁移后此分支不再触发；绝不能把已有的非空同步根改写掉。
    if (!target.originCharacterId && target.id === bundle.originId) {
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

    if (privateMemories.length || privateEvents.length || privateEventDays.length || privateSnapshots.length) {
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
      added.snapshots += await insertSnapshots(tx, privateScope.id, privateSnapshots, true);
      added.eventDays += await insertEventDays(tx, privateScope.id, privateEventDays, privateEvents, true);
    }

    const existingPhrases = new Set(
      (await tx.characterCatchphrase.findMany({
        where: { characterId: target.id },
        select: { phrase: true },
      })).map((row) => row.phrase.trim()),
    );
    added.catchphrases += await insertCatchphrases(tx, target.id, bundle.catchphrases, existingPhrases);

    /**
     * 互动经验 / 渠道策略的合并去重按「内容」而不是按 id：
     * 同一个角色在两台机器上各自被教过，内容相同就是同一条，不必出现两份。
     */
    const existingGuidance = new Set(
      (await tx.characterInteractionGuidance.findMany({
        where: { characterId: target.id },
        select: { kind: true, chatScope: true, content: true },
      })).map((row) => `${row.kind}|${row.chatScope}|${row.content}`),
    );
    added.interactionGuidance += await insertInteractionGuidance(
      tx,
      target.id,
      bundle.interactionGuidance,
      ownerId,
      existingGuidance,
    );

    const existingPolicyKinds = new Set(
      (await tx.channelBehaviorPolicy.findMany({
        where: { characterId: target.id },
        select: { kind: true },
      })).map((row) => row.kind),
    );
    added.channelPolicies += await insertChannelPolicies(
      tx,
      target.id,
      bundle.channelPolicies,
      ownerId,
      existingPolicyKinds,
    );

    /**
     * 表达习惯 / 目标 / 偏好的合并去重同样按「内容」：同一台机器上她自己已经有一条
     * 「说话带点气声」，再导一次不该变成两条。目标按 kind+标题、偏好按 kind+主题。
     */
    const existingHabits = new Set(
      (await tx.characterExpressionHabit.findMany({
        where: { characterId: target.id },
        select: { kind: true, content: true },
      })).map((row) => `${row.kind}|${row.content}`),
    );
    added.expressionHabits += await insertExpressionHabits(
      tx,
      target.id,
      bundle.expressionHabits,
      ownerId,
      existingHabits,
    );

    const existingGoals = new Set(
      (await tx.characterGoal.findMany({
        where: { characterId: target.id },
        select: { kind: true, title: true },
      })).map((row) => `${row.kind}|${row.title}`),
    );
    added.goals += await insertGoals(tx, target.id, bundle.goals, ownerId, existingGoals);

    const existingPreferences = new Set(
      (await tx.characterPreference.findMany({
        where: { characterId: target.id },
        select: { kind: true, topic: true },
      })).map((row) => `${row.kind}|${row.topic}`),
    );
    added.preferences += await insertPreferences(
      tx,
      target.id,
      bundle.preferences,
      ownerId,
      existingPreferences,
    );
    await mergeVisualProfile(tx, target.id, bundle.visualProfile, added, warnings);
    await insertStickerPlaceholders(tx, target.id, bundle.stickers, added);
    const mergedAssets = bundle.visualProfile?.assets.length ?? 0;
    if (mergedAssets > 0) {
      warnings.push(`形象档案按清单带了 ${mergedAssets} 张参考图的名称与用途，图片本身不随卡走，需要重新上传。`);
    }
    if (added.stickers > 0) {
      warnings.push(`表情包带了 ${added.stickers} 个名字与用途，图片不随卡走，已先停用；补图后再打开。`);
    }

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

    const growthResult = await importCharacterGrowth(tx, { characterId: target.id, ownerId, bundle: bundle.growth, mode: "merge", friends: bundle.friends });
    added.growth = growthResult.added;
    warnings.push(...growthResult.warnings);

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

  return { characterId: target.id, name: target.name, mode: "merge", counts: bundle.counts, added, warnings };
}
