import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/**
 * 「她的朋友」页面竞态回归：直接跑当前 `identities.vue` 的真实 script。
 *
 * 起因（2026-11-07 验收）：这一页的 `load()` 当时是「发了就等」，既没有请求代际，
 * 也在 `finally` 里无条件关 loading。表现为切角色后旧响应把 `activeCharacterId`
 * 写回去、界面自己跳回上一个角色；连点筛选时停在前一次的结果；而慢请求一回来，
 * 新请求还在飞，列表却已经显示空了。身份/交流两个字段共用一张卡片的保存序号，
 * 还会把另一项刚改好的值顶回旧值。
 *
 * 这里盯七件事，和浏览器验收清单一一对应：
 * 1. 切角色后旧列表晚回来，不能覆盖新角色，也不能把 activeCharacterId 写回去；
 * 2. 来源 / 排序 / 搜索 / 翻页连点时，最终显示最后一次操作的结果；
 * 3. 旧请求先返回时不能提前关 loading；
 * 4. 待审备注弹窗打开时切角色，弹窗关掉且旧角色的备注不落进新页面；
 * 5. 同一张卡片快速改身份 + 交流权限，两项都要留在界面上（并发不互相回滚）；
 * 6. 刷新持久化由 `test:friend-relation-db` 与浏览器验收覆盖，这里不重复造库；
 * 7. 卸载后在途请求不再写状态、不弹错误。
 */
const pagePath = new URL("../app/pages/identities.vue", import.meta.url);
const sfc = readFileSync(pagePath, "utf8");
const scriptMatch = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "identities.vue must contain a script block");
const source = ts.createSourceFile("identities-page.ts", scriptMatch[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = source.statements.filter((node) => !ts.isImportDeclaration(node)
  && !(ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)));
const names = statements.flatMap((node) => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []));
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
assert.equal(
  compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length,
  0,
  "identities.vue script must transpile without syntax errors",
);
const executable = new Script(compiled.outputText, { filename: "identities.vue.actual-script.js" });

type Ref = { value: unknown };
type PendingRequest = {
  url: string;
  options?: { method?: string; body?: unknown; query?: Record<string, unknown> };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type FriendRecord = {
  scopeId: string;
  characterId: string;
  characterName: string;
  identityId: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  status: string;
  linkedUserId: string | null;
  identityKind: "UNKNOWN" | "HUMAN" | "AI";
  identityKindSource: "AUTO" | "MANUAL";
  friendChatPolicy: "DEFAULT" | "ALLOW" | "BLOCK";
  interactionCount: number;
  lastInteractedAt: string | null;
  knownSince: string;
  firstSource: string | null;
  conversationCount: number;
  aliases: string[];
};

function friend(scopeId: string, characterId: string, overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    scopeId,
    characterId,
    characterName: "角色",
    identityId: `identity-${scopeId}`,
    platform: "qq-onebot",
    platformUid: "123456789",
    displayName: "某个群友",
    status: "ACTIVE",
    linkedUserId: null,
    identityKind: "UNKNOWN",
    identityKindSource: "AUTO",
    friendChatPolicy: "DEFAULT",
    interactionCount: 1,
    lastInteractedAt: "2026-11-06T12:00:00.000Z",
    knownSince: "2026-11-01T12:00:00.000Z",
    firstSource: "GROUP",
    conversationCount: 1,
    aliases: [],
    ...overrides,
  };
}

function pageResult(characterId: string, item: FriendRecord, overrides: Record<string, unknown> = {}) {
  return {
    items: [item],
    total: 1,
    page: 1,
    pageSize: 12,
    totalPages: 1,
    hasMore: false,
    characters: [
      { id: characterId, name: `角色 ${characterId}`, status: "ACTIVE", friendCount: 1 },
      { id: "char-a", name: "角色 char-a", status: "ACTIVE", friendCount: 1 },
      { id: "char-b", name: "角色 char-b", status: "ACTIVE", friendCount: 1 },
    ],
    activeCharacterId: characterId,
    stats: { total: 1, familiar: 0, recent: 1 },
    sourceCounts: { all: 1, private: 0, group: 1 },
    pendingSuggestions: 0,
    ...overrides,
  };
}

