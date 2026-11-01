import { createError } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const settings = await prisma.characterMemorySetting.upsert({
    where: { characterId },
    create: {
      characterId,
      snapshotIntervalDays: 8,
      timezone: "Asia/Shanghai",
      anchorAt: new Date(),
      autoSnapshotEnabled: false,
      rawMessageRetentionDays: null,
      rawMessageCleanupEnabled: false,
    },
    update: {},
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
