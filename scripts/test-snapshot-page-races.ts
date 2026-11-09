import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/**
 * Execute the actual script/setup handlers with deferred fetch/confirmation promises.
 * Run: yarn tsx scripts/test-snapshot-page-races.ts (no DB, model, server or network).
 *
 * 这一页现在是三个接口：列表（分页/筛选都在服务端）、详情（AI 提炼结果）、
 * 来源原文（展开才取）。并发点比原来多，所以这里按「列表 / 详情 / 来源」各测一遍：
 * 迟到的响应不能落到新角色、新选中项或新一页上。
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
  const watchers: Array<{ sources: Ref[]; callback: (...args: unknown[]) => void }> = [];
  const requests: Request[] = [];
  const confirmations: Array<{ resolve: (value?: unknown) => void; reject: (reason?: unknown) => void }> = [];
  const messages: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const role = { value: "role-a" };
  const notify = (message: string) => messages.push(message);
  const bindings = executable.runInContext(createContext({
    /** Nuxt 编译期宏：只在构建时注册路由元信息，运行时被抹掉，沙盒里桩掉即可。 */
    definePageMeta: () => {},
    // 页面里用 URLSearchParams 拼查询串；vm 沙盒没有这些 Web 全局。
    URLSearchParams,
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: (sources: Ref | Ref[], callback: (...args: unknown[]) => void) => watchers.push({ sources: Array.isArray(sources) ? sources : [sources], callback }),
    onMounted: () => {}, onBeforeUnmount: () => {},
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    useCharacterList: () => ({ value: [] }), useCharacterSelection: () => ({ id: role }),
    useMemoryProgress: () => ({ lastFinished: { value: null } }),
    ElMessage: { error: notify, success: notify, warning: notify, info: notify },
    ElMessageBox: { confirm: () => new Promise((resolve, reject) => confirmations.push({ resolve, reject })) },
    $fetch: (url: string, options?: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  })) as Record<string, Ref | ((...args: unknown[]) => unknown)>;
  function read<T = unknown>(name: string): T { return (bindings[name] as Ref).value as T; }
  function set(name: string, value: unknown) {
    const target = bindings[name] as Ref;
    const previous = target.value;
    target.value = value;
    if (previous !== value) for (const watcher of watchers) if (watcher.sources.includes(target)) watcher.callback(value, previous);
  }
  function call(name: string, ...args: unknown[]): unknown {
    return (bindings[name] as (...rest: unknown[]) => unknown)(...args);
  }
  function take(path: string, method = "GET") {
    const index = requests.findIndex((request) => request.url === path && (request.options?.method ?? "GET") === method);
    assert.ok(index >= 0, `missing ${method} ${path}`);
    return requests.splice(index, 1)[0]!;
  }
  /** 只在请求真的发出时才取：同一份再刷一次列表，详情不会重复请求。 */
  function takeIf(path: string, method = "GET") {
    const index = requests.findIndex((request) => request.url === path && (request.options?.method ?? "GET") === method);
    return index >= 0 ? requests.splice(index, 1)[0]! : null;
  }
  function confirm() { assert.ok(confirmations.length, "missing confirmation"); confirmations.shift()!.resolve(); }
  function runTimers() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); }
  function done() { assert.equal(requests.length, 0, "unexpected/unsettled request"); assert.equal(confirmations.length, 0); }
  return { read, set, call, take, takeIf, confirm, runTimers, done, messages, requests, bindings };
}

