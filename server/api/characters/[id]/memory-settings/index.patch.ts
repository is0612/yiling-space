import { createError, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
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
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw createError({ statusCode: 400, statusMessage: "归档周期必须为 1–365 天的整数。" });
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

  const settings = await prisma.$transaction(async (tx) => {
    // Ensure a row exists, then lock it before deciding whether an interval change
    // should be immediate or deferred. This serializes settings changes with the
    // scheduler's compare-and-set cursor advance.
    await tx.characterMemorySetting.upsert({
      where: { characterId },
      create: {
        characterId,
        snapshotIntervalDays: 8,
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

    return tx.characterMemorySetting.update({
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
  });

  return {
    snapshotIntervalDays: settings.pendingSnapshotIntervalDays ?? settings.snapshotIntervalDays,
    activeSnapshotIntervalDays: settings.snapshotIntervalDays,
    pendingSnapshotIntervalDays: settings.pendingSnapshotIntervalDays,
    timezone: settings.timezone,
    anchorAt: settings.anchorAt.toISOString(),
    rawMessageRetentionDays: settings.rawMessageRetentionDays ?? 0,
    rawMessageCleanupEnabled: settings.rawMessageCleanupEnabled,
    autoSnapshotEnabled: settings.autoSnapshotEnabled,
    changePolicy: settings.changePolicy,
    nextSnapshotAt: settings.nextSnapshotAt?.toISOString() ?? null,
    updatedAt: settings.updatedAt.toISOString(),
  };
});