function harness() {
  const requests: PendingRequest[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const successes: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let unmount: (() => void) | null = null;

  const context = createContext({
    /** Nuxt 编译期宏：只在构建时注册路由元信息，运行时被抹掉，沙盒里桩掉即可。 */
    definePageMeta: () => {},
    ref: (initial: unknown) => {
      let value = initial;
      const result = {} as Ref;
      Object.defineProperty(result, "value", {
        get: () => value,
        set: (next: unknown) => { value = next; },
      });
      return result;
    },
    computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: () => {},
    nextTick: async () => {},
    onMounted: () => {},
    onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    ElMessage: {
      error: (message: string) => errors.push(message),
      warning: (message: string) => warnings.push(message),
      success: (message: string) => successes.push(message),
      info: () => {},
    },
    $fetch: (url: string, options?: PendingRequest["options"]) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }),
  });
  const bindings = executable.runInContext(context) as Record<string, Ref | ((...args: unknown[]) => unknown)>;

  function read<T = unknown>(name: string): T {
    assert.ok(name in bindings, `missing page binding: ${name}`);
    return (bindings[name] as Ref).value as T;
  }
  function set(name: string, value: unknown) {
    (bindings[name] as Ref).value = value;
  }
  function call(name: string, ...args: unknown[]) {
    assert.equal(typeof bindings[name], "function", `missing page handler: ${name}`);
    return (bindings[name] as (...args: unknown[]) => Promise<void>)(...args);
  }
  /** 按路径 / 方法取下一个待结算请求；列表请求按出现顺序排队，便于模拟「旧请求晚回」。 */
  function take(path: string, method?: string) {
    const index = requests.findIndex((request) => {
      const parsed = new URL(request.url, "http://test.local");
      return parsed.pathname === path && (method === undefined || request.options?.method === method);
    });
    assert.ok(index >= 0, `expected pending request: ${method ?? "GET"} ${path}`);
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
  return { read, set, call, take, tickSearch, errors, warnings, successes, finish, unmountNow: () => unmount?.() };
}

async function flushMicrotasks() { await flush(); await flush(); }

/** 1. 切角色后，旧角色的列表晚回来：不能覆盖新角色，也不能把 activeCharacterId 写回去。 */
async function staleRoleLoadIgnored() {
  const page = harness();
  page.set("activeCharacterId", "char-a");
  const stale = page.call("load", 1);
  const staleResponse = page.take("/api/admin/identities");

  page.call("pickCharacter", "char-b");
  const freshResponse = page.take("/api/admin/identities");

  staleResponse.resolve(pageResult("char-a", friend("a-1", "char-a", { displayName: "A 的朋友" })));
  await stale;
  await flushMicrotasks();

  assert.equal(page.read("activeCharacterId"), "char-b", "旧响应不能把角色切回去");
  assert.equal(page.read<unknown[]>("friends").length, 0, "旧响应不能写进新角色的列表");
  assert.equal(page.read("loading"), true, "新请求还没回来，loading 不能先关");

  freshResponse.resolve(pageResult("char-b", friend("b-1", "char-b", { displayName: "B 的朋友" })));
  await flushMicrotasks();
  assert.equal(page.read("activeCharacterId"), "char-b");
  assert.deepEqual(
    page.read<FriendRecord[]>("friends").map((item) => item.scopeId),
    ["b-1"],
    "列表必须是新角色的",
  );
  assert.equal(page.read("loading"), false);
  page.finish();
}

/** 2. 连续切换来源 / 排序 / 搜索 / 分页：最终只能是最后一次操作的结果。 */
async function lastActionWins() {
  const page = harness();
  page.call("load", 1);
  page.take("/api/admin/identities").resolve(pageResult("char-a", friend("a-1", "char-a")));
  await flushMicrotasks();

  page.call("pickSource", "GROUP");
  const sourceResponse = page.take("/api/admin/identities");
  page.call("pickSort", "count");
  const sortResponse = page.take("/api/admin/identities");
  page.call("pickSource", "PRIVATE");
  const lastResponse = page.take("/api/admin/identities");

  // 最后一次先回来，前两次乱序后到。
  lastResponse.resolve(pageResult("char-a", friend("last", "char-a"), {
    sourceCounts: { all: 1, private: 1, group: 0 },
  }));
  await flushMicrotasks();
  sortResponse.resolve(pageResult("char-a", friend("by-count", "char-a")));
  await flushMicrotasks();
  sourceResponse.resolve(pageResult("char-a", friend("by-group", "char-a")));
  await flushMicrotasks();

  assert.deepEqual(
    page.read<FriendRecord[]>("friends").map((item) => item.scopeId),
    ["last"],
    "旧筛选的响应不能覆盖最后一次操作",
  );
  assert.deepEqual(page.read("sourceCounts"), { all: 1, private: 1, group: 0 });
  assert.equal(page.read("sourceFilter"), "PRIVATE");
  page.finish();
}