/** 列表 URL：与 loadSnapshots 拼出来的参数顺序一致。 */
function listUrl(characterId: string, options: { page?: number; kind?: "AUTOMATIC" | "ALL"; status?: string; q?: string } = {}) {
  const params = new URLSearchParams({ page: String(options.page ?? 1), pageSize: "10" });
  if (options.status) params.set("status", options.status);
  if (options.kind !== "ALL") params.set("kind", options.kind ?? "AUTOMATIC");
  if (options.q) params.set("q", options.q);
  return `/api/characters/${characterId}/snapshots?${params.toString()}`;
}
function detailUrl(characterId: string, id: string) {
  return `/api/characters/${characterId}/snapshots/${id}`;
}
function sourcesUrl(characterId: string, id: string, page = 1) {
  return `/api/characters/${characterId}/snapshots/${id}/sources?page=${page}&pageSize=10`;
}
function summary(id: string) {
  return {
    id, kind: "AUTOMATIC", number: 1, label: "第 1 份", version: 1, date: "2026-11-05 09:00",
    range: "2026-11-01 — 2026-11-05", summary: id, events: 0, messages: 0,
    status: "当前版本", statusTone: "green", pendingReview: 1,
  };
}
function detail(id: string) {
  return {
    ...summary(id),
    analysis: { memoryChangesApplied: [{ action: "ADD", result: "NOT_APPLIED_REGENERATION", content: id }] },
    evidenceIndex: { [`msg-${id}`]: 3 },
  };
}
function pageResult(ids: string[], page = 1) {
  return {
    items: ids.map(summary), total: ids.length, page, pageSize: 10, totalPages: 1,
    counts: { automatic: ids.length, manual: 0, current: ids.length, superseded: 0 },
    stats: { messages: 0, latestDate: null },
  };
}

/** 解析一次「列表 + 详情」：列表回来之后页面会紧跟一次详情请求。 */
async function settleLoad(page: ReturnType<typeof harness>, characterId: string, ids: string[], options: Parameters<typeof listUrl>[1] = {}) {
  page.take(listUrl(characterId, options)).resolve(pageResult(ids, options.page ?? 1));
  await flush();
  const nextDetail = ids.length ? page.takeIf(detailUrl(characterId, ids[0]!)) : null;
  if (nextDetail) {
    nextDetail.resolve(detail(ids[0]!));
    await flush();
  }
}

async function listAndDetailRaces() {
  // 1. 迟到的列表响应不能落到新角色上（成功/失败都一样）。
  for (const reject of [false, true]) {
    const page = harness();
    const old = page.call("loadSnapshots", { page: 1 });
    const stale = page.take(listUrl("role-a"));
    page.set("id", "role-b");
    await settleLoad(page, "role-b", ["b"]);
    if (reject) stale.reject(new Error("late list failure")); else stale.resolve(pageResult(["stale"]));
    await old;
    assert.equal(page.read<{ id: string }>("detail").id, "b");
    assert.equal(page.read("loading"), false);
    assert.equal(page.messages.length, 0);
    page.done();
  }

  // 2. 迟到的详情响应不能覆盖新选中项。
  const page = harness();
  void page.call("loadSnapshots", { page: 1 });
  await settleLoad(page, "role-a", ["a", "c"]);
  const stale = page.call("loadDetail", "a");
  const staleRequest = page.take(detailUrl("role-a", "a"));
  await page.call("selectDetail", summary("c"));
  page.take(detailUrl("role-a", "c")).resolve(detail("c"));
  await flush();
  assert.equal(page.read<{ id: string }>("detail").id, "c");
  staleRequest.reject(new Error("late detail"));
  await stale;
  assert.equal(page.read<{ id: string }>("detail").id, "c", "late detail must not replace the current one");
  assert.equal(page.messages.length, 0);
  page.done();
}

async function sourceRaces() {
  const page = harness();
  void page.call("loadSnapshots", { page: 1 });
  await settleLoad(page, "role-a", ["a"]);
  page.call("toggleSources");
  page.take(sourcesUrl("role-a", "a", 1)).resolve({
    items: [{ index: 1, id: "m1", role: "USER", eventType: "message", content: "hi", occurredAt: "2026-11-05T01:00:00.000Z", conversationTitle: null }],
    total: 20, page: 1, pageSize: 10, totalPages: 2,
  });
  await flush();
  assert.equal(page.read<unknown[]>("sourceItems").length, 1);
  assert.equal(page.read("sourceTotal"), 20);
  assert.equal(page.read("sourceTotalPages"), 2);

  page.call("changeSourcePage", 2);
  const second = page.take(sourcesUrl("role-a", "a", 2));
  // 翻页途中切到另一份：迟到的第 2 页属于旧快照，必须丢掉。
  await page.call("selectDetail", summary("c"));
  page.take(detailUrl("role-a", "c")).resolve(detail("c"));
  await flush();
  second.resolve({ items: [], total: 20, page: 2, pageSize: 10, totalPages: 2 });
  await flush();
  assert.equal(page.read<unknown[]>("sourceItems").length, 0, "stale sources must not leak into another snapshot");
  assert.equal(page.read("sourcePage"), 1);
  page.done();
}

