// `defineEventHandler` 从 h3 显式引入：Nitro 会自动注入，但脚本化测试直接 import 这个
// 处理器时没有那层自动导入（和 `memory-events/extract.post.ts` 的写法保持一致）。
import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { cancelPendingAutoGenerationJobs } from "../../../../utils/memory-auto-generation";
import { getPrisma } from "../../../../utils/prisma";

const allowedRetentionDays = new Set([0, 30, 90, 180]);

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const interval = Number(body.snapshotIntervalDays);
  /**
   * 归档周期 1–8 天（2026-11-03 从 1–365 收紧）。
   *
   * 上限压到 8：周期越长，「她记得的事」和「她读到的阶段总结」之间那段空窗越大，
   * 中间那些原文可能已经被保留期清理掉，总结就成了孤证。8 天也正好是原来那个默认值，
   * 存量角色（库里全是 8）不用迁移数据。
   */
  if (!Number.isInteger(interval) || interval < 1 || interval > 8) {
    throw createError({ statusCode: 400, statusMessage: "归档周期必须为 1–8 天的整数。" });
  }

  if (typeof body.timezone !== "string" || body.timezone.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的时区。" });
  }
  const timezone = body.timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw createError({ statusCode: 400, statusMessage: "不支持该时区。" });
  }

  if (typeof body.autoSnapshotEnabled !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "自动归档开关无效。" });
  }
  const autoSnapshotEnabled = body.autoSnapshotEnabled;

  if (body.changePolicy !== "NEXT_CYCLE" && body.changePolicy !== "IMMEDIATE_RECALC") {
    throw createError({ statusCode: 400, statusMessage: "无效的设置生效策略。" });
  }
  const changePolicy = body.changePolicy as "NEXT_CYCLE" | "IMMEDIATE_RECALC";

  const rawRetention = Number(body.rawMessageRetentionDays);
  if (!Number.isInteger(rawRetention) || !allowedRetentionDays.has(rawRetention)) {
    throw createError({ statusCode: 400, statusMessage: "原始消息保留期限只能选择永久、30、90 或 180 天。" });
  }
  if (typeof body.rawMessageCleanupEnabled !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "请明确确认原始消息自动清理是否已授权。" });
  }
  const rawMessageCleanupEnabled = body.rawMessageCleanupEnabled;
  if (rawRetention === 0 && rawMessageCleanupEnabled) {
    throw createError({ statusCode: 400, statusMessage: "永久保留模式下不能启用原始消息自动清理。" });
  }

  const rawAnchor = typeof body.anchorAt === "string" ? new Date(body.anchorAt) : new Date(Number.NaN);
  if (Number.isNaN(rawAnchor.getTime())) {
    throw createError({ statusCode: 400, statusMessage: "周期启用锚点无效。" });
  }

  const now = new Date();
  const settings = await prisma.$transaction(async (tx) => {
    // Ensure a row exists, then lock it before deciding whether an interval change
    // should be immediate or deferred. This serializes settings changes with the
    // scheduler's compare-and-set cursor advance.
    await tx.characterMemorySetting.upsert({
      where: { characterId },
      create: {
        characterId,
        snapshotIntervalDays: 3,
        timezone,
        anchorAt: rawAnchor,
        nextSnapshotAt: null,
        autoSnapshotEnabled: false,
        rawMessageRetentionDays: null,
        rawMessageCleanupEnabled: false,
      },
      update: {},
    });
    await tx.$queryRaw<Array<{ characterId: string }>>`SELECT "characterId" FROM "character_memory_settings" WHERE "characterId" = ${characterId}::uuid FOR UPDATE`;
    const existing = await tx.characterMemorySetting.findUniqueOrThrow({ where: { characterId } });

    // The UI exposes second-level precision. Ignore sub-second differences from
    // formatting a saved timestamp, but treat an actual anchor or timezone edit
    // as an explicit rebase of the cycle schedule.
    const anchorChanged =
      existing.timezone !== timezone ||
      Math.floor(existing.anchorAt.getTime() / 1000) !== Math.floor(rawAnchor.getTime() / 1000);
    const savedAnchorAt = anchorChanged ? rawAnchor : existing.anchorAt;

    let activeIntervalDays: number;
    let pendingIntervalDays: number | null = null;
    let nextSnapshotAt: Date | null;

    if (!autoSnapshotEnabled) {
      activeIntervalDays = interval;
      nextSnapshotAt = null;
    } else if (
      !existing.autoSnapshotEnabled ||
      anchorChanged ||
      changePolicy === "IMMEDIATE_RECALC"
    ) {
      activeIntervalDays = interval;
      nextSnapshotAt = addDays(savedAnchorAt, interval);
    } else {
      // NEXT_CYCLE keeps the in-flight period's original interval and boundary.
      // Choosing the active interval again cancels an existing pending change.
      activeIntervalDays = existing.snapshotIntervalDays;
      pendingIntervalDays = interval === activeIntervalDays ? null : interval;
      nextSnapshotAt = existing.nextSnapshotAt ?? addDays(existing.anchorAt, existing.snapshotIntervalDays);
    }

    const saved = await tx.characterMemorySetting.update({
      where: { characterId },
      data: {
        snapshotIntervalDays: activeIntervalDays,
        pendingSnapshotIntervalDays: pendingIntervalDays,
        timezone,
        anchorAt: savedAnchorAt,
        nextSnapshotAt,
        autoSnapshotEnabled,
        changePolicy,
        rawMessageRetentionDays: rawRetention === 0 ? null : rawRetention,
        rawMessageCleanupEnabled,
      },
    });

    /**
     * 关掉「自动生成阶段总结与忆泡」时，把已经排队但还没跑的自动任务一起作废。
     *
     * 只把 `nextSnapshotAt` 置空是不够的：那只是停掉调度器的下一次排期，
     * 队列里的 `QUEUED` / `RETRY_WAIT` 任务照样会被 Worker 领走并且跑完 ——
     * 关掉之后页面上还会冒出新的忆泡（见 `memory-auto-generation.ts` 的说明）。
     */
    const cancelled = autoSnapshotEnabled
      ? { count: 0, types: [] as string[] }
      : await cancelPendingAutoGenerationJobs(tx, { characterId, now });

    // 开关本身没有独立的审计入口，这里补一条：以后能回答「什么时候关的、当时清掉了什么」。
    if (!autoSnapshotEnabled) {
      await tx.auditLog.create({
        data: {
          actorType: "USER",
          actorId: ownerId,
          characterId,
          action: "memory.auto_generation_disabled",
          entityType: "Character",
          entityId: characterId,
          details: {
            autoSnapshotEnabled: false,
            cancelledPendingJobs: cancelled.count,
            cancelledJobTypes: cancelled.types,
          },
        },
      });
    }

    return { saved, cancelled };
  });

  return {
    snapshotIntervalDays: settings.saved.pendingSnapshotIntervalDays ?? settings.saved.snapshotIntervalDays,
    activeSnapshotIntervalDays: settings.saved.snapshotIntervalDays,
    pendingSnapshotIntervalDays: settings.saved.pendingSnapshotIntervalDays,
    timezone: settings.saved.timezone,
    anchorAt: settings.saved.anchorAt.toISOString(),
    rawMessageRetentionDays: settings.saved.rawMessageRetentionDays ?? 0,
    rawMessageCleanupEnabled: settings.saved.rawMessageCleanupEnabled,
    autoSnapshotEnabled: settings.saved.autoSnapshotEnabled,
    changePolicy: settings.saved.changePolicy,
    nextSnapshotAt: settings.saved.nextSnapshotAt?.toISOString() ?? null,
    updatedAt: settings.saved.updatedAt.toISOString(),
    /** 这次保存顺带作废了多少条排队中的阶段总结 / 忆泡任务。 */
    cancelledPendingJobs: settings.cancelled.count,
  };
});
