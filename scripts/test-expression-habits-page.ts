import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks as tick } from "./lib/page-harness";

// Executes the real SFC script with controlled Nuxt/API bindings, not a browser DOM.
const make = () => buildPageHarness("../app/pages/growth/language.vue");
const base = (role = "char-a") => `/api/characters/${role}/growth/language`;
const page = (items: unknown[] = [], current = 1) => ({ items, pagination: { page: current, pageSize: 20, total: items.length, pageCount: 1 } });
const habit = (id = "h1", status = "ACTIVE", role = "char-a") => ({ id, characterId: role, kind: "TONE", content: "安慰时先温和回应", context: "朋友难过", reason: "观察到这样更容易接住对方的情绪", status, revision: 3, sourceType: "MANUAL", sourceRefs: [], createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" });
const source = (id = "e1") => ({ type: "MEMORY_EVENT", id, title: "一次公开交流", summary: "她在倾听后简短回应", hash: `hash-${id}` });
const draft = (changes: Record<string, unknown> = {}) => ({ kind: "TONE", chatScope: "ALL", content: "先温和回应", context: "", reason: "观察依据", activate: true, ...changes });
const body = (value: unknown) => JSON.parse(JSON.stringify(value));
async function ready() { const h = make(); h.take(base()).resolve(page()); await tick(); return h; }
async function sourced() { const h = await ready(); h.call("openEditor", null, "sources"); h.take(`${base()}/sources`).resolve(page([source()])); await tick(); h.call("toggleSource", source()); return h; }
let cases = 0;

{
  const h = make(); const old = h.take(base()); h.switchRole("char-b"); const b = h.take(base("char-b")); h.switchRole("char-a"); const fresh = h.take(base());
  fresh.resolve(page([habit("fresh")])); await tick(); old.resolve(page([habit("old")])); b.reject(new Error("late failure")); await tick();
  assert.equal(h.read<Array<{ id: string }>>("items")[0]!.id, "fresh"); assert.equal(h.read("loadError"), ""); h.finish(); cases++;
}
{
  const h = await ready(); h.set("keyword", "温和"); h.call("search"); const search = h.take(base()); assert.equal(search.options!.query!.q, "温和");
  h.call("changeStatus", "PENDING"); const pending = h.take(base()); assert.equal(pending.options!.query!.status, "PENDING"); pending.resolve(page([habit("p", "PENDING"), habit("foreign", "PENDING", "char-b")])); search.resolve(page([habit("stale")])); await tick();
  assert.deepEqual(body(h.read("items")), [habit("p", "PENDING")]); h.call("changePage", 2); const next = h.take(base()); assert.equal(next.options!.query!.page, 2); next.resolve(page([], 2)); await tick(); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor"); h.set("draft", draft()); const saving = h.call("saveEditor"); const request = h.take(base(), "POST");
  assert.deepEqual(body(request.options!.body), { kind: "TONE", chatScope: "ALL", content: "先温和回应", context: "", reason: "观察依据", status: "ACTIVE" }); request.resolve({ habit: habit() }); await tick(); h.take(base()).resolve(page()); await saving; h.finish(); cases++;
}
{
  const h = await sourced(); h.set("draft", draft({ kind: "LENGTH", context: "日常问候" })); const saving = h.call("saveEditor"); const request = h.take(base(), "POST");
  assert.equal((request.options!.body as { status: string }).status, "PENDING"); assert.deepEqual(body((request.options!.body as { sources: unknown }).sources), [{ type: "MEMORY_EVENT", id: "e1", hash: "hash-e1" }]);
  h.switchRole("char-b"); h.take(base("char-b")).resolve(page()); request.resolve({ habit: habit() }); await saving; assert.equal(h.read("editorOpen"), false); assert.equal(h.read("status"), "ACTIVE"); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor", null, "sources"); const first = h.take(`${base()}/sources`); h.call("closeEditor"); h.call("openEditor", null, "sources"); const latest = h.take(`${base()}/sources`);
  latest.resolve(page([source("new")])); first.resolve(page([source("old")])); await tick(); assert.equal(h.read<Array<{ id: string }>>("sources")[0]!.id, "new");
  h.call("openHistory", habit()); const history = h.take(`${base()}/h1/history`); h.call("closeHistory"); history.resolve(page([habit()])); await tick(); assert.equal(h.read<unknown[]>("historyItems").length, 0); h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestHabit"); const request = h.take(`${base()}/suggest`, "POST"); assert.deepEqual(body(request.options!.body), { sources: [{ type: "MEMORY_EVENT", id: "e1", hash: "hash-e1" }] });
  await h.call("saveEditor"); request.resolve({ suggestion: { kind: "LENGTH", content: "闲聊简短", context: "闲聊", reason: "依据" } }); await pending;
  assert.equal(h.read<{ content: string }>("draft").content, "闲聊简短"); assert.equal(h.read("editorOpen"), true); h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestHabit"); const request = h.take(`${base()}/suggest`, "POST"); h.set("draft", draft({ context: "我写的场景" }));
  request.resolve({ suggestion: { kind: "TONE", content: "模型内容", context: "模型场景", reason: "推断" } }); await pending;
  assert.equal(h.read<{ context: string }>("draft").context, "我写的场景"); assert.match(h.read<string>("suggestionMessage"), /未覆盖/); h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestHabit"); const request = h.take(`${base()}/suggest`, "POST"); h.call("markDraftEdited");
  request.resolve({ suggestion: { kind: "WORDING", content: "过期草稿", context: "", reason: "推断" } }); await pending; assert.equal(h.read<{ content: string }>("draft").content, ""); assert.match(h.read<string>("suggestionMessage"), /未覆盖/); h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestHabit"); const request = h.take(`${base()}/suggest`, "POST"); for (let n = 2; n <= 6; n++) h.call("toggleSource", source(String(n)));
  assert.equal(h.read<unknown[]>("selectedSources").length, 5); request.resolve({ suggestion: { kind: "TONE", content: "过期建议", context: "", reason: "推断" } }); await pending; assert.equal(h.read<{ content: string }>("draft").content, ""); h.finish(); cases++;
}
{
  const h = await sourced(); const pending = h.call("suggestHabit"); h.take(`${base()}/suggest`, "POST").resolve({ suggestion: null }); await pending;
  assert.match(h.read<string>("suggestionMessage"), /不足/); assert.equal(h.read<{ content: string }>("draft").content, ""); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openAction", habit("h", "PENDING"), "ACTIVATE"); const pending = h.call("confirmAction"); const request = h.take(`${base()}/h`, "PATCH");
  assert.deepEqual(body(request.options!.body), { operation: "ACTIVATE", expectedRevision: 3 }); request.reject({ statusCode: 409 }); await tick(); assert.equal(h.read("actionOpen"), false); h.take(base()).resolve(page()); await pending; h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor", habit());
  for (const invalid of [draft({ content: "x".repeat(301) }), draft({ context: "x".repeat(201) }), draft({ reason: "x".repeat(1001) })]) { h.set("draft", invalid); await h.call("saveEditor"); assert.match(h.read<string>("editorError"), /300.*1000.*200/); }
  h.set("draft", draft({ kind: "WORDING", context: "解释步骤" })); const pending = h.call("saveEditor"); const request = h.take(`${base()}/h1`, "PATCH");
  assert.deepEqual(body(request.options!.body), { operation: "EDIT", expectedRevision: 3, kind: "WORDING", chatScope: "ALL", content: "先温和回应", context: "解释步骤", reason: "观察依据" });
  h.unmount(); request.resolve({ habit: habit() }); await pending; assert.equal(h.read("editorOpen"), false); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openHistory", habit()); h.take(`${base()}/h1/history`).resolve(page([{ ...habit(), action: "CREATE" }])); await tick();
  h.call("changeHistoryPage", 2); const second = h.take(`${base()}/h1/history`); assert.equal(second.options!.query!.page, 2); second.resolve(page([{ ...habit(), action: "EDIT" }], 2)); await tick(); assert.equal(h.read<Array<{ action: string }>>("historyItems")[0]!.action, "EDIT");
  assert.equal(await h.call("settingsHref", "catchphrases"), "/characters/char-a/settings/catchphrases"); h.switchRole("char-b"); h.take(base("char-b")).resolve(page()); assert.equal(h.read("historyOpen"), false); assert.equal(await h.call("settingsHref", "model"), "/characters/char-b/settings/model"); h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor", habit());
  assert.equal(h.read<{chatScope:string}>("draft").chatScope, "ALL", "legacy records default to all chats");
  assert.equal(await h.call("chatScopeLabel", habit()), "所有聊天");
  h.set("draft", draft({ chatScope: "GROUP" })); const saving = h.call("saveEditor");
  const request = h.take(`${base()}/h1`, "PATCH"); assert.equal((request.options!.body as {chatScope:string}).chatScope, "GROUP");
  request.resolve({habit:habit()}); await tick(); h.take(base()).resolve(page()); await saving; h.finish(); cases++;
}
{
  const h = await ready(); const scoped = {...habit(), conversationId:"original-private", chatScope:"ALL"}; h.call("openEditor", scoped);
  assert.equal(h.read<{chatScope:string}>("draft").chatScope, "PRIVATE");
  assert.equal(await h.call("chatScopeLabel", scoped), "仅原私聊会话");
  h.set("draft", draft({ chatScope:"GROUP" })); const saving = h.call("saveEditor");
  const request = h.take(`${base()}/h1`, "PATCH"); assert.equal((request.options!.body as {chatScope:string}).chatScope,"PRIVATE", "scoped record cannot be expanded by mutating draft");
  request.resolve({habit:scoped}); await tick(); h.take(base()).resolve(page()); await saving; h.finish(); cases++;
}
{
  const h = await ready(); h.call("openEditor"); h.set("draft",draft({chatScope:"PRIVATE"})); const saving=h.call("saveEditor");
  const request=h.take(base(),"POST"); assert.equal((request.options!.body as {chatScope:string}).chatScope,"PRIVATE");
  h.switchRole("char-b"); h.take(base("char-b")).resolve(page()); request.resolve({habit:habit()}); await saving;
  assert.equal(h.read("editorOpen"),false); assert.equal(h.read<{chatScope:string}>("draft").chatScope,"ALL"); h.finish(); cases++;
}
const template = readFileSync(new URL("../app/pages/growth/language.vue", import.meta.url), "utf8");
assert.match(template, /这里记录「怎么说」/); assert.match(template, /maxlength="300"/); assert.match(template, /maxlength="200"/); assert.match(template, /maxlength="1000"/); assert.match(template, /@input="markDraftEdited"/); assert.match(template, /点击才调用/);
console.log(`expression habits page: ${cases} role, source, revision, draft and pagination scenarios passed (script-level, no DOM).`);
