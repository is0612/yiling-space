import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { extractMemoryAssistantSearchTerms } from "./memory-retrieval";

const memorySelect = {
  id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true,
  validFrom: true, memoryScopeId: true, importance: true, lastRecalledAt: true, recallCount: true,
} satisfies Prisma.MemoryItemSelect;
const snapshotSelect = {
  id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true, memoryScopeId: true,
} satisfies Prisma.MemorySnapshotSelect;

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

/**
 * Both chat entrances use the same bounded candidate pool before budget ranking.
 * The caller must resolve authorized scopes first; this function never discovers or widens them.
 * Recent samples preserve conversational background; topic matches reach beyond the recent window.
 * This is lexical retrieval, not a guarantee of complete historical or semantic coverage.
 */
export async function loadPromptMemoryCandidates(
  prisma: Pick<PrismaClient, "memoryItem" | "memorySnapshot">,
  input: { readableScopeIds: readonly string[]; query: string },
) {
  if (!input.readableScopeIds.length) return { memories: [], snapshots: [] };
  const scopeIds = [...new Set(input.readableScopeIds)];
  const terms = extractMemoryAssistantSearchTerms(input.query, 20);
  const memoryWhere = { memoryScopeId: { in: scopeIds }, status: "ACTIVE" as const, deletedAt: null };
  const snapshotWhere = { memoryScopeId: { in: scopeIds }, status: "CURRENT" as const };
  const [recentMemories, recentSnapshots] = await Promise.all([
    prisma.memoryItem.findMany({
      where: memoryWhere, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 300, select: memorySelect,
    }),
    prisma.memorySnapshot.findMany({
      where: snapshotWhere, orderBy: [{ createdAt: "desc" }, { version: "desc" }, { id: "desc" }],
      take: 80, select: snapshotSelect,
    }),
  ]);
  // Below the recent cap the entire eligible set is already present; avoid duplicate scans.
  const [topicMemories, topicSnapshots] = await Promise.all([
    terms.length && recentMemories.length === 300 ? prisma.memoryItem.findMany({
      where: { ...memoryWhere, OR: terms.map(term => ({ content: { contains: term, mode: "insensitive" as const } })) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 180, select: memorySelect,
    }) : Promise.resolve([]),
    terms.length && recentSnapshots.length === 80 ? prisma.memorySnapshot.findMany({
      where: { ...snapshotWhere, OR: terms.map(term => ({ summary: { contains: term, mode: "insensitive" as const } })) },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }, { id: "desc" }], take: 120, select: snapshotSelect,
    }) : Promise.resolve([]),
  ]);
  return {
    memories: uniqueById([...recentMemories, ...topicMemories]),
    snapshots: uniqueById([...recentSnapshots, ...topicSnapshots]),
  };
}
