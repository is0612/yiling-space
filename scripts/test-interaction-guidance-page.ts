import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../app/components/InteractionGuidanceWorkspace.vue", import.meta.url), "utf8");
const ast = ts.createSourceFile("guidance.ts", source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = ast.statements.filter(node => !ts.isImportDeclaration(node));
const names = statements.flatMap(node => ts.isVariableStatement(node) ? node.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []) : ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : []);
const compiled = ts.transpileModule(`(function(){${statements.map(node => node.getText(ast)).join("\n")}\nreturn {${names.join(",")}}})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Request = { url: string; options: { body?: Record<string, unknown>; query?: Record<string, unknown> }; resolve: (value: unknown) => void; reject: (value: unknown) => void };
function harness() {
 const props = { characterId: "a" }; const requests: Request[] = []; let watcher = () => {}; let unmount = () => {}; let notices = 0;
 const ctx = createContext({ defineProps: () => props, ref: (value: unknown) => ({ value }), reactive: (value: unknown) => value, watch: (_: unknown, cb: () => void) => { watcher = cb; cb(); }, onBeforeUnmount: (cb: () => void) => { unmount = cb; }, ElMessage: { success: () => { notices++; } }, $fetch: (url: string, options: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
 const b = new Script(compiled).runInContext(ctx) as Record<string, any>;
 return { get: (key: string) => b[key].value, set: (key: string, value: unknown) => { b[key].value = value; }, call: (key: string, ...args: unknown[]) => b[key](...args), draft: b.draft, take: () => { assert(requests.length); return requests.shift()!; }, pending: () => requests.length, switch: (id: string) => { props.characterId = id; watcher(); }, unmount, notices: () => notices };
}
const item = (id = "g", characterId = "a") => ({ id, characterId, kind: "STRATEGY", content: "先理解再回应", context: "倾诉", reason: "经审核的抽象建议", chatScope: "PRIVATE", status: "PENDING", revision: 3, sourceRefs: [{ privateText: "never-render" }] });
const result = (items: unknown[] = [], pageCount = 1) => ({ items, pagination: { page: 1, pageSize: 20, total: items.length, pageCount } });
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
{
 const h = harness(), old = h.take(); h.switch("b"); const b = h.take(); h.switch("a"); const latest = h.take(); latest.resolve(result([item("fresh"), item("alien", "b")])); await tick(); old.resolve(result([item("stale")])); b.reject(new Error("stale")); await tick(); assert.equal(h.get("items")[0].id, "fresh"); assert.equal(h.get("items").length, 1); assert.equal(h.get("error"), "");
 h.call("filter", "DISABLED"); const filtered = h.take(); assert.equal(filtered.options.query?.status, "DISABLED"); assert.equal(h.get("items").length, 0); filtered.resolve(result()); await tick();
}
{
 const h = harness(); h.take().resolve(result([item()])); await tick(); h.call("open", item(), "ACTIVATE"); await h.call("submit"); assert.equal(h.pending(), 0, "acceptance requires redaction review checkbox"); h.set("reviewed", true); const work = h.call("submit"); const req = h.take(); assert.deepEqual(JSON.parse(JSON.stringify(req.options.body)), { operation: "ACTIVATE", expectedRevision: 3 }); h.switch("b"); h.take().resolve(result()); req.resolve({}); await work; assert.equal(h.notices(), 0); assert.equal(h.get("busy"), false);
}
{
 const h = harness(); h.take().resolve(result()); await tick(); h.call("open", item(), "EDIT"); h.draft.content = ""; await h.call("submit"); assert.equal(h.pending(), 0); assert.match(h.get("dialogError"), /正文/); h.draft.content = "先确认需要倾听还是建议"; h.draft.chatScope = "GROUP"; const work = h.call("submit"); const req = h.take(); assert.equal(req.options.body?.chatScope, "GROUP"); assert.equal(req.options.body?.expectedRevision, 3); assert(!("reason" in req.options.body!)); h.unmount(); req.resolve({}); await work; assert.equal(h.notices(), 0);
}
{
 const h = harness(); h.take().resolve(result()); await tick(); h.call("showHistory", item("one")); const old = h.take(); h.call("showHistory", item("two")); h.take().resolve(result([item("latest")])); await tick(); old.resolve(result([item("stale")])); await tick(); assert.equal(h.get("historyItems")[0].id, "latest"); h.unmount();
}
assert(!source.includes("sourceRefs.map")); assert(!source.includes("source.excerpt")); assert(source.includes("sourceRefs?.length")); assert(source.includes("reviewed")); assert(source.includes("InteractionGuidance") === false);
console.log("Guidance UI handlers passed: role A-B-A, stale list/history, redaction confirmation, revision-only actions, EDIT whitelist and unmount isolation (mock, no API writes).");
