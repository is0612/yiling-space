import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

type PendingRequest = {
  url: string;
  options?: { method?: string; body?: unknown; query?: Record<string, unknown> };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function buildPageHarness(relativePath: string) {
  const pagePath = new URL(relativePath, import.meta.url);
  const sfc = readFileSync(pagePath, "utf8");
  const scriptMatch = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, `${relativePath} must contain a script block`);

  const source = ts.createSourceFile("knowledge-page.ts", scriptMatch[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = source.statements.filter((node) => !ts.isImportDeclaration(node));
  const names = statements.flatMap((node) => {
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.flatMap((declaration) => (
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
      ));
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
    `${relativePath} script must transpile without syntax errors`,
  );

  const role = { value: { id: "char-a", name: "角色 A" } };
  const watchers: Array<{ source: { value: unknown }; callback: (next: unknown, previous: unknown) => void }> = [];
  const requests: PendingRequest[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const successes: string[] = [];
  const unmountCallbacks: Array<() => void> = [];
  const context = createContext({
    definePageMeta: () => {},
    useRoute: () => ({ path: relativePath }),
    useCharacterSelection: () => ({ character: role }),
    ref: (value: unknown) => ({ value }),
    computed: (getter: () => unknown) => Object.defineProperty({}, "value", { get: getter }),
    watch: (
      source: { value: unknown },
      callback: (next: unknown, previous: unknown) => void,
      options?: { immediate?: boolean },
    ) => {
      watchers.push({ source, callback });
      if (options?.immediate) callback(source.value, undefined);
    },
    onBeforeUnmount: (callback: () => void) => { unmountCallbacks.push(callback); },
    ElMessage: {
      error: (message: string) => errors.push(message),
      warning: (message: string) => warnings.push(message),
      success: (message: string) => successes.push(message),
    },
    $fetch: (url: string, options?: PendingRequest["options"]) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }),
  });
  const executable = new Script(compiled.outputText, { filename: relativePath + ".actual-script.js" });
  const bindings = executable.runInContext(context) as Record<string, unknown>;

  function read<T = unknown>(name: string): T {
    assert.ok(name in bindings, `missing page binding: ${name}`);
    return (bindings[name] as { value: T }).value;
  }
  function set(name: string, value: unknown) {
    (bindings[name] as { value: unknown }).value = value;
  }
  function call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const handler = bindings[name];
    assert.equal(typeof handler, "function", `missing page handler: ${name}`);
    return (handler as (...values: unknown[]) => Promise<T>)(...args);
  }
  function take(pathname: string, method?: string): PendingRequest {
    const index = requests.findIndex((request) => {
      const parsed = new URL(request.url, "http://test.local");
      return parsed.pathname === pathname && (method === undefined || (request.options?.method ?? "GET") === method);
    });
    assert.ok(index >= 0, `expected pending request: ${method ?? "GET"} ${pathname}`);
    return requests.splice(index, 1)[0]!;
  }
  function switchRole(id: string) {
    const previous = role.value.id;
    role.value = { id, name: `角色 ${id}` };
    assert.ok(watchers[0], "role watcher must be registered first");
    watchers[0]!.callback(id, previous);
  }
  function triggerKeyword() {
    const keyword = bindings.keyword;
    const watcher = watchers.find((entry) => entry.source === keyword);
    assert.ok(watcher, "keyword watcher must be registered");
    watcher.callback(read("keyword"), undefined);
  }
  function unmount() {
    for (const callback of unmountCallbacks) callback();
  }
  function finish() {
    assert.equal(requests.length, 0, `unsettled requests: ${requests.map((request) => request.url).join(", ")}`);
    assert.deepEqual(errors, [], `unexpected error notifications: ${errors.join(", ")}`);
  }

  return { read, set, call, take, switchRole, triggerKeyword, unmount, requests, errors, warnings, successes, finish };
}

function workspace(label: string) {
  return {
    candidates: [],
    items: [{ id: label, title: label, content: label, category: "GENERAL", tags: [], confidence: 1, status: "ACTIVE", sourceType: "MANUAL", sourceRef: null, revision: 1, createdAt: "2026-11-08", updatedAt: "2026-11-08" }],
    candidateCount: 0,
    itemCount: 1,
  };
}

function characterSettings(id: string, model = `model-${id}`) {
  return {
    id,
    knowledgeAssistantModel: model,
    knowledgeAssistantApiBaseUrl: `https://${id}.example.com/v1`,
    knowledgeAssistantEnabled: true,
    knowledgeAutoCollectEnabled: false,
    knowledgeAssistantTemperature: 0.2,
    knowledgeAssistantMaxInputTokens: 8192,
    knowledgeAssistantMaxOutputTokens: 1024,
    knowledgeAssistantApiKeyConfigured: true,
  };
}

async function flushMicrotasks() {
  await flush();
  await flush();
}

/** 1. 切换角色后，旧列表响应不能覆盖新角色，也不能提前关闭新请求的 loading。 */
async function knowledgeListSwitchRace() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  const oldRequest = page.take("/api/characters/char-a/growth/knowledge");
  page.switchRole("char-b");
  const newRequest = page.take("/api/characters/char-b/growth/knowledge");

  oldRequest.resolve(workspace("A old data"));
  await flushMicrotasks();
  assert.equal(page.read("loading"), true, "A 的旧请求不能提前关闭 B 的 loading");
  assert.equal(page.read<{ items: unknown[] }>("data").items.length, 0, "切角色时应立即清空旧角色知识");

  newRequest.resolve(workspace("B current data"));
  await flushMicrotasks();
  assert.equal(page.read<{ items: Array<{ title: string }> }>("data").items[0]?.title, "B current data");
  assert.equal(page.read("loading"), false);
  page.finish();
}

