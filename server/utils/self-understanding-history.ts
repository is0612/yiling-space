import type { PrismaClient } from "../../src/generated/prisma/client";
import type { SelfUnderstandingDomain } from "./self-understanding";

type HistoryDomain = "preferences" | "language" | "goals" | "social";
type CurrentEvidence = { domain: SelfUnderstandingDomain; id: string; revision?: number; scope: "character" | "private" };
type HistorySnapshot = {
  revision: number;
  excerpt: string;
  /** Recorded revision/change time, not a date of an experience. */
  recordedAt?: string;
  excerptTruncated?: true;
};
export type SelfUnderstandingHistoryEntry = {
  domain: HistoryDomain;
  /** The same stable entity as current evidence, never a historical source ID. */
  id: string;
  scope: "character";
  previous: HistorySnapshot;
  current: HistorySnapshot;
};

const MAX_LOOKUPS = 8;
const MAX_ENTRIES = 6;
const MAX_PRIOR_REVISIONS = 8;
const MAX_EXCERPT = 160;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function snapshot(revision: number, text: string, date?: Date): HistorySnapshot | undefined {
  const excerpt = text.replace(/\s+/gu, " ").trim();
  if (!excerpt || (date && !Number.isFinite(date.getTime()))) return;
  return {
    revision, excerpt: excerpt.slice(0, MAX_EXCERPT),
    ...(date ? { recordedAt: date.toISOString() } : {}),
    ...(excerpt.length > MAX_EXCERPT ? { excerptTruncated: true } : {}),
  };
}

function compareSnapshots<T extends { revision: number; createdAt: Date }>(
  rows: T[], revision: number, render: (row: T) => string,
): Pick<SelfUnderstandingHistoryEntry, "previous" | "current"> | undefined {
  // All rows come from the same entity in descending revision order. If the
  // exact current revision snapshot is absent, don't guess at its content.
  const first = rows[0];
  if (!first || first.revision !== revision) return;
  const current = snapshot(revision, render(first), first.createdAt);
  if (!current) return;
  for (const row of rows.slice(1)) {
    if (row.revision >= revision) continue;
    const previous = snapshot(row.revision, render(row), row.createdAt);
    if (previous && previous.excerpt !== current.excerpt) return { previous, current };
  }
}

/**
 * Only read versions of current evidence already selected by the trusted
 * cognition reader. Recheck ownership, ACTIVE state and revision consistency.
 * Conversation-bound history never leaves its source; this view omits it even
 * in private chats. Character-wide expression history must match the current
 * scene exactly. Never fetch reasons, raw evidence, source refs or actor IDs.
 */
