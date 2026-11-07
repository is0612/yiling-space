import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/** Run the current page code, not a second implementation of its request guards.
 * No Nuxt server, browser, database, real timers, or network requests are needed.
 * Run: yarn tsx scripts/test-memory-page-races.ts
 */
const pagePath = new URL("../app/pages/memory.vue", import.meta.url);
const sfc = readFileSync(pagePath, "utf8");
const scriptMatch = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "memory.vue must contain a script block");
const source = ts.createSourceFile("memory-page.ts", scriptMatch[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = source.statements.filter((node) => !ts.isImportDeclaration(node)
  && !(ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)));
const names = statements.flatMap((node) => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }
  return ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : [];
});
// Keep every declaration, function body, and watch registration verbatim. Only
// module imports and the unrelated top-level character-list SSR await are omitted.
const program = `${statements.map((node) => node.getText(source)).join("\n")}\nreturn { id, ${names.join(", ")} };`;
const compiled = ts.transpileModule(`(function () {\n${program}\n})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
const executable = new Script(compiled.outputText, { filename: "memory.vue.actual-script.js" });

type Ref = { value: unknown };
type PendingRequest = {
  url: string;
  options?: { query?: Record<string, string> };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function harness() {
  const watchers: Array<{ sources: Ref[]; callback: () => void }> = [];
  const timers = new Map<number, () => void>();
  const requests: PendingRequest[] = [];
  const errors: string[] = [];
  const role: Ref = { value: "role-a" };
  let timerId = 0;
  const bindings = executable.runInContext(createContext({
    /** Nuxt 编译期宏：只在构建时注册路由元信息，运行时被抹掉，沙盒里桩掉即可。 */
    definePageMeta: () => {},
    ref: (value: unknown) => ({ value }),
    computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: (sources: Ref | Ref[], callback: () => void) => watchers.push({ sources: Array.isArray(sources) ? sources : [sources], callback }),
    onMounted: () => {},
    onBeforeUnmount: () => {},
    useCharacterList: () => ({ value: [] }),
    useMemoryProgress: () => ({ lastFinished: { value: null } }),
    useCharacterSelection: () => ({ id: role }),
    URLSearchParams,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    ElMessage: { error: (message: string) => errors.push(message) },
    $fetch: (url: string, options?: PendingRequest["options"]) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }),
  })) as Record<string, Ref | ((...args: unknown[]) => Promise<void>)>;

  function read<T = unknown>(name: string): T {
    assert.ok(name in bindings, `missing page binding: ${name}`);
    return (bindings[name] as Ref).value as T;
  }
  function set(name: string, value: unknown) {
    const target = bindings[name] as Ref;
    const previous = target.value;
    target.value = value;
    if (previous !== value) {
      for (const watcher of watchers) if (watcher.sources.includes(target)) watcher.callback();
    }
  }
  function call(name: string, ...args: unknown[]) {
    assert.equal(typeof bindings[name], "function", `missing page handler: ${name}`);
    return (bindings[name] as (...args: unknown[]) => Promise<void>)(...args);
  }
  function take(path: string, query?: string) {
    const index = requests.findIndex((request) => new URL(request.url, "http://test.local").pathname === path
      && (query === undefined || new URL(request.url, "http://test.local").searchParams.get("q") === query));
    assert.ok(index >= 0, `expected pending request: ${path}${query ? ` q=${query}` : ""}`);
    return requests.splice(index, 1)[0]!;
  }
  function tickSearch() {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  }
  async function finishRoleLoad(roleId: string) {
    take(`/api/characters/${roleId}`).resolve({ id: roleId, name: roleId });
    await flush();
    take(`/api/characters/${roleId}/snapshots`).resolve([]);
    take(`/api/characters/${roleId}/timeline`).resolve(timeline(roleId));
    await flush();
  }
  function done() {
    assert.equal(requests.length, 0, `unsettled requests: ${requests.map((request) => request.url).join(", ")}`);
    assert.equal(errors.length, 0, `unexpected error notifications: ${errors.join(", ")}`);
  }
  return { read, set, call, take, tickSearch, finishRoleLoad, done, errors, timers };
}

function detail(id: string) {
  return { id, category: id === "b" ? "GOAL" : "FACT", content: `content-${id}`,
    sourceMessage: { id: `message-${id}`, content: `source-${id}` },
    sourceSnapshot: { id: `snapshot-${id}`, summary: `summary-${id}` } };
}
function timeline(id: string) {
  return { entries: [{ id }], counts: { message: 1, event: 2, memory: 3, snapshot: 4, memoryEvent: 5 },
    days: [{ dayKey: id, state: "FINAL", eventCount: 5, extractedAt: null }], today: id };
}
function search(id: string, nextCursor: string | null = null) {
  return { items: [{ id, content: `result-${id}` }], total: id === "b" ? 2 : 1, nextCursor };
}
function group(id: string) {
  return { groups: [{ conversationId: id, label: id }], selectedConversationId: id, messages: [{ id: `message-${id}` }] };
}
function equal(actual: unknown, expected: unknown) {
  // Normalize cross-VM prototypes before comparing the observable state.
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}
function assertDetail(page: ReturnType<typeof harness>, id: string) {
  assert.equal(page.read("editingMemoryId"), id);
  assert.equal(page.read("draftEditMemoryContent"), `content-${id}`);
  assert.equal(page.read("draftEditMemoryCategory"), detail(id).category);
  equal(page.read("editingMemorySource"), detail(id).sourceMessage);
  equal(page.read("editingMemorySnapshot"), detail(id).sourceSnapshot);
  assert.equal(page.read("memoryEditDialogOpen"), true);
}

async function detailOrder() {
  for (const rejectOld of [false, true]) {
    const page = harness();
    const old = page.call("openMemoryDetail", "a");
    const oldResponse = page.take("/api/memories/a");
    const current = page.call("openMemoryDetail", "b");
    page.take("/api/memories/b").resolve(detail("b"));
    await current;
    assertDetail(page, "b");
    if (rejectOld) oldResponse.reject(new Error("late A failure"));
    else oldResponse.resolve(detail("a"));
    await old;
    assertDetail(page, "b");
    assert.equal(page.read("memoryEditLoading"), false);
    page.done();
  }
  const page = harness();
  const old = page.call("openMemoryDetail", "a");
  const current = page.call("openMemoryDetail", "b");
  page.take("/api/memories/a").resolve(detail("a"));
  await old;
  assert.equal(page.read("memoryEditLoading"), true, "old finally must not end B's loading state");
  page.take("/api/memories/b").resolve(detail("b"));
  await current;
  assertDetail(page, "b");
  page.done();
}

async function saveDuringDetailLoad() {
  const page = harness();
  page.set("draftEditMemoryContent", "previous memory draft");
  page.set("draftEditMemoryCategory", "GOAL");
  const pending = page.call("openMemoryDetail", "b");
  assert.equal(page.read("draftEditMemoryContent"), "", "opening B must discard A's draft");
  assert.equal(page.read("draftEditMemoryCategory"), "FACT");
  // Even a nonempty draft must not be saved until the selected detail arrives.
  page.set("draftEditMemoryContent", "typed while loading");
  await page.call("saveEditedMemory");
  assert.equal(page.read("memoryEditSaving"), false);
  page.take("/api/memories/b").resolve(detail("b"));
  await pending;
  assertDetail(page, "b");
  page.done(); // Any accidental PATCH would still be pending here.
}

async function staleSaveCompletion() {
  for (const rejectOld of [false, true]) {
    const page = harness();
    const first = page.call("openMemoryDetail", "a");
    page.take("/api/memories/a").resolve(detail("a"));
    await first;
    const save = page.call("saveEditedMemory");
    const saveResponse = page.take("/api/memories/a");
    const second = page.call("openMemoryDetail", "b");
    page.take("/api/memories/b").resolve(detail("b"));
    await second;
    if (rejectOld) saveResponse.reject(new Error("old save failed"));
    else saveResponse.resolve({});
    await save;
    assertDetail(page, "b");
    assert.equal(page.read("memoryEditSaving"), false);
    page.done();
  }
}

async function roleSwitchDetail() {
  for (const rejectOld of [false, true]) {
    const page = harness();
    const pending = page.call("openMemoryDetail", "a");
    page.set("id", "role-b");
    assert.equal(page.read("memoryEditDialogOpen"), false);
    assert.equal(page.read("memoryEditLoading"), false);
    assert.equal(page.read("editingMemoryId"), "");
    assert.equal(page.read("draftEditMemoryContent"), "");
    const response = page.take("/api/memories/a");
    if (rejectOld) response.reject(new Error("previous role failed"));
    else response.resolve(detail("a"));
    await pending;
    assert.equal(page.read("memoryEditDialogOpen"), false);
    assert.equal(page.read("draftEditMemoryContent"), "");
    await page.finishRoleLoad("role-b");
    page.done();
  }
}

async function roleSwitchSearch() {
  const page = harness();
  page.set("query", "  favorite tea  ");
  page.tickSearch();
  const old = page.take("/api/characters/role-a/memories", "favorite tea");
  page.set("id", "role-b");
  const current = page.take("/api/characters/role-b/memories", "favorite tea");
  assert.equal(page.timers.size, 0, "role watcher must cancel the old debounce");
  old.resolve(search("a"));
  await flush();
  equal(page.read("searchRows"), []);
  assert.equal(page.read("searchLoading"), true);
  current.resolve(search("b", "cursor-b"));
  await flush();
  equal(page.read("searchRows"), search("b").items);
  assert.equal(page.read("searchTotal"), 2);
  assert.equal(page.read("searchCursor"), "cursor-b");
  await page.finishRoleLoad("role-b");
  page.done();
}

async function queryChanges() {
  for (const rejectOld of [false, true]) {
    const page = harness();
    page.set("query", "old query");
    page.tickSearch();
    const old = page.take("/api/characters/role-a/memories", "old query");
    page.set("query", "new query");
    // Old response arrives during the debounce, before the next request starts.
    if (rejectOld) old.reject(new Error("old query failed"));
    else old.resolve(search("a"));
    await flush();
    equal(page.read("searchRows"), []);
    page.tickSearch();
    page.take("/api/characters/role-a/memories", "new query").resolve(search("b", "cursor-b"));
    await flush();
    equal(page.read("searchRows"), search("b").items);
    const olderPage = page.call("runSearch", false);
    const pagination = page.take("/api/characters/role-a/memories", "new query");
    assert.equal(new URL(pagination.url, "http://test.local").searchParams.get("cursor"), "cursor-b");
    page.set("query", "");
    pagination.resolve(search("stale page"));
    await olderPage;
    equal(page.read("searchRows"), []);
    assert.equal(page.read("searchTotal"), 0);
    assert.equal(page.read("searchCursor"), null);
    assert.equal(page.read("searchLoading"), false);
    page.done();
  }
}

async function staleTimeline() {
  for (const rejectOld of [false, true]) {
    const page = harness();
    const old = page.call("loadTimeline");
    const oldResponse = page.take("/api/characters/role-a/timeline");
    const current = page.call("loadTimeline");
    if (rejectOld) oldResponse.reject(new Error("stale timeline failed"));
    else oldResponse.resolve(timeline("old"));
    await old;
    equal(page.read("timelineEntries"), []);
    assert.equal(page.read("timelineLoading"), true);
    page.take("/api/characters/role-a/timeline").resolve(timeline("new"));
    await current;
    equal(page.read("timelineEntries"), [{ id: "new" }]);
    equal(page.read("timelineCounts"), timeline("new").counts);
    equal(page.read("timelineDays"), { new: timeline("new").days[0] });
    assert.equal(page.read("todayKey"), "new");
    assert.equal(page.read("timelineLoading"), false);
    page.done();
  }
  const page = harness();
  const old = page.call("loadTimeline");
  const response = page.take("/api/characters/role-a/timeline");
  page.set("id", "role-b");
  await page.finishRoleLoad("role-b");
  response.resolve(timeline("role-a"));
  await old;
  equal(page.read("timelineEntries"), [{ id: "role-b" }]);
  assert.equal(page.read("todayKey"), "role-b");
  page.done();
}

async function staleGroup() {
  for (const rejectOld of [false, true]) {
    const page = harness();
    const old = page.call("loadGroupChats", "group-a");
    const oldResponse = page.take("/api/characters/role-a/group-chats");
    const current = page.call("loadGroupChats", "group-b");
    const response = page.take("/api/characters/role-a/group-chats");
    assert.equal(response.options?.query?.conversationId, "group-b");
    if (rejectOld) oldResponse.reject(new Error("old group failed"));
    else oldResponse.resolve(group("group-a"));
    await old;
    assert.equal(page.read("groupChatLoading"), true);
    response.resolve(group("group-b"));
    await current;
    equal(page.read("groupChatGroups"), group("group-b").groups);
    equal(page.read("groupChatMessages"), group("group-b").messages);
    assert.equal(page.read("groupChatSelectedId"), "group-b");
    assert.equal(page.read("groupChatError"), "");
    assert.equal(page.read("groupChatLoading"), false);
    page.done();
  }
  const page = harness();
  page.set("groupChatOpen", true);
  const old = page.call("loadGroupChats", "group-a");
  const response = page.take("/api/characters/role-a/group-chats");
  page.set("id", "role-b");
  response.resolve(group("group-a"));
  await old;
  assert.equal(page.read("groupChatOpen"), false);
  equal(page.read("groupChatGroups"), []);
  equal(page.read("groupChatMessages"), []);
  assert.equal(page.read("groupChatSelectedId"), "");
  await page.finishRoleLoad("role-b");
  page.done();
}

for (const test of [detailOrder, saveDuringDetailLoad, staleSaveCompletion, roleSwitchDetail, roleSwitchSearch, queryChanges, staleTimeline, staleGroup]) {
  await test();
  console.log(`PASS ${test.name}`);
}
console.log("memory page async race regressions passed (actual memory.vue handlers and watchers)");
