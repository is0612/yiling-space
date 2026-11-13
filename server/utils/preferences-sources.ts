import { createError } from "h3";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { preferencePage, preferenceSourceHash, type PreferenceSourceRef, type PreferenceSourceSnapshot } from "./preferences-domain";

type Database = PrismaClient | Prisma.TransactionClient;
export async function assertPreferenceOwner(tx: Database, ownerId: string, characterId: string) {
  if (!await tx.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
}
export async function lockPreferenceOwner(tx: Prisma.TransactionClient, ownerId: string, characterId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "characters" WHERE "id"=${characterId}::uuid AND "ownerId"=${ownerId}::uuid FOR SHARE`;
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
}
function memorySnapshot(row: { id: string; title: string; detail: string; occurredAt: Date }): PreferenceSourceSnapshot {
  return { type: "MEMORY_EVENT", id: row.id, title: row.title, summary: row.detail.slice(0, 600), hash: preferenceSourceHash("MEMORY_EVENT", row.id, row.title, row.detail, row.occurredAt.toISOString()) };
}
function reflectionSnapshot(row: { id: string; title: string; observation: string; inference: string; recommendation: string; sourceRefs: unknown }): PreferenceSourceSnapshot {
  const content = JSON.stringify([row.observation, row.inference, row.recommendation]);
  return { type: "REFLECTION_SUGGESTION", id: row.id, title: row.title, summary: `${row.observation}\n${row.inference}\n${row.recommendation}`.slice(0, 600), hash: preferenceSourceHash("REFLECTION_SUGGESTION", row.id, row.title, content, row.sourceRefs) };
}
/** Caller must be in a transaction. Lock hierarchy follows source deletion: character, scopes/runs, evidence rows. */
export async function loadPreferenceSources(tx: Prisma.TransactionClient, characterId: string, refs: readonly PreferenceSourceRef[]): Promise<PreferenceSourceSnapshot[]> {
  if (refs.length < 1 || refs.length > 5) throw createError({ statusCode: 400, statusMessage: "请选择1至5条来源。" });
  const ordered = [...refs].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  const memoryIds = ordered.filter(ref => ref.type === "MEMORY_EVENT").map(ref => ref.id);
  const memories = memoryIds.length ? await tx.memoryEvent.findMany({ where: { id: { in: memoryIds }, memoryScope: { characterId, scopeType: "CHARACTER_GLOBAL" } }, select: { memoryScopeId: true }, take: 5 }) : [];
  for (const scopeId of [...new Set(memories.map(row => row.memoryScopeId))].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "memory_scopes" WHERE "id"=${scopeId}::uuid AND "characterId"=${characterId}::uuid AND "scopeType"='CHARACTER_GLOBAL'::"MemoryScopeType" FOR SHARE`;
  }
  const result: PreferenceSourceSnapshot[] = [];
  for (const ref of ordered) {
    let snapshot: PreferenceSourceSnapshot | undefined;
    if (ref.type === "MEMORY_EVENT") {
      const rows = await tx.$queryRaw<Array<{ id: string; title: string; detail: string; occurredAt: Date; memoryScopeId: string }>>`
        SELECT source."id", source."title", source."detail", source."occurredAt", source."memoryScopeId" FROM "memory_events" source
        JOIN "memory_scopes" scope ON scope."id"=source."memoryScopeId"
        WHERE source."id"=${ref.id}::uuid AND source."status"='ACTIVE' AND scope."characterId"=${characterId}::uuid
        AND scope."scopeType"='CHARACTER_GLOBAL'::"MemoryScopeType" FOR SHARE OF source`;
      if (rows[0] && memories.some(row => row.memoryScopeId === rows[0]!.memoryScopeId)) snapshot = memorySnapshot(rows[0]);
    } else {
      // Runs are deleted before cascading suggestions; keep the same parent-first order.
      const parents = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT run."id" FROM "reflection_runs" run JOIN "reflection_suggestions" suggestion ON suggestion."runId"=run."id"
        WHERE suggestion."id"=${ref.id}::uuid AND run."characterId"=${characterId}::uuid
         AND run."conversationId" IS NULL AND run."memoryScopeId" IS NULL FOR SHARE OF run`;
      if (parents[0]) {
        const rows = await tx.$queryRaw<Array<{ id: string; title: string; observation: string; inference: string; recommendation: string; sourceRefs: unknown }>>`
          SELECT "id", "title", "observation", "inference", "recommendation", "sourceRefs" FROM "reflection_suggestions"
          WHERE "id"=${ref.id}::uuid AND "runId"=${parents[0].id}::uuid AND "status"='ACCEPTED' FOR SHARE`;
        if (rows[0]) snapshot = reflectionSnapshot(rows[0]);
      }
    }
    if (!snapshot || snapshot.hash !== ref.hash) throw createError({ statusCode: 409, statusMessage: "偏好来源已失效、变更或不属于当前角色公开范围，请重新选择。" });
    result.push(snapshot);
  }
  return result;
}
export async function listPreferenceSources(prisma: PrismaClient, input: { ownerId: string; characterId: string; type: PreferenceSourceRef["type"]; q: string; page: number; pageSize: number }) {
  await assertPreferenceOwner(prisma, input.ownerId, input.characterId);
  const skip = (input.page - 1) * input.pageSize;
  if (input.type === "MEMORY_EVENT") {
    const where: Prisma.MemoryEventWhereInput = { status: "ACTIVE", memoryScope: { characterId: input.characterId, scopeType: "CHARACTER_GLOBAL" }, ...(input.q ? { OR: [{ title: { contains: input.q, mode: "insensitive" } }, { detail: { contains: input.q, mode: "insensitive" } }] } : {}) };
    const [rows, total] = await Promise.all([prisma.memoryEvent.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip, take: input.pageSize, select: { id: true, title: true, detail: true, occurredAt: true } }), prisma.memoryEvent.count({ where })]);
    return preferencePage(rows.map(row => ({ ...memorySnapshot(row), occurredAt: row.occurredAt })), total, input.page, input.pageSize);
  }
  const where: Prisma.ReflectionSuggestionWhereInput = { status: "ACCEPTED", run: { characterId: input.characterId, conversationId: null, memoryScopeId: null }, ...(input.q ? { OR: [{ title: { contains: input.q, mode: "insensitive" } }, { observation: { contains: input.q, mode: "insensitive" } }, { recommendation: { contains: input.q, mode: "insensitive" } }] } : {}) };
  const [rows, total] = await Promise.all([prisma.reflectionSuggestion.findMany({ where, orderBy: [{ acceptedAt: "desc" }, { id: "desc" }], skip, take: input.pageSize, select: { id: true, title: true, observation: true, inference: true, recommendation: true, sourceRefs: true, acceptedAt: true, createdAt: true } }), prisma.reflectionSuggestion.count({ where })]);
  return preferencePage(rows.map(row => ({ ...reflectionSnapshot(row), occurredAt: row.acceptedAt ?? row.createdAt })), total, input.page, input.pageSize);
}
