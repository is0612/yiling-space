import { createHash } from "node:crypto";

/** Global audit readers may not own this private memory; never copy its body. */
export function memoryAuditContentSummary(content: string): { contentHash: string; contentLength: number } {
  return { contentHash: createHash("sha256").update(content).digest("hex"), contentLength: content.length };
}
