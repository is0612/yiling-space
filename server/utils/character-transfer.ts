/**
 * 角色卡的读写（导出查询 + 导入落库）。
 *
 * 单独一层的原因：这两段逻辑既要被 HTTP 接口调用，也要能被脚本直接测。
 * 放在 endpoint 里就只能起一个 Nuxt 才能验证「别人的私人记忆不会进包」这种安全属性，
 * 而那正是最该有测试的地方。
 */

import { randomUUID } from "node:crypto";
import {
  CHARACTER_BUNDLE_LIMITS,
  buildCharacterBundle,
  computeImportedCharacterName,
  parseCharacterBundle,
  type CharacterBundle,
  type CharacterBundleCounts,
  type CharacterBundleMemoryBody,
  type CharacterBundleSnapshotBody,
} from "./character-portable";
import { buildExternalIdentityScopeKey } from "./identity-scope";
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
    character,
    memorySetting: character.memorySetting,
    // 查询条件已经排除他人范围，这里再按同一规则筛一次：将来若有人把 where 放宽，
    // 泄出去的是别人的私聊记忆，这种错误不该有第二次机会。
    scopes: character.memoryScopes.filter(
      (scope) => scope.scopeType === "CHARACTER_GLOBAL" || scope.userId === input.ownerId,
    ),
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
        snapshots: bundle.counts.snapshots,
        catchphrases: bundle.counts.catchphrases,
        friends: bundle.counts.friends,
        friendMemories: bundle.counts.friendMemories,
      },
    },
  }).catch(() => undefined);

  return { bundle, characterName: character.name };
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
      externalIdentity: {
        select: { platform: true, platformUid: true, displayName: true },
      },
      memoryItems: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        take: CHARACTER_BUNDLE_LIMITS.friendMemories,
        select: {
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

export type CharacterImportResult = {
  characterId: string;
  name: string;
  counts: CharacterBundleCounts;
};

/**
 * 导入一张角色卡，**总是新建角色**：不合并、不覆盖、不动已有角色的任何一条数据。
 *
 * 原文不随包走，所以记忆与忆泡的来源字段一律置空，阶段总结也只留正文 ——
 * 宁可显示「来源不在本机」，也不指到一个别的角色的消息上。
 */
export async function importCharacterCard(input: {
  raw: unknown;
  ownerId: string;
  now?: Date;
}): Promise<CharacterImportResult> {
  const bundle = parseCharacterBundle(input.raw);
  const prisma = getPrisma();
  const now = input.now ?? new Date();

  const existing = await prisma.character.findMany({
    where: { ownerId: input.ownerId },
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
  const globalSnapshots = bundle.snapshots.filter((item) => item.scope === "character");

  await prisma.$transaction(async (tx) => {
    await tx.character.create({
      data: {
        id: characterId,
        ownerId: input.ownerId,
        name,
        avatar: name.slice(0, 1),
        basePrompt: bundle.character.basePrompt || "请补充角色的人设与行为规则。",
        styleExamples: bundle.character.styleExamples,
        userAddress: bundle.character.userAddress || "主人",
        // 导入即用：卡上写着「已暂停」的话，换机器后第一件事是找不到人。
        status: "ACTIVE",
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

    const createMemories = async (memoryScopeId: string, items: CharacterBundleMemoryBody[]) => {
      if (!items.length) return;
      await tx.memoryItem.createMany({
        data: items.map((item) => ({
          memoryScopeId,
          category: item.category,
          content: item.content,
          confidence: item.confidence,
          importance: item.importance,
          status: "ACTIVE" as const,
          validFrom: item.validFrom ? new Date(item.validFrom) : null,
          validTo: item.validTo ? new Date(item.validTo) : null,
          dedupeKey: item.dedupeKey,
        })),
      });
    };

    const createEvents = async (memoryScopeId: string, items: typeof bundle.events) => {
      if (!items.length) return;
      await tx.memoryEvent.createMany({
        data: items.map((item) => ({
          memoryScopeId,
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
          status: "ACTIVE" as const,
          // 原文不随包走：指向不存在的消息比没有来源更糟。
          sourceMessageId: null,
          sourceMessageIds: [],
          sourceSnapshotId: null,
          dedupeKey: `imported:${randomUUID()}`,
        })),
      });
    };

    const createSnapshots = async (memoryScopeId: string, items: CharacterBundleSnapshotBody[]) => {
      if (!items.length) return;
      const seen = new Set<string>();
      const data: Array<{
        snapshotKey: string;
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
      for (const item of items) {
        const key = `imported-snapshot:${memoryScopeId}:${item.periodStart}:${item.periodEnd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        data.push({
          snapshotKey: key,
          memoryScopeId,
          kind: item.kind,
          // 包里只带当前版本，导入后统一记为第 1 版，避免出现「第 3 版但没有 1、2」的断号。
          version: 1,
          periodStart: new Date(item.periodStart),
          periodEnd: new Date(item.periodEnd),
          summary: item.summary,
          structuredContent: item.structuredContent,
          status: "CURRENT" as const,
          generatedAt: item.generatedAt ? new Date(item.generatedAt) : null,
          createdAt: new Date(item.createdAt),
        });
      }
      if (data.length) await tx.memorySnapshot.createMany({ data: data as never });
    };

    await createMemories(globalScopeId, globalMemories);
    await createEvents(globalScopeId, globalEvents);
    await createSnapshots(globalScopeId, globalSnapshots);

    if (privateMemories.length || privateEvents.length) {
      const scopeKey = buildUserPrivateScopeKey(characterId, input.ownerId);
      const privateScope = await tx.memoryScope.create({
        data: {
          characterId,
          scopeType: "USER_PRIVATE",
          scopeKey,
          userId: input.ownerId,
        },
        select: { id: true },
      });
      await createMemories(privateScope.id, privateMemories);
      await createEvents(privateScope.id, privateEvents);
    }

    if (bundle.catchphrases.length) {
      await tx.characterCatchphrase.createMany({
        data: bundle.catchphrases.map((item) => ({
          characterId,
          phrase: item.phrase,
          usage: item.usage,
          enabled: item.enabled,
          status: "ACTIVE" as const,
          source: item.source,
        })),
      });
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
          firstSource: friend.firstSource,
          interactionCount: friend.interactionCount,
          lastInteractedAt: friend.lastInteractedAt ? new Date(friend.lastInteractedAt) : null,
        },
        select: { id: true },
      });

      await createMemories(friendScope.id, friend.memories);
      await createSnapshots(friendScope.id, friend.snapshots);
    }

    await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId: input.ownerId,
        characterId,
        action: "character.imported",
        entityType: "Character",
        entityId: characterId,
        details: {
          sourceCharacterName: bundle.character.name,
          bundleVersion: bundle.formatVersion,
          memories: bundle.counts.memories,
          privateMemories: bundle.counts.privateMemories,
          events: bundle.counts.events,
          snapshots: bundle.counts.snapshots,
          catchphrases: bundle.counts.catchphrases,
          friends: bundle.counts.friends,
          friendMemories: bundle.counts.friendMemories,
        },
      },
    });
  });

  return { characterId, name, counts: bundle.counts };
}
