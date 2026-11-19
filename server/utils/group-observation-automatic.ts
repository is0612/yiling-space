import { randomUUID } from "node:crypto";
import { createError } from "h3";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { GROUP_OBSERVATION_SOURCE } from "./group-expression-evidence";
import { GROUP_OBSERVATION_PENDING_LIMIT } from "./expression-habits";
import { observeGroupExpression } from "./group-expression-observation";
import { isSystemBroadcast } from "./system-message";

const minute = 60_000;
const modelInterval = 30 * minute;
const idleInterval = 5 * minute;
const leaseMs = 3 * minute;
const maxAttempts = 3;
const scanLimit = 36;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function roomFilter(characterId?: string): Prisma.ConversationWhereInput {
  return { ...(characterId ? { characterId } : {}), status: "ACTIVE", externalConversationId: { startsWith: "g:" },
    memoryScope: { scopeType: "CHARACTER_GLOBAL", ...(characterId ? { characterId } : {}) },
    channelBinding: { connection: { platform: "qq-onebot" } },
  };
}

export async function setAutomaticGroupObservation(db: PrismaClient, input: { ownerId: string; characterId: string; conversationId: string; enabled: boolean }, now = new Date()) {
  return db.$transaction(async tx => {
    // Same lock order as candidate creation: character, room, then observation state.
    const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "characters" WHERE "id"=${input.characterId}::uuid AND "ownerId"=${input.ownerId}::uuid FOR NO KEY UPDATE`;
    if (!owners.length) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const room = await tx.conversation.findFirst({ where: { id: input.conversationId, ...roomFilter(input.characterId) }, select: { id: true } });
    if (!room) throw createError({ statusCode: 404, statusMessage: "群聊不存在或不属于当前角色。" });
    const existing = await tx.groupObservationProgress.findUnique({ where: { conversationId: room.id } });
    if ((existing?.enabled ?? false) === input.enabled) return { enabled: input.enabled };
    const reset = { enabled: input.enabled, anchorAt: now, runAt: now, cursorIngestKey: null, cursorId: null, leaseToken: null, leaseUntil: null, attempts: 0, lastError: null };
    await tx.groupObservationProgress.upsert({ where: { conversationId: room.id }, create: { conversationId: room.id, ...reset }, update: reset });
    await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId, action: "group_observation.settings", entityType: "Conversation", entityId: room.id, details: { enabled: input.enabled } } });
    return { enabled: input.enabled };
  });
}

type Line = { id: string; role: string; content: string; occurredAt: Date; metadata: unknown; externalMessageId: string | null };
const author = (row: Line) => {
  const value = object(row.metadata).authorOpenId;
  return typeof value === "string" ? value : "";
};
const quote = (row: Line) => object(object(row.metadata).quotedMessage).messageId;
const eligible = (row: Line) => row.role === "USER" && author(row) && row.content.trim() && object(row.metadata).systemBroadcast !== true && !isSystemBroadcast(row.content);
// An explicit quote is stronger than proximity. Without it, require an A → B → A
// exchange with a visible acknowledgment from A; the model still decides whether it supports a habit.
const acknowledgment = /^(?:[\p{P}\p{Z}]*)(?:懂了|明白了|知道了|原来如此|原来是|确实|我理解了|这样就|这样说|怪不得|我明白|我懂了|哦[哦，,。！! ]|好[，,。！! ]|那就)/u;
export function selectAutomaticGroupWindow(conversationId: string, before: readonly Line[], outcome: Line) {
  if (!eligible(outcome)) return null;
  const quotedResponse = quote(outcome);
  const responseAt = quotedResponse ? before.findIndex(line => line.externalMessageId === quotedResponse) : acknowledgment.test(outcome.content.trim()) ? before.length - 1 : -1;
  if (responseAt < 1) return null;
  const response = before[responseAt]!;
  if (!eligible(response) || author(response) === author(outcome) || response.occurredAt >= outcome.occurredAt) return null;
  const quotedOpening = quote(response);
  const openingAt = quotedOpening ? before.findIndex(line => line.externalMessageId === quotedOpening) : responseAt - 1;
  if (openingAt < 0 || openingAt >= responseAt) return null;
  const opening = before[openingAt]!;
  if (!eligible(opening) || author(opening) === author(response) || (!quotedResponse && author(opening) !== author(outcome)) || opening.occurredAt >= response.occurredAt) return null;
  if (before.slice(openingAt).some(line => line.role === "ASSISTANT")) return null;
  return { conversationId, openingId: opening.id, responseId: response.id, outcomeId: outcome.id };
}

export async function processAutomaticGroupObservation(db: PrismaClient, clock = () => new Date()) {
  const now = clock();
  const free = { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] };
  const candidate = await db.groupObservationProgress.findFirst({ where: { enabled: true, runAt: { lte: now }, ...free, conversation: roomFilter() },
    orderBy: [{ runAt: "asc" }, { conversationId: "asc" }], include: { conversation: { select: { characterId: true, character: { select: { ownerId: true, status: true } } } } },
  });
  if (!candidate) return { processed: false };
  const leaseToken = randomUUID();
  const claimed = await db.groupObservationProgress.updateMany({ where: { conversationId: candidate.conversationId, enabled: true, anchorAt: candidate.anchorAt, runAt: candidate.runAt, ...free },
    data: { leaseToken, leaseUntil: new Date(now.getTime() + leaseMs) },
  });
  if (!claimed.count) return { processed: false };
  const { conversationId, conversation: { characterId, character } } = candidate;
  const owned = { conversationId, enabled: true, leaseToken };
  let cursor = { cursorIngestKey: candidate.cursorIngestKey, cursorId: candidate.cursorId };
  let reserved = false;
  let phase = "IDLE";
  let lastError: string | null = null;
  let attempts = 0;
  let interval = idleInterval;
  try {
    if (character.status !== "ACTIVE") { phase = "PAUSED"; return { processed: true, phase }; }
    if (await db.characterExpressionHabit.count({ where: { characterId, sourceType: GROUP_OBSERVATION_SOURCE, status: "PENDING" } }) >= GROUP_OBSERVATION_PENDING_LIMIT) {
      phase = "PENDING_FULL"; interval = modelInterval; return { processed: true, phase };
    }
    const floor = new Date(Math.max(candidate.anchorAt.getTime(), now.getTime() - 24 * 60 * minute));
    const outcomes = await db.$queryRaw<Array<Line & { ingestKey: string }>>`SELECT "id", "role"::text AS "role", "content", "occurredAt", "metadata", "externalMessageId", "ingestedAt"::text AS "ingestKey"
      FROM "messages" WHERE "conversationId"=${conversationId}::uuid AND "ingestedAt">=${floor} AND "ingestedAt"<=${new Date(now.getTime() - 30_000)}
      AND (${cursor.cursorIngestKey}::timestamptz IS NULL OR ("ingestedAt", "id") > (${cursor.cursorIngestKey}::timestamptz, ${cursor.cursorId}::uuid))
      ORDER BY "ingestedAt", "id" LIMIT ${scanLimit}`;
    for (const outcome of outcomes) {
      const nextCursor = { cursorIngestKey: outcome.ingestKey, cursorId: outcome.id };
      const explicitQuote = quote(outcome);
      if (!eligible(outcome) || (!explicitQuote && !acknowledgment.test(outcome.content.trim())) || outcome.occurredAt < candidate.anchorAt) { cursor = nextCursor; continue; }
      const preceding = await db.message.findMany({ where: { conversationId, ingestedAt: { gte: candidate.anchorAt, lte: now }, occurredAt: { gte: new Date(Math.max(candidate.anchorAt.getTime(), outcome.occurredAt.getTime() - 15 * minute)), lt: outcome.occurredAt } },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 11,
      });
      const selection = selectAutomaticGroupWindow(conversationId, preceding.reverse(), outcome);
      if (!selection) { cursor = nextCursor; continue; }
      if (candidate.attempts >= maxAttempts) { cursor = nextCursor; phase = "SKIPPED"; lastError = "ANALYSIS_FAILED"; return { processed: true, phase }; }
      // Persist the scanned prefix and reserve the attempt before I/O. A crashed process
      // can retry the candidate after the reservation window, without re-scanning the prefix.
      const reserveAt = clock();
      const reservation = await db.groupObservationProgress.updateMany({ where: { ...owned, leaseUntil: { gt: reserveAt } },
        data: { ...cursor, attempts: { increment: 1 }, runAt: new Date(reserveAt.getTime() + modelInterval) },
      });
      if (!reservation.count) return { processed: true, phase: "CANCELLED" };
      reserved = true;
      interval = modelInterval;
      try {
        const result = await observeGroupExpression(db, { characterId, ownerId: character.ownerId, body: selection, automatic: { conversationId, leaseToken } });
        cursor = nextCursor;
        phase = result.habit && !result.reused ? "CANDIDATE" : "SKIPPED";
      } catch (error) {
        const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : 0;
        if (status === 409 || status === 422 || status === 404) { cursor = nextCursor; phase = "SKIPPED"; if (status !== 409) interval = idleInterval; }
        else if (status === 429 || status === 503) {
          attempts = candidate.attempts;
          lastError = status === 429 ? "QUOTA_EXCEEDED" : "MODEL_UNAVAILABLE";
          phase = "RETRY_WAIT"; interval = 60 * minute;
        } else {
          attempts = candidate.attempts + 1;
          lastError = "ANALYSIS_FAILED";
          if (attempts >= maxAttempts) { cursor = nextCursor; attempts = 0; phase = "SKIPPED"; }
          else { phase = "RETRY_WAIT"; interval = modelInterval * attempts; }
        }
      }
      return { processed: true, phase };
    }
    return { processed: true, phase };
  } catch {
    phase = "RETRY_WAIT"; lastError = "SCAN_FAILED"; attempts = reserved ? candidate.attempts + 1 : candidate.attempts;
    return { processed: true, phase };
  } finally {
    await db.groupObservationProgress.updateMany({ where: { ...owned, leaseUntil: { gt: clock() } }, data: {
      ...cursor, attempts, lastError, runAt: new Date(clock().getTime() + interval), leaseToken: null, leaseUntil: null,
    } });
  }
}
