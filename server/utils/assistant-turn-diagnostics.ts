import { ASSISTANT_TURN_STAGES } from "./assistant-turn-context";
export type AssistantTurnDiagnostics = {
  version: 1; elapsedMs: number;
  stages: Array<{
    stage: "context" | "memory" | "knowledge" | "response";
    limit: number; logicalCalls: number; budgetRejections: number; skipped: "not_enabled" | "not_needed" | null;
    operations: Array<{
      state: "running" | "success" | "no_sources" | "failed" | "budget_exhausted";
      durationMs: number; reportedAttempts: number; rejectedDiagnostics: number;
      attempts: Array<{ status: "success" | "failed" | "timeout" | "http_error" | "invalid_response" | "truncated"; durationMs: number; usageReported: boolean; finishReason?: "stop" | "length" | "content_filter" | "unknown" }>;
    }>;
  }>;
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const integer = (value: unknown, max: number): number => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;
/** Read hostile stored metadata through an explicit, bounded allowlist. */
export function sanitizeAssistantTurnDiagnostics(value: unknown): AssistantTurnDiagnostics | undefined {
  const root = object(value);
  if (root.version !== 1 || !Array.isArray(root.stages)) return undefined;
  const seen = new Set<string>();
  const stages: AssistantTurnDiagnostics["stages"] = [];
  for (const entry of root.stages.slice(0, 4)) {
    const row = object(entry), stage = row.stage;
    if (typeof stage !== "string" || !ASSISTANT_TURN_STAGES.includes(stage as typeof ASSISTANT_TURN_STAGES[number]) || seen.has(stage)) continue;
    seen.add(stage);
    const limit = stage === "response" ? 2 : 1;
    const operations: AssistantTurnDiagnostics["stages"][number]["operations"] = [];
    for (const entry of (Array.isArray(row.operations) ? row.operations : []).slice(0, limit)) {
      const op = object(entry);
      if (typeof op.state !== "string" || !["running", "success", "no_sources", "failed", "budget_exhausted"].includes(op.state)) continue;
      const attempts: typeof operations[number]["attempts"] = [];
      for (const entry of (Array.isArray(op.attempts) ? op.attempts : []).slice(0, 16)) {
        const attempt = object(entry);
        if (typeof attempt.status !== "string" || !["success", "failed", "timeout", "http_error", "invalid_response", "truncated"].includes(attempt.status)) continue;
        attempts.push({ status: attempt.status as typeof attempts[number]["status"], durationMs: integer(attempt.durationMs, 3_600_000), usageReported: attempt.usageReported === true,
          ...(typeof attempt.finishReason === "string" && ["stop", "length", "content_filter", "unknown"].includes(attempt.finishReason) ? { finishReason: attempt.finishReason as "stop" | "length" | "content_filter" | "unknown" } : {}),
        });
      }
      operations.push({ state: op.state as typeof operations[number]["state"], durationMs: integer(op.durationMs, 3_600_000), reportedAttempts: attempts.length, rejectedDiagnostics: integer(op.rejectedDiagnostics, 1000), attempts });
    }
    stages.push({ stage: stage as typeof stages[number]["stage"], limit, logicalCalls: integer(row.logicalCalls, limit), budgetRejections: integer(row.budgetRejections, 1000),
      skipped: row.skipped === "not_enabled" || row.skipped === "not_needed" ? row.skipped : null, operations });
  }
  return { version: 1, elapsedMs: integer(root.elapsedMs, 3_600_000), stages };
}
