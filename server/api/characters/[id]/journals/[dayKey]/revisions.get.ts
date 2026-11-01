import { createError, getQuery } from "h3";
import { requireJournalCharacter, readJournalDayKey } from "../../../../../utils/journal-api";
import { journalRevisionSelect, toJournalRevisionDto } from "../../../../../utils/journal-dto";

const KINDS = ["DIARY", "HANDBOOK"] as const;

/** 指定文本（日记或手账）的历史版本：新到旧。恢复旧版是复制成新版本，不删新版本。 */
export default defineEventHandler(async (event) => {
  const { characterId, prisma } = await requireJournalCharacter(event);
  const dayKey = readJournalDayKey(event);
  const query = getQuery(event);
  const kindRaw = String(query.kind ?? "").trim().toUpperCase();
  if (!(KINDS as readonly string[]).includes(kindRaw)) {
    throw createError({ statusCode: 400, statusMessage: "kind 必须是 DIARY 或 HANDBOOK。" });
  }

  const journal = await prisma.characterJournal.findFirst({
    where: { dayKey, memoryScope: { is: { characterId, scopeType: "CHARACTER_GLOBAL" } } },
    select: { id: true },
  });
  if (!journal) throw createError({ statusCode: 404, statusMessage: "这一天还没有日记或手账。" });

  const revisions = await prisma.journalRevision.findMany({
    where: { journalId: journal.id, kind: kindRaw as "DIARY" | "HANDBOOK" },
    orderBy: { version: "desc" },
    select: {
      ...journalRevisionSelect,
      sourceDiaryRevision: { select: { version: true } },
    },
  });

  return {
    items: revisions.map((revision) => (
      toJournalRevisionDto(revision, revision.sourceDiaryRevision?.version ?? null)
    )),
  };
});
