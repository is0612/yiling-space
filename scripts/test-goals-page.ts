import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks as tick } from "./lib/page-harness";

// Real SFC script with controlled API completions; does not replace browser interaction checks.
const make = () => buildPageHarness("../app/pages/growth/goals.vue");
const base = (role = "char-a") => `/api/characters/${role}/growth/goals`;
const paged = (items: unknown[] = [], current = 1) => ({ items, pagination: { page: current, pageSize: 20, total: items.length, pageCount: 1 } });
const goal = (id = "g1", status = "ACTIVE", role = "char-a") => ({ id, characterId: role, kind: "GOAL", title: "认识常见星座", description: "先认识三个常见星座", reason: "持续提出学习兴趣", status, revision: 3, sourceType: "MANUAL", sourceRefs: [], createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z", progressCount: 0, latestProgress: null });
const source = (id = "e1") => ({ type: "MEMORY_EVENT", id, title: "公开经历", summary: "提出想学习星座", hash: `hash-${id}` });
const draft = (changes: Record<string, unknown> = {}) => ({ kind: "GOAL", title: "认识星座", description: "认识几个常见星座", reason: "她持续主动提起", activate: true, ...changes });
const body = (value: unknown) => JSON.parse(JSON.stringify(value));
async function ready() { const h = make(); h.take(base()).resolve(paged()); await tick(); return h; }
async function sourced() { const h = await ready(); h.call("openEditor", null, "sources"); h.take(`${base()}/sources`).resolve(paged([source()])); await tick(); h.call("toggleSource", source()); return h; }
async function progressReady(status = "ACTIVE") { const h = await ready(); h.call("openProgress", goal("g1", status)); h.take(`${base()}/g1/progress`).resolve(paged()); await tick(); return h; }
let cases = 0;
{
  const h = make(); const stale = h.take(base()); h.switchRole("char-b"); const b = h.take(base("char-b")); h.switchRole("char-a"); h.take(base()).resolve(paged([goal("new")])); await tick(); stale.resolve(paged([goal("old")])); b.reject(new Error("late")); await tick(); assert.equal(h.read<Array<{ id: string }>>("items")[0]!.id, "new"); h.finish(); cases++;
}
{
  const h = await ready(); h.set("keyword", "星座"); h.call("search"); const search = h.take(base()); assert.equal(search.options!.query!.q, "星座"); h.call("changeStatus", "PAUSED"); const request = h.take(base()); request.resolve(paged([goal("p", "PAUSED"), goal("x", "PAUSED", "char-b")])); search.resolve(paged([goal()])); await tick(); assert.equal(h.read<Array<{ id: string }>>("items")[0]!.id, "p"); h.call("changePage", 2); h.take(base()).resolve(paged([], 2)); await tick(); assert.equal(h.read("page"), 2); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor"); h.set("draft", draft({ kind: "WISH" })); const saving = h.call("saveEditor"); const request = h.take(base(), "POST"); assert.deepEqual(body(request.options!.body), { kind: "WISH", title: "认识星座", description: "认识几个常见星座", reason: "她持续主动提起", status: "ACTIVE" }); request.resolve({ goal: goal() }); await tick(); h.take(base()).resolve(paged()); await saving; h.finish(); cases++;
}
{
  const h = await sourced(); h.set("draft", draft()); const saving = h.call("saveEditor"); const request = h.take(base(), "POST"); assert.equal((request.options!.body as { status: string }).status, "PENDING"); assert.deepEqual(body((request.options!.body as { sources: unknown }).sources), [{ type: "MEMORY_EVENT", id: "e1", hash: "hash-e1" }]); h.switchRole("char-b"); h.take(base("char-b")).resolve(paged()); request.resolve({ goal: goal() }); await saving; assert.equal(h.read("editorOpen"), false); h.finish(); cases++;
}
{
  const h = await ready(); for (const status of ["COMPLETED", "ABANDONED", "REJECTED"]) { assert.deepEqual(body(await h.call("availableActions", goal("t", status))), []); assert.equal(await h.call("canEdit", goal("t", status)), false); h.call("openEditor", goal("t", status)); h.call("openAction", goal("t", status), "ACTIVATE"); assert.equal(h.read("editorOpen"), false); assert.equal(h.read("actionOpen"), false); }
  assert.deepEqual(body(await h.call("availableActions", goal("p", "PENDING"))), ["ACTIVATE", "REJECT"]); assert.deepEqual(body(await h.call("availableActions", goal("p", "PAUSED"))), ["ACTIVATE", "COMPLETE", "ABANDON"]); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openAction", goal(), "COMPLETE"); assert.match(await h.call<string>("actionDescription", "COMPLETE"), /完成后不再编辑/); const pending = h.call("confirmAction"); const request = h.take(`${base()}/g1`, "PATCH"); assert.deepEqual(body(request.options!.body), { operation: "COMPLETE", expectedRevision: 3 }); request.reject({ statusCode: 409 }); await tick(); assert.equal(h.read("actionOpen"), false); h.take(base()).resolve(paged()); await pending; h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor", goal()); for (const invalid of [draft({ title: "x".repeat(101) }), draft({ description: "x".repeat(1001) }), draft({ reason: "" })]) { h.set("draft", invalid); await h.call("saveEditor"); assert.match(h.read<string>("editorError"), /100.*1000/); } h.set("draft", draft()); const pending = h.call("saveEditor"); const request = h.take(`${base()}/g1`, "PATCH"); assert.equal((request.options!.body as { expectedRevision: number }).expectedRevision, 3); h.unmount(); request.resolve({ goal: goal() }); await pending; h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestGoal"); const request = h.take(`${base()}/suggest`, "POST"); await h.call("saveEditor"); request.resolve({ suggestion: { kind: "WISH", title: "想看星空", description: "看一次清晰的夜空", reason: "她主动表达" } }); await pending; assert.equal(h.read<{ title: string }>("draft").title, "想看星空"); assert.equal(h.read("editorOpen"), true); h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestGoal"); const request = h.take(`${base()}/suggest`, "POST"); h.call("markDraftEdited"); request.resolve({ suggestion: { kind: "WISH", title: "旧建议", description: "旧", reason: "旧" } }); await pending; assert.equal(h.read<{ title: string }>("draft").title, ""); assert.match(h.read<string>("suggestionMessage"), /未覆盖/); h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestGoal"); const request = h.take(`${base()}/suggest`, "POST"); for (let n = 2; n <= 6; n++) h.call("toggleSource", source(String(n))); assert.equal(h.read<unknown[]>("selectedSources").length, 5); request.resolve({ suggestion: null }); await pending; assert.equal(h.read<{ title: string }>("draft").title, ""); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor", null, "sources"); const old = h.take(`${base()}/sources`); h.call("closeEditor"); old.resolve(paged([source()])); await tick(); assert.equal(h.read<unknown[]>("sources").length, 0); h.call("openHistory", goal()); const history = h.take(`${base()}/g1/history`); h.call("closeHistory"); history.resolve(paged([goal()])); await tick(); assert.equal(h.read<unknown[]>("historyItems").length, 0); h.finish(); cases++;
}
{
  const h = await progressReady(); h.set("progressContent", "认出了北斗七星"); const first = h.call("saveProgress"); const initial = h.take(`${base()}/g1/progress`, "POST"); const initialBody = body(initial.options!.body); assert.match(initialBody.requestKey, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i); initial.reject(new Error("timeout")); await first; assert.equal(h.read("progressContent"), "认出了北斗七星"); const retry = h.call("saveProgress"); const replay = h.take(`${base()}/g1/progress`, "POST"); assert.deepEqual(body(replay.options!.body), initialBody); replay.resolve({ goal: { ...goal(), revision: 4 }, progress: { id: "p1" }, created: false }); await tick(); h.take(`${base()}/g1/progress`).resolve(paged()); h.take(base()).resolve(paged()); await retry; assert.equal(h.read("progressContent"), ""); assert.equal(h.read<{ item: { revision: number } }>("progressTarget").item.revision, 4); h.finish(); cases++;
}
{
  const h = await progressReady("PAUSED"); h.set("progressContent", "第一版"); const first = h.call("saveProgress"); const request = h.take(`${base()}/g1/progress`, "POST"); const key = (request.options!.body as { requestKey: string }).requestKey; request.reject(new Error("network")); await first; h.call("markProgressEdited"); h.set("progressContent", "修改后的进展"); const second = h.call("saveProgress"); const changed = h.take(`${base()}/g1/progress`, "POST"); assert.notEqual((changed.options!.body as { requestKey: string }).requestKey, key); changed.reject({ statusCode: 409 }); await tick(); assert.equal(h.read("progressOpen"), false); h.take(base()).resolve(paged()); await second; h.finish(); cases++;
}
{
  const h = await progressReady(); h.set("progressContent", "正在记录"); const pending = h.call("saveProgress"); const request = h.take(`${base()}/g1/progress`, "POST"); h.switchRole("char-b"); h.take(base("char-b")).resolve(paged()); request.resolve({ goal: goal(), progress: { id: "p" } }); await pending; assert.equal(h.read("progressOpen"), false); assert.equal(h.read("progressContent"), ""); h.finish(); cases++;
}
{
  const h = await progressReady("COMPLETED"); assert.equal(await h.call("canAppendProgress", goal("g", "COMPLETED")), false); h.set("progressContent", "不能追加"); await h.call("saveProgress"); h.call("changeProgressPage", 2); const request = h.take(`${base()}/g1/progress`); assert.equal(request.options!.query!.page, 2); h.call("closeProgress"); request.resolve(paged([], 2)); await tick(); assert.equal(h.read("progressItems").length, 0); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openHistory", goal()); h.take(`${base()}/g1/history`).resolve(paged([{ ...goal(), action: "PROGRESS" }])); await tick(); assert.equal(h.read<Array<{ action: string }>>("historyItems")[0]!.action, "PROGRESS"); h.call("changeHistoryPage", 2); h.take(`${base()}/g1/history`).resolve(paged([], 2)); await tick(); assert.equal(h.read("historyPage"), 2); h.finish(); cases++;
}
const template = readFileSync(new URL("../app/pages/growth/goals.vue", import.meta.url), "utf8");
assert.match(template, /maxlength="100"/); assert.match(template, /maxlength="1000"/); assert.match(template, /@input="markProgressEdited"/); assert.match(template, /模型不会自动完成目标/); assert.match(template, /保存时摘要/); assert.doesNotMatch(template, /DISABLED|适用场景|TONE|WORDING|LENGTH/);
console.log(`Goals page: ${cases} status, source, draft, role, history and idempotent progress scenarios passed (script-level, no DOM).`);
