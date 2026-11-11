import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAssistantTurnContext, AssistantTurnBudgetError, type AssistantTurnInput } from "../server/utils/assistant-turn-context";
function input(): AssistantTurnInput { return { turnId: randomUUID(), identity: { characterId: randomUUID(), channel: "qq-group", channelBindingId: randomUUID(), conversationKey: "g:synthetic", readableScopeIds: [randomUUID()], allowPrivate: false }, evidenceIds: ["message-a"] }; }
const key = { query: "历史问题", sourceVersion: "version-a" };
const stage = (turn: ReturnType<typeof createAssistantTurnContext>, name: string) => turn.snapshot().stages.find(row => row.stage === name)!;
{
  const source = input(); const turn = createAssistantTurnContext(source);
  source.identity.readableScopeIds = [randomUUID()]; source.evidenceIds = ["foreign"];
  assert(turn.hasEvidence("message-a")); assert(!turn.hasEvidence("foreign"));
  assert(Object.isFrozen(turn)); assert(Object.isFrozen(turn.identity)); assert(Object.isFrozen(turn.identity.readableScopeIds));
  assert.throws(() => createAssistantTurnContext({ ...input(), identity: { ...input().identity, allowPrivate: true } } as unknown as AssistantTurnInput));
  assert.throws(() => createAssistantTurnContext({ ...input(), evidenceIds: [""] }));
}
{
  const turn = createAssistantTurnContext(input()); let calls = 0; let resolve!: (value: { value: string[]; state: "no_sources" }) => void;
  const a = turn.runOnce("memory", key, async () => { calls++; return new Promise(done => { resolve = done; }); });
  const b = turn.runOnce("memory", { ...key, query: "  历史问题  " }, async () => { throw Error("duplicate"); });
  assert.strictEqual(a, b); await Promise.resolve(); assert.equal(calls, 1); assert.equal(stage(turn, "memory").operations[0]!.state, "running");
  resolve({ value: [], state: "no_sources" }); assert.equal((await a).state, "no_sources");
  assert.strictEqual(turn.runOnce("memory", key, async () => { throw Error("must cache empty"); }), a);
  await assert.rejects(turn.runOnce("memory", { ...key, sourceVersion: "version-b" }, async () => ({ state: "success", value: 1 })), AssistantTurnBudgetError);
  assert.equal(stage(turn, "memory").logicalCalls, 1); assert.equal(stage(turn, "memory").budgetRejections, 1);
}
{
  const turn = createAssistantTurnContext(input()); const original = Error("secret provider body"); let calls = 0;
  const a = turn.runOnce("context", key, () => { calls++; throw original; });
  await assert.rejects(a, error => error === original);
  assert.strictEqual(turn.runOnce("context", key, async () => ({ state: "success", value: 2 })), a);
  await assert.rejects(a); assert.equal(calls, 1); assert.equal(stage(turn, "context").operations[0]!.state, "failed");
  assert(!JSON.stringify(turn.snapshot()).includes("secret"));
}
{
  let time = 100; const turn = createAssistantTurnContext({ ...input(), now: () => time });
  await turn.runOnce("response", { query: "first", sourceVersion: "a" }, async record => {
    record({ attemptId: "a", status: "truncated", durationMs: 4, usageReported: true, finishReason: "length" });
    record({ attemptId: "a", status: "truncated", durationMs: 4, usageReported: true });
    record({ attemptId: "b", status: "success", durationMs: 8, usageReported: false });
    time = 120; return { value: "first", state: "success" };
  });
  await turn.runOnce("response", { query: "final", sourceVersion: "b" }, async () => ({ value: "final", state: "success" }));
  await assert.rejects(turn.runOnce("response", { query: "third", sourceVersion: "c" }, async () => ({ value: "bad", state: "success" })), AssistantTurnBudgetError);
  assert.equal(stage(turn, "response").logicalCalls, 2); assert.equal(stage(turn, "response").operations[0]!.attempts.length, 2);
  time = 90; assert.equal(turn.snapshot().elapsedMs, 20);
  const snapshot = turn.snapshot(); snapshot.stages[0]!.logicalCalls = 999; assert.equal(stage(turn, "context").logicalCalls, 0);
}
{
  const a = createAssistantTurnContext(input()), b = createAssistantTurnContext(input()); let calls = 0;
  const run = async () => { calls++; return { value: "okay", state: "success" as const }; };
  await Promise.all([a.runOnce("knowledge", key, run), b.runOnce("knowledge", key, run)]); assert.equal(calls, 2);
  a.skip("context", "not_enabled"); a.skip("context", "not_enabled");
  assert.throws(() => a.skip("context", "not_needed")); await assert.rejects(a.runOnce("context", key, run));
  assert.throws(() => a.skip("knowledge", "not_needed"));
}
{
  const turn = createAssistantTurnContext(input());
  await turn.runOnce("context", key, async record => {
    assert.doesNotThrow(() => record({ attemptId: "bad", status: "success", durationMs: -1, usageReported: true }));
    record({ attemptId: "known", status: "success", durationMs: 1, usageReported: false, finishReason: "stop", secret: "sk-private" } as Parameters<typeof record>[0]);
    return { value: "secret-result", state: "success" };
  });
  await turn.runOnce("response", key, async record => { record({ attemptId: "known", status: "success", durationMs: 1, usageReported: true }); return { value: 1, state: "success" }; });
  assert.equal(stage(turn, "response").operations[0]!.attempts.length, 0, "Duplicate telemetry cannot invalidate success");
  const data = JSON.stringify(turn.snapshot()); assert(!data.includes("sk-private")); assert(!data.includes("secret-result")); assert(!data.includes("历史问题")); assert(!data.includes(turn.identity.characterId));
}
{
  const turn = createAssistantTurnContext(input());
  const produced = { value: { evidence: [{ title: "original" }] }, state: "success" as const };
  const result = await turn.runOnce("knowledge", key, async record => {
    for (let i = 0; i < 20; i++) record({ attemptId: `attempt-${i}`, status: "success", durationMs: 1, usageReported: true });
    return produced;
  });
  produced.value.evidence[0]!.title = "mutated";
  assert.equal(result.value.evidence[0]!.title, "original");
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.value.evidence[0]));
  assert.equal(stage(turn, "knowledge").operations[0]!.attempts.length, 16);
  assert.equal(stage(turn, "knowledge").operations[0]!.state, "success");
  const bad = createAssistantTurnContext(input());
  await assert.rejects(bad.runOnce("knowledge", key, async () => ({ value: new Map(), state: "success" })), /plain JSON/);
}
console.log("Assistant turn context: immutable trusted inputs, concurrent Promise reuse, cached empty/failure, logical budgets, attempt dedupe, diagnostics privacy and turn isolation passed.");
