import { createHash } from "node:crypto";

export const ASSISTANT_TURN_STAGES = ["context", "memory", "knowledge", "response"] as const;
export type AssistantTurnStage = typeof ASSISTANT_TURN_STAGES[number];
export type AssistantStageState = "not_enabled" | "not_needed" | "running" | "success" | "no_sources" | "failed" | "budget_exhausted";
export type AssistantAttempt = {
  attemptId: string;
  status: "success" | "failed" | "timeout" | "http_error" | "invalid_response" | "truncated";
  durationMs: number;
  usageReported: boolean;
  finishReason?: "stop" | "length" | "content_filter" | "unknown";
};
export type AssistantOperationKey = { query: string; sourceVersion: string };
export type AssistantOperationResult<T> = { value: T; state: "success" | "no_sources" };
export type AssistantTurnInput = {
  turnId: string;
  identity: {
    characterId: string; channel: "qq-group"; channelBindingId: string; conversationKey: string;
    readableScopeIds: readonly string[]; allowPrivate: false;
  };
  evidenceIds: readonly string[];
  /** Must be supplied by a trusted server caller; this module does not perform authorization. */
  now?: () => number;
};
const POLICY = Object.freeze({ context: 1, memory: 1, knowledge: 1, response: 2 });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) throw new TypeError(`Invalid ${label}`);
}
function stageName(stage: AssistantTurnStage) {
  if (!ASSISTANT_TURN_STAGES.includes(stage)) throw new TypeError("Invalid assistant stage");
}
export class AssistantTurnBudgetError extends Error {
  constructor(public readonly stage: AssistantTurnStage) { super(`Assistant logical budget exhausted: ${stage}`); this.name = "AssistantTurnBudgetError"; }
}

/** Cache only plain JSON-compatible evidence; copy before freezing so producers retain ownership. */
function immutableResult<T>(value: T): T {
  const seen = new WeakSet<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new TypeError("Assistant result nesting limit exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)) throw new TypeError("Assistant results must be acyclic JSON data");
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = Object.freeze(item.map(entry => copy(entry, depth + 1)));
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError("Assistant results must be plain JSON data");
      result = Object.freeze(Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, copy(entry, depth + 1)])));
    }
    seen.delete(item);
    return result;
  };
  return copy(value, 0) as T;
}

type Operation = {
  stage: AssistantTurnStage; state: AssistantStageState; startedAt: number; completedAt?: number;
  attempts: Map<string, AssistantAttempt>; rejectedDiagnostics: number; promise: Promise<unknown>;
};

