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
  return { memories, snapshots };
}
