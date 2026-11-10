import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";
const path = "../app/pages/growth/social/assessments.vue";
const base = (role = "char-a") => `/api/characters/${role}/growth/social/assessments`;
const summary = { all: 131, actionable: 2, accepted: 9, failed: 0, running: 0 };
function person(id = "scope-a") { return { scopeId: id, friend: { displayName: "测试好友", platform: "qq", platformUid: "synthetic", kind: "HUMAN" }, currentRelationship: { stage: "FRIEND", status: "NORMAL", version: 2 }, assessmentCount: 14, matchingCount: 2,
  latestAssessment: { id: `latest-${id}`, status: "SUCCEEDED", outcome: "MAINTAIN", reviewStatus: "NOT_REQUIRED", createdAt: "2026-11-10T00:00:00Z" },
  changes: [{ id: "change-a", fromStage: "STRANGER", toStage: "ACQUAINTANCE", fromStatus: "UNOBSERVED", toStatus: "NORMAL", createdAt: "2026-11-09T00:00:00Z" }, { id: "change-b", fromStage: "STRANGER", toStage: "ACQUAINTANCE", fromStatus: "UNOBSERVED", toStatus: "NORMAL", createdAt: "2026-11-09T01:00:00Z" }, { id: "change-c", fromStage: "ACQUAINTANCE", toStage: "FRIEND", fromStatus: "NORMAL", toStatus: "NORMAL", createdAt: "2026-11-10T00:00:00Z" }], changeCount: 3 }; }
function people(items = [person()], page = 1, pages = 1) { return { items, total: 49, page, pageSize: 12, totalPages: pages, summary }; }
function assessment(id = "assessment-a", scopeId = "scope-a") { return { id, scopeId, friend: person(scopeId).friend, currentRelationship: person(scopeId).currentRelationship, evaluatedStage: "FRIEND", evaluatedStatus: "NORMAL", relationshipVersion: 2,
  generation: 1, triggerReasons: ["NEW_EXPERIENCE"], status: "SUCCEEDED", outcome: "CHANGE", suggestedStage: "CLOSE_FRIEND", suggestedStatus: "NORMAL", reviewStatus: "PENDING", evidence: [], canReview: true, staleReason: null, reviews: [], createdAt: "2026-11-10T00:00:00Z" }; }