async function filterAndPagination() {
  const page = harness();
  void page.call("loadSnapshots", { page: 1 });
  await settleLoad(page, "role-a", ["a"]);

  page.call("changePage", 2);
  await settleLoad(page, "role-a", ["b"], { page: 2 });

  page.call("setShowManual", true);
  await settleLoad(page, "role-a", ["b"], { kind: "ALL" });

  page.call("setStatusFilter", "已被替代");
  await settleLoad(page, "role-a", ["b"], { kind: "ALL", status: "SUPERSEDED" });

  // 搜索防抖：改关键词先不发请求，定时器到点才带上 q。
  page.set("query", "片单");
  assert.equal(page.requests.length, 0, "typing must not fire a request before the debounce");
  page.runTimers();
  await settleLoad(page, "role-a", ["b"], { kind: "ALL", status: "SUPERSEDED", q: "片单" });

  assert.equal(page.read<{ id: string }>("detail").id, "b");
  page.done();
}

async function writeGuards() {
  // 采纳建议：POST 之后刷新列表 + 详情；切换角色后旧结果不允许写回页面。
  for (const switchRole of [false, true]) {
    const page = harness();
    void page.call("loadSnapshots", { page: 1 });
    await settleLoad(page, "role-a", ["a"]);
    const item = page.read<{ analysis: { memoryChangesApplied: Array<Record<string, unknown>> } }>("detail").analysis.memoryChangesApplied[0]!;
    const pending = page.call("reviewChange", 0, "ACCEPT", item);
    page.confirm();
    await flush();
    const post = page.take(detailUrl("role-a", "a") + "/review", "POST");
    assert.equal(JSON.stringify(post.options?.body), JSON.stringify({ changeIndex: 0, decision: "ACCEPT" }));
    if (switchRole) {
      page.set("id", "role-b");
      await settleLoad(page, "role-b", ["b"]);
    }
    post.resolve({ outcome: "CREATED" });
    if (switchRole) {
      await pending;
      assert.equal(page.read<{ id: string }>("detail").id, "b");
      assert.equal(page.messages.length, 0, "a stale review must not report success");
    } else {
      // 采纳成功会刷新「列表 + 详情」；先把它解析掉，写入流程才走得完。
      await flush();
      await settleLoad(page, "role-a", ["a"]);
      await pending;
      assert.equal(page.messages.length, 1);
      assert.equal(page.read<{ id: string }>("detail").id, "a");
      assert.equal(page.read("reviewingKey"), "");
    }
    page.done();
  }

  // 手动存档：POST 成功后才拉列表，并且自动展开「手动存档」这一层筛选。
  const page = harness();
  void page.call("loadSnapshots", { page: 1 });
  await settleLoad(page, "role-a", ["a"]);
  const pending = page.call("createSnapshot");
  page.confirm();
  await flush();
  page.take("/api/characters/role-a/snapshots", "POST").resolve({ id: "new" });
  await flush();
  assert.equal(page.read("showManual"), true);
  page.take(listUrl("role-a", { kind: "ALL" })).resolve(pageResult(["new"]));
  await flush();
  page.take(detailUrl("role-a", "new")).resolve(detail("new"));
  await pending;
  assert.equal(page.read<{ id: string }>("detail").id, "new");
  assert.equal(page.read("creating"), false);
  page.done();
}

async function evidenceNumbering() {
  const page = harness();
  void page.call("loadSnapshots", { page: 1 });
  await settleLoad(page, "role-a", ["a"]);
  // 依据编号来自服务端的 evidenceIndex：翻到第几页都不依赖本地数组下标。
  assert.equal(page.call("evidenceLabel", ["msg-a"]), "#3");
  assert.equal(page.call("evidenceLabel", ["unknown-id"]), "unknown-");
  page.done();
}

await listAndDetailRaces();
await sourceRaces();
await filterAndPagination();
await writeGuards();
await evidenceNumbering();
console.log("snapshot page races: actual script/setup list, detail, sources, filters, confirmations and refresh guards passed");
