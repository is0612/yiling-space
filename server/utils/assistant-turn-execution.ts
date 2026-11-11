import type { AssistantRequestObserver } from "./assistant-request-diagnostics";
import { createHash, randomUUID } from "node:crypto";
import type { AssistantTurnContext, AssistantTurnStage } from "./assistant-turn-context";

/** Hash data only; credentials and executable callbacks never enter cache keys or snapshots. */
export function assistantTurnFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (key, item: unknown) =>
    /apiKey|authorization|password|secret|encrypted/i.test(key) || typeof item === "function" ? undefined : item,
  )).digest("hex");
}
export function snapshotAssistantTurnData<T>(value: T): T {
  if (value === undefined) return value;
  const freeze = (item: unknown): unknown => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(JSON.parse(JSON.stringify(value))) as T;
}
export async function runAssistantTurnStage<T>(context: AssistantTurnContext | undefined, stage: AssistantTurnStage, query: string, source: unknown, run: (observer?: AssistantRequestObserver) => Promise<T>, noSources?: (value: T) => boolean): Promise<T> {
  if (!context) return run(undefined);
  const result = await context.runOnce(stage, { query: query.slice(0, 2000), sourceVersion: assistantTurnFingerprint(source) }, async record => {
    const observer: AssistantRequestObserver = entry => {
      try { record({ ...entry, attemptId: randomUUID() }); } catch { /* Optional diagnostics never affect generation. */ }
    };
    const value = await run(observer);
    return { value: snapshotAssistantTurnData(value), state: noSources?.(value) ? "no_sources" : "success" };
  });
  return result.value;
}
export function skipAssistantTurnStage(context: AssistantTurnContext | undefined, stage: AssistantTurnStage, state: "not_enabled" | "not_needed") {
  if (!context) return;
  const current = context.snapshot().stages.find(item => item.stage === stage);
  if (!current?.logicalCalls && !current?.skipped) context.skip(stage, state);
}

// One bounded orchestration entry per context; callbacks cannot repeat after cache hits.
const groupExecutions = new WeakMap<AssistantTurnContext, { fingerprint: string; promise: Promise<unknown> }>();
export function executeAssistantGroupTurn<T>(context: AssistantTurnContext, source: unknown, run: () => Promise<T>): Promise<T> {
  const fingerprint = assistantTurnFingerprint(source);
  const previous = groupExecutions.get(context);
  if (previous) {
    if (previous.fingerprint !== fingerprint) return Promise.reject(new Error("Assistant turn context cannot be reused with changed group input"));
    return previous.promise as Promise<T>;
  }
  const promise = Promise.resolve().then(run).then(snapshotAssistantTurnData);
  groupExecutions.set(context, { fingerprint, promise });
  return promise;
}

export function validateAssistantTurnEvidence(context: AssistantTurnContext, input: {
  transcript?: ReadonlyArray<{ id?: string }>;
  groupBackground?: ReadonlyArray<{ id?: string }>;
  recentMessages: ReadonlyArray<{ id?: string }>;
}, extra?: ReadonlyArray<{ id?: string }>, previous?: { evidence?: ReadonlyArray<{ id?: string }> }) {
  for (const row of [...(input.transcript ?? []), ...(input.groupBackground ?? []), ...input.recentMessages, ...(extra ?? []), ...(previous?.evidence ?? [])]) {
    if (row.id && !context.hasEvidence(row.id)) throw new Error("Assistant turn evidence does not match trusted group context");
  }
}
