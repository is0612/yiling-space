import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Script-level state/race regression; this does not claim browser DOM coverage.
const sfc = readFileSync(new URL("../app/pages/growth/preferences.vue", import.meta.url), "utf8");
const script = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]!;
const ast = ts.createSourceFile("preferences.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = ast.statements.filter(node => !ts.isImportDeclaration(node));
const names = statements.flatMap(node => ts.isVariableStatement(node) ? node.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []) : ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : []);
const compiled = ts.transpileModule(`(function(){${statements.map(node => node.getText(ast)).join("\n")}\nreturn {${names.join(",")}}})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Request = { url: string; options: { method?: string; body?: Record<string, unknown>; query?: Record<string, unknown> }; resolve: (value: unknown) => void; reject: (error: unknown) => void };
function harness() {
  const role = { value: { id: "a" } };
  const requests: Request[] = [];
  const callbacks: Array<() => void> = [];
  let watcher: () => void = () => {};
  const context = createContext({
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useRoute: () => ({ path: "/growth/preferences" }), useCharacterSelection: () => ({ character: role }), definePageMeta: () => {},
    watch: (_: unknown, cb: () => void, options: { immediate?: boolean }) => { watcher = cb; if (options.immediate) cb(); },
    onBeforeUnmount: (cb: () => void) => callbacks.push(cb), ElMessage: { success() {}, warning() {} },
    $fetch: (url: string, options: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  const bindings = new Script(compiled).runInContext(context) as Record<string, unknown>;
  function get<T>(key: string) { return (bindings[key] as { value: T }).value; }
  function set(key: string, value: unknown) { (bindings[key] as { value: unknown }).value = value; }
  function call(key: string, ...args: unknown[]) { return (bindings[key] as (...params: unknown[]) => unknown)(...args); }
  function take(method = "GET", suffix = "") { const index = requests.findIndex(r => (r.options?.method ?? "GET") === method && r.url.endsWith(suffix)); assert.ok(index >= 0, `${method} ${suffix}`); return requests.splice(index, 1)[0]!; }
  function switchRole(id: string) { role.value = { id }; watcher(); }
  function finish() { assert.equal(requests.length, 0, "all requests accounted for"); }
  return { get, set, call, take, switchRole, finish, unmount: () => callbacks.forEach(cb => cb()) };
}
const page = (items: unknown[] = [], total = items.length) => ({ items, pagination: { page: 1, pageSize: 20, total, pageCount: 1 } });
const item = (id = "p1", status = "ACTIVE") => ({ id, characterId: "a", kind: "LIKE", topic: "星空", reason: "一起观察", status, revision: 3, sourceType: "MANUAL", sourceRefs: [], createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" });
const source = (id = "e1") => ({ type: "MEMORY_EVENT", id, title: "观察星空", summary: "一次公开经历", hash: `hash-${id}` });
async function tick() { await Promise.resolve(); await Promise.resolve(); }

// A -> B -> A cannot let the first A response overwrite the new A state.
{
  const h = harness(); const old = h.take(); h.switchRole("b"); const b = h.take(); h.switchRole("a"); const fresh = h.take();
  fresh.resolve(page([item("fresh")])); await tick(); old.resolve(page([item("old")])); b.reject(new Error("old failure")); await tick();
  assert.equal(h.get<Array<{ id: string }>>("items")[0]!.id, "fresh"); assert.equal(h.get("loadError"), ""); h.finish();
}
// Searches/pagination use server parameters and stale filter responses are ignored.
{
  const h = harness(); h.take().resolve(page()); await tick(); h.set("keyword", "星空"); h.call("search"); const search = h.take();
  assert.equal(search.options.query!.q, "星空"); h.call("changeStatus", "PENDING"); const pending = h.take(); assert.equal(pending.options.query!.status, "PENDING");
  pending.resolve(page([item("pending", "PENDING")])); search.resolve(page([item("stale")])); await tick(); assert.equal(h.get<Array<{ id: string }>>("items")[0]!.id, "pending");
  h.call("changePage", 2); const next = h.take(); assert.equal(next.options.query!.page, 2); next.resolve(page()); await tick(); h.finish();
}
// Sourced records always stay PENDING and carry only white-listed source identity/hash.
{
  const h = harness(); h.take().resolve(page()); await tick(); h.call("openEditor", null, "sources"); h.take("GET", "/sources").resolve(page([source()])); await tick();
  h.call("toggleSource", source()); h.set("draft", { kind: "INTEREST", topic: "星空", reason: "愿意继续观察", activate: true });
  const save = h.call("saveEditor"); const request = h.take("POST"); assert.equal(request.options.body!.status, "PENDING");
  assert.deepEqual(JSON.parse(JSON.stringify(request.options.body!.sources)), [{ type: "MEMORY_EVENT", id: "e1", hash: "hash-e1" }]);
  h.switchRole("b"); h.take().resolve(page()); request.resolve({ preference: item() }); await save; assert.equal(h.get("editorOpen"), false); assert.equal(h.get("status"), "ACTIVE"); h.finish();
}
// Closed source and history dialogs cannot receive late responses into a new dialog.
{
  const h = harness(); h.take().resolve(page()); await tick(); h.call("openEditor", null, "sources"); const first = h.take("GET", "/sources"); h.call("closeEditor"); h.call("openEditor", null, "sources"); const latest = h.take("GET", "/sources");
  latest.resolve(page([source("new")])); first.resolve(page([source("old")])); await tick(); assert.equal(h.get<Array<{ id: string }>>("sources")[0]!.id, "new");
  h.call("openHistory", item()); const history = h.take("GET", "/history"); h.call("closeHistory"); history.resolve(page([item()])); await tick(); assert.equal(h.get<unknown[]>("historyItems").length, 0); h.finish();
}
// Explicit suggestions preserve edits made while a model request is in flight.
{
  const h = harness(); h.take().resolve(page()); await tick(); h.call("openEditor", null, "sources"); h.take("GET", "/sources").resolve(page()); await tick(); h.call("toggleSource", source());
  const suggest = h.call("suggestPreference"); const request = h.take("POST", "/suggest"); h.set("draft", { kind: "LIKE", topic: "我改的主题", reason: "我的判断", activate: true });
  request.resolve({ suggestion: { kind: "DISLIKE", topic: "模型主题", reason: "推断" } }); await suggest; assert.equal(h.get<{ topic: string }>("draft").topic, "我改的主题");
  assert.match(h.get<string>("suggestionMessage"), /未覆盖/); h.finish();
}
// Source selection changes invalidate suggestion, and max five evidence sources are allowed.
{
  const h = harness(); h.take().resolve(page()); await tick(); h.call("openEditor", null, "sources"); h.take("GET", "/sources").resolve(page()); await tick(); h.call("toggleSource", source());
  const suggest = h.call("suggestPreference"); const request = h.take("POST", "/suggest"); for (let n = 2; n <= 6; n++) h.call("toggleSource", source(String(n)));
  assert.equal(h.get<unknown[]>("selectedSources").length, 5); request.resolve({ suggestion: { kind: "LIKE", topic: "过期建议", reason: "过期" } }); await suggest;
  assert.equal(h.get<{ topic: string }>("draft").topic, ""); h.finish();
}
// Conflict closes the obsolete confirmation, refreshes state, and preserves revision checking.
{
  const h = harness(); h.take().resolve(page()); await tick(); h.call("openAction", item("p", "PENDING"), "ACTIVATE");
  const action = h.call("confirmAction"); const request = h.take("PATCH", "/p"); assert.equal(request.options.body!.expectedRevision, 3);
  request.reject({ statusCode: 409 }); await tick(); assert.equal(h.get("actionOpen"), false); h.take().resolve(page()); await action; h.finish();
}
// Edits carry their own revision; local validation and unmount prevent writes/results.
{
  const h = harness(); h.take().resolve(page()); await tick(); h.call("openEditor", item()); h.set("draft", { kind: "LIKE", topic: "x".repeat(101), reason: "原因", activate: true }); await h.call("saveEditor"); assert.match(h.get<string>("editorError"), /100/);
  h.set("draft", { kind: "LIKE", topic: "主题", reason: "原因", activate: true }); const save = h.call("saveEditor"); const request = h.take("PATCH", "/p1"); assert.equal(request.options.body!.operation, "EDIT"); assert.equal(request.options.body!.expectedRevision, 3);
  h.unmount(); request.resolve({ preference: item() }); await save; assert.equal(h.get("editorOpen"), false); h.finish();
}
console.log("preferences page: 8 race, contract, validation and suggestion scenarios passed (script-level, no DOM).");
