import type { ExpressionChatScope } from "./expression-habits-domain";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { validateExperienceReflectionRefs, type ExperienceScope, type ExperienceReflectionRef } from "./experience-reflection";
import { preferenceQueryTerms } from "./preference-retrieval";
import { createGrowthReadDiagnostic, reportGrowthRead, type GrowthReadObserver } from "./growth-read-diagnostics";

export type ConversationExpressionHabit = {
  id: string; kind: string; content: string; context: string; revision: number; chatScope?: ExpressionChatScope;
};
export type ExpressionHabitSearchRecord = ConversationExpressionHabit & { status: string };

/** General habits are always eligible; scene-specific ones require lexical scene evidence. */
export function selectExpressionHabitsForPrompt(query: string, rows: readonly ExpressionHabitSearchRecord[], budget = 800, onDiagnostic?: GrowthReadObserver, chatScene?: "GROUP" | "PRIVATE"): ConversationExpressionHabit[] {
  const terms = preferenceQueryTerms(query);
  const ranked = rows.filter(row => row.status === "ACTIVE" && ((row.chatScope ?? "ALL") === "ALL" || row.chatScope === chatScene)).map(row => ({ row,
    score: row.context.trim() ? terms.reduce((sum, term) => sum + (row.context.toLowerCase().includes(term) ? 1 : 0), 0) : 0,
  })).filter(({ row, score }) => !row.context.trim() || score > 0)
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  const selected: ConversationExpressionHabit[] = [];
  let used = 0; let budgetExcludedCount = 0; let limitExcludedCount = 0;
  for (const { row } of ranked) {
    if (selected.length >= 6) { limitExcludedCount++; continue; }
    const item = { id: row.id, kind: row.kind, content: row.content, context: row.context, revision: row.revision, ...(row.chatScope ? { chatScope: row.chatScope } : {}) };
    const cost = JSON.stringify(item).length + 1;
    if (used + cost + 2 > Math.max(0, budget)) { budgetExcludedCount++; continue; }
    selected.push(item); used += cost;
  }
  reportGrowthRead(onDiagnostic, createGrowthReadDiagnostic("language", {
    status: selected.length ? "provided" : ranked.length && budgetExcludedCount ? "budget_excluded" : "no_match",
    candidateCount: rows.length, matchedCount: ranked.length, selectedCount: selected.length,
    budgetExcludedCount, limitExcludedCount, provided: selected.map(({ id, revision }) => ({ id, revision })),
  }));
  return selected;
}

export async function loadExpressionHabitsForPrompt(prisma: PrismaClient, characterId: string, query: string, onDiagnostic?: GrowthReadObserver, scope?: ExperienceScope, chatScene?: "GROUP" | "PRIVATE"): Promise<ConversationExpressionHabit[]> {
  const terms = preferenceQueryTerms(query);
  try {
  const rows = await prisma.characterExpressionHabit.findMany({
    where: { characterId, status: "ACTIVE", chatScope: { in: chatScene ? ["ALL", chatScene] : ["ALL"] }, AND: [{ OR: [{ conversationId: null, memoryScopeId: null }, ...(scope ? [{ conversationId: scope.conversationId, memoryScopeId: scope.memoryScopeId }] : [])] }], OR: [{ context: "" }, ...terms.map(term => ({ context: { contains: term, mode: "insensitive" as const } }))] },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100,
    select: { id: true, kind: true, content: true, context: true, chatScope: true, revision: true, status: true, sourceType: true, sourceRefs: true },
  });
  const eligible = [];
  for (const row of rows) {
    if (row.sourceType === "EXPERIENCE_REFLECT" && (!scope || !await prisma.$transaction(tx => validateExperienceReflectionRefs(tx, characterId, row.sourceRefs as unknown as ExperienceReflectionRef[], scope)))) continue;
    if (row.sourceType === "EXPERIENCE_REFLECT" && chatScene === "GROUP") continue;
    eligible.push({ ...row, chatScope: row.chatScope as ExpressionChatScope });
  }
  return selectExpressionHabitsForPrompt(query, eligible, 800, onDiagnostic ? entry => reportGrowthRead(onDiagnostic, { ...entry, candidateLimitReached: rows.length === 100 }) : undefined, chatScene);
  } catch (error) {
    reportGrowthRead(onDiagnostic, createGrowthReadDiagnostic("language", { status: "failed" }));
    throw error;
  }
}
export function usedExpressionHabitSnapshots(items: readonly ConversationExpressionHabit[], ids: readonly string[]) {
  const used = new Set(ids);
  return items.filter(item => used.has(item.id)).map(item => ({ ...item }));
}
