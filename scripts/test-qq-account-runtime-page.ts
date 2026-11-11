import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { selectRuntimeConnection } from "../app/utils/qq-channel";

const source = readFileSync(new URL("../app/pages/qq.vue", import.meta.url), "utf8");
const setup = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
const parsed = ts.createSourceFile("qq.ts", setup, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functions = ["loadRuntime", "attachHook", "provisionPanel", "reconnectConnection"];
const body = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && functions.includes(node.name.text)).map(node => node.getText(parsed)).join("\n");
const compiled = ts.transpileModule(`(function(){${body};return {loadRuntime,attachHook,provisionPanel,reconnectConnection};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Request = { url: string; options?: { method?: string; body?: Record<string, unknown>; query?: Record<string, unknown> }; resolve: (value: unknown) => void; reject: (value: unknown) => void };
const ref = <T>(value: T) => ({ value });
function harness() {
  const requests: Request[] = [], errors: string[] = [], infos: string[] = [];
  const runtime = ref<any>(null), selectedRuntimeConnectionId = ref("");
  const primaryConnection = { get value() { return selectRuntimeConnection([{ id: "offline", status: "ERROR" }, { id: "online", status: "CONNECTED" }], runtime.value?.selectedConnectionId); } };
  const bindings = new Script(compiled).runInContext(createContext({
    runtime, selectedRuntimeConnectionId, runtimeRequestVersion: 0, primaryConnection,
    homeEditing: ref(false), homeDraft: ref(""), panelProvisioning: ref(false), panelAuthPaused: ref(false),
    reconnecting: ref(false), stopping: ref(false), connecting: ref(false), connectStep: ref(""),
    snowluma: { get value() { return runtime.value?.snowluma; } }, gateway: { get value() { return runtime.value?.gateway; } },
    adapterStatus: { get value() { return runtime.value?.adapter; } },
    loadQuota: async () => {}, refresh: async () => {}, startReloadPolling: () => {},
    ElMessage: { error: (message: string) => errors.push(message), info: (message: string) => infos.push(message), success: () => {}, warning: () => {} },
    PANEL_NEEDED_REASONS: new Set(["no-password"]), openPanel: () => { throw Error("Unexpected panel open"); },
    readErrorMessage: (_: unknown, fallback: string) => fallback,
    $fetch: (url: string, options?: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  })) as Record<string, (...args: any[]) => Promise<any>>;
  const take = (ending: string) => { const index = requests.findIndex(row => row.url.endsWith(ending)); assert(index >= 0, ending); return requests.splice(index, 1)[0]!; };
  return { bindings, requests, take, errors, infos, runtime, selectedRuntimeConnectionId, primaryConnection };
}
const runtimeValue = (selectedConnectionId: string, accountState = "ready") => ({ selectedConnectionId, gateway: { reachable: false, accountState }, adapter: { running: true }, snowluma: { running: true, home: "test" } });
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
{
  const h = harness(); assert.equal(h.primaryConnection.value?.id, "online");
  const first = h.bindings.loadRuntime!("offline"); const old = h.take("/runtime");
  const second = h.bindings.loadRuntime!("online"); const latest = h.take("/runtime");
  assert.equal(old.options?.query?.connectionId, "offline"); assert.equal(latest.options?.query?.connectionId, "online");
  latest.resolve(runtimeValue("online")); await second; old.resolve(runtimeValue("offline", "waiting_login")); await first;
  assert.equal(h.primaryConnection.value?.id, "online", "Late runtime response must not replace selected account");
}
{
  const h = harness(); const pending = h.bindings.reconnectConnection!({ id: "offline" });
  const runtime = h.take("/runtime"); assert.equal(runtime.options?.query?.connectionId, "offline");
  runtime.resolve(runtimeValue("offline", "waiting_login")); await pending;
  assert.equal(h.errors.length, 0); assert.equal(h.infos.length, 1); assert.equal(h.requests.length, 0, "Known logged-out account must not modify panel, launch or reload adapter");
}
{
  const h = harness(); const pending = h.bindings.reconnectConnection!({ id: "offline" });
  h.take("/runtime").resolve(runtimeValue("offline")); await flush();
  const provision = h.take("/provision"); assert.equal(provision.options?.body?.connectionId, "offline");
  provision.resolve({ ok: true, message: "aligned", changes: [], warnings: [] }); await flush();
  h.take("/runtime").resolve(runtimeValue("offline")); await flush();
  const hook = h.take("/hook"); assert.equal(hook.options?.body?.connectionId, "offline");
  hook.resolve({ ok: true, action: "waiting-login", reason: "account-not-logged-in", message: "当前账号未登录，暂不连接" }); await flush();
  h.take("/runtime").resolve(runtimeValue("offline", "waiting_login")); await pending;
  assert.equal(h.errors.length, 0); assert.equal(h.infos.length, 1); assert.equal(h.requests.length, 0, "Waiting hook result must not reload or launch adapter");
}
{
  const h = harness(); const pending = h.bindings.attachHook!(false, "offline"); const request = h.take("/hook");
  assert.equal(request.options?.body?.connectionId, "offline"); request.resolve({ ok: true, action: "waiting-login", reason: "account-not-logged-in", message: "等待登录" });
  const result = await pending; assert.equal(result.action, "waiting-login"); assert.equal(h.infos.length, 1); assert.equal(h.errors.length, 0);
}
{
  const h = harness(); const pending = h.bindings.reconnectConnection!({ id: "offline" });
  h.take("/runtime").resolve(runtimeValue("offline")); await flush();
  h.take("/provision").resolve({ ok: true, action: "waiting-login", reason: "account-not-logged-in", message: "等待登录", changes: [], warnings: [] }); await flush();
  h.take("/runtime").resolve(runtimeValue("offline", "waiting_login")); await pending;
  assert.equal(h.errors.length, 0); assert.equal(h.infos.length, 1); assert.equal(h.requests.length, 0, "Provision waiting result must stop before hook/reload");
}
assert(!source.includes("QQ 没挂上面板（3001 上不会有节点）"));
console.log("QQ account runtime page: connected selection, explicit account requests, stale response guards and neutral waiting-login short circuit passed (script-level, no panel calls).");
