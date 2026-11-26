/**
 * 本期最小范围改造的页面级回归测试：
 *   1. 开关连拨只允许一个在途请求（梗语录 / 表情包）
 *   2. 日常生活的进行中标记改成集合后，先结束的活动不得清掉别人的标记
 *   3. 同一轮轮询里多个角色完成任务时，完成信号全部记录且不重复触发
 *
 * 执行的是 .vue / composable 里的**真实函数源码**：沿用 test-role-switch-lock-reset.ts 的
 * vm 思路，但只取需要的顶层声明，避免为整页注入一堆无关的 Nuxt composable 桩。
 * daily-life.vue 有顶层 await，所以包在 async 函数里执行；useMemoryProgress 的
 * import.meta.client 在 vm 里无法解析，替换为 true 后只测客户端分支。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

type Bindings = Record<string, unknown>;
type Ref<T> = { value: T };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function loadDeclarations(
  relativePath: string,
  names: string[],
  sandbox: Bindings,
  options: { sfc?: boolean; clientOnly?: boolean } = {},
): Promise<Bindings> {
  const raw = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  let script = options.sfc === false ? raw : (raw.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "");
  assert.ok(script, `${relativePath} must contain a script block`);
  // vm 的 Script 不支持 export；顶层 export 去掉后声明类型不变。
  script = script.replace(/^export /gm, "");
  if (options.clientOnly) script = script.replace(/import\.meta\.client/g, "true");

  const source = ts.createSourceFile(relativePath, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const picked = source.statements.filter((node) => {
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text),
      );
    }
    if (ts.isFunctionDeclaration(node)) return Boolean(node.name && names.includes(node.name.text));
    return false;
  });
  assert.equal(picked.length, names.length, `${relativePath}: 期望取到 ${names.length} 个顶层声明，实际 ${picked.length} 个`);

  const program = `${picked.map((node) => node.getText(source)).join("\n")}\nreturn { ${names.join(", ")} };`;
  const compiled = ts.transpileModule(`(async function () {\n${program}\n})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  assert.equal(
    compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length,
    0,
    `${relativePath}: 提取出的脚本编译不应报错`,
  );
  const executable = new Script(compiled.outputText, { filename: `${relativePath}.js` });
  return await (executable.runInContext(createContext(sandbox)) as Promise<Bindings>);
}

const refStub = <T>(value: T): Ref<T> => ({ value });
const messages = { success: () => {}, error: () => {}, warning: () => {}, info: () => {} };

// ── 1. 开关连拨 ────────────────────────────────────────────
async function testToggleSerializesRequests(
  relativePath: string,
  apiMethod: "updateCatchphrase" | "updateSticker",
) {
  const calls: Array<{ id: string; enabled: boolean }> = [];
  const pending: Array<(value: unknown) => void> = [];
  const api = {
    [apiMethod]: (payload: { catchphraseId?: string; stickerId?: string; enabled: boolean }) => {
      calls.push({ id: String(payload.catchphraseId ?? payload.stickerId), enabled: payload.enabled });
      const gate = deferred<unknown>();
      pending.push(gate.resolve);
      return gate.promise;
    },
  };
  const bindings = await loadDeclarations(
    relativePath,
    ["togglingIds", "markToggling", "toggleEnabled"],
    { ref: refStub, api, id: { value: "character-a" }, ElMessage: messages },
  );
  const togglingIds = bindings.togglingIds as Ref<Set<string>>;
  const toggleEnabled = bindings.toggleEnabled as (row: { id: string; enabled: boolean }, enabled: boolean) => Promise<void>;

  const row = { id: "row-1", enabled: false };
  void toggleEnabled(row, true);
  await flush();
  assert.equal(calls.length, 1, "第一次拨动应发出请求");

  // 上一次还没回来时再拨一次：行级守卫应直接忽略，界面状态也不会被第二个请求改写。
  void toggleEnabled(row, false);
  await flush();
  assert.equal(calls.length, 1, "同一行的第二次拨动不得再发请求");
  assert.equal(togglingIds.value.has("row-1"), true, "在途期间该行应处于忙碌态");

  pending[0]!({ enabled: true });
  await flush();
  assert.equal(row.enabled, true, "界面应以真实响应为准");
  assert.equal(togglingIds.value.has("row-1"), false, "finally 只清自己的行");

  void toggleEnabled(row, false);
  await flush();
  assert.equal(calls.length, 2, "锁释放后可以再拨一次");
  pending[1]!({ enabled: false });
  await flush();
  assert.equal(togglingIds.value.size, 0, "结束后不应留下残留忙碌标记");
}

await testToggleSerializesRequests("app/pages/characters/[id]/settings/catchphrases.vue", "updateCatchphrase");
await testToggleSerializesRequests("app/pages/characters/[id]/settings/stickers.vue", "updateSticker");

// ── 2. daily-life 的进行中集合 ──────────────────────────────
{
  const startCalls: Array<{ planItemId: string }> = [];
  const startPending: Array<(value: unknown) => void> = [];
  const api = {
    startActivity: (_id: string, payload: { planItemId: string }) => {
      startCalls.push(payload);
      const gate = deferred<unknown>();
      startPending.push(gate.resolve);
      return gate.promise;
    },
    completeActivity: async () => ({}),
  };
  const bindings = await loadDeclarations(
    "app/pages/daily-life.vue",
    ["actingIds", "markActing", "startPlanned", "completeCurrent"],
    {
      ref: refStub,
      api,
      id: { value: "character-a" },
      overview: { value: { currentActivity: { id: "activity-current" } } },
      ElMessage: messages,
      readApiErrorMessage: () => "请求失败",
      load: async () => {},
    },
  );
  const actingIds = bindings.actingIds as Ref<Set<string>>;
  const startPlanned = bindings.startPlanned as (item: { id: string }) => Promise<void>;

  const x = { id: "item-x" };
  const y = { id: "item-y" };
  void startPlanned(x);
  await flush();
  void startPlanned(y);
  await flush();
  assert.equal(startCalls.length, 2, "两个不同活动可以各自发起");
  assert.equal(actingIds.value.has("item-x") && actingIds.value.has("item-y"), true, "两个忙碌标记应同时存在");

  // X 先结束：只删自己的 ID，Y 的按钮必须仍然显示进行中。
  startPending[0]!({});
  await flush();
  assert.equal(actingIds.value.has("item-x"), false, "X 结束后应清掉 X");
  assert.equal(actingIds.value.has("item-y"), true, "X 的 finally 不得清掉 Y 的标记");

  void startPlanned(y);
  await flush();
  assert.equal(startCalls.length, 2, "Y 仍在进行中，重复点击不得再发请求");

  startPending[1]!({});
  await flush();
  assert.equal(actingIds.value.size, 0, "全部结束后集合应清空");

  // completeCurrent 也走同一套集合，确认没有留下单值写法。
  const completeCurrent = bindings.completeCurrent as () => Promise<void>;
  void completeCurrent();
  await flush();
  assert.equal(actingIds.value.size, 0, "completeCurrent 完成后也不应残留标记");
}

// ── 3. lastFinished 全量记录 ────────────────────────────────
{
  const state = new Map<string, Ref<unknown>>();
  const useState = (key: string, init: () => unknown): Ref<unknown> => {
    if (!state.has(key)) state.set(key, { value: init() });
    return state.get(key)!;
  };
  const done = (id: string, characterId: string, status: string) => ({
    id, characterId, status, type: "GENERATE_SNAPSHOT",
  });
  let payload: { jobs: ReturnType<typeof done>[]; checkedAt: string } = { jobs: [], checkedAt: "t1" };
  const useApiRequest = () => async () => payload;

  const bindings = await loadDeclarations(
    "app/composables/useMemoryProgress.ts",
    ["ACTIVE_STATUSES", "isActiveMemoryJob", "PROGRESS_FETCH_TIMEOUT_MS", "inflight", "progressState", "refreshMemoryProgress"],
    {
      useState,
      useApiRequest,
      AbortController,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    { sfc: false, clientOnly: true },
  );
  const refresh = bindings.refreshMemoryProgress as () => Promise<unknown>;
  // useState 的槽位在 progressState() 首次调用时才建立。
  (bindings.progressState as () => void)();
  const jobs = state.get("memory-progress-jobs")!;
  const lastFinished = state.get("memory-progress-last-finished")!;

  // 上一快照：两个角色各有一个 RUNNING 任务。
  jobs.value = [done("job-a", "character-a", "RUNNING"), done("job-b", "character-b", "RUNNING")];
  payload = {
    jobs: [done("job-a", "character-a", "SUCCEEDED"), done("job-b", "character-b", "SUCCEEDED")],
    checkedAt: "t2",
  };
  await refresh();
  const batch = lastFinished.value as Array<{ id: string; characterId: string }>;
  assert.equal(batch.length, 2, "同轮完成的多个任务必须全部记录，不能只取第一个");
  assert.deepEqual(batch.map((job) => job.characterId).sort(), ["character-a", "character-b"]);

  // 下一轮状态没变：wasActive 里已没有这两个任务，不得重复产生完成信号。
  payload = { ...payload, checkedAt: "t3" };
  await refresh();
  assert.equal(lastFinished.value, batch, "同一批完成事件不得在下一轮重复触发");

  // 只有单个任务完成时也应正常记录（保持旧行为）。
  jobs.value = [done("job-c", "character-a", "RUNNING")];
  payload = { jobs: [done("job-c", "character-a", "FAILED")], checkedAt: "t4" };
  await refresh();
  assert.equal((lastFinished.value as unknown[]).length, 1, "单个任务完成仍应记录一次");
}

console.log("最小范围异步改造回归通过：开关连拨、进行中集合、完成事件全量记录。");
