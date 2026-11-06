import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/** Execute the current days.vue script with controlled requests and watchers. */
const pagePath = new URL("../app/pages/days.vue", import.meta.url);
const sfc = readFileSync(pagePath, "utf8");
const scriptMatch = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "days.vue must contain a script block");
const source = ts.createSourceFile("days-page.ts", scriptMatch[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = source.statements.filter((node) => !ts.isImportDeclaration(node)
  && !(ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)));
const names = statements.flatMap((node) => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }
  return ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : [];
});
const program = `${statements.map((node) => node.getText(source)).join("\n")}
return { ${names.join(", ")} };
`;
const compiled = ts.transpileModule(`(function () {\n${program}\n})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
const executable = new Script(compiled.outputText, { filename: "days.vue.actual-script.js" });

type Ref = { value: unknown };
type PendingRequest = {
  url: string;
  options?: { method?: string; body?: unknown };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function harness() {
  const watchers: Array<{ sources: Ref[]; callback: () => void }> = [];
  const timers = new Map<number, () => void>();
  const requests: PendingRequest[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const successes: string[] = [];
  const role: Ref = { value: "role-a" };
  let timerId = 0;
  let unmount: (() => void) | null = null;

  const context = createContext({
    ref: (initial: unknown) => {
      let value = initial;
      const result = {} as Ref;
      Object.defineProperty(result, "value", {
        get: () => value,
        set: (next: unknown) => {
          const previous = value;
          value = next;
          if (Object.is(previous, next)) return;
          for (const watcher of watchers) if (watcher.sources.includes(result)) watcher.callback();
        },
      });
      return result;
    },
    computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: (sources: Ref | Ref[], callback: () => void) => watchers.push({ sources: Array.isArray(sources) ? sources : [sources], callback }),
    onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    useCharacterListData: async () => {},
    useCharacterSelection: () => ({ id: role }),
    useCharacterList: () => ({ value: [{ id: "role-a", name: "角色 A" }, { id: "role-b", name: "角色 B" }] }),
    URLSearchParams,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    ElMessage: {
      error: (message: string) => errors.push(message),
      warning: (message: string) => warnings.push(message),
      success: (message: string) => successes.push(message),
    },
    ElMessageBox: { confirm: async () => true },
    $fetch: (url: string, options?: PendingRequest["options"]) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }),
  });
  const bindings = executable.runInContext(context) as Record<string, Ref | ((...args: unknown[]) => Promise<void>)>;

  function read<T = unknown>(name: string): T {
    assert.ok(name in bindings, `missing page binding: ${name}`);
    return (bindings[name] as Ref).value as T;
  }
  function set(name: string, value: unknown) {
    const target = bindings[name] as Ref;
    target.value = value;
  }
  function call(name: string, ...args: unknown[]) {
    assert.equal(typeof bindings[name], "function", `missing page handler: ${name}`);
    return (bindings[name] as (...args: unknown[]) => Promise<void>)(...args);
  }
  function take(path: string, query?: string, method?: string) {
    const index = requests.findIndex((request) => {
      const parsed = new URL(request.url, "http://test.local");
      return parsed.pathname === path
        && (query === undefined || parsed.searchParams.get("q") === query)
        && (method === undefined || request.options?.method === method);
    });
    assert.ok(index >= 0, `expected pending request: ${path}`);
    return requests.splice(index, 1)[0]!;
  }
  function tickSearch() {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  }
  function finish() {
    assert.equal(requests.length, 0, `unsettled requests: ${requests.map((request) => request.url).join(", ")}`);
    assert.equal(errors.length, 0, `unexpected error notifications: ${errors.join(", ")}`);
  }
  return { read, set, call, take, tickSearch, timers, errors, warnings, successes, finish, unmount: () => unmount?.() };
}

function day(key: string) {
  return { dayKey: key, state: "FINAL", eventCount: 2, extractedAt: "2026-11-05T16:00:00.000Z" };
}
function daysResult(key: string, timeZone = "Asia/Shanghai") {
  return { today: key, timeZone, days: [day(key)] };
}
function detailResult(key: string, timeZone = "Asia/Shanghai") {
  return {
    day: day(key),
    events: [],
    eventsTotal: 0,
    eventsTruncated: false,
    messageGroups: [],
    usage: { calls: 1, tokens: 100 },
    timeZone,
  };
}
async function flushMicrotasks() { await flush(); await flush(); }

async function staleRoleDays() {
  const page = harness();
  const old = page.call("loadDays", "role-a");
  const oldResponse = page.take("/api/characters/role-a/days");
  page.set("id", "role-b");
  const currentResponse = page.take("/api/characters/role-b/days");
  oldResponse.resolve(daysResult("2026-11-04"));
  await old;
  assert.deepEqual(page.read("days"), []);
  assert.equal(page.read("loading"), true);
  currentResponse.resolve(daysResult("2026-11-05", "America/Los_Angeles"));
  await flushMicrotasks();
  assert.deepEqual(page.read("days"), [day("2026-11-05")]);
  assert.equal(page.read("timeZone"), "America/Los_Angeles");
  page.take("/api/characters/role-b/days/2026-11-05").resolve(detailResult("2026-11-05", "America/Los_Angeles"));
  await flushMicrotasks();
  assert.equal(page.read("detail").day.dayKey, "2026-11-05");
  assert.equal(page.read("loading"), false);
  page.finish();
}

async function staleSelectedDay() {
  const page = harness();
  page.set("selected", "2026-11-04");
  const old = page.take("/api/characters/role-a/days/2026-11-04");
  page.set("selected", "2026-11-05");
  const current = page.take("/api/characters/role-a/days/2026-11-05");
  old.resolve(detailResult("2026-11-04"));
  await flushMicrotasks();
  assert.equal(page.read("detail"), null);
  assert.equal(page.read("detailLoading"), true);
  current.resolve(detailResult("2026-11-05"));
  await flushMicrotasks();
  assert.equal(page.read("detail").day.dayKey, "2026-11-05");
  assert.equal(page.read("detailLoading"), false);
  page.finish();
}

async function searchInvalidatesBeforeDebounce() {
  const page = harness();
  page.set("searchQuery", "旧关键词");
  page.tickSearch();
  const old = page.take("/api/characters/role-a/days", "旧关键词");
  page.set("searchQuery", "新关键词");
  old.resolve(daysResult("2026-11-01"));
  await flushMicrotasks();
  assert.deepEqual(page.read("days"), []);
  assert.equal(page.read("loading"), true);
  page.tickSearch();
  page.take("/api/characters/role-a/days", "新关键词").resolve(daysResult("2026-11-05"));
  await flushMicrotasks();
  assert.deepEqual(page.read("days"), [day("2026-11-05")]);
  page.take("/api/characters/role-a/days/2026-11-05").resolve(detailResult("2026-11-05"));
  await flushMicrotasks();
  page.finish();
}

async function selectingFromListLoadsDetailOnce() {
  const page = harness();
  const pending = page.call("loadDays");
  page.take("/api/characters/role-a/days").resolve(daysResult("2026-11-05"));
  await flushMicrotasks();
  assert.equal(page.read("selected"), "2026-11-05");
  const detailRequests = page.requestsCount?.() ?? 0;
  assert.equal(detailRequests, 0);
  const request = page.take("/api/characters/role-a/days/2026-11-05");
  request.resolve(detailResult("2026-11-05"));
  await pending;
  await flushMicrotasks();
  page.finish();
}

async function unmountInvalidatesRequests() {
  const page = harness();
  const pending = page.call("loadDays");
  const response = page.take("/api/characters/role-a/days");
  page.unmount();
  response.resolve(daysResult("2026-11-05"));
  await pending;
  assert.deepEqual(page.read("days"), []);
  page.finish();
}

for (const test of [staleRoleDays, staleSelectedDay, searchInvalidatesBeforeDebounce, selectingFromListLoadsDetailOnce, unmountInvalidatesRequests]) {
  await test();
  console.log(`PASS ${test.name}`);
}
console.log("days page async race regressions passed (actual days.vue handlers and watchers)");
