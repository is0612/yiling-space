import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { previewMemoryEvents } from "./memory-events-preview";
import { eventMessageWhere } from "./memory-event-source";
import { notAmbientMessageWhere } from "./group-ambient-memory";
import { resolveDayWindow } from "./memory-event-time";

export function parsePendingMemoryDelete(value: unknown) {
  const body = value as Record<string, unknown> | null;
  const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !["key", "expectedCount", "checkedAt"].includes(key))
    || typeof body.key !== "string" || !new RegExp(`^\\d{4}-\\d{2}-\\d{2}:${uuid}:${uuid}$`, "i").test(body.key)
    || !Number.isSafeInteger(body.expectedCount) || Number(body.expectedCount) < 1
    || typeof body.checkedAt !== "string" || !Number.isFinite(Date.parse(body.checkedAt))) {
    throw createError({ statusCode: 400, statusMessage: "删除范围无效，请刷新预览。" });
  }
  return { key: body.key, expectedCount: Number(body.expectedCount), checkedAt: new Date(body.checkedAt) };
}

/** Delete only the previewed unprocessed originals; derived memories remain intact. */
export async function deletePendingMemoryEvents(prisma: PrismaClient, input: { ownerId: string; characterId: string; body: unknown; now?: Date }) {
  const request = parsePendingMemoryDelete(input.body);
  const now = input.now ?? new Date();
  if (request.checkedAt > now || now.getTime() - request.checkedAt.getTime() > 30 * 60_000) {
    throw createError({ statusCode: 409, statusMessage: "预览已过期，请刷新后再删除。" });
  }
  const [dayKey, scopeId, conversationId] = request.key.split(":") as [string, string, string];
  try {
    return await prisma.$transaction(async tx => {
      const character = await tx.character.findFirst({ where: { id: input.characterId, ownerId: input.ownerId }, select: { id: true } });
      if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
      // Lock this conversation while computing and deleting a frozen message set.
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId}::uuid AND "characterId" = ${input.characterId}::uuid FOR UPDATE`;
      const conversation = await tx.conversation.findFirst({ where: { id: conversationId, characterId: input.characterId, memoryScopeId: scopeId }, select: { id: true } });
      if (!conversation) throw createError({ statusCode: 404, statusMessage: "待整理会话不存在。" });
      const preview = await previewMemoryEvents(tx, { ownerId: input.ownerId, characterId: input.characterId, now });
      if (!preview.rows.some(row => row.key === request.key)) throw createError({ statusCode: 409, statusMessage: "待整理范围已变化，请刷新预览。" });
      const window = resolveDayWindow(dayKey, preview.timeZone);
      // Any active task in the same scope may already hold a copy of these originals.
      const active = await tx.memoryJob.findFirst({ where: { memoryScopeId: scopeId, status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] }, periodStart: { lt: window.end }, periodEnd: { gt: window.start } }, select: { id: true } });
      if (active) throw createError({ statusCode: 409, statusMessage: "该范围有等待或执行中的记忆任务，请先取消或等待完成后刷新。" });
      const day = await tx.memoryEventDay.findUnique({ where: { memoryScopeId_dayKey: { memoryScopeId: scopeId, dayKey } } });
      const base = eventMessageWhere({ memoryScopeId: scopeId, privateOnly: false, periodStart: window.start, periodEnd: window.end, progress: day });
      const scopedWhere: Prisma.MessageWhereInput = { AND: [base, { conversationId, ingestedAt: { lte: request.checkedAt }, occurredAt: { lte: request.checkedAt } }] };
      const where = await notAmbientMessageWhere(tx, scopedWhere);
      const count = await tx.message.count({ where });
      if (count !== request.expectedCount) throw createError({ statusCode: 409, statusMessage: "待整理消息数量已变化，请刷新预览后确认。" });
      const deleted = await tx.message.deleteMany({ where });
      if (deleted.count !== count) throw createError({ statusCode: 409, statusMessage: "消息刚刚发生变化，请刷新。" });
      await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId,
        action: "memory_events.pending_messages_deleted", entityType: "Conversation", entityId: conversationId,
        details: { dayKey, memoryScopeId: scopeId, deletedMessages: deleted.count, previewCheckedAt: request.checkedAt.toISOString(), memoriesPreserved: true } } });
      return { deletedMessages: deleted.count, memoriesPreserved: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw createError({ statusCode: 409, statusMessage: "记忆整理或消息发生变化，请刷新后重试。" });
    }
    throw error;
  }
}
