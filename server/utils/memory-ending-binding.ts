/** 严格读取事件绑定，不修剪、过滤或截断非法目标。 */
export function readEndedMemoryIds(value: unknown, allowed: (id: string) => boolean): string[] | null {
  if (!Array.isArray(value) || !value.every(id => typeof id === "string" && allowed(id))
    || new Set(value).size !== value.length) return null;
  return value;
}

/** 返回不可变快照数组内的实际下标；全部结束证据必须属于同一个事件。 */
export function matchingEndingEventIndexes(
  events: readonly unknown[] | undefined,
  memoryId: string,
  endingIds: readonly string[],
  allowed: (id: string) => boolean,
): number[] {
  if (!Array.isArray(events) || !endingIds.length) return [];
  return events.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const event = value as Record<string, unknown>;
    const targets = readEndedMemoryIds(event.endedMemoryIds, allowed);
    const evidence = event.evidenceMessageIds;
    if (!targets?.includes(memoryId) || typeof event.title !== "string" || !event.title.trim()
      || typeof event.detail !== "string" || !event.detail.trim()
      || !Array.isArray(evidence) || evidence.length > 10
      || !evidence.every(id => typeof id === "string")
      || !endingIds.every(id => evidence.includes(id))) return [];
    return [index];
  });
}
