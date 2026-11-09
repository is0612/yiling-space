import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/** Run the current page code, not a second implementation of its request guards.
 * No Nuxt server, browser, database, real timers, or network requests are needed.
 * Run: yarn tsx scripts/test-memory-page-races.ts
 *
 * 长期记忆列表现在是一页一条请求（页码 / 关键词 / 范围都在服务端），
 * 统计数字走 `/memory-stats`。这里守住三件事：迟到的列表不能覆盖新角色或新关键词、
 * 写操作完成后刷新的是当前页、详情弹窗的竞态和以前一样。
 */
const pagePath = new URL("../app/components/MemoryWorkspace.vue", import.meta.url);
const sfc = readFileSync(pagePath, "utf8");
const scriptMatch = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "MemoryWorkspace.vue must contain a script block");
const source = ts.createSourceFile("memory-workspace.ts", scriptMatch[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
const executable = new Script(compiled.outputText, { filename: "MemoryWorkspace.vue.actual-script.js" });

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
    ElMessage: { error: (message: string) => errors.push(message), success: () => {}, warning: () => {}, info: () => {} },
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
  function match(path: string, params: Record<string, string> = {}) {
    const found = requests.findIndex((request) => {
      const url = new URL(request.url, "http://test.local");
      if (url.pathname !== path) return false;
      return Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
    });
    assert.ok(found >= 0, `expected pending request: ${path} ${JSON.stringify(params)}`);
    return requests.splice(found, 1)[0]!;
  }
  function take(path: string, query?: string) {
    return match(path, query === undefined ? {} : { q: query });
  }
  function tickSearch() {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  }
  async function finishRoleLoad(roleId: string) {
    take(`/api/characters/${roleId}`).resolve({ id: roleId, name: roleId });
    await flush();
    take(`/api/characters/${roleId}/memories`).resolve(list(roleId));
    take(`/api/characters/${roleId}/memory-stats`).resolve(stats(roleId));
    await flush();
  }
  function done() {
    assert.equal(requests.length, 0, `unsettled requests: ${requests.map((request) => request.url).join(", ")}`);
    assert.equal(errors.length, 0, `unexpected error notifications: ${errors.join(", ")}`);
  }
  return { read, set, call, match, take, tickSearch, finishRoleLoad, done, errors, timers, requests };
}

function detail(id: string) {
  return { id, category: id === "b" ? "GOAL" : "FACT", content: `content-${id}`,
    sourceMessage: { id: `message-${id}`, content: `source-${id}` },
    sourceSnapshot: { id: `snapshot-${id}`, summary: `summary-${id}` } };
}
function row(id: string) {
  return {
    id, category: "FACT", content: `content-${id}`, status: "ACTIVE", scopeType: "CHARACTER_GLOBAL",
    importance: 0.5, validTo: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
  };
}
function list(id: string, options: { total?: number; page?: number; totalPages?: number } = {}) {
  return {
    items: [row(id)],
    total: options.total ?? 1,
    page: options.page ?? 1,
    pageSize: 10,
    totalPages: options.totalPages ?? 1,
  };
}
function trash(id: string) {
  return {
    id, category: "FACT", content: `trashed-${id}`, status: "TRASHED", statusBeforeTrash: "ACTIVE",
    deletedAt: "2026-11-08T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z",
  };
}
function stats(id: string) {
  return { memory: id === "role-b" ? 7 : 3, commitment: 1, message: 10, event: 2, snapshot: 4, memoryEvent: 5 };
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

async function onlyLoadsMemories() {
  const page = harness();
  const loading = page.call("loadCharacter");
  page.take("/api/characters/role-a").resolve({ id: "role-a", name: "角色 A" });
  await flush();
  const listRequest = page.take("/api/characters/role-a/memories");
  const url = new URL(listRequest.url, "http://test.local");
  assert.equal(url.searchParams.get("page"), "1", "The list must ask the server for a page, not a 400-row window.");
  assert.equal(url.searchParams.has("q"), false, "An empty search box must not send a keyword.");
  listRequest.resolve(list("role-a"));
  page.take("/api/characters/role-a/memory-stats").resolve(stats("role-a"));
  await loading;
  equal(page.read("memoryRows"), [row("role-a")]);
  assert.equal(page.read("memoryTotal"), 1);
  assert.equal(page.read("recordedMessageCount"), 10);
  assert.equal(page.read("commitmentCount"), 1);
  page.done(); // No timeline call: the page only needs its own page of memories + counters.
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
    await flush();
    // 保存期间换了详情：写入会落库，但刷新被 detailSeq 挡住，不会把结果画到 b 上。
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

async function roleSwitchList() {
  const page = harness();
  void page.call("loadCharacter");
  await page.finishRoleLoad("role-a");
  page.set("query", "  favorite tea  ");
  page.tickSearch();
  const old = page.take("/api/characters/role-a/memories", "favorite tea");
  page.set("id", "role-b");
  assert.equal(page.timers.size, 0, "role watcher must cancel the old debounce");
  const characterRequest = page.take("/api/characters/role-b");
  old.resolve(list("stale"));
  await flush();
  equal(page.read("memoryRows"), [], "a stale page must not repopulate the new role");
  characterRequest.resolve({ id: "role-b", name: "role-b" });
  await flush();
  // 换角色会清空搜索词，所以新请求不带 q。
  const current = page.take("/api/characters/role-b/memories");
  const url = new URL(current.url, "http://test.local");
  assert.equal(url.searchParams.has("q"), false);
  current.resolve(list("role-b"));
  page.take("/api/characters/role-b/memory-stats").resolve(stats("role-b"));
  await flush();
  equal(page.read("memoryRows"), [row("role-b")]);
  assert.equal(page.read<{ memory: number }>("memoryStats").memory, 7, "counters must follow the new role");
  page.done();
}

async function queryChanges() {
  const page = harness();
  void page.call("loadCharacter");
  await page.finishRoleLoad("role-a");
  page.set("query", "old query");
  page.tickSearch();
  const old = page.take("/api/characters/role-a/memories", "old query");
  page.set("query", "new query");
  // Old response arrives during the debounce, before the next request starts.
  old.resolve(list("a"));
  await flush();
  equal(page.read("memoryRows"), [row("role-a")], "a response for the previous keyword must be dropped");
  page.tickSearch();
  const fresh = page.take("/api/characters/role-a/memories", "new query");
  fresh.resolve(list("b", { total: 2 }));
  await flush();
  equal(page.read("memoryRows"), [row("b")]);
  assert.equal(page.read("memoryTotal"), 2);

  // 范围筛选是服务端参数：改一次就是一次带 scope 的请求。
  page.call("changeScope", "USER_PRIVATE");
  const scoped = page.match("/api/characters/role-a/memories", { scope: "USER_PRIVATE", q: "new query" });
  scoped.resolve(list("c"));
  await flush();
  equal(page.read("memoryRows"), [row("c")]);
  page.done();
}

async function stalePage() {
  for (const rejectOld of [false, true]) {
    const page = harness();
    void page.call("loadCharacter");
    await page.finishRoleLoad("role-a");
    const old = page.call("loadMemories", 1);
    const oldResponse = page.take("/api/characters/role-a/memories");
    const current = page.call("loadMemories", 2);
    const currentResponse = page.match("/api/characters/role-a/memories", { page: "2" });
    if (rejectOld) oldResponse.reject(new Error("stale page failed"));
    else oldResponse.resolve(list("old", { page: 1 }));
    await old;
    equal(page.read("memoryRows"), [row("role-a")]);
    assert.equal(page.read("memoryLoading"), true, "old finally must not stop the newer loading");
    currentResponse.resolve(list("new", { page: 2, total: 20, totalPages: 2 }));
    await current;
    equal(page.read("memoryRows"), [row("new")]);
    assert.equal(page.read("memoryPage"), 2);
    assert.equal(page.read("memoryLoading"), false);
    page.done();
  }
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

/**
 * 回收站也分页：打开回到第 1 页，翻页只换这一页，恢复/删除后按当前页刷新。
 */
async function recycleBinPaging() {
  const page = harness();
  void page.call("loadCharacter");
  await page.finishRoleLoad("role-a");

  const opening = page.call("openRecycleBin");
  const first = page.match("/api/characters/role-a/memories/trash", { page: "1", pageSize: "10" });
  first.resolve({ items: [trash("a")], total: 12, page: 1, pageSize: 10, totalPages: 2 });
  await opening;
  assert.equal(page.read<unknown[]>("recycleBinEntries").length, 1);
  assert.equal(page.read("recycleBinTotal"), 12);
  assert.equal(page.read("recycleBinTotalPages"), 2);

  page.call("changeRecycleBinPage", 2);
  page.match("/api/characters/role-a/memories/trash", { page: "2", pageSize: "10" }).resolve({
    items: [trash("b")], total: 12, page: 2, pageSize: 10, totalPages: 2,
  });
  await flush();
  equal(page.read("recycleBinEntries"), [trash("b")]);
  assert.equal(page.read("recycleBinPage"), 2);

  // 再打开一次必须回到第 1 页：停在上次翻到的页会让人以为只剩这些。
  const reopen = page.call("openRecycleBin");
  page.match("/api/characters/role-a/memories/trash", { page: "1", pageSize: "10" }).resolve({
    items: [trash("a")], total: 12, page: 1, pageSize: 10, totalPages: 2,
  });
  await reopen;
  assert.equal(page.read("recycleBinPage"), 1);

  // 迟到的第 2 页不能覆盖重新打开后的第 1 页。
  const stale = page.call("loadRecycleBin", 2);
  const staleResponse = page.match("/api/characters/role-a/memories/trash", { page: "2", pageSize: "10" });
  const fresh = page.call("loadRecycleBin", 1);
  const freshResponse = page.match("/api/characters/role-a/memories/trash", { page: "1", pageSize: "10" });
  staleResponse.resolve({ items: [trash("b")], total: 12, page: 2, pageSize: 10, totalPages: 2 });
  await stale;
  equal(page.read("recycleBinEntries"), [trash("a")], "stale trash page must be dropped");
  freshResponse.resolve({ items: [trash("c")], total: 1, page: 1, pageSize: 10, totalPages: 1 });
  await fresh;
  equal(page.read("recycleBinEntries"), [trash("c")]);
  assert.equal(page.read("recycleBinLoading"), false);
  page.done();
}

for (const test of [onlyLoadsMemories, detailOrder, saveDuringDetailLoad, staleSaveCompletion, roleSwitchDetail, roleSwitchList, queryChanges, stalePage, staleGroup, recycleBinPaging]) {
  await test();
  console.log(`PASS ${test.name}`);
}
console.log("memory page async race regressions passed (actual MemoryWorkspace.vue handlers and watchers)");
