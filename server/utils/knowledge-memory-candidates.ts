import { createHash } from "node:crypto";
import { createError } from "h3";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { publishGrowthEvent } from "./growth-event-center";
import { readPublicMemoryKnowledgeSource } from "./growth-domain-gateway";

export function memoryKnowledgeSourceHash(source: { title: string; detail: string }) {
  return createHash("sha256").update(JSON.stringify([source.title, source.detail])).digest("hex");
}
export function parseMemoryKnowledgeRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw createError({ statusCode: 400, statusMessage: "请求内容无效。" });
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["excerpt", "reason"].includes(key))) throw createError({ statusCode: 400, statusMessage: "请求包含不支持的字段。" });
  if (typeof body.excerpt !== "string" || (body.reason !== undefined && typeof body.reason !== "string")) throw createError({ statusCode: 400, statusMessage: "摘录和说明必须是文本。" });
  const excerpt = body.excerpt.trim();
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (excerpt.length < 20 || excerpt.length > 2_000 || reason.length > 240) throw createError({ statusCode: 400, statusMessage: "请选择20到2000字的原文摘录，说明最多240字。" });
  return { excerpt, reason };
}

export async function requestMemoryKnowledgeCandidate(
  prisma: PrismaClient,
  input: { ownerId: string; characterId: string; memoryEventId: string; excerpt: string; reason: string },
) {
  input = { ...input, ...parseMemoryKnowledgeRequest({ excerpt: input.excerpt, reason: input.reason }) };
  return prisma.$transaction(async tx => {
    const character = await tx.character.findFirst({ where: { id: input.characterId, ownerId: input.ownerId }, select: { id: true } });
    if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const source = await readPublicMemoryKnowledgeSource(tx, input.characterId, input.memoryEventId);
    if (!source) throw createError({ statusCode: 404, statusMessage: "仅可从当前角色公开范围的有效忆泡提出知识候选。" });
    const existing = await tx.memoryKnowledgeCandidateRequest.findUnique({ where: { characterId_memoryEventId: { characterId: input.characterId, memoryEventId: source.id } } });
    if (existing) return { requestId: existing.id, eventId: existing.growthEventId, status: existing.status, candidateId: existing.candidateId, created: false };
    if (!source.detail.includes(input.excerpt)) throw createError({ statusCode: 409, statusMessage: "摘录不是当前忆泡详情中的连续原文，请刷新后重新选择。" });
    const inserted = await tx.memoryKnowledgeCandidateRequest.createMany({
      data: [{ characterId: input.characterId, memoryEventId: source.id, excerpt: input.excerpt, reason: input.reason, sourceHash: memoryKnowledgeSourceHash(source) }], skipDuplicates: true,
    });
    const request = await tx.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { characterId_memoryEventId: { characterId: input.characterId, memoryEventId: source.id } } });
    if (!inserted.count) return { requestId: request.id, eventId: request.growthEventId, status: request.status, candidateId: request.candidateId, created: false };
    const event = await publishGrowthEvent(tx, {
      characterId: input.characterId, sourceDomain: "memory", eventType: "memory.knowledge-candidate.requested", aggregateType: "MemoryKnowledgeCandidateRequest", aggregateId: request.id,
      occurredAt: request.createdAt, idempotencyKey: `memory.knowledge-candidate.requested:${request.id}`, payload: { requestId: request.id },
    });
    await tx.memoryKnowledgeCandidateRequest.update({ where: { id: request.id }, data: { growthEventId: event.eventId } });
    await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId, action: "knowledge.memory_candidate.requested", entityType: "MemoryKnowledgeCandidateRequest", entityId: request.id, details: { memoryEventId: source.id, growthEventId: event.eventId } } });
    return { requestId: request.id, eventId: event.eventId, status: request.status, candidateId: null, created: true };
  });
}

export async function createKnowledgeCandidateFromMemoryRequest(tx: Prisma.TransactionClient, input: { characterId: string; requestId: string }) {
  const pending = await tx.memoryKnowledgeCandidateRequest.findFirst({ where: { id: input.requestId, characterId: input.characterId, status: "PENDING" } });
  if (!pending) return { skipReason: "请求不存在、角色不匹配或已完成处理。" };
  const source = await readPublicMemoryKnowledgeSource(tx, input.characterId, pending.memoryEventId);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "memory_knowledge_candidate_requests"
    WHERE "id" = ${input.requestId}::uuid AND "characterId" = ${input.characterId}::uuid AND "status" = 'PENDING'::"MemoryKnowledgeRequestStatus"
    FOR NO KEY UPDATE
  `;
  if (!locked.length) return { skipReason: "请求不存在、角色不匹配或已完成处理。" };
  const request = await tx.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: input.requestId } });
  if (!source || memoryKnowledgeSourceHash(source) !== request.sourceHash || !source.detail.includes(request.excerpt)) {
    const skipReason = "来源已删除、归档、转为私人范围或内容发生变化，请重新核对来源。";
    await tx.memoryKnowledgeCandidateRequest.update({ where: { id: request.id }, data: { status: "SKIPPED", skipReason, excerpt: "", reason: "" } });
    return { skipReason };
  }
  const candidate = await tx.knowledgeCandidate.create({ data: {
    characterId: input.characterId, sourceType: "MEMORY_EVENT", rawContent: request.excerpt,
    sourceRef: { kind: "MEMORY_EVENT", requestId: request.id, memoryEventId: source.id, sourceHash: request.sourceHash, occurredAt: source.occurredAt.toISOString(), ownerProposed: true },
  } });
  await tx.memoryKnowledgeCandidateRequest.update({ where: { id: request.id }, data: { status: "CREATED", candidateId: candidate.id, excerpt: "", reason: "" } });
  await tx.auditLog.create({ data: { actorType: "WORKER", characterId: input.characterId, action: "knowledge.memory_candidate.created", entityType: "KnowledgeCandidate", entityId: candidate.id, details: { requestId: request.id, memoryEventId: source.id } } });
  return;
}

/** 在处理/采纳候选前重新校验公开来源，防止候选创建后来源失效仍进入全局知识。 */
export async function requireValidMemoryKnowledgeCandidateSource(tx: Prisma.TransactionClient, candidate: { characterId: string; sourceType: string; sourceRef: Prisma.JsonValue }) {
  if (candidate.sourceType !== "MEMORY_EVENT") return;
  const ref = candidate.sourceRef && typeof candidate.sourceRef === "object" && !Array.isArray(candidate.sourceRef) ? candidate.sourceRef : {};
  if (typeof ref.memoryEventId !== "string" || typeof ref.sourceHash !== "string" || !/^[0-9a-f-]{36}$/i.test(ref.memoryEventId)) throw createError({ statusCode: 409, statusMessage: "候选来源引用无效。" });
  const source = await readPublicMemoryKnowledgeSource(tx, candidate.characterId, ref.memoryEventId);
  if (!source || memoryKnowledgeSourceHash(source) !== ref.sourceHash) throw createError({ statusCode: 409, statusMessage: "候选来源已失效或变更，不能处理或采纳，请核对后删除该候选。" });
}
