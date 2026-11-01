import { createError, readBody } from "h3";
import { requireJournalCharacter, journalGenerationResponse, readJournalDayKey } from "../../../../../utils/journal-api";
import { generateJournalForDay, type JournalGenerationTarget } from "../../../../../utils/journal-service";

const TARGETS = ["DIARY", "HANDBOOK", "BOTH"] as const;

/**
 * 重写指定文本（默认两份都重写）。
 *
 * 每份各自追加一个新版本，旧版保留；重写日记不会动到手账，
 * 重写手账会引用当前最新那一版日记。
 */
export default defineEventHandler(async (event) => {
  const { ownerId, characterId, prisma } = await requireJournalCharacter(event);
  const dayKey = readJournalDayKey(event);
  const body = await readBody<{ target?: unknown }>(event).catch(() => null);
  const targetRaw = typeof body?.target === "string" ? body.target.trim().toUpperCase() : "BOTH";
  if (!(TARGETS as readonly string[]).includes(targetRaw)) {
    throw createError({ statusCode: 400, statusMessage: "target 必须是 DIARY / HANDBOOK / BOTH。" });
  }
  const target = targetRaw as JournalGenerationTarget;

  const outcome = await generateJournalForDay({
    characterId,
    dayKey,
    mode: "regenerate",
    target,
    actorUserId: ownerId,
  }, prisma);

  if (outcome.status === "created") {
    await prisma.auditLog.create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId,
        action: "journal.regenerated",
        entityType: "CharacterJournal",
        entityId: outcome.journalId ?? characterId,
        details: { dayKey, target, texts: Object.keys(outcome.created ?? {}) },
      },
    });
  }

  return journalGenerationResponse(outcome);
});