/** 2. 搜索连续变化时，只允许最后一次查询结果写回。 */
async function knowledgeSearchLastRequestWins() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("initial"));
  await flushMicrotasks();

  page.set("keyword", "first query");
  page.triggerKeyword();
  const first = page.take("/api/characters/char-a/growth/knowledge");
  assert.equal(first.options?.query?.q, "first query");

  page.set("keyword", "latest query");
  page.triggerKeyword();
  const latest = page.take("/api/characters/char-a/growth/knowledge");
  assert.equal(latest.options?.query?.q, "latest query");

  latest.resolve(workspace("latest result"));
  await flushMicrotasks();
  first.resolve(workspace("stale result"));
  await flushMicrotasks();

  assert.equal(page.read<{ items: Array<{ title: string }> }>("data").items[0]?.title, "latest result");
  page.finish();
}

/** 3. A 角色的新增操作晚回来时，不得清空 B 正在输入的内容或提示 A 的操作已完成。 */
async function candidatePostDoesNotTouchNextRole() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("A"));
  await flushMicrotasks();

  page.set("rawContent", "A 的候选");
  const adding = page.call("addCandidate");
  const post = page.take("/api/characters/char-a/growth/knowledge/candidates", "POST");
  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b/growth/knowledge");
  page.set("rawContent", "B 正在输入的新内容");

  post.resolve({ candidate: { id: "candidate-a" } });
  await adding;
  assert.equal(page.read("rawContent"), "B 正在输入的新内容");
  assert.equal(page.successes.includes("已加入知识候选。"), false);
  assert.equal(page.requests.length, 0, "A 的操作不能额外触发 B 的列表刷新");
  loadB.resolve(workspace("B"));
  await flushMicrotasks();
  page.finish();
}

/** 4. A→B→A 快速切换时，第一次 A 的慢配置不能覆盖第二次 A 的新配置。 */
async function settingsLoadUsesRoleGeneration() {
  const page = buildPageHarness("../app/pages/growth/knowledge/settings.vue");
  const firstA = page.take("/api/characters/char-a");

  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b");
  page.switchRole("char-a");
  const secondA = page.take("/api/characters/char-a");

  secondA.resolve(characterSettings("char-a", "new-a-model"));
  await flushMicrotasks();
  firstA.resolve(characterSettings("char-a", "stale-a-model"));
  loadB.resolve(characterSettings("char-b"));
  await flushMicrotasks();

  assert.equal(page.read("model"), "new-a-model");
  assert.equal(page.read("apiBaseUrl"), "https://char-a.example.com/v1");
  page.finish();
}

/** 5. A 角色的慢保存响应不能覆盖 B 的表单，也不能清除 B 新输入的 API Key。 */
async function staleSettingsSaveCannotMutateNextRole() {
  const page = buildPageHarness("../app/pages/growth/knowledge/settings.vue");
  page.take("/api/characters/char-a").resolve(characterSettings("char-a"));
  await flushMicrotasks();

  page.set("model", "a-custom-model");
  page.set("apiKey", "A_SECRET");
  const saving = page.call<boolean>("save");
  const patchA = page.take("/api/characters/char-a", "PATCH");
  assert.equal((patchA.options?.body as Record<string, unknown>).knowledgeAssistantApiKey, "A_SECRET");

  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b");
  loadB.resolve(characterSettings("char-b"));
  await flushMicrotasks();
  page.set("apiKey", "B_SECRET_NEW");

  patchA.resolve(characterSettings("char-a", "saved-a-model"));
  assert.equal(await saving, false, "角色切换后旧保存应视为对当前页面无效");
  assert.equal(page.read("model"), "model-char-b");
  assert.equal(page.read("apiBaseUrl"), "https://char-b.example.com/v1");
  assert.equal(page.read("apiKey"), "B_SECRET_NEW");
  assert.equal(page.successes.includes("知识处理助手设置已保存。"), false);
  page.finish();
}

