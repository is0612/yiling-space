import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import ts from "typescript";
const main = readFileSync("app/components/CharacterModelSettings.vue", "utf8");
const page = readFileSync("app/pages/models.vue", "utf8");
const wrapper = readFileSync("app/pages/characters/[id]/settings/model.vue", "utf8");
function scriptOf(source: string) { const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]; assert(script); return ts.createSourceFile("component.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function functionCode(source: string, names: string[]) {
  const parsed = scriptOf(source);
  return parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)).map(node => node.getText(parsed)).join("\n");
}
const sections = ["chat", "voice", "vision", "memoryAssistant", "contextAssistant", "knowledge", "social"];
const route = { query: { c: "role-a", from: "characters", section: "chat" }, hash: "#connection" };
const navigations: unknown[] = [];
const busy = { value: false };
const code = functionCode(page, ["readSection", "selectSection"]);
const controller = new Script(ts.transpileModule(`(function(){${code};return {readSection,selectSection};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText).runInContext(createContext({ busy, sections: sections.map(key => ({ key })), section: { value: "chat" }, characterId: { value: "role-a" }, route, router: { replace: (value: unknown) => { navigations.push(value); } } })) as { readSection(value: unknown): string; selectSection(value: string): void };
assert.equal(controller.readSection("social"), "social"); assert.equal(controller.readSection(["social"]), "chat"); assert.equal(controller.readSection("unknown"), "chat");
controller.selectSection("chat"); assert.equal(navigations.length, 0);
controller.selectSection("knowledge"); assert.deepEqual(JSON.parse(JSON.stringify(navigations[0])), { path: "/models", query: { c: "role-a", from: "characters", section: "knowledge" }, hash: "#connection" });
busy.value = true; controller.selectSection("social"); assert.equal(navigations.length, 1, "Saving panels cannot start a concurrent capability save"); busy.value = false;
for (const name of sections) assert(page.includes(`key: "${name}"`));
assert(page.includes('<KeepAlive :key="characterId">'), "Role switch destroys cached forms; capability switch preserves them");
assert(page.includes(':is="activeComponent"')); assert(page.includes(':character-id="characterId"')); assert(page.includes("分别保存"));
assert(main.includes("const id = computed(() => props.characterId)")); assert(!main.includes("definePageMeta("));
assert(main.includes('v-if="!embedded"')); assert(main.includes('v-show="activeTab === \'chat\'"')); assert(main.includes('v-show="activeTab === \'contextAssistant\'"'));
assert(main.includes('if (disposed || version !== roleVersion) throw new Error("Model settings role changed")'));
for (const field of ["chatApiKey: draftChatApiKey.value", "voiceApiKey: draftVoiceApiKey.value.trim()", "asrApiKey: draftAsrApiKey.value.trim()", "visionApiKey: draftVisionApiKey.value.trim()", "memoryAssistantApiKey: draftMemoryAssistantApiKey.value.trim()", "contextAssistantApiKey: draftContextAssistantApiKey.value.trim()"]) assert(main.includes(field), `Preserve credential save field: ${field}`);
for (const endpoint of ["/voice/models", "/voice/test-connection", "/vision/test-connection", "/chat/memory-assistant/models", "/chat/context-assistant/models", "/chat/test-connection"]) assert(main.includes(endpoint), endpoint);
assert(wrapper.includes('path: "/models"')); assert(wrapper.includes("c: String(route.params.id")); assert(wrapper.includes("hash: route.hash"));
assert(!/font-size:\s*(?:[0-9]|1[01])px/.test(page));
for (const path of ["app/pages/characters/[id]/settings/model.vue", "app/pages/growth/knowledge/settings.vue", "app/pages/growth/social/assessment-settings.vue"]) {
  assert(readFileSync(path, "utf8").includes("<style scoped>"), "Legacy HMR style-block URLs remain valid after route migration");
}
{
  let done!: (value: unknown) => void;
  const runtime = createContext({ disposed: false, roleVersion: 0, $fetch: () => new Promise(resolve => { done = resolve; }) });
  const requestCode = functionCode(main, ["modelRequest"]);
  const request = new Script(ts.transpileModule(`(function(){${requestCode};return modelRequest;})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText).runInContext(runtime) as (url: string) => Promise<unknown>;
  const pending = request("/api/characters/role-a");
  runtime.disposed = true;
  done({ chatApiKey: "provider-must-not-reach-new-role" });
  await assert.rejects(pending, /no longer active|role changed/);
  runtime.disposed = false;
  const stale = request("/api/characters/role-a");
  runtime.roleVersion = 1;
  done({ name: "old role" });
  await assert.rejects(stale, /role changed/);
}
{
  const parsed = scriptOf(main);
  const draftNames = parsed.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations).flatMap(declaration => ts.isIdentifier(declaration.name) && declaration.name.text.startsWith("draft") && declaration.name.text !== "draftSignature" ? [declaration.name.text] : []);
  const context: Record<string, unknown> = Object.fromEntries(draftNames.map(name => [name, { value: "" }]));
  Object.assign(context, { id: { value: "role-a" }, saving: { value: false }, character: { value: {} }, savedSignature: { value: "" }, lastSavedAt: { value: null }, syncAsrFromVoice: { value: false }, modelMessage: { success: () => {}, error: () => {}, warning: () => {} }, readError: () => "error", loadUsage: async () => {} });
  let resolveSave!: (value: unknown) => void;
  context.modelRequest = () => new Promise(resolve => { resolveSave = resolve; });
  const actual = new Script(ts.transpileModule(`(function(){${functionCode(main, ["buildDraftSignature", "save"])};return {save,buildDraftSignature};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText).runInContext(createContext(context)) as { save(silent?: boolean): Promise<boolean>; buildDraftSignature(clear?: boolean): string };
  (context.draftChatModel as { value: string }).value = "submitted-model";
  (context.draftChatApiKey as { value: string }).value = "submitted-key";
  const pending = actual.save(true);
  (context.draftChatModel as { value: string }).value = "new-unsaved-model";
  (context.draftChatApiKey as { value: string }).value = "new-unsaved-key";
  resolveSave({ chatModel: "submitted-model" });
  assert.equal(await pending, true);
  assert.equal((context.draftChatApiKey as { value: string }).value, "new-unsaved-key");
  assert.notEqual((context.savedSignature as { value: string }).value, actual.buildDraftSignature(), "Edits while PATCH is pending remain dirty");
  const second = actual.save(true);
  resolveSave({ chatModel: "new-unsaved-model" });
  assert.equal(await second, true);
  assert.equal((context.draftChatApiKey as { value: string }).value, "");
  assert.equal((context.savedSignature as { value: string }).value, actual.buildDraftSignature());
}
assert(page.includes("调用日志")); assert(page.includes("<ModelCallLogsDialog"));
console.log("Unified model settings: seven capabilities, canonical role/section routing, per-role draft cache, original independent credentials and request lifecycle guards passed (script-level, no DOM).");
