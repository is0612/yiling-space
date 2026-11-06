import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/** Run the actual journal.vue script with deferred network and confirmation promises. */
const sfc = readFileSync(new URL("../app/pages/journal.vue", import.meta.url), "utf8");
const match = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
assert.ok(match, "journal.vue must contain a script block");
const source = ts.createSourceFile("journal-page.ts", match[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = source.statements.filter((node) => !ts.isImportDeclaration(node)
  && !(ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)));
const names = statements.flatMap((node) => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((d) => ts.isIdentifier(d.name) ? [d.name.text] : []);
  }
  return ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : [];
});
const program = `${statements.map((node) => node.getText(source)).join("\n")}
return { id, ${names.join(", ")} };
`;
const compiled = ts.transpileModule(`(function () {\n${program}\n})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
const executable = new Script(compiled.outputText, { filename: "journal.vue.actual-script.js" });

type Ref = { value: unknown };
type Request = {
  url: string;
  options?: { method?: string; body?: unknown; query?: Record<string, unknown> };
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};
type Confirmation = { resolve: (value?: unknown) => void; reject: (reason?: unknown) => void };

function harness() {
  const watchers: Array<{ sources: Ref[]; callback: () => void }> = [];
  const requests: Request[] = [];
  const confirmations: Confirmation[] = [];
  const messages: string[] = [];
  const role = { value: "role-a" };
  let unmount: (() => void) | null = null;

  const bindings = executable.runInContext(createContext({
    ref: (initial: unknown) => {
      let value = initial;
      const target = {} as Ref;
      Object.defineProperty(target, "value", {
        get: () => value,
        set: (next: unknown) => {
          const previous = value;
          value = next;
          if (Object.is(previous, next)) return;
          for (const watcher of watchers) if (watcher.sources.includes(target)) watcher.callback();
        },
      });
      return target;
    },
    reactive: (value: unknown) => value,
    computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: (sources: Ref | Ref[], callback: () => void) => watchers.push({ sources: Array.isArray(sources) ? sources : [sources], callback }),
    onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    useCharacterListData: async () => {},
    useCharacterSelection: () => ({ id: role }),
    useCharacterList: () => ({ value: [{ id: "role-a", name: "角色 A" }, { id: "role-b", name: "角色 B" }] }),
    useRequestFetch: () => (url: string, options?: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    ElMessage: {
      error: (message: string) => messages.push(`error:${message}`),
      success: (message: string) => messages.push(`success:${message}`),
      warning: (message: string) => messages.push(`warning:${message}`),
      info: (message: string) => messages.push(`info:${message}`),
    },
    ElMessageBox: {
      confirm: () => new Promise((resolve, reject) => confirmations.push({ resolve, reject })),
    },
  })) as Record<string, Ref | ((...args: unknown[]) => Promise<unknown>)>;

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
    return (bindings[name] as (...values: unknown[]) => Promise<unknown>)(...args);
  }
  function take(path: string, method = "GET") {
    const index = requests.findIndex((request) => request.url === path && (request.options?.method ?? "GET") === method);
    assert.ok(index >= 0, `missing ${method} ${path}; pending: ${requests.map((request) => request.url).join(", ")}`);
    return requests.splice(index, 1)[0]!;
  }
  function confirm() {
    assert.ok(confirmations.length, "no pending confirmation");
    confirmations.shift()!.resolve();
  }
  function finish() {
    assert.equal(requests.length, 0, `unsettled requests: ${requests.map((request) => request.url).join(", ")}`);
    assert.equal(confirmations.length, 0, "unsettled confirmations");
    assert.equal(messages.filter((m) => m.startsWith("error:")).length, 0, `unexpected errors: ${messages.join("; ")}`);
  }
  function unmountPage() { unmount?.(); }
  return { read, set, call, take, confirm, finish, unmountPage, requests, messages };
}

const DAY_A = "2026-11-04";
const DAY_B = "2026-11-05";
function listResult(dayKey: string) {
  return {
    items: [{
      id: `journal-${dayKey}`, dayKey, status: "ACTIVE", diaryTitle: "一天",
      diaryFirstLine: "今天发生了一些事。", handbookQuote: null,
      diaryVersion: 1, handbookVersion: 0, updatedAt: "2026-11-05T10:00:00.000Z",
    }],
    total: 1, page: 1, pageSize: 20, totalPages: 1, hasMore: false,
    timeZone: "Asia/Kuala_Lumpur", todayKey: DAY_B, yesterdayKey: DAY_A,
  };
}
function revision(kind: "DIARY" | "HANDBOOK" = "DIARY") {
  return {
    id: "revision-a", kind, version: 1, title: "一天", content: "今天经历了重要的事情。".repeat(8),
    thought: null, quote: null, tags: [], sourceDiaryRevisionId: null, sourceDiaryVersion: null,
    revisionType: "USER_EDITED", promptVersion: null, model: null, editedByUserId: "user-a",
    createdAt: "2026-11-05T10:00:00.000Z", sources: { messages: 1, events: 0 },
  };
}
function detailResult(dayKey: string) {
  return {
    id: `journal-${dayKey}`, dayKey, status: "ACTIVE", skipReason: null,
    createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z",
    diaryState: "GENERATED", handbookState: "PENDING", diaryDecidedAt: null, handbookDecidedAt: null,
    revisionCounts: { diary: 1, handbook: 0 }, diary: revision(), handbook: null,
  };
}
async function flushMicrotasks() { await flush(); await flush(); }

async function staleListAfterRoleSwitch() {
  const page = harness();
  const oldLoad = page.call("loadList");
  const oldRequest = page.take("/api/characters/role-a/journals");
  page.set("id", "role-b");
  const newRequest = page.take("/api/characters/role-b/journals");
  oldRequest.resolve(listResult(DAY_A));
  await oldLoad;
  assert.deepEqual(page.read("items"), []);
  assert.equal(page.read("loading"), true);
  newRequest.resolve(listResult(DAY_B));
  await flushMicrotasks();
  const detail = page.take(`/api/characters/role-b/journals/${DAY_B}`);
  detail.resolve(detailResult(DAY_B));
  await flushMicrotasks();
  assert.equal(page.read<{ dayKey: string }>("detail").dayKey, DAY_B);
  assert.equal(page.read("detailCharacterId"), "role-b");
  assert.equal(page.read("loading"), false);
  page.finish();
}

async function staleDetailAfterDaySwitch() {
  const page = harness();
  page.set("selectedDay", DAY_A);
  const oldLoad = page.call("loadDetail", DAY_A);
  const oldRequest = page.take(`/api/characters/role-a/journals/${DAY_A}`);
  page.set("selectedDay", DAY_B);
  const newLoad = page.call("loadDetail", DAY_B);
  const newRequest = page.take(`/api/characters/role-a/journals/${DAY_B}`);
  oldRequest.resolve(detailResult(DAY_A));
  await oldLoad;
  assert.equal(page.read("detail"), null);
  assert.equal(page.read("detailLoading"), true);
  newRequest.resolve(detailResult(DAY_B));
  await newLoad;
  assert.equal(page.read<{ dayKey: string }>("detail").dayKey, DAY_B);
  page.finish();
}

async function staleHistoryAfterRoleSwitch() {
  const page = harness();
  page.set("selectedDay", DAY_A);
  page.set("detailCharacterId", "role-a");
  const oldLoad = page.call("openHistory", "DIARY");
  const oldRequest = page.take(`/api/characters/role-a/journals/${DAY_A}/revisions`);
  page.set("id", "role-b");
  const newList = page.take("/api/characters/role-b/journals");
  oldRequest.resolve({ items: [revision()] });
  await oldLoad;
  assert.deepEqual(page.read("revisions"), []);
  assert.equal(page.read("historyOpen"), false);
  newList.resolve({ ...listResult(DAY_B), items: [] });
  await flushMicrotasks();
  page.finish();
}

async function regenerateConfirmationCannotCrossRole() {
  const page = harness();
  page.set("selectedDay", DAY_A);
  page.set("detailCharacterId", "role-a");
  const pending = page.call("regenerate", "DIARY");
  await flushMicrotasks();
  assert.equal(page.requests.length, 0);
  page.set("id", "role-b");
  const newList = page.take("/api/characters/role-b/journals");
  page.confirm();
  await pending;
  assert.equal(page.requests.length, 0, "confirmation for the old role must not create a regeneration request");
  newList.resolve({ ...listResult(DAY_B), items: [] });
  await flushMicrotasks();
  page.finish();
}

async function editUsesCapturedRoleAndDoesNotRefreshNewRole() {
  const page = harness();
  page.set("selectedDay", DAY_A);
  page.set("detailCharacterId", "role-a");
  page.set("detail", detailResult(DAY_A));
  page.call("openEdit", "DIARY");
  assert.equal(page.read<{ characterId: string; dayKey: string } | null>("editTarget")?.characterId, "role-a");
  const pending = page.call("saveEdit");
  const patch = page.take(`/api/characters/role-a/journals/${DAY_A}`, "PATCH");
  page.set("id", "role-b");
  const newList = page.take("/api/characters/role-b/journals");
  patch.resolve({ ok: true, revision: revision() });
  await pending;
  assert.equal(page.read("editOpen"), false);
  assert.equal(page.messages.length, 0, "an old role's edit must not display a success toast on the new role");
  newList.resolve({ ...listResult(DAY_B), items: [] });
  await flushMicrotasks();
  page.finish();
}

async function restoreConfirmationCannotCrossDay() {
  const page = harness();
  page.set("selectedDay", DAY_A);
  page.set("detailCharacterId", "role-a");
  page.set("historyTarget", { characterId: "role-a", dayKey: DAY_A, kind: "DIARY" });
  const pending = page.call("restoreRevision", 1);
  await flushMicrotasks();
  page.set("historyTarget", { characterId: "role-a", dayKey: DAY_B, kind: "DIARY" });
  page.confirm();
  await pending;
  assert.equal(page.requests.length, 0, "restore confirmation must be invalidated after the history target changes");
  page.finish();
}

async function monthFilterResetsPaginationAndSelection() {
  const page = harness();
  page.set("page", 2);
  const secondPage = page.take("/api/characters/role-a/journals");
  assert.equal(secondPage.options?.query?.page, 2);
  secondPage.resolve({
    ...listResult("2026-10-20"),
    page: 2,
    total: 21,
    totalPages: 2,
    hasMore: true,
  });
  await flushMicrotasks();

  page.call("selectDay", "2026-10-20");
  const oldDetail = page.take("/api/characters/role-a/journals/2026-10-20");
  oldDetail.resolve(detailResult("2026-10-20"));
  await flushMicrotasks();
  assert.equal(page.read("selectedDay"), "2026-10-20");

  page.set("month", "2026-11");
  const filtered = page.take("/api/characters/role-a/journals");
  assert.equal(filtered.options?.query?.page, 1, "切换月份必须回到第一页");
  assert.equal(filtered.options?.query?.month, "2026-11");
  filtered.resolve(listResult(DAY_B));
  await flushMicrotasks();

  const newDetail = page.take(`/api/characters/role-a/journals/${DAY_B}`);
  newDetail.resolve(detailResult(DAY_B));
  await flushMicrotasks();
  assert.equal(page.read("selectedDay"), DAY_B, "月份过滤后应自动选中该月份最新的一天");
  assert.equal(page.read<{ dayKey: string }>("detail").dayKey, DAY_B);
  page.finish();
}

async function unmountInvalidatesListRequest() {
  const page = harness();
  const pending = page.call("loadList");
  const request = page.take("/api/characters/role-a/journals");
  page.unmountPage();
  request.resolve(listResult(DAY_A));
  await pending;
  assert.deepEqual(page.read("items"), []);
  page.finish();
}

for (const test of [
  staleListAfterRoleSwitch,
  staleDetailAfterDaySwitch,
  staleHistoryAfterRoleSwitch,
  regenerateConfirmationCannotCrossRole,
  editUsesCapturedRoleAndDoesNotRefreshNewRole,
  restoreConfirmationCannotCrossDay,
  monthFilterResetsPaginationAndSelection,
  unmountInvalidatesListRequest,
]) {
  await test();
  console.log(`PASS ${test.name}`);
}
console.log("journal page async race regressions passed (actual journal.vue handlers and watchers)");