export async function loadSelfUnderstandingHistory(prisma: PrismaClient, input: {
  characterId: string;
  current: readonly CurrentEvidence[];
  groupChat: boolean;
  includeAllExpressionScenes?: boolean;
}): Promise<SelfUnderstandingHistoryEntry[]> {
  const entries: SelfUnderstandingHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const ref of input.current) {
    if (entries.length >= MAX_ENTRIES || seen.size >= MAX_LOOKUPS) break;
    const { domain, id, scope } = ref;
    const revision = ref.revision;
    if (scope !== "character" || !UUID.test(id) || revision === undefined
      || !Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647) continue;
    if (domain !== "preferences" && domain !== "language" && domain !== "goals" && domain !== "social") continue;
    if (input.groupChat && domain === "social") continue;
    const key = `${domain}:${id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const parent = { characterId: input.characterId, status: "ACTIVE", revision } as const;
    const candidates = { status: "ACTIVE", revision: { lte: revision } } as const;
    const bounds = { orderBy: { revision: "desc" }, take: MAX_PRIOR_REVISIONS + 1 } as const;
    let pair: Pick<SelfUnderstandingHistoryEntry, "previous" | "current"> | undefined;
    if (domain === "preferences") {
      const rows = await prisma.characterPreferenceRevision.findMany({
        ...bounds,
        where: { ...candidates, preferenceId: id, preference: parent },
        select: { revision: true, createdAt: true, kind: true, topic: true },
      });
      pair = compareSnapshots(rows, revision, row => `${row.kind}: ${row.topic}`);
    } else if (domain === "goals") {
      const rows = await prisma.characterGoalRevision.findMany({
        ...bounds,
        where: { ...candidates, goalId: id, goal: parent },
        select: { revision: true, createdAt: true, title: true, description: true },
      });
      pair = compareSnapshots(rows, revision, row => `${row.title}: ${row.description}`);
    } else if (domain === "language") {
      // Use an exact scene on both sides so broadening PRIVATE to ALL cannot
      // expose an older PRIVATE snapshot even within a private request.
      const habit = await prisma.characterExpressionHabit.findFirst({
        where: { ...parent, id, conversationId: null, memoryScopeId: null,
          chatScope: { in: input.includeAllExpressionScenes && !input.groupChat ? ["ALL", "GROUP", "PRIVATE"] : ["ALL", input.groupChat ? "GROUP" : "PRIVATE"] }, sourceType: { not: "EXPERIENCE_REFLECT" } },
        select: { chatScope: true },
      });
      if (!habit) continue;
      const exactScene = { chatScope: habit.chatScope, conversationId: null, memoryScopeId: null,
        sourceType: { not: "EXPERIENCE_REFLECT" } } as const;
      const rows = await prisma.characterExpressionHabitRevision.findMany({
        ...bounds,
        where: { ...candidates, ...exactScene, habitId: id, habit: { ...parent, ...exactScene } },
        select: { revision: true, createdAt: true, content: true, context: true },
      });
      pair = compareSnapshots(rows, revision, row => row.context ? `${row.content}（${row.context}）` : row.content);
    } else {
      pair = await relationshipChange(prisma, input.characterId, id, revision);
    }
    if (pair) entries.push({ ...pair, domain, id, scope });
  }
  return entries;
}

async function relationshipChange(prisma: PrismaClient, characterId: string, scopeId: string, revision: number) {
  const eligibleScope = { characterId, scopeType: "EXTERNAL_IDENTITY", relationshipVersion: revision,
    interactionCount: { gt: 0 }, friendChatPolicy: { not: "BLOCK" }, externalIdentity: { isNot: null },
    OR: [{ friendChatPolicy: "ALLOW" }, { externalIdentity: { is: { kind: { not: "AI" } } } }] } as const;
  const scope = await prisma.memoryScope.findFirst({
    where: { id: scopeId, ...eligibleScope, OR: [...eligibleScope.OR] },
    select: { relationshipStage: true, relationshipStatus: true },
  });
  if (!scope?.relationshipStage || !scope.relationshipStatus) return;
  const rows = await prisma.socialRelationChange.findMany({
    where: {
      scopeId, relationshipVersionBefore: revision - 1, relationshipVersionAfter: revision,
      toStage: scope.relationshipStage, toStatus: scope.relationshipStatus,
      scope: { ...eligibleScope, OR: [...eligibleScope.OR],
        relationshipStage: scope.relationshipStage, relationshipStatus: scope.relationshipStatus },
      assessment: { is: { scopeId, relationshipVersion: revision - 1,
        status: "SUCCEEDED", outcome: "CHANGE", reviewStatus: "ACCEPTED",
        suggestedStage: scope.relationshipStage, suggestedStatus: scope.relationshipStatus } },
    },
    take: 2,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { fromStage: true, fromStatus: true, toStage: true, toStatus: true, createdAt: true,
      assessment: { select: { evaluatedStage: true, evaluatedStatus: true } } },
  });
  // The accepted transition documents the before-state, not when it began.
  const change = rows[0];
  if (rows.length !== 1 || !change?.fromStatus || !change.toStatus
    || change.assessment?.evaluatedStage !== change.fromStage || change.assessment.evaluatedStatus !== change.fromStatus
    || (change.fromStage === change.toStage && change.fromStatus === change.toStatus)) return;
  const previous = snapshot(revision - 1, `${change.fromStage}, ${change.fromStatus}`);
  const current = snapshot(revision, `${change.toStage}, ${change.toStatus}`, change.createdAt);
  return previous && current ? { previous, current } : undefined;
}
