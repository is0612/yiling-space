import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import { MODEL_PURPOSE_DEFAULTS } from "../shared/utils/model-purpose-defaults";
const cases = [
  { file: "app/components/CharacterModelSettings.vue", functions: ["resetRecommendedGenerationSettings", "resetRecommendedMemoryAssistantSettings", "resetRecommendedContextAssistantSettings", "resetRecommendedVoiceSettings"] },
  { file: "app/components/KnowledgeAssistantSettings.vue", functions: ["resetRecommendedParameters"] },
  { file: "app/components/SocialAssessmentSettings.vue", functions: ["resetRecommendedParameters"] },
];
for (const entry of cases) {
  const source = readFileSync(entry.file, "utf8").match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
  const parsed = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  for (const name of entry.functions) {
    const fn = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert(fn, name);
    const bindings: Record<string, unknown> = { MODEL_PURPOSE_DEFAULTS, ElMessage: { success: () => {} }, modelMessage: { success: () => {} } };
    const references = new Set([...fn.getText(parsed).matchAll(/\b(draft[A-Z]\w*|temperature|maxInputTokens|maxOutputTokens)\.value\b/gu)].map(match => match[1]!));
    for (const variable of references) bindings[variable] = { value: 999 };
    // Protected values are available to detect accidental assignment if a reset grows in the future.
    for (const variable of ["draftChatApiKey", "draftVoiceApiKey", "draftAsrApiKey", "draftVisionApiKey", "draftMemoryAssistantApiKey", "draftContextAssistantApiKey", "draftDailyTokenLimit", "draftMemoryTokenBudget", "draftSnapshotTokenBudget", "apiKey", "model", "apiBaseUrl", "enabled"]) bindings[variable] = { value: "preserve" };
    const code = ts.transpileModule(`(function(){${fn.getText(parsed)};return ${name};})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    new Script(code).runInContext(createContext(bindings))();
    for (const variable of ["draftChatApiKey", "draftVoiceApiKey", "draftAsrApiKey", "draftVisionApiKey", "draftMemoryAssistantApiKey", "draftContextAssistantApiKey", "draftDailyTokenLimit", "draftMemoryTokenBudget", "draftSnapshotTokenBudget", "apiKey", "model", "apiBaseUrl", "enabled"]) assert.equal((bindings[variable] as { value: unknown }).value, "preserve", `${name} must not reset ${variable}`);
    const numeric = [...references].map(variable => (bindings[variable] as { value?: unknown })?.value).filter(value => typeof value === "number");
    assert(numeric.length && numeric.every(value => value !== 999), `${name} applies purpose parameters`);
    assert(!/\$fetch|modelRequest|\bsave\s*\(/u.test(fn.getText(parsed)), "Reset is a draft operation, never auto-save/model call");
  }
}
console.log("Purpose reset: actual component functions restore numeric drafts only, preserving keys/models/enabled/quota and no network writes passed.");