/** 2b. 搜索防抖结束后，之前的慢请求同样不能覆盖搜索结果。 */
async function staleSearchIgnored() {
  const page = harness();
  page.call("load", 1);
  page.take("/api/admin/identities").resolve(pageResult("char-a", friend("a-1", "char-a")));
  await flushMicrotasks();

  page.call("pickSource", "GROUP");
  const slow = page.take("/api/admin/identities");

  page.set("query", "阿汐");
  page.call("onQueryInput");
  page.tickSearch();
  const searchResponse = page.take("/api/admin/identities");

  searchResponse.resolve(pageResult("char-a", friend("hit", "char-a")));
  await flushMicrotasks();
  slow.resolve(pageResult("char-a", friend("slow", "char-a")));
  await flushMicrotasks();

  assert.deepEqual(
    page.read<FriendRecord[]>("friends").map((item) => item.scopeId),
    ["hit"],
    "搜索结果不能被更早发出的列表请求顶掉",
  );
  page.finish();
}

/** 3. 旧请求先返回时不能提前关 loading（否则新请求还在飞，界面已经显示空）。 */
async function staleRequestKeepsLoading() {
  const page = harness();
  page.call("load", 1);
  const first = page.take("/api/admin/identities");
  page.call("pickSort", "closeness");
  const second = page.take("/api/admin/identities");

  first.resolve(pageResult("char-a", friend("a-1", "char-a")));
  await flushMicrotasks();
  assert.equal(page.read("loading"), true, "旧请求回来时新请求还在飞，loading 必须保持");

  second.resolve(pageResult("char-a", friend("a-2", "char-a")));
  await flushMicrotasks();
  assert.equal(page.read("loading"), false);
  page.finish();
}

/** 4. 待审备注弹窗打开时切角色：弹窗关闭，旧角色的备注不落进新页面。 */
async function suggestionsDoNotCrossRole() {
  const page = harness();
  page.call("load", 1);
  page.take("/api/admin/identities").resolve(pageResult("char-a", friend("a-1", "char-a")));
  await flushMicrotasks();

  page.call("openSuggestions");
  const suggestionResponse = page.take("/api/admin/identities/aliases/suggestions");
  assert.equal(page.read("suggestionDialogOpen"), true);
  assert.equal(page.read("suggestionsLoading"), true);

  page.call("pickCharacter", "char-b");
  const roleResponse = page.take("/api/admin/identities");
  assert.equal(page.read("suggestionDialogOpen"), false, "切角色后弹窗必须关掉");
  assert.equal(page.read("suggestionsLoading"), false);

  suggestionResponse.resolve({ items: [{ id: "s-1", scopeId: "a-1", alias: "旧角色的叫法", reason: "", friendName: "", platform: "", platformUid: "" }] });
  await flushMicrotasks();
  assert.equal(page.read<unknown[]>("suggestions").length, 0, "旧角色的备注不能写进当前页面");
  assert.equal(page.read("suggestionsLoading"), false);

  roleResponse.resolve(pageResult("char-b", friend("b-1", "char-b")));
  await flushMicrotasks();
  page.finish();
}

/** 5. 同一张卡片快速改身份 + 交流权限：两项都要留在界面上。 */
async function concurrentFieldPatchesKeepBoth() {
  const page = harness();
  page.call("load", 1);
  page.take("/api/admin/identities").resolve(pageResult("char-a", friend("a-1", "char-a")));
  await flushMicrotasks();

  const target = page.read<FriendRecord[]>("friends")[0]!;
  page.call("setIdentityKind", target, "AI");
  const kindPatch = page.take("/api/admin/identities/a-1", "PATCH");
  page.call("setChatPolicy", target, "ALLOW");
  const policyPatch = page.take("/api/admin/identities/a-1", "PATCH");

  const kindBody = kindPatch.options?.body as Record<string, unknown>;
  const policyBody = policyPatch.options?.body as Record<string, unknown>;
  assert.equal(kindBody.identityKind, "AI", "身份只提交身份字段");
  assert.equal("friendChatPolicy" in kindBody, false, "身份请求不该顺带写交流权限");
  assert.equal(policyBody.friendChatPolicy, "ALLOW", "权限只提交权限字段");
  assert.equal("identityKind" in policyBody, false, "权限请求不该顺带写身份");

  // 服务端回报的整条关系是「请求开始时」的快照：权限那次带着旧的 UNKNOWN。
  policyPatch.resolve({ identityKind: "UNKNOWN", identityKindSource: "AUTO", friendChatPolicy: "ALLOW" });
  await flushMicrotasks();
  kindPatch.resolve({ identityKind: "AI", identityKindSource: "MANUAL", friendChatPolicy: "DEFAULT" });
  await flushMicrotasks();

  const after = page.read<FriendRecord[]>("friends")[0]!;
  assert.equal(after.identityKind, "AI", "身份不能被权限响应里的旧值顶回去");
  assert.equal(after.friendChatPolicy, "ALLOW", "权限也不能被身份响应里的旧值顶回去");
  assert.equal(after.identityKindSource, "MANUAL");
  page.finish();
}

