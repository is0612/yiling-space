import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

/**
 * 角色切换时的「操作锁」复位：旧请求的 finally 有 current() 守卫，
 * 因此旧角色遗留的 loading/starting/reviewingId 必须由 watch 主动清掉，
 * 否则新角色的按钮会永久停在禁用或「处理中」。
 *
 * 不走 DOM：直接执行 .vue 的真实 script，用受控 API 桩把请求挂在 pending，
 * 再模拟「A 未完成 → 切 B → A 返回」的顺序。
 */

type Ref = { value: unknown };

function loadScript(relativePath: string, filename: string, sandbox: Record<string, unknown>) {
  const sfc = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const scriptMatch = sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, `${relativePath} must contain a script block`);
  const source = ts.createSourceFile(filename, scriptMatch[1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = source.statements.filter(node => !ts.isImportDeclaration(node));
  const names = statements.flatMap(node => {
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
    }
    return ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : [];
  });
  const program = `${statements.map(node => node.getText(source)).join("\n")}\nreturn { ${names.join(", ")} };`;
  const compiled = ts.transpileModule(`(function () {\n${program}\n})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
  const executable = new Script(compiled.outputText, { filename: `${filename}.js` });
  return executable.runInContext(createContext(sandbox)) as Record<string, unknown>;
}

function reader(bindings: Record<string, unknown>) {
  return {
    read: (name: string) => (bindings[name] as Ref).value,
    set: (name: string, value: unknown) => { (bindings[name] as Ref).value = value; },
    call: (name: string, ...args: unknown[]) => (bindings[name] as (...rest: unknown[]) => Promise<unknown>)(...args),
  };
}

// ---------- 1. 主题发现面板：切角色复位 loading / starting / reviewingId ----------
{
  let role = "role-a";
  const watchers: Array<() => void> = [];
  const requests: Array<{ kind: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const props: Record<string, unknown> = {};
  Object.defineProperty(props, "characterId", { get: () => role });
  Object.defineProperty(props, "items", { get: () => [] });
  const pending = (kind: string) => new Promise((resolve, reject) => requests.push({ kind, resolve, reject }));

  const bindings = loadScript("app/components/KnowledgeTopicDiscoveryPanel.vue", "topic-discovery", {
    defineProps: () => props,
    defineEmits: () => () => {},
    ref: (value: unknown) => ({ value }),
    computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: (_source: unknown, callback: () => void) => watchers.push(callback),
    ElMessage: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} },
    readApiErrorMessage: (_error: unknown, fallback: string) => fallback,
    useApiRequest: () => ({}),
    createKnowledgeTopicsApi: () => ({
      listRuns: () => pending("runs"),
      list: () => pending("topics"),
      getRun: () => pending("run"),
      createRun: () => pending("create"),
      acceptSuggestion: () => pending("accept"),
      dismissSuggestion: () => pending("dismiss"),
    }),
  });
  const { read, set, call } = reader(bindings);
  const switchRole = (next: string) => {
    role = next;
    for (const callback of watchers) callback();
  };

  // A 打开面板，runs/topics 都挂在 pending。
  void call("openDiscovery");
  await flush();
  assert.equal(read("loading"), true, "打开面板应进入 loading");
  const aRuns = requests.find(request => request.kind === "runs");
  assert.ok(aRuns, "应发出 A 的批次请求");

  // A 未完成时切到 B：操作锁必须当场复位。loading 会因为面板仍开着而立即重载 B，
  // 所以这里只断言不会被旧请求卡住的两个锁。
  switchRole("role-b");
  assert.equal(read("starting"), false, "切角色必须复位 starting");
  assert.equal(read("reviewingId"), "", "切角色必须复位 reviewingId");

  // A 的迟到响应不能写进 B 的数据，也不能提前关掉 B 的 loading。
  aRuns.resolve({ runs: [{ id: "a-run" }] });
  await flush();
  assert.deepEqual([...(read("runs") as unknown[])], [], "旧角色的批次响应不得写入新角色");
  assert.equal(read("loading"), true, "旧角色响应不得关闭新角色的 loading");

  // B 自己的请求返回后正常展示并结束 loading。
  const bRuns = requests.filter(request => request.kind === "runs")[1];
  assert.ok(bRuns, "切角色后应重新请求 B 的批次");
  bRuns.resolve({ runs: [{ id: "b-run" }] });
  await flush();
  assert.deepEqual([...(read("runs") as unknown[])], [{ id: "b-run" }], "新角色的批次应正常展示");
  // 批次列表拿到后会自动拉第一条详情，详情返回才结束 loading。
  const bRunDetail = requests.find(request => request.kind === "run");
  assert.ok(bRunDetail, "应自动加载第一条批次的详情");
  bRunDetail.resolve({ run: { id: "b-run", suggestions: [] } });
  await flush();
  assert.equal(read("loading"), false, "新角色请求完成后应关闭 loading");

  // B 启动发现任务，未完成时再切角色：starting 复位，旧 create 不得改状态。
  set("selectedInputIds", ["item-1"]);
  void call("startRun");
  await flush();
  assert.equal(read("starting"), true, "提交后应进入 starting");
  switchRole("role-c");
  assert.equal(read("starting"), false, "切角色必须复位 starting");
  const createRequest = requests.find(request => request.kind === "create");
  assert.ok(createRequest, "应发出创建批次请求");
  createRequest.resolve({ run: { id: "old-run" } });
  await flush();
  assert.equal(read("selectedRunId"), "", "旧角色的创建响应不得写入新角色");
}

// ---------- 2. 记忆设置页：确认框期间切角色不得发出旧保存 ----------
{
  let role = "role-a";
  const watchers: Array<() => void> = [];
  const saved: string[] = [];
  let confirmResolve: (() => void) | null = null;
  const settingsFor = (_id: string) => ({
    snapshotIntervalDays: 3,
    activeSnapshotIntervalDays: 3,
    pendingSnapshotIntervalDays: null,
    anchorAt: "2026-10-21T01:00:00.000Z",
    timezone: "Asia/Shanghai",
    autoSnapshotEnabled: false,
    rawMessageRetentionDays: 0,
    rawMessageCleanupEnabled: false,
    nextSnapshotAt: null,
    changePolicy: "NEXT_CYCLE",
  });

  const bindings = loadScript("app/pages/characters/[id]/settings/memory.vue", "memory-settings", {
    definePageMeta: () => {},
    ref: (value: unknown) => ({ value }),
    computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: (_source: unknown, callback: () => void) => watchers.push(callback),
    onMounted: () => {},
    useRoute: () => ({ params: { get id() { return role; } }, query: {} }),
    useRouter: () => ({ resolve: () => ({ fullPath: "/characters" }) }),
    useApiRequest: () => ({}),
    ElMessage: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} },
    ElMessageBox: {
      confirm: () => new Promise<void>((resolve) => { confirmResolve = resolve; }),
    },
    initialCharacters: [{ id: "", name: "stub" }],
    createCharacterSettingsApi: () => ({
      getCharacter: async (id: string) => ({ id, name: id }),
      getMemorySettings: async (id: string) => settingsFor(id),
      updateMemorySettings: async (id: string) => { saved.push(id); return settingsFor(id); },
    }),
  });
  const { read, set, call } = reader(bindings);

  // onMounted 被桩掉，手动结束初始加载；否则 saveSettings 会被 loading 守卫拦下。
  set("loading", false);
  // 让「保留期限变得更激进」成立，才会进入确认框。
  set("retention", 30);
  set("savedRetention", 0);

  const saving = call("saveSettings");
  await flush();
  assert.ok(confirmResolve, "应弹出原始消息清理确认框");

  // 确认框停留期间切角色。
  role = "role-b";
  for (const callback of watchers) callback();
  await flush();

  // 用户此时才点「确认并保存」。
  confirmResolve!();
  await saving;
  assert.deepEqual(saved, [], "切角色后不得用旧角色的表单发出保存请求");
  assert.equal(read("saving"), false, "未发出的保存不应留下 saving 锁");
}

console.log("Role switch lock reset: panel loading/starting/reviewing and memory save confirmation passed.");
