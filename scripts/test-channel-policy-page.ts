import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../app/components/ChannelPolicyWorkspace.vue", import.meta.url), "utf8");
const ast = ts.createSourceFile("channel.ts", source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = ast.statements.filter(node => !ts.isImportDeclaration(node));
const names = statements.flatMap(node => ts.isVariableStatement(node) ? node.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []) : ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : []);
const compiled = ts.transpileModule(`(function(){${statements.map(node => node.getText(ast)).join("\n")}\nreturn {${names.join(",")}}})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Request = { url: string; options: { body?: Record<string, unknown>; query?: Record<string, unknown> }; resolve: (value: unknown) => void; reject: (value: unknown) => void };
function harness() {
 const props = { characterId: "a" }; const requests: Request[] = []; let watcher = () => {}; let unmount = () => {}; let notices = 0;
 const ctx = createContext({ defineProps: () => props, ref: (value: unknown) => ({ value }), watch: (_: unknown, cb: () => void) => { watcher = cb; cb(); }, onBeforeUnmount: (cb: () => void) => { unmount = cb; }, ElMessage: { success: () => { notices++; } }, $fetch: (url: string, options: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
 const b = new Script(compiled).runInContext(ctx) as Record<string, any>;
 return { get: (key: string) => b[key].value, set: (key: string, value: unknown) => { b[key].value = value; }, call: (key: string, ...args: unknown[]) => b[key](...args), take: () => { assert(requests.length); return requests.shift()!; }, pending: () => requests.length, switch: (id: string) => { props.characterId = id; watcher(); }, unmount, notices: () => notices };
}
const item = (id = "p", characterId = "a", status = "PENDING") => ({ id, characterId, kind: "GROUP_AT_DISABLED", chatScope: "GROUP", content: "被动群聊回复不附带@提醒", status, revision: 3, sourceRefs: [{ privateText: "must-not-render" }] });
const result = (items: unknown[] = [], total = items.length, pageCount = 1) => ({ items, pagination: { page: 1, pageSize: 20, total, pageCount } });
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
{
 const h = harness(), old = h.take(); assert.match(old.url, /\/a\/growth\/channel-policies$/); h.switch("b"); const b = h.take(); h.switch("a"); h.take().resolve(result([item("fresh"), item("alien", "b")])); await tick(); old.resolve(result([item("stale")])); b.reject(new Error("stale")); await tick(); assert.equal(h.get("items")[0].id, "fresh"); assert.equal(h.get("items").length, 1); assert.equal(h.get("error"), "");
 h.call("filter", "DISABLED"); const filtered = h.take(); assert.equal(filtered.options.query?.status, "DISABLED"); assert.equal(h.get("page"), 1); filtered.resolve(result()); await tick();
}
{
 const h = harness(); h.take().resolve(result([item()])); await tick(); h.call("open", item(), "ACTIVATE"); await h.call("submit"); assert.equal(h.pending(), 0, "must explicitly confirm all-binding passive reply scope"); h.set("reviewed", true); const work = h.call("submit"); const req = h.take(); assert.deepEqual(JSON.parse(JSON.stringify(req.options.body)), { operation: "ACTIVATE", expectedRevision: 3 }); h.switch("b"); h.take().resolve(result()); req.resolve({}); await work; assert.equal(h.notices(), 0); assert.equal(h.get("busy"), false);
}
{
 const h = harness(); h.take().resolve(result()); await tick(); h.call("open", item("active", "a", "ACTIVE"), "DISABLE"); const work = h.call("submit"); const req = h.take(); assert.deepEqual(JSON.parse(JSON.stringify(req.options.body)), { operation: "DISABLE", expectedRevision: 3 }); h.unmount(); req.resolve({}); await work; assert.equal(h.notices(), 0);
}
{
 const h = harness(); h.take().resolve(result()); await tick(); h.call("showHistory", item("one")); const old = h.take(); h.call("showHistory", item("two")); h.take().resolve(result([item("latest")], 21, 3)); await tick(); old.resolve(result([item("stale")])); await tick(); assert.equal(h.get("historyItems")[0].id, "latest"); h.set("historyPage", 2); const work = h.call("loadHistory"); const second = h.take(); assert.equal(second.options.query?.page, 2); assert.equal(second.options.query?.pageSize, 10); h.unmount(); second.resolve(result([item("late")])); await work; assert.equal(h.get("historyItems").length, 0);
}
{
 const h = harness(); h.take().resolve(result()); await tick(); h.call("open", item("foreign", "b"), "ACTIVATE"); assert.equal(h.get("target"), null); h.call("open", item("active", "a", "ACTIVE"), "REJECT"); assert.equal(h.get("target"), null);
}
assert(source.includes("sourceRefs?.length")); assert(!source.includes("sourceRefs.map")); assert(!source.includes("source.excerpt")); assert(!source.includes("EDIT")); assert(source.includes("所有 QQ 绑定")); assert(source.includes("不影响主动好友联系或群公告"));
const page = readFileSync(new URL("../app/pages/growth/language.vue", import.meta.url), "utf8"); assert(page.includes('<ChannelPolicyWorkspace :character-id="characterId" />'));
console.log("Channel policy UI handlers passed: owner scope checkbox, revision-only whitelist, role A-B-A, stale history pagination, unmount and private-source exclusion (mock, no API writes).");