/** 6. 旧角色的获取模型请求不能把旧模型列表写入新角色。 */
async function staleModelListCannotCrossRole() {
  const page = buildPageHarness("../app/pages/growth/knowledge/settings.vue");
  page.take("/api/characters/char-a").resolve(characterSettings("char-a"));
  await flushMicrotasks();

  const fetching = page.call("fetchModels");
  const saveA = page.take("/api/characters/char-a", "PATCH");
  saveA.resolve(characterSettings("char-a"));
  await flushMicrotasks();
  const modelsA = page.take("/api/characters/char-a/growth/knowledge/models");

  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b");
  loadB.resolve(characterSettings("char-b"));
  await flushMicrotasks();

  modelsA.resolve({ ok: true, models: ["old-a-model"], message: "已获取 1 个模型。" });
  await fetching;
  // 页面状态是 vm 沙箱里创建的数组，原型与宿主不同，assert/strict 的 deepEqual 会判两个 [] 不等，
  // 所以先展开到宿主 realm 再比较（这是沙箱用例的通用坑，不是实现问题）。
  assert.deepEqual([...page.read<string[]>("models")], [], "A 的模型列表不能出现在 B 的设置页");
  assert.equal(page.read("model"), "model-char-b");
  page.finish();
}

/** 7. 页面卸载后，在途读取不再写状态或弹提示。 */
async function unmountedSettingsLoadIsIgnored() {
  const page = buildPageHarness("../app/pages/growth/knowledge/settings.vue");
  const pending = page.take("/api/characters/char-a");
  page.unmount();
  pending.reject(new Error("late failure"));
  await flushMicrotasks();
  assert.equal(page.read("character"), null);
  assert.deepEqual(page.errors, []);
  page.finish();
}

/** 8. 正式知识编辑必须携带读取时的 revision，成功后刷新当前角色数据。 */
async function knowledgeEditUsesOptimisticRevision() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("initial"));
  await flushMicrotasks();
  const item = page.read<{ items: Array<{ id: string; title: string; content: string; category: string; tags: string[]; confidence: number; revision: number }> }>("data").items[0]!;
  await page.call("startEdit", item);
  page.set("editDraft", { title: "修订标题", content: "修订正文", category: "SCIENCE", tagsText: "天文学, 相对论", confidence: "0.95" });
  const saving = page.call("saveEdit", item);
  const patch = page.take("/api/characters/char-a/growth/knowledge/items/initial", "PATCH");
  assert.equal((patch.options?.body as Record<string, unknown>).revision, 1);
  // 页面代码跑在 vm 沙箱里，跨 realm 的数组原型不同，deepStrictEqual 会判成「结构相同但非同一引用」，
  // 因此先展平到当前 realm（与文件里其他跨 realm 断言一致）。
  assert.deepEqual([...((patch.options?.body as Record<string, unknown>).tags as string[])], ["天文学", "相对论"]);
  patch.resolve({
    item: { ...item, title: "修订标题", content: "修订正文", revision: 2 },
    unchanged: false,
  });
  await flushMicrotasks();
  const refreshed = page.take("/api/characters/char-a/growth/knowledge");
  refreshed.resolve(workspace("after edit"));
  await saving;
  assert.equal(page.read("editingItemId"), "");
  assert.ok(page.successes.some(message => message.includes("第 2 版")));
  page.finish();
}

/** 9. 角色切换后，旧角色的版本历史响应不能显示在新角色页面。 */
async function knowledgeHistoryDoesNotCrossRole() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("A"));
  await flushMicrotasks();
  const item = page.read<{ items: Array<{ id: string }> }>("data").items[0]!;
  const opening = page.call("toggleHistory", item);
  const history = page.take("/api/characters/char-a/growth/knowledge/items/A/history");
  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b/growth/knowledge");
  history.resolve({ revisions: [{ id: "old", revision: 1, title: "A 的旧版本" }] });
  await opening;
  assert.equal(page.read("historyItemId"), "");
  assert.deepEqual([...page.read<unknown[]>("historyItems")], []);
  loadB.resolve(workspace("B"));
  await flushMicrotasks();
  page.finish();
}

