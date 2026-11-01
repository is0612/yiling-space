import { createError, readBody } from "h3";
import { requireJournalCharacter, readJournalDayKey } from "../../../../../utils/journal-api";
import { restoreJournalRevision, type JournalTextKind } from "../../../../../utils/journal-service";
import { toJournalRevisionDto } from "../../../../../utils/journal-dto";

const KINDS = ["DIARY", "HANDBOOK"] as const;

/** 恢复指定文本的某个旧版本：复制成一条新版本，后面的版本仍留在历史里。 */
export default defineEventHandler(async (event) => {
  const { ownerId, characterId, prisma } = await requireJournalCharacter(event);
  const dayKey = readJournalDayKey(event);
  const body = await readBody<{ kind?: unknown; version?: unknown }>(event).catch(() => null);

  const kindRaw = typeof body?.kind === "string" ? body.kind.trim().toUpperCase() : "";
  if (!(KINDS as readonly string[]).includes(kindRaw)) {
    throw createError({ statusCode: 400, statusMessage: "kind 必须是 DIARY 或 HANDBOOK。" });
  }
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1 || version > 10_000) {
    throw createError({ statusCode: 400, statusMessage: "version 必须是正整数。" });
  }

  const result = await restoreJournalRevision({
    characterId,
    dayKey,
    kind: kindRaw as JournalTextKind,
    version,
    actorUserId: ownerId,
  }, prisma);

  if (!result.ok) {
    throw createError({
      statusCode: result.message.includes("还没有") ? 404 : 400,
      statusMessage: result.message,
    });
  }

  await prisma.auditLog.create({
    data: {
      actorType: "USER",
      actorId: ownerId,
      characterId,
      action: "journal.restored",
      entityType: "JournalRevision",
      entityId: result.revision.id,
      details: { dayKey, kind: kindRaw, restoredFrom: version, version: result.revision.version },
    },
  });

  return { ok: true, revision: toJournalRevisionDto(result.revision) };
});
