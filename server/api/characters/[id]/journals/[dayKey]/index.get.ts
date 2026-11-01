import { createError } from "h3";
import { requireJournalCharacter, readJournalDayKey } from "../../../../../utils/journal-api";
import { journalRevisionSelect, toJournalDetailDto, type JournalShape } from "../../../../../utils/journal-dto";

/** 某一天的两份文本：最新一版日记 + 最新一版手账，以及各自的版本数。 */
export default defineEventHandler(async (event) => {
  const { characterId, prisma } = await requireJournalCharacter(event);
  const dayKey = readJournalDayKey(event);

  const journal = await prisma.characterJournal.findFirst({
    where: { dayKey, memoryScope: { is: { characterId, scopeType: "CHARACTER_GLOBAL" } } },
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
      updatedAt: true,
      revisions: {
        orderBy: { version: "desc" },
        select: {
          ...journalRevisionSelect,
          sourceDiaryRevision: { select: { version: true } },
        },
      },
    },
  });
  if (!journal) throw createError({ statusCode: 404, statusMessage: "这一天还没有日记或手账。" });

  const revisions = journal.revisions;
  const handbook = revisions
    .filter((revision) => revision.kind === "HANDBOOK")
    .sort((left, right) => right.version - left.version)[0];

  return toJournalDetailDto(journal as unknown as JournalShape, {
    diaryCount: revisions.filter((revision) => revision.kind === "DIARY").length,
    handbookCount: revisions.filter((revision) => revision.kind === "HANDBOOK").length,
    diarySourceVersion: handbook?.sourceDiaryRevision?.version ?? null,
  });
});