/** 10. 角色切换后，旧角色正在提交的编辑响应不能刷新或提示新角色。 */
async function staleKnowledgeEditCannotTouchNextRole() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("A"));
  await flushMicrotasks();
  const item = page.read<{ items: Array<{ id: string; title: string; content: string; category: string; tags: string[]; confidence: number; revision: number }> }>("data").items[0]!;
  await page.call("startEdit", item);
  page.set("editDraft", { title: "A 新内容", content: item.content, category: item.category, tagsText: "", confidence: "1" });
  const saving = page.call("saveEdit", item);
  const patch = page.take("/api/characters/char-a/growth/knowledge/items/A", "PATCH");
  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b/growth/knowledge");
  patch.resolve({ item: { ...item, title: "A 新内容", revision: 2 }, unchanged: false });
  await saving;
  assert.equal(page.read("editingItemId"), "");
  assert.equal(page.successes.some(message => message.includes("第 2 版")), false);
  assert.equal(page.requests.length, 0, "旧角色的编辑响应不能额外刷新新角色列表");
  loadB.resolve(workspace("B"));
  await flushMicrotasks();
  page.finish();
}

/** 11. 遇到 409 时关闭旧草稿并刷新，避免用户拿过期内容覆盖新版本。 */
async function revisionConflictClosesStaleEditor() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("A"));
  await flushMicrotasks();
  const item = page.read<{ items: Array<{ id: string; title: string; content: string; category: string; tags: string[]; confidence: number; revision: number }> }>("data").items[0]!;
  await page.call("startEdit", item);
  const saving = page.call("saveEdit", item);
  const patch = page.take("/api/characters/char-a/growth/knowledge/items/A", "PATCH");
  patch.reject({ data: { statusCode: 409, statusMessage: "版本冲突" } });
  await flushMicrotasks();
  const refresh = page.take("/api/characters/char-a/growth/knowledge");
  refresh.resolve(workspace("latest"));
  await saving;
  assert.equal(page.read("editingItemId"), "");
  assert.ok(page.errors.includes("版本冲突"));
  assert.equal(page.requests.length, 0);
}

/** 12. 候选关联确认使用当前角色与候选ID，并在成功后刷新状态。 */
async function candidateRelationConfirmationRefreshesWorkspace() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("initial"));
  await flushMicrotasks();
  const candidate = {
    id: "candidate-a",
    sourceType: "MANUAL",
    sourceRef: null,
    rawContent: "知识候选",
    status: "REVIEW",
    processingError: null,
    processedAt: null,
    createdAt: "2026-11-09",
    relatedItems: [{ id: "item-a", title: "已有知识", content: "已有正文", category: "GENERAL", tags: [], revision: 2 }],
    processedResult: {
      isKnowledge: true,
      recommendation: "DUPLICATE",
      title: "候选标题",
      content: "候选正文",
      category: "GENERAL",
      tags: [],
      confidence: 0.9,
      reason: "内容相似",
      relatedItemIds: ["item-a"],
      confirmedRelatedItemIds: [],
    },
  };
  const saving = page.call("toggleCandidateRelation", candidate, candidate.relatedItems[0]);
  const post = page.take("/api/characters/char-a/growth/knowledge/candidates/candidate-a/relations", "POST");
  assert.equal((post.options?.body as Record<string, unknown>).targetItemId, "item-a");
  assert.equal((post.options?.body as Record<string, unknown>).confirmed, true);
  post.resolve({ confirmedRelatedItemIds: ["item-a"] });
  await flushMicrotasks();
  const refresh = page.take("/api/characters/char-a/growth/knowledge");
  refresh.resolve(workspace("after relation confirmation"));
  await saving;
  assert.ok(page.successes.includes("已确认这条关联。"));
  page.finish();
}

