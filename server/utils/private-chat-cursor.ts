/**
 * 内部键集游标（带 Date）。与响应里的 `PrivateChatCursor`（`{ before, beforeId }`）
 * 不是一回事：那个是传输形状的字符串，这个是查询用的时间戳 + id。
 * 之前两者同名，跨层读代码很容易以为是同一个东西。
 */
export type PrivateChatKeyset = { occurredAt: Date; id: string };

/** Parse the stable timestamp+id keyset cursor used by private-chat pagination. */
export function readPrivateChatCursor(rawAt: unknown, rawId: unknown): PrivateChatKeyset | null {
  if (rawAt === undefined && rawId === undefined) return null;
  if (typeof rawAt !== "string" || typeof rawId !== "string" || !rawId.trim()) {
    throw new Error("before and beforeId must be provided together.");
  }
  if (rawId.trim().length > 64) throw new Error("beforeId is too long.");
  const occurredAt = new Date(rawAt);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("before must be a valid timestamp.");
  return { occurredAt, id: rawId.trim() };
}

export function privateChatCursorWhere(cursor: PrivateChatKeyset) {
  return {
    OR: [
      { occurredAt: { lt: cursor.occurredAt } },
      { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
    ],
  };
}

export function nextPrivateChatCursor(message: { occurredAt: Date; id: string } | undefined) {
  return message ? { before: message.occurredAt.toISOString(), beforeId: message.id } : null;
}