function flat(items = [assessment()], page = 1, pages = 1) { return { items, total: 14, page, pageSize: 12, totalPages: pages, hasMore: page < pages, summary }; }
async function setup() { const p = buildPageHarness(path); const request = p.take(base()); assert.equal(request.options?.query?.view, "people"); request.resolve(people()); await flushMicrotasks(); return p; }
{
  const p = await setup(); assert.equal(p.read("view"), "people"); assert.equal(p.read("peopleTotal"), 49); assert.equal(p.read<unknown[]>("rows").length, 0);
  const groups = p.read<ReturnType<typeof person>[]>("groups"); assert.equal(groups[0]!.assessmentCount, 14); assert.equal(groups[0]!.changes.length, 3, "Actual duplicate-looking change audits must not be silently merged"); assert.equal(p.read<{all:number}>("summary").all, 131); p.finish();
}
{
  const p = await setup(); p.call("changePeoplePage", 3); const page = p.take(base()); assert.equal(page.options?.query?.page, 3); page.resolve(people([person("scope-b")], 3, 4)); await flushMicrotasks();
  p.call("openPerson", person("scope-b")); const detail = p.take(base()); assert.equal(detail.options?.query?.scopeId, "scope-b"); assert.equal(detail.options?.query?.page, 1); assert.equal(detail.options?.query?.pageSize, 12); detail.resolve(flat([assessment("b", "scope-b")], 1, 2)); await flushMicrotasks();
  p.call("changePage", 2); const next = p.take(base()); assert.equal(next.options?.query?.scopeId, "scope-b"); assert.equal(next.options?.query?.page, 2); next.resolve(flat([], 2, 2)); await flushMicrotasks();
  p.call("backToPeople"); const back = p.take(base()); assert.equal(back.options?.query?.view, "people"); assert.equal(back.options?.query?.page, 3); back.resolve(people([person("scope-b")], 3, 4)); await flushMicrotasks(); assert.equal(p.read("selectedScope"), ""); assert.equal(p.read<unknown[]>("rows").length, 0); p.finish();
}
{
  const p = await setup(); p.call("openPerson", person()); const old = p.take(base()); p.call("backToPeople"); const fresh = p.take(base()); old.resolve(flat()); fresh.resolve(people([person("scope-b")])); await flushMicrotasks(); assert.equal(p.read<unknown[]>("rows").length, 0); assert.equal(p.read<ReturnType<typeof person>[]>("groups")[0]!.scopeId, "scope-b"); p.finish();
}
{
  const p = await setup(); p.call("openPerson", person()); const old = p.take(base()); p.switchRole("char-b"); const b = p.take(base("char-b")); p.switchRole("char-a"); const a = p.take(base());
  old.resolve(flat([assessment("old")])); b.reject(new Error("late")); a.resolve(people([person("fresh")])); await flushMicrotasks(); assert.equal(p.read("selectedScope"), ""); assert.equal(p.read<unknown[]>("rows").length, 0); assert.equal(p.read<ReturnType<typeof person>[]>("groups")[0]!.scopeId, "fresh"); p.finish();
}
{
  const p = await setup(); p.call("changeFilter", "ACTIONABLE"); const old = p.take(base()); p.call("changeFilter", "FAILED"); const fresh = p.take(base()); assert.equal(fresh.options?.query?.filter, "FAILED"); fresh.resolve(people([], 1)); old.resolve(people()); await flushMicrotasks(); assert.equal(p.read<unknown[]>("groups").length, 0); p.finish();
}
{
  const p = await setup(); p.call("changeView", "records"); const old = p.take(base()); assert.equal(old.options?.query?.view, undefined); p.call("changeView", "people"); const fresh = p.take(base()); old.resolve(flat()); fresh.resolve(people()); await flushMicrotasks(); assert.equal(p.read<unknown[]>("rows").length, 0); assert.equal(p.read("showingPeople"), true); p.finish();
}
{
  const p = await setup(); p.call("openPerson", person()); p.take(base()).resolve(flat()); await flushMicrotasks(); p.call("changeFilter", "ACTIONABLE"); const req = p.take(base()); assert.equal(req.options?.query?.scopeId, "scope-a"); assert.equal(req.options?.query?.filter, "ACTIONABLE"); req.resolve(flat()); await flushMicrotasks(); p.call("review", assessment(), "ACCEPTED"); assert.equal(p.read("reviewOpen"), true);
  p.call("backToPeople"); p.take(base()).resolve(people()); await flushMicrotasks(); await p.call("confirmReview"); assert.equal(p.requests.length, 0); assert.equal(p.read("reviewOpen"), false); p.finish();
}
{
  const p = await setup(); p.call("changePeoplePage", 8); p.take(base()).resolve(people([], 8, 2)); await flushMicrotasks(); const corrected = p.take(base()); assert.equal(corrected.options?.query?.page, 2); corrected.resolve(people([person()], 2, 2)); await flushMicrotasks(); assert.equal(p.read("peoplePage"), 2); p.finish();
}
{
  const p = await setup(); const req = p.call("loadPeople"); p.take(base()).reject(new Error("network")); await req; assert.equal(p.read<unknown[]>("groups").length, 0); assert.equal(p.read("summary"), null); assert.match(p.read<string>("loadError"), /好友评估汇总/); p.call("refresh"); const late = p.take(base()); p.unmount(); late.resolve(people()); await flushMicrotasks(); assert.equal(p.read<unknown[]>("groups").length, 0); p.finish();
}
{
  const p = await setup(); assert.equal(await p.call("latestLabel", { ...person(), latestAssessment: null }), "暂无评估");
  p.call("openPerson", person()); const req = p.take(base());
  req.resolve(flat([{ ...assessment(), currentRelationship: { stage: "CLOSE_FRIEND", status: "NORMAL", version: 3 } }])); await flushMicrotasks();
  assert.equal(p.read<ReturnType<typeof person>>("selectedPerson").currentRelationship.version, 3, "Drilldown refresh must update current relationship after review"); p.finish();
}
const source = readFileSync(new URL(path, import.meta.url), "utf8");
assert(source.includes('v-for="person in groups"')); assert(source.includes('v-for="change in person.changes"')); assert(source.includes("person.changeCount > person.changes.length")); assert(source.includes("实际关系变化")); assert(!source.includes("groupBy(")); assert(!/font-size:\s*(?:[0-9]|1[01])px/.test(source));
console.log("Social assessment people groups: 10 server-grouped overview, independent pagination, drilldown, real changes, role/filter/view races and review safety scenarios passed (script-level, no DOM).");