/** 5b. 同一字段连点两次：只认最后一次，前一次的响应不能把选择改回去。 */
async function sameFieldLastWriteWins() {
  const page = harness();
  page.call("load", 1);
  page.take("/api/admin/identities").resolve(pageResult("char-a", friend("a-1", "char-a")));
  await flushMicrotasks();

  const target = page.read<FriendRecord[]>("friends")[0]!;
  page.call("setIdentityKind", target, "HUMAN");
  const first = page.take("/api/admin/identities/a-1", "PATCH");
  page.call("setIdentityKind", target, "AI");
  const second = page.take("/api/admin/identities/a-1", "PATCH");

  first.resolve({ identityKind: "HUMAN", identityKindSource: "MANUAL", friendChatPolicy: "DEFAULT" });
  await flushMicrotasks();
  second.resolve({ identityKind: "AI", identityKindSource: "MANUAL", friendChatPolicy: "DEFAULT" });
  await flushMicrotasks();

  const after = page.read<FriendRecord[]>("friends")[0]!;
  assert.equal(after.identityKind, "AI", "连点两次应停在最后一次选择");
  page.finish();
}

/** 7. 卸载后在途请求不再写状态、不弹错误。 */
async function unmountInvalidatesRequests() {
  const page = harness();
  const pending = page.call("load", 1);
  const response = page.take("/api/admin/identities");

  page.unmountNow();
  response.resolve(pageResult("char-a", friend("a-1", "char-a")));
  await pending;
  await flushMicrotasks();

  assert.equal(page.read<unknown[]>("friends").length, 0, "卸载后不能写回列表");
  assert.equal(page.read("loading"), true, "卸载后不再改 loading");
  assert.deepEqual(page.errors, [], "卸载后不能弹错误提示");
  page.finish();
}

/** 7b. 卸载后待审备注的在途响应也不写回。 */
async function unmountInvalidatesSuggestions() {
  const page = harness();
  page.call("load", 1);
  page.take("/api/admin/identities").resolve(pageResult("char-a", friend("a-1", "char-a")));
  await flushMicrotasks();

  page.call("openSuggestions");
  const response = page.take("/api/admin/identities/aliases/suggestions");
  page.unmountNow();
  response.resolve({ items: [{ id: "s-1", scopeId: "a-1", alias: "迟到的叫法", reason: "", friendName: "", platform: "", platformUid: "" }] });
  await flushMicrotasks();

  assert.equal(page.read<unknown[]>("suggestions").length, 0, "卸载后待审备注不能写回");
  page.finish();
}

const cases: Array<[string, () => Promise<void>]> = [
  ["staleRoleLoadIgnored", staleRoleLoadIgnored],
  ["lastActionWins", lastActionWins],
  ["staleSearchIgnored", staleSearchIgnored],
  ["staleRequestKeepsLoading", staleRequestKeepsLoading],
  ["suggestionsDoNotCrossRole", suggestionsDoNotCrossRole],
  ["concurrentFieldPatchesKeepBoth", concurrentFieldPatchesKeepBoth],
  ["sameFieldLastWriteWins", sameFieldLastWriteWins],
  ["unmountInvalidatesRequests", unmountInvalidatesRequests],
  ["unmountInvalidatesSuggestions", unmountInvalidatesSuggestions],
];

for (const [name, run] of cases) {
  await run();
  console.log(`PASS ${name}`);
}
console.log("friend page async race regressions passed (actual identities.vue handlers)");
