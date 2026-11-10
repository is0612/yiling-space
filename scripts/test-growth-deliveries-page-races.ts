import assert from "node:assert/strict";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";

const path = "../app/pages/growth/deliveries.vue";
const base = (role = "char-a") => `/api/characters/${role}/growth/deliveries`;
function item(id: string, status = "FAILED") {
  return {
    id, eventId: `event-${id}`, consumerKey: "social.relationship-assessment-dispatch", status,
    attemptCount: 5, maxAttempts: 5, runAt: "2026-11-10T00:00:00Z", lockedAt: null,
    lockedBy: null, leaseExpiresAt: null, fencingToken: 2, lastError: "synthetic failure",
    processedAt: null, createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z",
    eventType: "social.experience.created", sourceDomain: "social", aggregateType: "SocialExperience",
    aggregateId: `source-${id}`, occurredAt: "2026-11-10T00:00:00Z", leaseExpired: false, queueDelayMs: 100,
  };
}
function list(id: string) {
  return { items: [item(id)], total: 1, page: 1, pageSize: 20, totalPages: 1, hasMore: false,
    summary: { statusCounts: { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, RETRY_WAIT: 0, FAILED: 1, SKIPPED: 0, CANCELLED: 0 }, readyCount: 0, stuckCount: 0, oldestReadyAt: null } };
}
function detail(id: string, status = "FAILED") { return { ...item(id, status), audits: [] }; }
async function setup() {
  const page = buildPageHarness(path);
  page.take(base()).resolve(list("initial"));
  await flushMicrotasks();
  return page;
}

async function listGenerationRace() {
  const page = buildPageHarness(path);
  const firstA = page.take(base());
  page.switchRole("char-b"); const b = page.take(base("char-b"));
  page.switchRole("char-a"); const secondA = page.take(base());
  assert.equal(page.read<unknown[]>("items").length, 0);
  firstA.resolve(list("stale-a")); b.reject({ statusCode: 403 });
  await flushMicrotasks();
  assert.equal(page.read("loading"), true);
  assert.equal(page.read("loadError"), "");
  secondA.resolve(list("current-a")); await flushMicrotasks();
  assert.equal(page.read<Array<{ id: string }>>("items")[0]?.id, "current-a");
  page.finish();
}
async function filterLatestWins() {
  const page = await setup();
  page.call("changeStatus", "RUNNING"); const first = page.take(base());
  assert.equal(first.options?.query?.status, "RUNNING");
  assert.equal(first.options?.query?.pageSize, 20);
  page.call("changeStatus", "FAILED"); const last = page.take(base());
  last.resolve(list("failed-current")); await flushMicrotasks();
  first.resolve(list("running-stale")); await flushMicrotasks();
  assert.equal(page.read<Array<{ id: string }>>("items")[0]?.id, "failed-current");
  page.finish();
}
async function detailGenerationAndSelectionRace() {
  const page = await setup();
  page.call("openDetail", item("one")); const oldDetail = page.take(`${base()}/one`);
  page.switchRole("char-b"); const b = page.take(base("char-b"));
  assert.equal(page.read("detail"), null); assert.equal(page.read("detailOpen"), false);
  page.switchRole("char-a"); const a = page.take(base());
  page.call("openDetail", item("one")); const newDetail = page.take(`${base()}/one`);
  oldDetail.resolve(detail("stale-one")); await flushMicrotasks();
  assert.equal(page.read("detailLoading"), true); assert.equal(page.read("detail"), null);
  newDetail.resolve(detail("one")); b.resolve(list("b")); a.resolve(list("a")); await flushMicrotasks();
  page.call("openDetail", item("two")); const two = page.take(`${base()}/two`);
  page.call("closeDetail"); two.resolve(detail("two")); await flushMicrotasks();
  assert.equal(page.read("detail"), null); assert.equal(page.read("detailOpen"), false);
  page.finish();
}
async function staleRetryCannotTouchReturnedRole() {
  const page = await setup();
  page.call("openDetail", item("failed-a")); page.take(`${base()}/failed-a`).resolve(detail("failed-a")); await flushMicrotasks();
  page.call("requestRetry"); assert.equal(page.read("confirmOpen"), true);
  const retry = page.call("confirmRetry"); const post = page.take(`${base()}/failed-a/retry`, "POST");
  page.switchRole("char-b"); const b = page.take(base("char-b"));
  page.switchRole("char-a"); const a = page.take(base());
  page.call("openDetail", item("new-a")); const newDetail = page.take(`${base()}/new-a`);
  newDetail.resolve(detail("new-a")); b.resolve(list("b")); a.resolve(list("a-new")); await flushMicrotasks();
  post.resolve({ deliveryId: "failed-a" }); await retry;
  assert.equal(page.read<{ id: string }>("detail").id, "new-a");
  assert.equal(page.read("retrying"), false); assert.equal(page.successes.length, 0);
  assert.equal(page.requests.length, 0, "Old retry must not refresh returned A's new state");
  page.finish();
}
async function retryRefreshesAndErrors() {
  const page = await setup();
  page.call("openDetail", item("failed")); page.take(`${base()}/failed`).resolve(detail("failed")); await flushMicrotasks();
  page.call("requestRetry");
  let retry = page.call("confirmRetry"); page.take(`${base()}/failed/retry`, "POST").reject({ statusCode: 409 }); await retry;
  assert.match(page.read<string>("retryError"), /状态已变化/);
  assert.equal(page.read("confirmOpen"), true);
  retry = page.call("confirmRetry"); page.take(`${base()}/failed/retry`, "POST").resolve({ deliveryId: "failed" }); await flushMicrotasks();
  const refreshedList = page.take(base()); const refreshedDetail = page.take(`${base()}/failed`);
  refreshedList.resolve(list("refreshed")); refreshedDetail.resolve(detail("failed", "QUEUED")); await retry;
  assert.equal(page.read<{ status: string }>("detail").status, "QUEUED");
  assert.equal(page.read("confirmOpen"), false); assert.equal(page.successes.length, 1);
  page.call("requestRetry"); assert.equal(page.read("confirmOpen"), false, "Only FAILED can open recovery confirmation");
  page.finish();
}
async function errorsAndUnmount() {
  const page = buildPageHarness(path);
  page.take(base()).reject({ statusCode: 403 }); await flushMicrotasks(); assert.match(page.read<string>("loadError"), /无权/);
  page.call("openDetail", item("gone")); page.take(`${base()}/gone`).reject({ statusCode: 404 }); await flushMicrotasks();
  assert.match(page.read<string>("detailError"), /不存在/);
  page.call("openDetail", item("late")); const late = page.take(`${base()}/late`);
  page.unmount(); late.resolve(detail("late")); await flushMicrotasks(); assert.equal(page.read("detail"), null);
  page.finish();
}
await listGenerationRace();
await filterLatestWins();
await detailGenerationAndSelectionRace();
await staleRetryCannotTouchReturnedRole();
await retryRefreshesAndErrors();
await errorsAndUnmount();
console.log("Growth delivery page races: 6 scenarios passed.");
