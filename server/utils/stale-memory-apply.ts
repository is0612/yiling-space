import { createError } from "h3";
import { readableMemoryScopeWhere, readableMemoryScopeSql } from "./memory-scope-access";
import type { PrismaClient } from "../../src/generated/prisma/client";
import type { StaleKind } from "./stale-memory-parse";
import { staleMemoryFingerprint, staleEventFingerprint } from "./stale-memory-version";

/** Lock in one global order, then revalidate the exact preview before any mutation. */
export async function applyStaleMemories(prisma: PrismaClient, input: {
  ownerId: string;
  characterId: string;
  items: Array<{ kind: StaleKind; id: string; fingerprint: string; reason?: string }>;
}): Promise<{ memory: number; event: number }> {
  const scope = {
    characterId: input.characterId,
    character: { is: { ownerId: input.ownerId } },
    ...readableMemoryScopeWhere(input.ownerId),
  };
  const items = [...new Map(input.items.map(item => [`${item.kind}:${item.id.toLowerCase()}`, { ...item, id: item.id.toLowerCase() }])).values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return prisma.$transaction(async tx => {
    // Lock all candidates before reads. Other editors/deleters use these same row locks.
    for (const item of items) {
      if (item.kind === "MEMORY") {
        await tx.$queryRaw`
          SELECT m.id FROM memory_items m
          JOIN memory_scopes s ON s.id = m."memoryScopeId"
          JOIN characters c ON c.id = s."characterId"
          WHERE m.id = ${item.id}::uuid AND m.status = 'ACTIVE' AND c.id = ${input.characterId}::uuid
            AND c."ownerId" = ${input.ownerId}::uuid AND ${readableMemoryScopeSql(input.ownerId)}
          FOR UPDATE OF m
        `;
      } else {
        await tx.$queryRaw`
          SELECT e.id FROM memory_events e
          JOIN memory_scopes s ON s.id = e."memoryScopeId"
          JOIN characters c ON c.id = s."characterId"
          WHERE e.id = ${item.id}::uuid AND e.status = 'ACTIVE' AND c.id = ${input.characterId}::uuid
            AND c."ownerId" = ${input.ownerId}::uuid AND ${readableMemoryScopeSql(input.ownerId)}
          FOR UPDATE OF e
        `;
      }
    }
    const memories = await tx.memoryItem.findMany({
      where: { id: { in: items.filter(item => item.kind === "MEMORY").map(item => item.id) }, status: "ACTIVE", memoryScope: { is: scope } },
      select: { id: true, memoryScopeId: true, category: true, content: true, importance: true, updatedAt: true },
    });
    const events = await tx.memoryEvent.findMany({
      where: { id: { in: items.filter(item => item.kind === "EVENT").map(item => item.id) }, status: "ACTIVE", memoryScope: { is: scope } },
      select: { id: true, memoryScopeId: true, dayKey: true, title: true, detail: true, participants: true },
    });
    for (const item of items) {
      const memory = item.kind === "MEMORY" ? memories.find(row => row.id === item.id) : undefined;
      const event = item.kind === "EVENT" ? events.find(row => row.id === item.id) : undefined;
      const fingerprint = memory ? staleMemoryFingerprint(memory) : event ? staleEventFingerprint(event) : null;
      if (!fingerprint || fingerprint !== item.fingerprint) {
        throw createError({ statusCode: 409, statusMessage: "条目内容、状态或可见范围已变化，请重新体检后再确认。" });
      }
    }
    const now = new Date();
    for (const item of items) {
      const memory = memories.find(row => row.id === item.id);
      const event = events.find(row => row.id === item.id);
      if (item.kind === "MEMORY") {
        await tx.memoryItem.update({ where: { id: item.id }, data: { status: "INVALIDATED", validTo: now } });
      } else {
        await tx.memoryEvent.update({ where: { id: item.id }, data: { status: "ARCHIVED" } });
      }
      await tx.auditLog.create({ data: {
        actorType: "USER", actorId: input.ownerId, characterId: input.characterId,
        action: item.kind === "MEMORY" ? "memory.invalidated" : "memory.event_archived",
        entityType: item.kind === "MEMORY" ? "MemoryItem" : "MemoryEvent", entityId: item.id,
        details: {
          before: memory ? { category: memory.category, status: "ACTIVE" } : { title: event!.title, status: "ACTIVE" },
          after: memory ? { status: "INVALIDATED", validTo: now.toISOString() } : { status: "ARCHIVED" },
          changed: memory ? ["status", "validTo"] : ["status"], reason: item.reason ?? "", source: "stale-memory-audit",
        },
      } });
    }
    return { memory: memories.length, event: events.length };
  });
}
