import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";
const path = "../app/pages/growth/social/assessments.vue";
const base = (role = "char-a") => `/api/characters/${role}/growth/social/assessments`;
function item(id = "assessment-a", extra: Record<string, unknown> = {}) {
  return { id, scopeId: "scope-a", friend: { displayName: "测试好友", platform: "qq", platformUid: "synthetic", kind: "HUMAN" },
    currentRelationship: { stage: "ACQUAINTANCE", status: "NORMAL", version: 1 }, generation: 2, triggerReasons: ["NEW_EXPERIENCE"],
    evaluatedStage: "ACQUAINTANCE", evaluatedStatus: "NORMAL", relationshipVersion: 1, outcome: "CHANGE", suggestedStage: "FRIEND", suggestedStatus: "NORMAL",
    reason: "有独立经历支持", observations: { observations: ["测试观察"] }, confidence: 0.8, modelName: "test", promptVersion: "v1",
    status: "SUCCEEDED", reviewStatus: "PENDING", reviewedAt: null, reviews: [], error: null, startedAt: "2026-11-10T00:00:00Z", completedAt: "2026-11-10T00:00:01Z", createdAt: "2026-11-10T00:00:00Z", evidence: [], canReview: true, staleReason: null, ...extra };
}
function list(items = [item()], page = 1, totalPages = 1) { return { items, total: items.length, page, pageSize: 12, totalPages, hasMore: false, summary: { all: 3, actionable: 1, accepted: 1, failed: 1, running: 0 } }; }
function buildFlatPage() {
  const page = buildPageHarness(path);
  page.take(base()).resolve({ items: [], total: 0, page: 1, pageSize: 12, totalPages: 1, summary: list().summary });
  page.call("changeView", "records");
  return page;
}
async function setup() { const page = buildFlatPage(); page.take(base()).resolve(list()); await flushMicrotasks(); return page; }
{
  const page = buildFlatPage(); const old = page.take(base()); page.switchRole("char-b"); const b = page.take(base("char-b")); page.switchRole("char-a"); const fresh = page.take(base());
  old.resolve(list([item("old")])); b.reject(new Error("old")); await flushMicrotasks(); assert.equal(page.read<unknown[]>("rows").length, 0); assert.equal(page.read("loadError"), "");
  fresh.resolve(list([item("fresh")])); await flushMicrotasks(); assert.equal(page.read<Array<{id:string}>>("rows")[0]!.id, "fresh"); page.finish();
}
{
  const page = await setup(); page.call("changeFilter", "ACTIONABLE"); const old = page.take(base()); assert.equal(old.options?.query?.filter, "ACTIONABLE");
  page.call("changeFilter", "FAILED"); const fresh = page.take(base()); fresh.resolve(list([item("failed", { status: "FAILED", outcome: null })])); old.resolve(list()); await flushMicrotasks();
  assert.equal(page.read<Array<{id:string}>>("rows")[0]!.id, "failed"); assert.match(await page.call<string>("resultLabel", item("failed", { status: "FAILED", outcome: null })), /执行失败/); page.finish();
}
{
  const page = await setup(); const action = page.call("load"); page.take(base()).reject(new Error("network")); await action;
  assert.equal(page.read<unknown[]>("rows").length, 0); assert.equal(page.read("summary"), null); assert.equal(page.read("total"), 0); assert.match(page.read<string>("loadError"), /读取评估历史失败/);
  const retry = page.call("load"); page.take(base()).resolve(list()); await retry; assert.equal(page.read("loadError"), ""); page.finish();
}
{
  const page = await setup(); page.call("review", item(), "ACCEPTED"); assert.equal(page.read("reviewOpen"), true);
  page.switchRole("char-b"); const b = page.take(base("char-b")); page.switchRole("char-a"); const a = page.take(base());
  await page.call("confirmReview"); assert.equal(page.requests.length, 0, "Old confirmation must not submit under ABA role switch"); b.resolve(list()); a.resolve(list()); await flushMicrotasks();
  assert.equal(page.read("reviewOpen"), false); assert.deepEqual(Array.from(page.read<string[]>("reviewingIds")), []); page.finish();
}
{
  const page = await setup(); page.call("review", item(), "ACCEPTED"); page.set("reviewNote", "x".repeat(501)); await page.call("confirmReview"); assert.equal(page.requests.length, 0);
  page.set("reviewNote", "  已核实来源  "); const action = page.call("confirmReview"); const post = page.take(`${base()}/assessment-a/review`, "POST");
  assert.equal(JSON.stringify(post.options?.body), JSON.stringify({ decision: "ACCEPTED", note: "已核实来源" }));
  page.switchRole("char-b"); const b = page.take(base("char-b")); page.switchRole("char-a"); const a = page.take(base()); b.resolve(list()); a.resolve(list([item("new")])); await flushMicrotasks();
  post.resolve({ applied: true }); await action; assert.equal(page.successes.length, 0); assert.equal(page.requests.length, 0); assert.equal(page.read<Array<{id:string}>>("rows")[0]!.id, "new"); page.finish();
}
{
  const page = await setup(); page.call("review", item(), "DEFERRED"); const action = page.call("confirmReview"); const post = page.take(`${base()}/assessment-a/review`, "POST");
  post.reject({ statusCode: 409, data: { statusMessage: "来源已变化" } }); await flushMicrotasks(); page.take(base()).resolve(list([item("assessment-a", { canReview: false, staleReason: "来源变化请重评" })])); await action;
  assert.match(page.read<string>("reviewError"), /来源已变化/); assert.equal(page.successes.length, 0); assert.deepEqual(Array.from(page.read<string[]>("reviewingIds")), []);
  page.call("closeReview"); page.call("review", item("assessment-a", { canReview: false }), "ACCEPTED"); assert.equal(page.read("reviewOpen"), false);
  page.call("review", item("assessment-a", { canReview: false }), "REJECTED"); assert.equal(page.read("reviewOpen"), true); page.finish();
}
{
  const page = await setup(); assert.equal(await page.call("canAccept", item("x", { currentRelationship: { stage: "FRIEND", status: "NORMAL", version: 2 } })), false);
  for (const extra of [{ status: "FAILED" }, { status: "RUNNING" }, { outcome: "REVIEW" }, { reviewStatus: "ACCEPTED" }]) assert.equal(await page.call("canAct", item("x", extra)), false);
  page.call("review", item(), "REJECTED"); const action = page.call("confirmReview"); page.take(`${base()}/assessment-a/review`, "POST").resolve({ applied: false }); await flushMicrotasks(); page.take(base()).resolve(list([item("assessment-a", { reviewStatus: "REJECTED" })])); await action;
  assert.equal(page.successes.length, 1); assert.equal(page.read("reviewOpen"), false); assert.equal(await page.call("roleHref", "/growth/social"), "/growth/social?c=char-a"); page.finish();
}
{
  const page = await setup(); page.call("changePage", 4); const overflow = page.take(base()); overflow.resolve(list([], 4, 2)); await flushMicrotasks(); const corrected = page.take(base()); assert.equal(corrected.options?.query?.page, 2);
  corrected.resolve(list([item()], 2, 2)); await flushMicrotasks(); assert.equal(page.read("pageNumber"), 2);
  page.call("review", item(), "ACCEPTED"); const action = page.call("confirmReview"); const post = page.take(`${base()}/assessment-a/review`, "POST"); page.call("closeReview"); post.reject(new Error("late")); await action;
  assert.equal(page.read("reviewError"), ""); assert.equal(page.requests.length, 0); page.finish();
}
{
  const page = await setup(); page.call("review", item(), "REJECTED"); const action = page.call("confirmReview"); const post = page.take(`${base()}/assessment-a/review`, "POST"); page.unmount(); post.resolve({ applied: false }); await action;
  assert.equal(page.successes.length, 0); assert.equal(page.requests.length, 0); page.finish();
}
const source = readFileSync(new URL(path, import.meta.url), "utf8");
assert(!source.includes("ElMessageBox")); assert(!source.includes("v-html")); assert(!/font-size:\s*(?:[0-9]|1[01])px/.test(source));
assert(source.includes("评估时关系"));
assert(source.includes("relation(item.evaluatedStage, item.evaluatedStatus)"), "Historical comparisons must use the evaluated relationship, not today's current state.");
assert(source.includes('v-if="loadError"')); assert(source.includes("!loadError && !rows.length")); assert(source.includes("本轮新经历")); assert(source.includes("历史背景"));
console.log("Social assessment history page: 9 real-script groups passed (role ABA, controlled review confirmation, late response, errors, filters, status gates and overflow).");
