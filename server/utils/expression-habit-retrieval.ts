import type { PrismaClient } from "../../src/generated/prisma/client";
import { preferenceQueryTerms } from "./preference-retrieval";

export type ConversationExpressionHabit = {
  id: string; kind: string; content: string; context: string; revision: number;
};
export type ExpressionHabitSearchRecord = ConversationExpressionHabit & { status: string };

/** General habits are always eligible; scene-specific ones require lexical scene evidence. */
export function selectExpressionHabitsForPrompt(query: string, rows: readonly ExpressionHabitSearchRecord[], budget = 800): ConversationExpressionHabit[] {
  const terms = preferenceQueryTerms(query);
  const ranked = rows.filter(row => row.status === "ACTIVE").map(row => ({ row,
    score: row.context.trim() ? terms.reduce((sum, term) => sum + (row.context.toLowerCase().includes(term) ? 1 : 0), 0) : 0,
  })).filter(({ row, score }) => !row.context.trim() || score > 0)
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  const selected: ConversationExpressionHabit[] = [];
  let used = 0;
  for (const { row } of ranked) {
    const item = { id: row.id, kind: row.kind, content: row.content, context: row.context, revision: row.revision };
    const cost = JSON.stringify(item).length + 1;
    if (used + cost + 2 > Math.max(0, budget)) continue;
    selected.push(item); used += cost;
    if (selected.length >= 6) break;
  }
  return selected;
}

export async function loadExpressionHabitsForPrompt(prisma: PrismaClient, characterId: string, query: string): Promise<ConversationExpressionHabit[]> {
  const terms = preferenceQueryTerms(query);
  const rows = await prisma.characterExpressionHabit.findMany({
    where: { characterId, status: "ACTIVE", OR: [{ context: "" }, ...terms.map(term => ({ context: { contains: term, mode: "insensitive" as const } }))] },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100,
    select: { id: true, kind: true, content: true, context: true, revision: true, status: true },
  });
  return selectExpressionHabitsForPrompt(query, rows);
}
export function usedExpressionHabitSnapshots(items: readonly ConversationExpressionHabit[], ids: readonly string[]) {
  const used = new Set(ids);
  return items.filter(item => used.has(item.id)).map(item => ({ ...item }));
}
