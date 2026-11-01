import { createError, readBody } from "h3";
import { requireJournalCharacter, journalGenerationResponse } from "../../../../utils/journal-api";
import {
  generateJournalForDay,
  isJournalDayKey,
  type JournalGenerationTarget,
} from "../../../../utils/journal-service";

const TARGETS = ["DIARY", "HANDBOOK", "BOTH"] as const;

/**
 * 手动写某一天的日记/手账。
 *
 * 和自动任务共用同一份生成逻辑；默认两份都补（只补缺的那份），
 * 已有正文不会覆盖；想换一版要用 `regenerate`。
 */
export default defineEventHandler(async (event) => {
  const { ownerId, characterId, prisma } = await requireJournalCharacter(event);
  const body = await readBody<{ dayKey?: unknown; target?: unknown }>(event).catch(() => null);
  const dayKey = typeof body?.dayKey === "string" ? body.dayKey.trim() : "";
  if (!isJournalDayKey(dayKey)) {
    throw createError({ statusCode: 400, statusMessage: "dayKey 必须是 YYYY-MM-DD。" });
  }
  const targetRaw = typeof body?.target === "string" ? body.target.trim().toUpperCase() : "BOTH";
  if (!(TARGETS as readonly string[]).includes(targetRaw)) {
    throw createError({ statusCode: 400, statusMessage: "target 必须是 DIARY / HANDBOOK / BOTH。" });
  }
  const target = targetRaw as JournalGenerationTarget;

  const outcome = await generateJournalForDay({
    characterId,
    dayKey,
    mode: "manual",
    target,
    actorUserId: ownerId,
  }, prisma);

  if (outcome.status === "created") {
    await prisma.auditLog.create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId,
        action: "journal.generated",
        entityType: "CharacterJournal",
        entityId: outcome.journalId ?? characterId,
        details: {
          dayKey,
          target,
          texts: Object.keys(outcome.created ?? {}),
        },
      },
    });
  }

  return journalGenerationResponse(outcome);
});