/** Request-local control only. No DB, model calls, global cache, automatic retries or deadline. */
export function createAssistantTurnContext(input: AssistantTurnInput) {
  identifier(input.turnId, "turn id");
  identifier(input.identity.characterId, "character id");
  identifier(input.identity.channelBindingId, "binding id");
  if (input.identity.channel !== "qq-group" || input.identity.allowPrivate !== false) throw new TypeError("Only public group turns are supported");
  if (typeof input.identity.conversationKey !== "string" || !input.identity.conversationKey.trim() || input.identity.conversationKey.length > 512) throw new TypeError("Invalid conversation key");
  if (!Array.isArray(input.identity.readableScopeIds) || !input.identity.readableScopeIds.length || input.identity.readableScopeIds.length > 50) throw new TypeError("Invalid readable scopes");
  const scopes = [...new Set(input.identity.readableScopeIds)];
  scopes.forEach(id => identifier(id, "scope id"));
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length > 1000 || input.evidenceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200)) throw new TypeError("Invalid evidence ids");
  const evidence = new Set(input.evidenceIds);
  const identity = Object.freeze({
    characterId: input.identity.characterId, channel: "qq-group" as const,
    channelBindingId: input.identity.channelBindingId, conversationKey: input.identity.conversationKey,
    readableScopeIds: Object.freeze(scopes.sort()), allowPrivate: false as const,
  });
  const now = input.now ?? Date.now;
  let lastTime = now();
  if (!Number.isFinite(lastTime)) throw new TypeError("Invalid clock");
  const startedAt = lastTime;
  const time = () => { const value = now(); if (Number.isFinite(value)) lastTime = Math.max(lastTime, value); return lastTime; };
  const turnId = input.turnId;
  const scopeDigest = digest([turnId, identity.characterId, identity.channelBindingId, identity.conversationKey, identity.readableScopeIds]);
  const operations = new Map<string, Operation>();
  const skipped = new Map<AssistantTurnStage, "not_enabled" | "not_needed">();
  const logical = { context: 0, memory: 0, knowledge: 0, response: 0 };
  const rejected = { context: 0, memory: 0, knowledge: 0, response: 0 };
  const attemptIds = new Set<string>();
  const keyOf = (stage: AssistantTurnStage, key: AssistantOperationKey) => {
    stageName(stage);
    if (!key || typeof key.query !== "string" || key.query.length > 2000 || typeof key.sourceVersion !== "string" || !key.sourceVersion.trim() || key.sourceVersion.length > 512) throw new TypeError("Invalid assistant operation key");
    // Whitespace/case can be meaningful evidence. Trim only; callers own query canonicalization.
    return digest([scopeDigest, stage, key.query.trim(), key.sourceVersion]);
  };
  return Object.freeze({
    turnId, identity, startedAt, policy: POLICY,
    hasEvidence(id: string) { return evidence.has(id); },
    runOnce<T>(stage: AssistantTurnStage, key: AssistantOperationKey, run: (attempt: (data: AssistantAttempt) => void) => Promise<AssistantOperationResult<T>>): Promise<AssistantOperationResult<T>> {
      const hash = keyOf(stage, key);
      const previous = operations.get(hash);
      if (previous) return previous.promise as Promise<AssistantOperationResult<T>>;
      if (skipped.has(stage)) return Promise.reject(new Error("Assistant stage already skipped"));
      if (logical[stage] >= POLICY[stage]) { rejected[stage]++; return Promise.reject(new AssistantTurnBudgetError(stage)); }
      logical[stage]++;
      const operation: Operation = { stage, state: "running", startedAt: time(), attempts: new Map(), rejectedDiagnostics: 0, promise: Promise.resolve() };
      // Defer execution until the cache entry exists, including synchronous throws and re-entrancy.
      operation.promise = Promise.resolve().then(() => run(data => {
        try {
        if (operation.state !== "running") throw new Error("Assistant operation already settled");
        if (!data || typeof data.attemptId !== "string" || !data.attemptId || data.attemptId.length > 200
          || !["success", "failed", "timeout", "http_error", "invalid_response", "truncated"].includes(data.status)
          || !Number.isFinite(data.durationMs) || data.durationMs < 0 || typeof data.usageReported !== "boolean"
          || (data.finishReason !== undefined && !["stop", "length", "content_filter", "unknown"].includes(data.finishReason))) throw new TypeError("Invalid assistant attempt");
        if (operation.attempts.has(data.attemptId)) return;
        if (attemptIds.has(data.attemptId)) throw new Error("Assistant attempt belongs to another operation");
        if (operation.attempts.size >= 16) throw new Error("Assistant attempt diagnostic limit exceeded");
        attemptIds.add(data.attemptId);
        operation.attempts.set(data.attemptId, { attemptId: data.attemptId, status: data.status, durationMs: data.durationMs, usageReported: data.usageReported,
          ...(data.finishReason !== undefined ? { finishReason: data.finishReason } : {}) });
        } catch { operation.rejectedDiagnostics++; /* Best-effort telemetry must not change a valid business result. */ }
      })).then(result => {
        if (!result || !["success", "no_sources"].includes(result.state)) throw new TypeError("Invalid assistant operation result");
        const stored = Object.freeze({ state: result.state, value: immutableResult(result.value) });
        operation.state = stored.state; operation.completedAt = time();
        return stored;
      }).catch((error: unknown) => {
        operation.state = "failed"; operation.completedAt = time();
        // Original failure reaches trusted caller; diagnostics never copy its text or cause.
        throw error;
      });
      operations.set(hash, operation);
      return operation.promise as Promise<AssistantOperationResult<T>>;
    },
    skip(stage: AssistantTurnStage, state: "not_enabled" | "not_needed") {
      stageName(stage);
      if (state !== "not_enabled" && state !== "not_needed") throw new TypeError("Invalid skip state");
      if (logical[stage] || (skipped.has(stage) && skipped.get(stage) !== state)) throw new Error("Assistant stage already started or skipped");
      skipped.set(stage, state);
    },
    /** Counts and allowlisted status only: no identity, query, sources, errors or attempt IDs. */
    snapshot() {
      return { version: 1 as const, elapsedMs: time() - startedAt, stages: ASSISTANT_TURN_STAGES.map(stage => ({
        stage, limit: POLICY[stage], logicalCalls: logical[stage], budgetRejections: rejected[stage], skipped: skipped.get(stage) ?? null,
        operations: [...operations.values()].filter(operation => operation.stage === stage).map(operation => ({
          reportedAttempts: operation.attempts.size, rejectedDiagnostics: operation.rejectedDiagnostics,
          state: operation.state, durationMs: (operation.completedAt ?? time()) - operation.startedAt,
          attempts: [...operation.attempts.values()].map(({ status, durationMs, usageReported, finishReason }) => ({ status, durationMs, usageReported, ...(finishReason ? { finishReason } : {}) })),
        })),
      })) };
    },
  });
}
export type AssistantTurnContext = ReturnType<typeof createAssistantTurnContext>;
