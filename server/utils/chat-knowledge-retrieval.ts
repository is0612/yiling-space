import type { PrismaClient } from "../../src/generated/prisma/client";
import { rankKnowledgeItems } from "./knowledge-retrieval";
import { createGrowthReadDiagnostic, reportGrowthRead, type GrowthReadObserver } from "./growth-read-diagnostics";

/** Shared, character-scoped formal knowledge reader for authenticated chat entry points. */
export async function loadChatKnowledge(prisma: PrismaClient, characterId: string, query: string, observer?: GrowthReadObserver) {
  try {
    const rows = await prisma.knowledgeItem.findMany({
      where: { characterId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" }, take: 300,
      select: { id: true, title: true, content: true, category: true, tags: true, confidence: true, sourceType: true, updatedAt: true },
    });
    const selected = rankKnowledgeItems(query, rows, 8);
    const matchedCount = observer ? rows.filter(row => rankKnowledgeItems(query, [row], 1).length).length : 0;
    reportGrowthRead(observer, createGrowthReadDiagnostic("knowledge", {
      status: selected.length ? "provided" : "no_match", candidateCount: rows.length, matchedCount,
      selectedCount: selected.length, limitExcludedCount: Math.max(0, matchedCount - selected.length),
      candidateLimitReached: rows.length === 300,
      provided: selected.map(item => ({ id: item.id, updatedAt: new Date(item.updatedAt).toISOString() })),
    }));
    return selected.map(item => ({ id: item.id, title: item.title, content: item.content, category: item.category,
      tags: item.tags, confidence: item.confidence, sourceType: item.sourceType }));
  } catch (error) {
    reportGrowthRead(observer, createGrowthReadDiagnostic("knowledge", { status: "failed" }));
    throw error;
  }
}