/** 13. 合并提交必须携带双方 revision 与用户确认后的完整正文，成功后刷新。 */
async function knowledgeMergeUsesBothOptimisticRevisions() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("initial"));
  await flushMicrotasks();
  const item = page.read<{ items: Array<{ id: string; title: string; content: string; category: string; tags: string[]; confidence: number; status: string; revision: number }> }>("data").items[0]!;
  await page.call("startMerge", {
    id: "source-item", revision: 4, status: "ACTIVE", title: "源知识",
    content: "源知识原文", category: "GENERAL", tags: ["源标签"], confidence: 0.8,
    sourceType: "CHAT", sourceRef: { messageIds: ["source-message"] },
  }, {
    id: item.id, title: item.title, content: item.content, category: item.category,
    tags: item.tags, confidence: item.confidence, revision: 1, status: "ACTIVE",
    sourceType: "MANUAL", sourceRef: { note: "target source" },
  });
  page.set("mergeDraft", {
    sourceItemId: "source-item", targetItemId: item.id,
    expectedSourceRevision: 4, expectedTargetRevision: 1,
    title: "最终标题", content: "用户确认的完整正文", category: "SCIENCE",
    tagsText: "天文学, 相对论", confidence: "0.95",
  });
  const merging = page.call("submitMerge");
  const post = page.take("/api/characters/char-a/growth/knowledge/items/source-item/merge", "POST");
  const body = post.options?.body as Record<string, unknown>;
  assert.equal(body.expectedSourceRevision, 4);
  assert.equal(body.expectedTargetRevision, 1);
  assert.equal(body.title, "最终标题");
  assert.equal(body.content, "用户确认的完整正文");
  assert.deepEqual([...(body.tags as string[])], ["天文学", "相对论"]);
  post.resolve({ source: { status: "MERGED" }, target: { revision: 2 } });
  await flushMicrotasks();
  const refresh = page.take("/api/characters/char-a/growth/knowledge");
  refresh.resolve(workspace("after merge"));
  await merging;
  assert.equal(page.read("mergeDraft"), null);
  assert.ok(page.successes.includes("重复知识已合并，源条目和双方历史均已保留。"));
  page.finish();
}

/** 14. 关系处置按真实 source/target 方向携带双方 revision。 */
async function relationDecisionUsesEndpointRevisions() {
  const page = buildPageHarness("../app/pages/growth/knowledge/index.vue");
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspace("initial"));
  await flushMicrotasks();
  const item = page.read<{ items: Array<{ id: string; revision: number }> }>("data").items[0]!;
  const relation = {
    id: "relation-1", sourceItemId: "source-item", targetItemId: item.id,
    relationType: "CONFLICT", status: "OPEN", resolution: null, metadata: null, updatedAt: "2026-11-09",
    relatedItem: { id: "source-item", title: "另一条知识", content: "另一条正文", category: "GENERAL", tags: [], confidence: null, status: "ACTIVE", revision: 7, sourceType: "MANUAL", sourceRef: null },
  };
  const resolving = page.call("resolveRelation", item, relation, "CONFIRM_CONFLICT");
  const post = page.take("/api/characters/char-a/growth/knowledge/relations/relation-1/resolve", "POST");
  const body = post.options?.body as Record<string, unknown>;
  assert.equal(body.action, "CONFIRM_CONFLICT");
  assert.equal(body.expectedSourceRevision, 7);
  assert.equal(body.expectedTargetRevision, 1);
  post.resolve({ relation: { status: "RESOLVED" } });
  await flushMicrotasks();
  const refresh = page.take("/api/characters/char-a/growth/knowledge");
  refresh.resolve(workspace("after decision"));
  await resolving;
  assert.ok(page.successes.includes("已确认冲突，双方知识均予以保留。"));
  page.finish();
}

async function main() {
  const tests = [
    ["知识列表切角色竞态", knowledgeListSwitchRace],
    ["知识搜索最后请求生效", knowledgeSearchLastRequestWins],
    ["候选提交不污染新角色", candidatePostDoesNotTouchNextRole],
    ["设置页 A-B-A 代际隔离", settingsLoadUsesRoleGeneration],
    ["旧保存响应不覆盖新角色", staleSettingsSaveCannotMutateNextRole],
    ["旧模型列表不跨角色写入", staleModelListCannotCrossRole],
    ["卸载后忽略设置读取", unmountedSettingsLoadIsIgnored],
    ["正式知识编辑携带乐观版本号", knowledgeEditUsesOptimisticRevision],
    ["版本历史不跨角色显示", knowledgeHistoryDoesNotCrossRole],
    ["旧知识编辑响应不污染新角色", staleKnowledgeEditCannotTouchNextRole],
    ["版本冲突关闭过期草稿", revisionConflictClosesStaleEditor],
    ["候选关联确认后刷新工作区", candidateRelationConfirmationRefreshesWorkspace],
    ["知识合并携带双方版本号与确认正文", knowledgeMergeUsesBothOptimisticRevisions],
    ["关系处置携带正确端点版本号", relationDecisionUsesEndpointRevisions],
  ] as const;
  for (const [name, test] of tests) {
    await test();
    console.log("  ✅", name);
  }
  console.log(`知识系统页面竞态验收通过：${tests.length} 项。`);
}

main().catch((error) => {
  console.error("知识系统页面竞态验收失败。");
  console.error(error);
  process.exitCode = 1;
});
