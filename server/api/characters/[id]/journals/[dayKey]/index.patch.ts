import { createError, readBody } from "h3";
import { requireJournalCharacter, readJournalDayKey } from "../../../../../utils/journal-api";
import { saveJournalEdit, type JournalTextKind } from "../../../../../utils/journal-service";
import { toJournalRevisionDto } from "../../../../../utils/journal-dto";

const KINDS = ["DIARY", "HANDBOOK"] as const;

/**
 * 人工编辑：只改指定的那一份（DIARY 或 HANDBOOK），新建一个版本。
 *
 * 手账的「一句」必须能在它所引用的日记版本里找到；改完日记后如果对不上，
 * 返回 400 让用户重选或清空，而不是静默保存一句对不上的话。
 */
export default defineEventHandler(async (event) => {
  const { ownerId, characterId, prisma } = await requireJournalCharacter(event);
  const dayKey = readJournalDayKey(event);
  const body = await readBody<{
    kind?: unknown;
    content?: unknown;
    title?: unknown;
    thought?: unknown;
    quote?: unknown;
    tags?: unknown;
  }>(event).catch(() => null);

  const kindRaw = typeof body?.kind === "string" ? body.kind.trim().toUpperCase() : "";
  if (!(KINDS as readonly string[]).includes(kindRaw)) {
    throw createError({ statusCode: 400, statusMessage: "kind 必须是 DIARY 或 HANDBOOK。" });
  }
  const kind = kindRaw as JournalTextKind;
  const content = typeof body?.content === "string" ? body.content : "";
  const tags = Array.isArray(body?.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string")
    : null;

  const result = await saveJournalEdit({
    characterId,
    dayKey,
    kind,
    content,
    title: typeof body?.title === "string" ? body.title : null,
    thought: typeof body?.thought === "string" ? body.thought : null,
    quote: typeof body?.quote === "string" ? body.quote : null,
    tags,
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
      action: "journal.edited",
      entityType: "JournalRevision",
      entityId: result.revision.id,
      details: { dayKey, kind, version: result.revision.version },
    },
  });

  return { ok: true, revision: toJournalRevisionDto(result.revision) };
});
