import type { PrismaClient } from "../../src/generated/prisma/client";
import { createGrowthReadDiagnostic, reportGrowthRead, type GrowthReadObserver } from "./growth-read-diagnostics";

export type ConversationPreference = {
  id: string; kind: string; topic: string; reason: string; revision: number;
};
export type PreferenceSearchRecord = ConversationPreference & { status: string };

/** Lexical matching deliberately does not infer interests from unrelated small talk. */
export function preferenceQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]+/gu) ?? []) {
    if (/^[a-z0-9]/u.test(word)) terms.add(word);
    else if (word.length === 1) continue;
    else for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms].slice(0, 40);
}
export function selectPreferencesForPrompt(query: string, rows: readonly PreferenceSearchRecord[], budget = 600, onDiagnostic?: GrowthReadObserver): ConversationPreference[] {
  const terms = preferenceQueryTerms(query);
  if (!terms.length) {
    reportGrowthRead(onDiagnostic, createGrowthReadDiagnostic("preferences", { candidateCount: rows.length }));
    return [];
  }
  const selected: ConversationPreference[] = [];
  let used = 0; let budgetExcludedCount = 0; let limitExcludedCount = 0;
  const ranked = rows.filter(row => row.status === "ACTIVE").map(row => ({ row,
    score: terms.reduce((sum, term) => sum + (row.topic.toLowerCase().includes(term) ? 5 : 0) + (row.reason.toLowerCase().includes(term) ? 1 : 0), 0),
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  for (const { row } of ranked) {
    if (selected.length >= 6) { limitExcludedCount++; continue; }
    const item = { id: row.id, kind: row.kind, topic: row.topic, reason: row.reason, revision: row.revision };
    // Conservative character estimate with envelope overhead; no first-item budget bypass.
    const cost = JSON.stringify(item).length;
    if (used + cost > Math.max(0, budget)) { budgetExcludedCount++; continue; }
    selected.push(item); used += cost;
  }
  reportGrowthRead(onDiagnostic, createGrowthReadDiagnostic("preferences", {
    status: selected.length ? "provided" : ranked.length && budgetExcludedCount ? "budget_excluded" : "no_match",
    candidateCount: rows.length, matchedCount: ranked.length, selectedCount: selected.length,
    budgetExcludedCount, limitExcludedCount, provided: selected.map(({ id, revision }) => ({ id, revision })),
  }));
  return selected;
}

/** Caller must already have resolved the trusted character, as in the chat entry points. */
export async function loadPreferencesForPrompt(prisma: PrismaClient, characterId: string, query: string, onDiagnostic?: GrowthReadObserver): Promise<ConversationPreference[]> {
  const terms = preferenceQueryTerms(query);
  if (!terms.length) { reportGrowthRead(onDiagnostic, createGrowthReadDiagnostic("preferences")); return []; }
  try {
  const rows = await prisma.characterPreference.findMany({
    where: { characterId, status: "ACTIVE", OR: terms.flatMap(term => [
      { topic: { contains: term, mode: "insensitive" as const } },
      { reason: { contains: term, mode: "insensitive" as const } },
    ]) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100,
    select: { id: true, kind: true, topic: true, reason: true, revision: true, status: true },
  });
  return selectPreferencesForPrompt(query, rows, 600, onDiagnostic ? entry => reportGrowthRead(onDiagnostic, { ...entry, candidateLimitReached: rows.length === 100 }) : undefined);
  } catch (error) {
    reportGrowthRead(onDiagnostic, createGrowthReadDiagnostic("preferences", { status: "failed" }));
    throw error;
  }
}

export function usedPreferenceSnapshots(items: readonly ConversationPreference[], ids: readonly string[]) {
  const used = new Set(ids);
  return items.filter(item => used.has(item.id)).map(item => ({ ...item }));
}
