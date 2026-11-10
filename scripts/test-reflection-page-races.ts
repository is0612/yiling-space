import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";

const path = "../app/pages/growth/reflection.vue";
const base = (role = "char-a") => `/api/characters/${role}/growth/reflections`;
const stamp = "2026-11-10T00:00:00Z";
function suggestion(id = "suggestion-a", status = "PENDING") {
  return { id, title: "逐渐重视证据", observation: "记录中有可核对的事实", inference: "可能形成了核对习惯", recommendation: "继续核对来源",
    sourceRefs: [{ key: "memory:one", type: "memory", id: "memory-one", title: "一次核对", hash: "abc", excerpt: "只引用这段事实" }],
    status, reviewNote: null, reviewedAt: null, acceptedAt: status === "ACCEPTED" ? stamp : null };
}
function run(id = "run-a", status = "SUCCEEDED", suggestions = [suggestion()]) {
  return { id, periodStart: stamp, periodEnd: stamp, status, attemptCount: 1, maxAttempts: 3, runAt: stamp, lastError: null,
    model: "test-model", promptVersion: "v1", createdAt: stamp, completedAt: stamp, suggestions };
}
function list(items = [run()], page = 1, total = items.length) { return { items, total, page, pageSize: 20, totalPages: Math.max(1, Math.ceil(total / 20)), hasMore: false }; }
async function setup() {
  const page = buildPageHarness(path);
  page.take(base()).resolve(list()); await flushMicrotasks(); return page;
}
async function listGenerationAndLatestRequest() {
  const page = buildPageHarness(path);
  const oldA = page.take(base());
  page.switchRole("char-b"); const b = page.take(base("char-b"));
  page.switchRole("char-a"); const a = page.take(base());
  oldA.resolve(list([run("old-a")])); b.reject({ statusCode: 404 }); await flushMicrotasks();
  assert.equal(page.read<unknown[]>("runs").length, 0); assert.equal(page.read("loadError"), "");
  a.resolve(list([run("new-a")])); await flushMicrotasks();
  page.call("changePage", 2); const two = page.take(base()); assert.equal(two.options?.query?.page, 2); assert.equal(two.options?.query?.pageSize, 20);
  page.call("changePage", 3); const three = page.take(base());
  three.resolve(list([run("page-three")], 3, 50)); two.resolve(list([run("stale-two")], 2, 50)); await flushMicrotasks();
  assert.equal(page.read<Array<{ id: string }>>("runs")[0]?.id, "page-three"); page.finish();
}
async function createRequiresConfirmationAndReusesKey() {
  const page = await setup();
  await page.call("confirmCreate"); assert.equal(page.requests.length, 0);
  page.call("openCreate"); assert.equal(page.read("createOpen"), true);
  const first = page.call("confirmCreate"); const request = page.take(base(), "POST");
  const body = request.options?.body as { requestKey: string; days: number };
  assert.match(body.requestKey, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(body.days, 7); assert.deepEqual(Object.keys(body).sort(), ["days", "requestKey"]);
  request.reject(new Error("network")); await first;
  assert.match(page.read<string>("createError"), /同一请求编号/);
  page.call("closeConfirmations"); page.call("openCreate");
  const retry = page.call("confirmCreate"); const retried = page.take(base(), "POST");
  assert.equal((retried.options?.body as { requestKey: string }).requestKey, body.requestKey);
  retried.resolve({ run: run("queued", "QUEUED"), created: false }); await flushMicrotasks();
  page.take(base()).resolve(list([run("queued", "QUEUED")])); await retry;
  assert.equal(page.read("createOpen"), false); assert.equal(page.successes.length, 1); assert.notEqual(page.read("requestKey"), body.requestKey);
  page.call("openCreate");
  const reuse = page.call("confirmCreate");
  page.take(base(), "POST").resolve({ run: run("existing"), created: false }); await flushMicrotasks();
  page.take(base()).resolve(list([run("existing")])); await reuse;
  assert.match(page.successes.at(-1)!, /资料没有变化.*不会重复生成/);
  page.call("openCreate"); const key = page.read("requestKey"); page.call("changeDays", 14);
  assert.equal(page.read("createOpen"), false); assert.notEqual(page.read("requestKey"), key);
  page.call("openCreate"); const changed = page.call("confirmCreate"); const changedRequest = page.take(base(), "POST");
  assert.equal((changedRequest.options?.body as { days: number }).days, 14);
  changedRequest.reject({ statusCode: 409 }); await changed; assert.match(page.read<string>("createError"), /状态已发生变化/); page.finish();
}
async function createWriteAndConfirmationAbaGuards() {
  const page = await setup();
  page.call("openCreate"); const action = page.call("confirmCreate"); const old = page.take(base(), "POST");
  page.switchRole("char-b"); const b = page.take(base("char-b"));
  page.switchRole("char-a"); const a = page.take(base());
  b.resolve(list()); a.resolve(list([run("current")])); await flushMicrotasks();
  old.resolve({ run: run("old"), created: true }); await action;
  assert.equal(page.successes.length, 0); assert.equal(page.requests.length, 0); assert.equal(page.read("createOpen"), false);
  assert.equal(page.read<Array<{ id: string }>>("runs")[0]?.id, "current");
  page.call("openCreate"); page.switchRole("char-b"); const finalB = page.take(base("char-b"));
  await page.call("confirmCreate"); assert.equal(page.requests.length, 0, "Old confirmation cannot submit under a new role");
  finalB.resolve(list()); await flushMicrotasks(); page.finish();
}
async function retryContractAndTerminalGate() {
  const page = await setup();
  page.call("openRetry", run("running", "RUNNING")); assert.equal(page.read("retryOpen"), false);
  page.call("openRetry", run("failed", "FAILED")); assert.equal(page.read("retryOpen"), true);
  const action = page.call("confirmRetry"); const request = page.take(`${base()}/failed/retry`, "POST");
  assert.equal(JSON.stringify(request.options?.body), "{}"); request.reject({ statusCode: 409 }); await action;
  assert.match(page.read<string>("retryError"), /状态已发生变化/);
  const retry = page.call("confirmRetry"); page.take(`${base()}/failed/retry`, "POST").resolve({}); await flushMicrotasks();
  page.take(base()).resolve(list([run("failed", "QUEUED")])); await retry;
  assert.equal(page.successes.length, 1); assert.equal(page.read("retryOpen"), false); page.finish();
}
async function reviewContractAndConclusionFilter() {
  const page = await setup();
  for (const status of ["ACCEPTED", "REJECTED"]) { page.call("openReview", suggestion("done", status), "ACCEPTED"); assert.equal(page.read("reviewOpen"), false); }
  page.call("openReview", suggestion(), "ACCEPTED"); assert.equal(page.read("reviewOpen"), true);
  page.set("reviewNote", "x".repeat(501)); await page.call("confirmReview"); assert.equal(page.requests.length, 0); assert.match(page.read<string>("reviewError"), /500/);
  page.set("reviewNote", " 依据充分 "); const action = page.call("confirmReview");
  const request = page.take(`${base()}/suggestions/suggestion-a/review`, "POST");
  assert.equal(JSON.stringify(request.options?.body), JSON.stringify({ decision: "ACCEPTED", note: "依据充分" }));
  request.resolve({ suggestion: suggestion("suggestion-a", "ACCEPTED") }); await flushMicrotasks();
  page.take(base()).resolve(list([run("accepted-run", "SUCCEEDED", [suggestion("accepted", "ACCEPTED"), suggestion("pending")]), run("pending-only")])); await action;
  assert.match(page.successes[0]!, /不会修改人设或注入对话提示词/);
  page.call("setView", "accepted"); assert.equal(page.read<unknown[]>("visibleRuns").length, 1);
  assert.equal((await page.call<unknown[]>("shownSuggestions", page.read<unknown[]>("visibleRuns")[0])).length, 1);
  page.call("openReview", suggestion("deferred", "DEFERRED"), "DEFERRED"); assert.equal(page.read("reviewOpen"), false);
  page.call("openReview", suggestion("deferred", "DEFERRED"), "REJECTED"); assert.equal(page.read("reviewOpen"), true);
  page.finish();
}
async function reviewRetryAbaAndDismissedConfirmation() {
  const page = await setup();
  page.call("openReview", suggestion(), "DEFERRED"); const review = page.call("confirmReview"); const oldReview = page.take(`${base()}/suggestions/suggestion-a/review`, "POST");
  page.switchRole("char-b"); const b = page.take(base("char-b")); page.switchRole("char-a"); const a = page.take(base());
  a.resolve(list()); b.resolve(list()); await flushMicrotasks(); oldReview.reject({ statusCode: 404 }); await review;
  assert.equal(page.read("reviewError"), ""); assert.equal(page.successes.length, 0);
  page.call("openRetry", run("failed", "FAILED")); const retry = page.call("confirmRetry"); const oldRetry = page.take(`${base()}/failed/retry`, "POST");
  page.call("closeConfirmations"); page.call("openReview", suggestion("new"), "ACCEPTED");
  oldRetry.resolve({}); await retry; assert.equal(page.read("reviewOpen"), true); assert.equal(page.successes.length, 0); assert.equal(page.requests.length, 0);
  page.finish();
}
async function deleteContractConfirmationAndLastPage() {
  const page = await setup();
  await page.call("confirmDelete"); assert.equal(page.requests.length, 0);
  for (const status of ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]) {
    page.call("openDelete", run(`delete-${status}`, status));
    assert.equal(page.read("deleteOpen"), true, `${status} must be deletable`);
    page.call("closeConfirmations"); await page.call("confirmDelete"); assert.equal(page.requests.length, 0);
  }
  page.call("changePage", 3); page.take(base()).resolve(list([run("last-page")], 3, 41)); await flushMicrotasks();
  page.call("openDelete", run("last-page"));
  const action = page.call("confirmDelete"); const request = page.take(`${base()}/last-page`, "DELETE");
  assert.equal(request.options?.body, undefined);
  await page.call("confirmDelete"); assert.equal(page.requests.length, 0, "Double confirmation sends one DELETE");
  request.reject({ statusCode: 403 }); await action;
  assert.equal(page.read("deleteSaving"), false); assert.equal(page.read("deleteOpen"), true);
  assert.match(page.read<string>("deleteError"), /无权/);
  const retry = page.call("confirmDelete"); page.take(`${base()}/last-page`, "DELETE").resolve({ deletedRuns: 1, deletedSuggestions: 2 }); await flushMicrotasks();
  const refresh = page.take(base()); assert.equal(refresh.options?.query?.page, 1);
  assert.equal(page.read<unknown[]>("runs").length, 0); assert.equal(page.read("deleteOpen"), false);
  refresh.resolve(list([run("first-page")], 1, 40)); await retry;
  assert.match(page.successes[0]!, /1 次反思.*2 条建议.*成长结论.*相同来源/);
  page.call("openDelete");
  const clear = page.call("confirmDelete"); const all = page.take(base(), "DELETE");
  await page.call("confirmDelete"); assert.equal(page.requests.length, 0);
  all.resolve({ deletedRuns: 40, deletedSuggestions: 50 }); await flushMicrotasks();
  const cleared = page.take(base()); assert.equal(cleared.options?.query?.page, 1);
  cleared.resolve(list([], 1, 0)); await clear;
  assert.equal(page.read("total"), 0); assert.equal(page.read<unknown[]>("runs").length, 0);
  page.call("openDelete"); assert.equal(page.read("deleteOpen"), false, "Empty roles cannot open clear-all confirmation");
  page.finish();
}
async function deleteAbaDismissalAndStaleReads() {
  for (const all of [false, true]) {
    const page = await setup();
    page.call("openDelete", ...(all ? [] : [run()]));
    const action = page.call("confirmDelete"); const request = page.take(all ? base() : `${base()}/run-a`, "DELETE");
    page.switchRole("char-b"); const b = page.take(base("char-b")); page.switchRole("char-a"); const a = page.take(base());
    a.resolve(list([run("new-a")])); b.resolve(list()); await flushMicrotasks();
    page.call("openDelete", run("new-a")); assert.equal(page.read("deleteOpen"), false, "In-flight deletion remains locked through role ABA");
    request.resolve({ deletedRuns: 1, deletedSuggestions: 1 }); await action;
    assert.equal(page.successes.length, 0); assert.equal(page.requests.length, 0);
    assert.equal(page.read<Array<{ id: string }>>("runs")[0]?.id, "new-a");
    page.call("openDelete", run("new-a"));
    const dismissed = page.call("confirmDelete"); const old = page.take(`${base()}/new-a`, "DELETE");
    page.call("closeConfirmations"); page.call("openReview", suggestion("current"), "ACCEPTED");
    old.reject(new Error("late failure")); await dismissed;
    assert.equal(page.read("reviewOpen"), true); assert.equal(page.read("deleteError"), ""); assert.equal(page.requests.length, 0);
    page.call("closeConfirmations");
    page.call("load"); const stale = page.take(base());
    page.call("openDelete"); const final = page.call("confirmDelete");
    page.take(base(), "DELETE").resolve({ deletedRuns: 1, deletedSuggestions: 1 }); await flushMicrotasks();
    const refresh = page.take(base());
    stale.resolve(list([run("deleted-row")])); await flushMicrotasks();
    assert.equal(page.read<unknown[]>("runs").length, 0, "A pre-delete GET cannot restore deleted rows");
    refresh.resolve(list([], 1, 0)); await final; page.finish();
  }
  const page = await setup();
  page.call("openDelete", run()); page.switchRole("char-b"); const b = page.take(base("char-b"));
  await page.call("confirmDelete"); assert.equal(page.requests.length, 0, "A stale confirmation cannot delete the newly selected role");
  b.resolve(list()); await flushMicrotasks();
  page.call("openDelete"); const action = page.call("confirmDelete"); const pending = page.take(base("char-b"), "DELETE");
  page.unmount(); pending.reject({ statusCode: 404 }); await action;
  assert.equal(page.read("deleteError"), ""); assert.equal(page.successes.length, 0); page.finish();
}
async function errorsUnmountAndReadOnlyGet() {
  const page = buildPageHarness(path); const request = page.take(base());
  assert.equal(request.options?.method, undefined, "Reading records must use GET only");
  request.reject({ statusCode: 404 }); await flushMicrotasks(); assert.match(page.read<string>("loadError"), /不存在/);
  page.call("load"); const pending = page.take(base()); page.unmount(); pending.resolve(list([run("late")])); await flushMicrotasks();
  assert.equal(page.read<unknown[]>("runs").length, 0); page.finish();
}
await listGenerationAndLatestRequest();
await createRequiresConfirmationAndReusesKey();
await createWriteAndConfirmationAbaGuards();
await retryContractAndTerminalGate();
await reviewContractAndConclusionFilter();
await reviewRetryAbaAndDismissedConfirmation();
await deleteContractConfirmationAndLastPage();
await deleteAbaDismissalAndStaleReads();
await errorsUnmountAndReadOnlyGet();
const source = readFileSync(new URL(path, import.meta.url), "utf8");
for (const label of ["观察到的事实", "可能的推断", "建议如何行动", "成长结论", "调用费用", "公开事实", "清空全部反思", "删除本次反思", "不可撤销", "相同来源可重新发起反思", "后台旧结果不会恢复"]) assert(source.includes(label));
assert(source.includes('v-if="total > 0"'));
assert(!source.includes("v-html")); assert(!source.includes("setInterval"));
assert(!/font-size:\s*(?:[0-9]|1[01])px/u.test(source));
console.log("Reflection page: 9 real-script race/contract groups passed (no database or model calls).");
