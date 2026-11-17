// 知识页脚本级测试的共享 harness。
// 从 SFC 抽出 <script>，用 TypeScript 转译后在 node:vm 里跑，
// 并把 Nuxt 自动导入（ref/computed/watch/useCharacterSelection/ElMessage/$fetch）替换成可控替身。
// 注意：这驱动的是页面脚本逻辑与模板绑定，不是浏览器 DOM 渲染。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";
import { MODEL_PURPOSE_DEFAULTS } from "../../shared/utils/model-purpose-defaults";
import { createKnowledgeApi } from "../../app/api/knowledge";
import { readApiErrorMessage } from "../../app/utils/api-error";
import { createRequestClient, type RawFetch } from "../../app/utils/request";

type PendingRequest = {
  url: string;
  options?: { method?: string; body?: unknown; query?: Record<string, unknown> };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export function buildPageHarness(
  relativePath: string,
  options: {
    props?: Record<string, unknown>;
    globals?: Record<string, unknown>;
    /**
     * 角色来源的绑定名。合并后的模型设置组件用 `watch(id, ...)` 跟着 `props.characterId` 走，
     * 而 `id` 是个 computed —— 默认的「找 characterId 观察者」匹配不到。
     * 传 `["id"]` 就按这些绑定逐个触发；不传则保持旧行为（只触发 characterId 或第一个观察者）。
     */
    roleSources?: string[];
  } = {},
) {
  // 调用方传入的路径相对 scripts/（如 "../app/pages/xxx.vue"），
  // 这里以 scripts/ 为基准解析，与 harness 自身所在目录无关。
  const pagePath = new URL(relativePath, new URL("../", import.meta.url));
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
  const mountedCallbacks: Array<() => void> = [];
  // 领域 API 通过 useApiRequest() 取传输层；这里复用真实 createRequestClient，
  // 让页面测试同时覆盖「路径不带 /api、查询进 params、正文进 data」的约定。
  const recordingFetch: RawFetch = (url, fetchOptions) => new Promise((resolve, reject) => {
    requests.push({
      url,
      options: {
        method: fetchOptions?.method as string | undefined,
        body: fetchOptions?.body,
        query: fetchOptions?.query as Record<string, unknown> | undefined,
      },
      resolve,
      reject,
    });
  });
  const context = createContext({
    MODEL_PURPOSE_DEFAULTS,
    definePageMeta: () => {},
    defineProps: () => options.props ?? { get characterId() { return role.value.id; }, embedded: true },
    defineEmits: () => () => {},
    defineExpose: () => {},
    useRoute: () => ({ path: relativePath }),
    useRouter: () => ({
      resolve: (target: unknown) => ({ href: "/", path: relativePath, target }),
      replace: async () => {},
      push: async () => {},
    }),
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
    onMounted: (callback: () => void) => { mountedCallbacks.push(callback); },
    onBeforeUnmount: (callback: () => void) => { unmountCallbacks.push(callback); },
    ElMessage: {
      error: (message: string) => errors.push(message),
      warning: (message: string) => warnings.push(message),
      success: (message: string) => successes.push(message),
      info: (message: string) => successes.push(message),
    },
    $fetch: (url: string, options?: PendingRequest["options"]) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }),
    // 页面里显式 import 的领域工具在沙箱中也要可见（import 声明会被剥掉）。
    readApiErrorMessage,
    createKnowledgeApi,
    useApiRequest: () => createRequestClient(recordingFetch),
    ...options.globals,
  });
  const executable = new Script(compiled.outputText, { filename: relativePath + ".actual-script.js" });
  const bindings = executable.runInContext(context) as Record<string, unknown>;
  // 首次加载常常挂在 onMounted 里（合并后的模型设置组件就是）。等 setup 跑完再触发，
  // 调用方紧接着 take(...) 才拿得到首个请求。
  for (const callback of mountedCallbacks) callback();

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
  /**
   * 按谓词取请求：同一个路径带不同 query 时（如列表 ?itemStatus=ARCHIVED），
   * 只靠路径会取错对象。谓词可以读 request.options.query 精确挑。
   */
  function takeMatching(predicate: (request: PendingRequest) => boolean, label = "matching"): PendingRequest {
    const index = requests.findIndex(predicate);
    assert.ok(index >= 0, `expected pending request: ${label}（现有：${requests.map((request) => request.url).join(", ")}）`);
    return requests.splice(index, 1)[0]!;
  }
  function switchRole(id: string) {
    const previous = role.value.id;
    role.value = { id, name: `角色 ${id}` };
    // 显式指定了角色来源：把这些绑定上的观察者全部触发（`watch(id, ...)` + `watch(id, 版本++)` 都要跑）。
    if (options.roleSources?.length) {
      const sources = options.roleSources.map((name) => bindings[name]).filter((value) => value !== undefined);
      const matched = watchers.filter((entry) => sources.includes(entry.source));
      assert.ok(matched.length > 0, `role watchers must be registered on: ${options.roleSources.join(", ")}`);
      for (const watcher of matched) watcher.callback(id, previous);
      return;
    }
    const roleWatcher = watchers.find(entry => entry.source === bindings.characterId) ?? watchers[0];
    assert.ok(roleWatcher, "role watcher must be registered");
    roleWatcher.callback(id, previous);
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
  function finish(options: { allowErrors?: boolean } = {}) {
    assert.equal(requests.length, 0, `unsettled requests: ${requests.map((request) => request.url).join(", ")}`);
    // 只断言「不该出现的错误」：需要验证错误反馈的用例自己断言 errors 后传 allowErrors。
    if (!options.allowErrors) {
      assert.deepEqual(errors, [], `unexpected error notifications: ${errors.join(", ")}`);
    }
  }

  return { read, set, call, take, takeMatching, switchRole, triggerKeyword, unmount, requests, errors, warnings, successes, finish };
}

export async function flushMicrotasks() {
  await flush();
  await flush();
}
