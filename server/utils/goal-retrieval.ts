import type { PrismaClient } from "../../src/generated/prisma/client";
import { preferenceQueryTerms } from "./preference-retrieval";

export type ConversationGoal = {
  id: string; kind: string; title: string; description: string; status: string; revision: number;
  latestProgress?: { content: string; createdAt: string };
};
export type GoalSearchRecord = Omit<ConversationGoal, "latestProgress"> & { progress?: Array<{ content: string; createdAt: Date | string }> };
export function selectGoalsForPrompt(query: string, rows: readonly GoalSearchRecord[], budget = 1000): ConversationGoal[] {
  const terms = preferenceQueryTerms(query);
  if (!terms.length) return [];
  const ranked = rows.filter(row => row.status === "ACTIVE").map(row => ({ row, score: terms.reduce((sum, term) =>
    sum + (row.title.toLowerCase().includes(term) ? 5 : 0) + (row.description.toLowerCase().includes(term) ? 1 : 0), 0),
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  const output: ConversationGoal[] = []; let used = 2;
  for (const { row } of ranked) {
    const last = row.progress?.[0];
    const item: ConversationGoal = { id: row.id, kind: row.kind, title: row.title, description: row.description.slice(0, 400), status: row.status, revision: row.revision,
      ...(last ? { latestProgress: { content: last.content.slice(0, 200), createdAt: new Date(last.createdAt).toISOString() } } : {}),
    };
    const cost = JSON.stringify(item).length + 1;
    if (used + cost > Math.max(0, budget)) continue;
    output.push(item); used += cost;
    if (output.length >= 4) break;
  }
  return output;
}
export async function loadGoalsForPrompt(prisma: PrismaClient, characterId: string, query: string): Promise<ConversationGoal[]> {
  const terms = preferenceQueryTerms(query);
  if (!terms.length) return [];
  const rows = await prisma.characterGoal.findMany({
    where: { characterId, status: "ACTIVE", OR: terms.flatMap(term => [
      { title: { contains: term, mode: "insensitive" as const } }, { description: { contains: term, mode: "insensitive" as const } },
    ]) }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100,
    select: { id: true, kind: true, title: true, description: true, status: true, revision: true,
      progress: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { content: true, createdAt: true } },
    },
  });
  return selectGoalsForPrompt(query, rows);
}
export function usedGoalSnapshots(items: readonly ConversationGoal[], ids: readonly string[]) {
  const allowed = new Set(ids); return items.filter(item => allowed.has(item.id)).map(item => ({ ...item }));
}
