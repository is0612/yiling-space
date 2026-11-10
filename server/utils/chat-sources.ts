import { readStoredMemoryScopeOrigin, type MemoryScopeOrigin } from "./memory-scope-access";

export type StoredChatMemorySource = {
  id: string;
  category: string;
  content: string;
  scope: MemoryScopeOrigin;
};

export type StoredChatSnapshotSource = {
  id: string;
  summary: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  scope: MemoryScopeOrigin;
};

export type StoredChatSources = {
  memories: StoredChatMemorySource[];
  snapshots: StoredChatSnapshotSource[];
  goals?: import("./goal-retrieval").ConversationGoal[];
  expressionHabits?: Array<{ id: string; kind: string; content: string; context: string; revision: number }>;
  preferences?: Array<{ id: string; kind: string; topic: string; reason: string; revision: number }>;
};

const EMPTY_SOURCES: StoredChatSources = { memories: [], snapshots: [] };

/**
 * Rebuilds the cited sources stored on an assistant message. Records written before scope
 * tracking existed have no scope field and default to character-global, which is the only
 * scope those replies could have retrieved from.
 */
export function readStoredChatSources(metadata: unknown): StoredChatSources {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return EMPTY_SOURCES;
  const root = metadata as Record<string, unknown>;
  const raw = root.usedSources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SOURCES;
  const sourceRoot = raw as Record<string, unknown>;
  const memories = Array.isArray(sourceRoot.memories)
    ? sourceRoot.memories.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.content !== "string") return [];
        return [{
          id: record.id,
          category: typeof record.category === "string" ? record.category : "OTHER",
          content: record.content,
          scope: readStoredMemoryScopeOrigin(record.scope),
        }];
      }).slice(0, 12)
    : [];
  const snapshots = Array.isArray(sourceRoot.snapshots)
    ? sourceRoot.snapshots.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.summary !== "string" ||
          typeof record.periodStart !== "string" || typeof record.periodEnd !== "string" || typeof record.version !== "number") return [];
        return [{
          id: record.id,
          summary: record.summary,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
          version: record.version,
          scope: readStoredMemoryScopeOrigin(record.scope),
        }];
      }).slice(0, 12)
    : [];
  const preferences = Array.isArray(sourceRoot.preferences) ? sourceRoot.preferences.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.kind !== "string" || !["LIKE", "DISLIKE", "INTEREST"].includes(row.kind)
      || typeof row.topic !== "string" || typeof row.reason !== "string" || typeof row.revision !== "number"
      || !Number.isSafeInteger(row.revision) || row.revision < 1) return [];
    return [{ id: row.id, kind: row.kind, topic: row.topic.slice(0, 100), reason: row.reason.slice(0, 1000), revision: row.revision }];
  }).slice(0, 6) : [];
  const expressionHabits = Array.isArray(sourceRoot.expressionHabits) ? sourceRoot.expressionHabits.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.kind !== "string" || !["TONE", "WORDING", "LENGTH"].includes(row.kind)
      || typeof row.content !== "string" || typeof row.context !== "string" || typeof row.revision !== "number"
      || !Number.isSafeInteger(row.revision) || row.revision < 1) return [];
    return [{ id: row.id, kind: row.kind, content: row.content.slice(0, 300), context: row.context.slice(0, 200), revision: row.revision }];
  }).slice(0, 6) : [];
  const goals = Array.isArray(sourceRoot.goals) ? sourceRoot.goals.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.kind !== "string" || !["GOAL", "WISH"].includes(row.kind)
      || typeof row.title !== "string" || typeof row.description !== "string" || row.status !== "ACTIVE"
      || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1) return [];
    const progress = row.latestProgress && typeof row.latestProgress === "object" && !Array.isArray(row.latestProgress) ? row.latestProgress as Record<string, unknown> : null;
    return [{ id: row.id, kind: row.kind, title: row.title.slice(0, 100), description: row.description.slice(0, 400), status: row.status, revision: row.revision,
      ...(progress && typeof progress.content === "string" && typeof progress.createdAt === "string" ? { latestProgress: { content: progress.content.slice(0, 200), createdAt: progress.createdAt } } : {}),
    }];
  }).slice(0, 4) : [];
  return { memories, snapshots, ...(preferences.length ? { preferences } : {}), ...(expressionHabits.length ? { expressionHabits } : {}), ...(goals.length ? { goals } : {}) };
}
