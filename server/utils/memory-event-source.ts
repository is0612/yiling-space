import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { estimateTokens } from "./memory-retrieval";

/** 每次请求的新消息预算；系统提示词、已知事件另计，前文与新消息共享消息总预算。 */
export const EVENT_AI_INPUT_TOKENS = 4_000;
export const EVENT_AI_MESSAGES_PER_REQUEST = 40;
export const EVENT_AI_CONTEXT_TOKENS = 3_000;
export const EVENT_AI_TOTAL_TOKENS = 5_000;
export const EVENT_AI_CONTEXT_MESSAGES = 12;
export const EVENT_NATURAL_GAP_MS = 5 * 60 * 1_000;

/** 正序分块，不取样、不截原文；仅在硬块后仍有消息时，回退到后半段最近的全局停顿。 */
export function splitEventMessagesByBudget<T extends { content: string; occurredAt?: Date }>(
  messages: T[],
  tokenBudget = EVENT_AI_INPUT_TOKENS,
): T[][] {
  const budget = Number.isFinite(tokenBudget)
    ? Math.min(EVENT_AI_INPUT_TOKENS, Math.max(2_000, tokenBudget))
    : EVENT_AI_INPUT_TOKENS;
  // 序列化字段（ID、时间、作者、来源等）也占输入，使用整行的保守估算。
  const costs = messages.map(message => estimateTokens(JSON.stringify(message)));
  const chunks: T[][] = [];
  let start = 0;
  while (start < messages.length) {
    let end = start;
    let tokens = 0;
    while (end < messages.length && end - start < EVENT_AI_MESSAGES_PER_REQUEST) {
      const cost = costs[end]!;
      // 单条超预算仍独立处理，避免静默漏掉证据。
      if (end > start && tokens + cost > budget) break;
      tokens += cost;
      end++;
    }
    if (end < messages.length) {
      const halfway = start + Math.ceil((end - start) / 2);
      for (let boundary = end; boundary >= halfway && boundary > start; boundary--) {
        const previous = messages[boundary - 1]!.occurredAt;
        const next = messages[boundary]!.occurredAt;
        if (previous instanceof Date && next instanceof Date
          && Number.isFinite(previous.getTime()) && Number.isFinite(next.getTime())
          && next.getTime() - previous.getTime() >= EVENT_NATURAL_GAP_MS) {
          end = boundary;
          break;
        }
      }
    }
    chunks.push(messages.slice(start, end));
    start = end;
  }
  return chunks;
}

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
  input: {
    conversationId: string;
    periodStart: Date;
    periodEnd: Date;
    first: { occurredAt: Date; id: string };
    newMessageTokens?: number;
  },
) {
  const newMessageTokens = Number.isFinite(input.newMessageTokens)
    ? input.newMessageTokens!
    : EVENT_AI_INPUT_TOKENS;
  const contextBudget = Math.min(EVENT_AI_CONTEXT_TOKENS, Math.max(1_000, EVENT_AI_TOTAL_TOKENS - newMessageTokens));
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
    take: EVENT_AI_CONTEXT_MESSAGES,
    select: {
      id: true, role: true, eventType: true, content: true, occurredAt: true, metadata: true,
      conversationId: true,
      conversation: { select: { externalConversationId: true } },
    },
  });
  const selected: typeof rows = [];
  let tokens = 0;
  for (const row of rows) {
    const cost = estimateTokens(JSON.stringify(row));
    // 从最近一条向前连续取完整行，遇到装不下的行就停，不跳过或截断。
    if (tokens + cost > contextBudget) break;
    selected.push(row);
    tokens += cost;
  }
  return selected.reverse();
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
