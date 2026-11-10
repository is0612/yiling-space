import assert from "node:assert/strict";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";

const BASE = "/api/characters/char-a/growth/knowledge";
function candidate(id: string, status = "PENDING") {
  return { id, status, rawContent: id, sourceType: "MANUAL", sourceRef: null, processedResult: null, processingError: null, processedAt: null, createdAt: "2026-11-10", relatedItems: [] };
}
function workspace(candidates: unknown[]) { return { candidates, items: [], candidateCount: candidates.length, itemCount: 0 }; }
async function setup() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take(BASE).resolve(workspace([candidate("a"), candidate("b", "FAILED"), candidate("review", "REVIEW"), candidate("done", "ACCEPTED")]));
  await flushMicrotasks();
  return page;
}
async function selectedOnlyAndDuplicateGuard() {
  const page = await setup();
  page.set("selectedProcessIds", ["b", "done"]);
  const running = page.call("runBatchCandidates");
  const request = page.take(`${BASE}/candidates/b/process`, "POST");
  await page.call("runBatchCandidates");
  await page.call("runCandidate", candidate("a"));
  assert.equal(page.requests.length, 0, "批量期间不能重复启动或单条整理");
  request.resolve({ candidate: { status: "REVIEW", processedResult: null, processedAt: "now" } });
  await flushMicrotasks();
  page.take(BASE).resolve(workspace([candidate("b", "REVIEW")]));
  await running;
  assert.equal(page.read<{ succeeded: number }>("batchProgress").succeeded, 1);
  assert.equal(page.read("batchRunning"), false);
  page.finish();
}
async function failureContinues() {
  const page = await setup();
  const running = page.call("runBatchCandidates");
  const first = page.take(`${BASE}/candidates/a/process`, "POST");
  assert.equal(page.requests.length, 0, "每次只发一个模型请求");
  first.reject({ data: { statusMessage: "模型不可用" } });
  await flushMicrotasks();
  page.take(`${BASE}/candidates/b/process`, "POST").resolve({ candidate: { status: "REVIEW" } });
  await flushMicrotasks();
  page.take(BASE).resolve(workspace([candidate("a", "FAILED"), candidate("b", "REVIEW")]));
  await running;
  const progress = page.read<{ completed: number; failed: number; succeeded: number }>("batchProgress");
  assert.equal(progress.completed, 2);
  assert.equal(progress.failed, 1);
  assert.equal(progress.succeeded, 1);
  assert.equal(page.read<Array<{ message: string }>>("batchFailures")[0]?.message, "模型不可用");
  assert.equal(page.read<string[]>("selectedProcessIds").join(), "a");
  assert.equal(page.warnings.length, 1);
  page.finish();
}
async function stopAndRoleChange() {
  const page = await setup();
  const running = page.call("runBatchCandidates");
  const first = page.take(`${BASE}/candidates/a/process`, "POST");
  page.set("batchStopRequested", true);
  first.resolve({ candidate: { status: "REVIEW" } });
  await flushMicrotasks();
  page.take(BASE).resolve(workspace([candidate("a", "REVIEW"), candidate("b")]));
  await running;
  assert.equal(page.read<{ completed: number }>("batchProgress").completed, 1);
  page.finish();

  const other = await setup();
  const old = other.call("runBatchCandidates");
  const oldRequest = other.take(`${BASE}/candidates/a/process`, "POST");
  other.switchRole("char-b");
  other.take("/api/characters/char-b/growth/knowledge").resolve(workspace([]));
  oldRequest.resolve({ candidate: { status: "REVIEW" } });
  await old;
  assert.equal(other.read<{ total: number }>("batchProgress").total, 0);
  assert.equal(other.read("batchRunning"), false);
  assert.equal(other.successes.length, 0);
  other.finish();
}
async function unmountStopsQueue() {
  const page = await setup();
  const running = page.call("runBatchCandidates");
  const first = page.take(`${BASE}/candidates/a/process`, "POST");
  page.unmount();
  first.resolve({ candidate: { status: "REVIEW" } });
  await running;
  assert.equal(page.successes.length, 0);
  page.finish();
}
await selectedOnlyAndDuplicateGuard();
await failureContinues();
await stopAndRoleChange();
await unmountStopsQueue();
console.log("知识批量整理通过：勾选范围、串行调用、防重复、失败继续、停止、角色隔离与卸载保护。");
