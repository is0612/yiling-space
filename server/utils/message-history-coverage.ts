import type { RawMessageCandidate } from "./message-retrieval";

export type HistoryMessage = RawMessageCandidate & { conversationId: string };
export type HistoryCursor = Pick<HistoryMessage, "id" | "occurredAt">;

/** Bounded read-only coverage. Filtering happens before deciding whether more history is needed. */
export async function loadMessageHistoryCoverage<T extends HistoryMessage>(input: {
  matched: T[];
  window: T[];
  excludeIds: ReadonlySet<string>;
  filterVisible: (rows: T[]) => Promise<T[]>;
  fetchPage: (options: { excludeIds: string[]; cursor?: HistoryCursor; take: number }) => Promise<T[]>;
  fetchNeighbors: (anchor: T, direction: "before" | "after") => Promise<T[]>;
  fallbackLimit?: number;
  oldestFirst?: boolean;
}): Promise<T[]> {
  const unique = (rows: T[]) => [...new Map(rows.filter(row => row.content.trim() && !input.excludeIds.has(row.id)).map(row => [row.id, row])).values()];
  const matched = await input.filterVisible(unique(input.matched));
  const window = await input.filterVisible(unique(input.window));
  let rows = unique([...matched, ...window]);
  // A window is a coverage boundary even if all of its messages were already supplied to the caller.
  // Continue past it instead of fetching those same rows only to discard them afterwards.
  let cursor: HistoryCursor | undefined = !input.oldestFirst && input.window.length
    ? [...input.window].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))[0]
    : undefined;
  const fallbackLimit = Math.min(120, Math.max(16, input.fallbackLimit ?? 40));
  let fallbackCount = 0;
  if (matched.length < 16) {
    for (let page = 0; page < 3 && fallbackCount < fallbackLimit; page++) {
      const batch = await input.fetchPage({
        excludeIds: [...new Set([...input.excludeIds, ...rows.map(row => row.id)])], cursor, take: 80,
      });
      if (!batch.length) break;
      // Move by fetched rows, including filtered-out speakers, so a blocked speaker cannot pin the cursor.
      cursor = batch[batch.length - 1];
      const visible = await input.filterVisible(unique(batch));
      const prior = new Set(rows.map(row => row.id));
      const fresh = visible.filter(row => !prior.has(row.id)).slice(0, fallbackLimit - fallbackCount);
      rows = unique([...rows, ...fresh]);
      fallbackCount += fresh.length;
      if (batch.length < 80) break;
    }
  }
  // At most four anchors and sixteen surrounding rows. The callback must retain the same
  // authorized base predicate and exact conversation; no cross-room/private expansion is allowed.
  const anchors = matched.slice(0, 4);
  const neighbors = (await Promise.all(anchors.flatMap(anchor =>
    (["before", "after"] as const).map(async direction => {
      const fetched = await input.fetchNeighbors(anchor, direction);
      return fetched.filter(row => {
        const delta = row.occurredAt.getTime() - anchor.occurredAt.getTime();
        const position = delta || row.id.localeCompare(anchor.id);
        return row.conversationId === anchor.conversationId && Math.abs(delta) <= 120_000
          && (direction === "before" ? position < 0 : position > 0);
      }).slice(0, 2);
    }),
  ))).flat();
  rows = unique([...rows, ...await input.filterVisible(unique(neighbors))]);
  return rows;
}

/** Stable timestamp + id cursor: ties must not skip the remainder of a message batch. */
export function historyCursorWhere(cursor: HistoryCursor, direction: "asc" | "desc") {
  const comparison = direction === "asc" ? "gt" : "lt";
  return { OR: [
    { occurredAt: { [comparison]: cursor.occurredAt } },
    { occurredAt: cursor.occurredAt, id: { [comparison]: cursor.id } },
  ] };
}

/** Preserve evidence eligibility: fetching or analyzing a row is not proof the final model saw it. */
export function historyExcludedIds(input: {
  groupChat: boolean;
  recentIds: readonly string[];
  suppliedIds: readonly string[];
}): Set<string> {
  return new Set([...(input.groupChat ? [] : input.recentIds), ...input.suppliedIds]);
}
