import { createHash } from "node:crypto";

/** Fingerprint the complete scanned content, never the clipped model excerpt. */
export function staleMemoryFingerprint(row: { memoryScopeId: string; category: string; content: string; importance: number; updatedAt: Date }): string {
  return createHash("sha256").update(JSON.stringify([row.memoryScopeId, row.category, row.content, row.importance, row.updatedAt.toISOString()])).digest("hex");
}

export function staleEventFingerprint(row: { memoryScopeId: string; dayKey: string; title: string; detail: string; participants: string[] }): string {
  return createHash("sha256").update(JSON.stringify([row.memoryScopeId, row.dayKey, row.title, row.detail, row.participants])).digest("hex");
}

export function requireStaleFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("条目缺少有效的体检版本，请重新体检。");
  return value;
}
