import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

export const EVENT_AI_CHUNK_SIZE = 120;
export const MAX_EVENT_CHUNKS = 8;
export const EVENT_MESSAGE_BATCH_SIZE = EVENT_AI_CHUNK_SIZE * MAX_EVENT_CHUNKS;

/** Preserve the global chunk boundary; only model requests are split by conversation. */
export function groupEventMessagesByConversation<T extends { conversationId: string }>(messages: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const message of messages) {
    const group = groups.get(message.conversationId) ?? [];
    group.push(message);
    groups.set(message.conversationId, group);
  }
  return [...groups.values()];
}

/** Context never advances the evidence cursor and cannot cross the period or conversation. */
export async function loadEventContextMessages(
  prisma: Pick<PrismaClient, "message">,
  input: { conversationId: string; periodStart: Date; periodEnd: Date; first: { occurredAt: Date; id: string } },
) {
  const rows = await prisma.message.findMany({
    where: {
      conversationId: input.conversationId,
      occurredAt: { gte: input.periodStart, lt: input.periodEnd },
      OR: [
        { occurredAt: { lt: input.first.occurredAt } },
        { occurredAt: input.first.occurredAt, id: { lt: input.first.id } },
      ],
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 6,
    select: {
      id: true, role: true, eventType: true, content: true, occurredAt: true, metadata: true,
      conversationId: true,
      conversation: { select: { externalConversationId: true } },
    },
  });
  return rows.reverse();
}

export type EventExtractionProgress = {
  extractedAt: Date | null;
  extractedMessageId?: string | null;
};

/** Timestamp + id keyset, inclusive for legacy timestamp-only progress. */
export function eventMessageWhere(input: {
  memoryScopeId: string;
  privateOnly: boolean;
  periodStart: Date;
  periodEnd: Date;
  progress: EventExtractionProgress | null;
}): Prisma.MessageWhereInput {
  const { progress, periodStart, periodEnd } = input;
  const hasCursor = progress?.extractedAt && progress.extractedAt >= periodStart && progress.extractedMessageId;
  return {
    conversation: { is: {
      memoryScopeId: input.memoryScopeId,
      ...(input.privateOnly ? { externalConversationId: { startsWith: "c:" } } : {}),
    } },
    occurredAt: { gte: periodStart, lt: periodEnd },
    ...(hasCursor ? {
      OR: [
        { occurredAt: { gt: progress.extractedAt! } },
        { occurredAt: progress.extractedAt!, id: { gt: progress.extractedMessageId! } },
      ],
    } : progress?.extractedAt && progress.extractedAt > periodStart ? {
      occurredAt: { gte: progress.extractedAt, lt: periodEnd },
    } : {}),
  };
}

/** Read the oldest unprocessed evidence, never the newest sample. One lookahead detects backlog. */
export async function loadEventMessageBatch(
  prisma: Pick<PrismaClient, "message">,
  input: Parameters<typeof eventMessageWhere>[0],
) {
  const rows = await prisma.message.findMany({
    where: eventMessageWhere(input),
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: EVENT_MESSAGE_BATCH_SIZE + 1,
    select: {
      id: true, role: true, eventType: true, content: true, occurredAt: true, metadata: true,
      conversationId: true,
      conversation: { select: { externalConversationId: true } },
    },
  });
  return { messages: rows.slice(0, EVENT_MESSAGE_BATCH_SIZE), hasMore: rows.length > EVENT_MESSAGE_BATCH_SIZE };
}
