import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/** Execute the actual script/setup handlers with deferred fetch/confirmation promises.
 * Run: yarn tsx scripts/test-snapshot-page-races.ts (no DB, model, server or network).
 */
const sfc = readFileSync(new URL("../app/components/SnapshotsWorkspace.vue", import.meta.url), "utf8");
const match = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
assert.ok(match);
const source = ts.createSourceFile("snapshots-page.ts", match[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = source.statements.filter((node) => !ts.isImportDeclaration(node)
  && !(ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)));
const names = statements.flatMap((node) => {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.flatMap((d) => ts.isIdentifier(d.name) ? [d.name.text] : []);
  return ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : [];
});
const compiled = ts.transpileModule(`(function () {\n${statements.map((node) => node.getText(source)).join("\n")}\nreturn { id, ${names.join(", ")} };\n})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
const executable = new Script(compiled.outputText, { filename: "snapshots.vue.actual-script.js" });
type Ref = { value: unknown };
type Request = { url: string; options?: { method?: string; body?: unknown }; resolve: (value: unknown) => void; reject: (error: unknown) => void };
function harness() {
  const watchers: Array<{ sources: Ref[]; callback: () => void }> = [];
  const requests: Request[] = [];
  const confirmations: Array<{ resolve: (value?: unknown) => void; reject: (reason?: unknown) => void }> = [];
  const messages: string[] = [];
  const role = { value: "role-a" };
  const notify = (message: string) => messages.push(message);
  const bindings = executable.runInContext(createContext({
    /** Nuxt 编译期宏：只在构建时注册路由元信息，运行时被抹掉，沙盒里桩掉即可。 */
    definePageMeta: () => {},
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: (sources: Ref | Ref[], callback: () => void) => watchers.push({ sources: Array.isArray(sources) ? sources : [sources], callback }),
    onMounted: () => {}, useCharacterList: () => ({ value: [] }), useCharacterSelection: () => ({ id: role }),
    useMemoryProgress: () => ({ lastFinished: { value: null } }),
    ElMessage: { error: notify, success: notify, warning: notify, info: notify },
    ElMessageBox: { confirm: () => new Promise((resolve, reject) => confirmations.push({ resolve, reject })) },
    $fetch: (url: string, options?: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  })) as Record<string, Ref | ((...args: unknown[]) => Promise<unknown>)>;
  function read<T = unknown>(name: string): T { return (bindings[name] as Ref).value as T; }
  function set(name: string, value: unknown) {
    const target = bindings[name] as Ref;
    const previous = target.value;
    target.value = value;
    if (previous !== value) for (const watcher of watchers) if (watcher.sources.includes(target)) watcher.callback();
  }
  function call(name: string, ...args: unknown[]) { return (bindings[name] as (...args: unknown[]) => Promise<unknown>)(...args); }
  function take(path: string, method = "GET") {
    const index = requests.findIndex((request) => request.url === path && (request.options?.method ?? "GET") === method);
    assert.ok(index >= 0, `missing ${method} ${path}`);
    return requests.splice(index, 1)[0]!;
  }
  function confirm() { assert.ok(confirmations.length); confirmations.shift()!.resolve(); }
  async function switchRole() {
    set("id", "role-b");
    take("/api/characters/role-b/snapshots").resolve([snapshot("b")]);
    await flush();
  }
  function done() { assert.equal(requests.length, 0, "unexpected/unsettled request"); assert.equal(confirmations.length, 0); }
  return { read, set, call, take, confirm, switchRole, done, messages, requests };
}
function snapshot(id: string) {
  return { id, kind: "AUTOMATIC", number: 1, version: 1, analysis: { memoryChangesApplied: [{ action: "ADD", result: "NOT_APPLIED_REGENERATION", content: id }] } };
}
const list = "/api/characters/role-a/snapshots";
async function listRaces() {
  for (const reject of [false, true]) {
    const page = harness();
    const old = page.call("loadSnapshots");
    const response = page.take(list);
    await page.switchRole();
    if (reject) response.reject(new Error("late list failure")); else response.resolve([snapshot("old")]);
    await old;
    assert.equal(page.read<{ id: string }>("detail").id, "b");
    assert.equal(page.read("loading"), false);
    assert.equal(page.messages.length, 0);
    page.done();
  }
  const page = harness();
  const old = page.call("loadSnapshots");
  const oldResponse = page.take(list);
  const next = page.call("loadSnapshots");
  oldResponse.reject(new Error("older same-role request"));
  await old;
  assert.equal(page.read("loading"), true, "old finally must not stop newer loading");
  page.take(list).resolve([snapshot("new")]);
  await next;
  assert.equal(page.read<{ id: string }>("detail").id, "new");
  assert.equal(page.messages.length, 0);
  page.done();
}
const handlers = ["reviewChange", "createSnapshot", "regenerateWithAi", "regenerate"];
function start(page: ReturnType<typeof harness>, handler: string, selected: ReturnType<typeof snapshot>) {
  return handler === "reviewChange" ? page.call(handler, 0, "ACCEPT", selected.analysis.memoryChangesApplied[0])
    : page.call(handler, selected);
}
async function confirmationRaces() {
  for (const handler of handlers) for (const change of ["role", "detail", "return"]) {
    const page = harness();
    const selected = snapshot("a");
    await page.call("applyDetail", selected);
    const pending = start(page, handler, selected);
    if (change === "role") await page.switchRole();
    else {
      await page.call("selectDetail", snapshot("other"));
      if (change === "return") await page.call("selectDetail", selected);
    }
    page.confirm();
    await pending;
    assert.equal(page.messages.length, 0, handler);
    page.done(); // No POST is allowed after any of these navigation changes.
  }
}
function writeResult() {
  return { id: "new", outcome: "CREATED", duplicate: false };
}
async function completionRaces() {
  // AI 重新提炼只排后台任务，不会在 POST 返回后立即刷新列表。
  // 这里测的是「完成后会跟进列表刷新」的写操作；后台 AI 重提炼另由 normalFlow 验证。
  for (const handler of handlers.filter((item) => item !== "regenerateWithAi")) for (const reject of [false, true]) {
    const page = harness();
    const selected = snapshot("a");
    await page.call("applyDetail", selected);
    const pending = start(page, handler, selected);
    page.confirm();
    await flush();
    const path = handler === "reviewChange" ? `${list}/a/review` : list;
    const request = page.take(path, "POST");
    if (handler === "reviewChange") assert.equal(JSON.stringify(request.options?.body), JSON.stringify({ changeIndex: 0, decision: "ACCEPT" }));
    if (handler === "regenerate" || handler === "regenerateWithAi") assert.equal((request.options?.body as { snapshotId: string }).snapshotId, "a");
    await page.switchRole();
    if (reject) request.reject(new Error("late write failure")); else request.resolve(writeResult());
    await pending;
    assert.equal(page.read<{ id: string }>("detail").id, "b");
    assert.equal(page.read("showManual"), false);
    assert.equal(page.messages.length, 0, handler);
    page.done();
  }
  // Navigation while the follow-up refresh is in flight must not restore old detail/source state.
  for (const handler of ["reviewChange", "createSnapshot", "regenerate"]) {
    const page = harness();
    const selected = snapshot("a");
    await page.call("applyDetail", selected);
    const pending = start(page, handler, selected);
    page.confirm();
    await flush();
    page.take(handler === "reviewChange" ? `${list}/a/review` : list, "POST").resolve(writeResult());
    await flush();
    const refresh = page.take(list);
    await page.switchRole();
    page.set("sourcesOpen", true);
    refresh.resolve([snapshot("stale")]);
    await pending;
    assert.equal(page.read<{ id: string }>("detail").id, "b");
    assert.equal(page.read("sourcesOpen"), true);
    page.done();
  }
}
async function normalFlow() {
  for (const handler of handlers) {
    const page = harness();
    const selected = snapshot("a");
    await page.call("applyDetail", selected);
    page.set("sourcesOpen", true);
    const pending = start(page, handler, selected);
    page.confirm();
    await flush();
    page.take(handler === "reviewChange" ? `${list}/a/review` : list, "POST").resolve(writeResult());
    await flush();
    if (handler !== "regenerateWithAi") page.take(list).resolve([snapshot("new"), selected]);
    await pending;
    assert.equal(page.messages.length, 1, `normal ${handler} must still succeed`);
    if (handler === "reviewChange") { assert.equal(page.read<{ id: string }>("detail").id, "a"); assert.equal(page.read("sourcesOpen"), true); }
    assert.equal(page.read("creating"), false);
    assert.equal(page.read("reviewingKey"), "");
    page.done();
  }
}
async function reviewIdentityAndFinally() {
  const page = harness();
  const selected = snapshot("a");
  await page.call("applyDetail", selected);
  await page.call("reviewChange", 0, "IGNORE", snapshot("wrong").analysis.memoryChangesApplied[0]);
  page.done(); // A stale row cannot be submitted against the current index.
  const old = page.call("reviewChange", 0, "IGNORE", selected.analysis.memoryChangesApplied[0]);
  const response = page.take(`${list}/a/review`, "POST");
  await page.switchRole();
  const current = page.read<ReturnType<typeof snapshot>>("detail");
  const next = page.call("reviewChange", 0, "IGNORE", current.analysis.memoryChangesApplied[0]);
  response.reject(new Error("old review"));
  await old;
  assert.equal(page.read("reviewingKey"), "0:IGNORE", "old finally must not clear the new role's review");
  page.take("/api/characters/role-b/snapshots/b/review", "POST").resolve({ outcome: null });
  await flush();
  page.take("/api/characters/role-b/snapshots").resolve([current]);
  await next;
  assert.equal(page.read("reviewingKey"), "");
  assert.equal(page.messages.length, 1);
  page.done();
}
async function detailCompletionRaces() {
  for (const handler of handlers) {
    const page = harness();
    const selected = snapshot("a");
    await page.call("applyDetail", selected);
    const pending = start(page, handler, selected);
    page.confirm();
    await flush();
    const response = page.take(handler === "reviewChange" ? `${list}/a/review` : list, "POST");
    await page.call("selectDetail", snapshot("other"));
    response.resolve(writeResult());
    await pending;
    assert.equal(page.read<{ id: string }>("detail").id, "other");
    assert.equal(page.messages.length, 0);
    page.done();
  }
}
await listRaces();
await reviewIdentityAndFinally();
await detailCompletionRaces();
await confirmationRaces();
await completionRaces();
await normalFlow();
console.log("snapshot page races: actual script/setup list, confirmations, writes and refresh guards passed");
