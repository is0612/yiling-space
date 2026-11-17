import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import ts from "typescript";
const main = readFileSync("app/components/CharacterModelSettings.vue", "utf8");
const page = readFileSync("app/pages/characters/[id]/settings/model.vue", "utf8");
const legacy = readFileSync("app/pages/models.vue", "utf8");
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
controller.selectSection("knowledge"); assert.deepEqual(JSON.parse(JSON.stringify(navigations[0])), { path: "/characters/role-a/settings/model", query: { c: "role-a", from: "characters", section: "knowledge" }, hash: "#connection" });
busy.value = true; controller.selectSection("social"); assert.equal(navigations.length, 1, "Saving panels cannot start a concurrent capability save"); busy.value = false;
// 页面上真正的分节只有三个；四个助手已经并进对话模型（2026-11-12），不再是独立 key。
// `sections` 仍然喂给 vm 里那份 readSection，是为了验证它「按分节表匹配、不认识就回 chat」。
const realSections = ["chat", "voice", "vision"];
const mergedSections = ["memoryAssistant", "contextAssistant", "knowledge", "social"];
for (const name of realSections) assert(page.includes(`key: "${name}"`));
for (const name of mergedSections) assert(!page.includes(`key: "${name}"`), `${name} 已并入对话模型，不该再有独立分节`);
assert(page.includes('<KeepAlive :key="characterId">'), "Role switch destroys cached forms; capability switch preserves them");
assert(page.includes('<main class="model-workspace-content">'), "Panel renders inside the model workspace content area");
assert(page.includes(':is="mainComponent"')); assert(page.includes(':character-id="characterId"')); assert(page.includes(':section="section"'));
assert(main.includes("const id = computed(() => props.characterId)")); assert(!main.includes("definePageMeta("));
assert(main.includes('const activeTab = computed<ModelSection>(() => props.section ?? "chat")'), "The workspace controls the active model section through the section prop"); assert(main.includes('v-show="activeTab === \'chat\'"')); assert(main.includes('v-show="activeTab === \'vision\'"'), "Assistant panels are folded into the chat section, vision stays its own panel");
assert(main.includes('if (disposed || version !== roleVersion) throw new Error("Model settings role changed")'));
for (const field of ["chatApiKey: draftChatApiKey.value", "voiceApiKey: draftVoiceApiKey.value.trim()", "asrApiKey: draftAsrApiKey.value.trim()", "visionApiKey: draftVisionApiKey.value.trim()", "memoryAssistantApiKey: draftMemoryAssistantApiKey.value.trim()", "contextAssistantApiKey: draftContextAssistantApiKey.value.trim()"]) assert(main.includes(field), `Preserve credential save field: ${field}`);
for (const endpoint of ["/voice/models", "/voice/test-connection", "/vision/test-connection", "/chat/memory-assistant/models", "/chat/context-assistant/models", "/chat/test-connection"]) assert(main.includes(endpoint), endpoint);
assert(legacy.includes("/settings/model"), "旧 /models 应转到角色下的模型设置页");
assert(legacy.includes("...route.query")); assert(legacy.includes("hash: route.hash")); assert(legacy.includes("useCharacterSelection"));
assert(!/font-size:\s*(?:[0-9]|1[01])px/.test(page));
for (const path of ["app/pages/models.vue", "app/pages/growth/knowledge/settings.vue", "app/pages/growth/social/assessment-settings.vue"]) {
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
  Object.assign(context, { id: { value: "role-a" }, saving: { value: false }, character: { value: {} }, savedSignature: { value: "" }, lastSavedAt: { value: null }, syncAsrFromVoice: { value: false }, modelMessage: { success: () => {}, error: () => {}, warning: () => {} }, readError: () => "error", loadUsage: async () => {}, disposed: false, roleVersion: 0 });
  // 「清除 Key」记账本和字段映射：save 里的 sendsKeyClear 会读它们，缺了就是未定义标识符。
  context.pendingKeyClears = { value: new Set<string>() };
  context.keyDrafts = Object.fromEntries(Object.entries({
    chat: "draftChatApiKey", voice: "draftVoiceApiKey", asr: "draftAsrApiKey", vision: "draftVisionApiKey",
    memory: "draftMemoryAssistantApiKey", context: "draftContextAssistantApiKey", knowledge: "draftKnowledgeAssistantApiKey", social: "draftSocialAssistantApiKey",
  }).map(([field, draftName]) => [field, context[draftName]]));
  let resolveSave!: (value: unknown) => void;
  context.modelRequest = () => new Promise(resolve => { resolveSave = resolve; });
  // `save` 落库后会用服务端回显回填 Key 输入框，还会按代际判断响应是否过期；
  // 这些函数都得进沙箱，否则在 vm 里是未定义标识符，save 会一路掉进 catch 返回 false。
  const actual = new Script(ts.transpileModule(`(function(){${functionCode(main, ["buildDraftSignature", "syncKeysFromCharacter", "requestGeneration", "isStaleResponse", "save", "sendsKeyClear", "markKeyForClear"])};return {save,buildDraftSignature,markKeyForClear,sendsKeyClear};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText).runInContext(createContext(context)) as { save(silent?: boolean): Promise<boolean>; buildDraftSignature(): string; markKeyForClear(field: string): void; sendsKeyClear(field: string): boolean };
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
{
  // 「清除 Key」的语义：空输入框 = 「不动」；只有点过「清除」且保存时仍为空，才发 clear* 字段。
  // 勾了清除又重新手打了新值，以新值为准，不发 clear —— 账本必须等保存成功后才翻页。
  const parsed = scriptOf(main);
  const draftNames = parsed.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations).flatMap(declaration => ts.isIdentifier(declaration.name) && declaration.name.text.startsWith("draft") && declaration.name.text !== "draftSignature" ? [declaration.name.text] : []);
  const context: Record<string, unknown> = Object.fromEntries(draftNames.map(name => [name, { value: "" }]));
  Object.assign(context, { id: { value: "role-a" }, saving: { value: false }, character: { value: {} }, savedSignature: { value: "" }, lastSavedAt: { value: null }, syncAsrFromVoice: { value: false }, modelMessage: { success: () => {}, error: () => {}, warning: () => {} }, readError: () => "error", loadUsage: async () => {}, disposed: false, roleVersion: 0 });
  context.pendingKeyClears = { value: new Set<string>() };
  context.keyDrafts = Object.fromEntries(Object.entries({
    chat: "draftChatApiKey", voice: "draftVoiceApiKey", asr: "draftAsrApiKey", vision: "draftVisionApiKey",
    memory: "draftMemoryAssistantApiKey", context: "draftContextAssistantApiKey", knowledge: "draftKnowledgeAssistantApiKey", social: "draftSocialAssistantApiKey",
  }).map(([field, draftName]) => [field, context[draftName]]));
  const bodies: Record<string, unknown>[] = [];
  let resolveSave!: (value: unknown) => void;
  context.modelRequest = (_url: string, init?: { body?: Record<string, unknown> }) => new Promise(resolve => { resolveSave = resolve; bodies.push(init?.body ?? {}); });
  const actual = new Script(ts.transpileModule(`(function(){${functionCode(main, ["buildDraftSignature", "syncKeysFromCharacter", "requestGeneration", "isStaleResponse", "save", "sendsKeyClear", "markKeyForClear"])};return {save,markKeyForClear,sendsKeyClear};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText).runInContext(createContext(context)) as { save(silent?: boolean): Promise<boolean>; markKeyForClear(field: string): void; sendsKeyClear(field: string): boolean };

  // 1) 只是清空输入框（没点「清除」）：保存 body 绝不能带 clear 字段 —— 否则存量 Key 静默消失。
  (context.draftChatApiKey as { value: string }).value = "";
  (context.draftVoiceApiKey as { value: string }).value = "";
  const passiveSave = actual.save(true);
  resolveSave({});
  await passiveSave;
  assert.equal("clearApiKey" in bodies[0], false, "空输入框只能代表「不动」，不允许静默清库");
  assert.equal("clearVoiceApiKey" in bodies[0], false);

  // 2) 点了「清除」：输入框清空、账本记账，保存 body 发对应 clear 字段。
  actual.markKeyForClear("chat");
  assert.equal((context.draftChatApiKey as { value: string }).value, "", "点「清除」先把输入框清空");
  assert.equal(actual.sendsKeyClear("chat"), true);
  const clearingSave = actual.save(true);
  resolveSave({});
  await clearingSave;
  assert.equal((bodies[1] as { clearApiKey?: boolean }).clearApiKey, true, "点过「清除」且输入框为空，保存时发 clearApiKey");
  assert.equal(actual.sendsKeyClear("chat"), false, "保存成功后账本翻页，后续手动清空不会被误判成清除");

  // 3) 点了「清除」又重新手打了新值：以新值为准，不发 clear。
  actual.markKeyForClear("voice");
  (context.draftVoiceApiKey as { value: string }).value = "fresh-key";
  const retypedSave = actual.save(true);
  resolveSave({});
  await retypedSave;
  assert.equal("clearVoiceApiKey" in bodies[2], false, "清除后重新输入新 Key，以新值为准");
  assert.equal((bodies[2] as { voiceApiKey?: string }).voiceApiKey, "fresh-key");
}
assert(main.includes("调用日志")); assert(main.includes("<ModelCallLogsDialog"), "Call logs dialog belongs to the extracted model settings component");
console.log("Unified model settings: seven capabilities, canonical role/section routing, per-role draft cache, original independent credentials and request lifecycle guards passed (script-level, no DOM).");
