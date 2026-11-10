import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";

// Run the actual component script with controlled requests, following page-harness.
const sfc = readFileSync(new URL("../app/components/DaysWorkspace.vue", import.meta.url), "utf8");
const source = ts.createSourceFile("days.ts", sfc.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = source.statements.filter(node => !ts.isImportDeclaration(node) && !(ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)));
const names = statements.flatMap(node => ts.isVariableStatement(node)
  ? node.declarationList.declarations.flatMap(item => ts.isIdentifier(item.name) ? [item.name.text] : [])
  : ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : []);
const compiled = ts.transpileModule(`(function(){${statements.map(node => node.getText(source)).join("\n")}\nreturn {${names.join(",")}};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
const executable = new Script(compiled.outputText);
type Ref = { value: unknown };
type Request = { url: string; options?: { method?: string; body?: unknown }; resolve: (value: unknown) => void; reject: (error: unknown) => void };
function harness() {
  const role: Ref = { value: "role-a" };
  const watchers: Array<{ source: Ref; callback: () => void }> = [];
  const requests: Request[] = [];
  const successes: string[] = [];
  const infos: string[] = [];
  let unmount = () => {};
  const context = createContext({
    ref: (value: unknown) => ({ value }), computed: (getter: () => unknown) => ({ get value() { return getter(); } }),
    watch: (source: Ref, callback: () => void) => watchers.push({ source, callback }),
    useCharacterSelection: () => ({ id: role }), useCharacterListData: async () => {},
    useCharacterList: () => ({ value: [{ id: "role-a", name: "A" }, { id: "role-b", name: "B" }] }),
    useMemoryProgress: () => ({ lastFinished: { value: null } }),
    onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    ElMessage: { success: (message: string) => successes.push(message), info: (message: string) => infos.push(message), warning: () => {}, error: () => {} },
    ElMessageBox: { confirm: async () => true }, URLSearchParams, setTimeout, clearTimeout,
    $fetch: (url: string, options?: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  const bindings = executable.runInContext(context) as Record<string, Ref | ((...args: unknown[]) => unknown)>;
  return {
    read: <T = unknown>(name: string) => (bindings[name] as Ref).value as T,
    set: (name: string, value: unknown) => { (bindings[name] as Ref).value = value; },
    call: (name: string, ...args: unknown[]) => (bindings[name] as (...args: unknown[]) => unknown)(...args),
    switchRole: (id: string) => { role.value = id; watchers.find(watcher => watcher.source === role)!.callback(); },
    takePost: () => { const index = requests.findIndex(request => request.options?.method === "POST"); assert(index >= 0); return requests.splice(index, 1)[0]!; },
    requests, successes, infos, unmount: () => unmount(),
  };
}
const text = "这是公开忆泡中的一段连续原文，它记录了一个可以进一步整理与核实的知识线索。";
const event = (scope = "character", status = "ACTIVE", id = "event-a") => ({ id, scope, status, detail: text, title: "测试忆泡", participants: [] });
function prepare(page: ReturnType<typeof harness>, item = event()) {
  page.set("selected", "2026-11-10");
  page.set("detail", { events: [item] });
  page.call("openKnowledgeRequest", item);
}
const response = { requestId: "request-a", eventId: "event-a", status: "PENDING", candidateId: null, created: true };

// Public ACTIVE only, with no default whole-event extraction.
{
  const page = harness();
  for (const item of [event("private"), event("external"), event("character", "ARCHIVED")]) {
    prepare(page, item); assert.equal(page.read("knowledgeOpen"), false);
  }
  prepare(page); assert.equal(page.read("knowledgeOpen"), true);
  assert.equal(page.read<{ excerpt: string }>("knowledgeForm").excerpt, "");
  assert.match(sfc, /v-if="canRequestKnowledge\(event\)"/);
}
// Length, exact continuous substring and reason validation never POST invalid input.
{
  const page = harness(); prepare(page);
  for (const [excerpt, reason, error] of [["短摘录", "", /20～2000/], ["字".repeat(2001), "", /20～2000/], ["这是一段不存在于原始详情中的改写文本，不能提交为原文摘录。", "", /连续原文/], [text, "字".repeat(241), /240/]] as const) {
    page.set("knowledgeForm", { excerpt, reason }); await page.call("submitKnowledgeRequest");
    assert.match(page.read<string>("knowledgeError"), error); assert.equal(page.requests.length, 0);
  }
}
// Explicit confirmation sends only excerpt/reason and describes asynchronous dispatch.
{
  const page = harness(); prepare(page); assert.equal(page.requests.length, 0);
  const excerpt = text.slice(0, 25); page.set("knowledgeForm", { excerpt, reason: " 可复用的知识线索 " });
  const submitting = page.call("submitKnowledgeRequest"); const request = page.takePost();
  assert.equal(request.url, "/api/characters/role-a/memory-events/event-a/knowledge-candidate");
  assert.deepEqual(JSON.parse(JSON.stringify(request.options?.body)), { excerpt, reason: "可复用的知识线索" });
  request.resolve(response); await submitting;
  assert.equal(page.read("knowledgeOpen"), false); assert.match(page.successes[0]!, /等待后台派发/); assert.match(page.successes[0]!, /不会自动调用模型或入库/);
}
// A->B->A late POST must not close/notify the returned A's new dialog.
{
  const page = harness(); prepare(page); page.set("knowledgeForm", { excerpt: text, reason: "" });
  const submitting = page.call("submitKnowledgeRequest"); const old = page.takePost();
  page.switchRole("role-b"); page.switchRole("role-a"); prepare(page, event("character", "ACTIVE", "new-event"));
  old.resolve(response); await submitting;
  assert.equal(page.read("knowledgeOpen"), true); assert.equal(page.read<{ id: string }>("knowledgeEvent").id, "new-event"); assert.equal(page.successes.length, 0);
}
// Detail switch, dialog close and unmount invalidate successes and errors.
for (const action of ["detail", "close", "unmount"]) {
  const page = harness(); prepare(page); page.set("knowledgeForm", { excerpt: text, reason: "" });
  const submitting = page.call("submitKnowledgeRequest"); const old = page.takePost();
  if (action === "detail") page.call("loadDetail", "2026-11-11");
  else if (action === "close") page.call("closeKnowledgeRequest");
  else page.unmount();
  old.reject({ data: { statusMessage: "late error" } }); await submitting;
  assert.equal(page.read("knowledgeOpen"), false); assert.equal(page.read("knowledgeError"), ""); assert.equal(page.successes.length, 0);
}
// Switching event within a date is another generation; duplicate pending/terminal results are honest.
{
  const page = harness(); prepare(page); page.set("knowledgeForm", { excerpt: text, reason: "" });
  const oldSubmit = page.call("submitKnowledgeRequest"); const old = page.takePost();
  prepare(page, event("character", "ACTIVE", "event-b")); old.resolve(response); await oldSubmit;
  assert.equal(page.read<{ id: string }>("knowledgeEvent").id, "event-b"); assert.equal(page.successes.length, 0);
  page.set("knowledgeForm", { excerpt: text, reason: "" });
  const submit = page.call("submitKnowledgeRequest"); page.takePost().resolve({ ...response, created: false }); await submit;
  assert.match(page.successes[0]!, /已有待处理请求/);
  prepare(page); page.set("knowledgeForm", { excerpt: text, reason: "" });
  const skipped = page.call("submitKnowledgeRequest"); page.takePost().resolve({ ...response, status: "SKIPPED", eventId: null }); await skipped;
  assert.match(page.infos[0]!, /已跳过/);
}
await setImmediate();
console.log("Memory knowledge request page: public scope, excerpt validation, explicit contract and generation races passed.");
