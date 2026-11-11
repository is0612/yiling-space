import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";
import { MODEL_PROVIDERS, buildModelOptions, providerByBaseUrl, providerByKey } from "../app/utils/model-catalog";
const social = "../app/components/SocialAssessmentSettings.vue";
const api = (role = "char-a") => `/api/characters/${role}`;
const settings = (id = "char-a") => ({ id, socialRelationshipAssessmentAssistantModel: `model-${id}`, socialRelationshipAssessmentAssistantApiBaseUrl: "https://api.example.com/v1", socialRelationshipAssessmentAssistantEnabled: true, socialRelationshipAssessmentAssistantApiKeyConfigured: true, socialRelationshipAssessmentAssistantTemperature: 0.1, socialRelationshipAssessmentAssistantMaxInputTokens: 16384, socialRelationshipAssessmentAssistantMaxOutputTokens: 8192 });
const buildSocial = () => buildPageHarness(social, { globals: { MODEL_PROVIDERS, buildModelOptions, providerByBaseUrl, providerByKey } });
async function loadedSocial() { const page = buildSocial(); page.take(api()).resolve(settings()); await flushMicrotasks(); return page; }
{
  const page = buildSocial(); const old = page.take(api()); page.switchRole("char-b"); const b = page.take(api("char-b")); page.switchRole("char-a"); const fresh = page.take(api());
  old.resolve(settings("old")); b.resolve(settings("char-b")); fresh.resolve(settings()); await flushMicrotasks();
  assert.equal(page.read("model"), "model-char-a"); assert.equal(page.read("apiKey"), ""); page.finish();
}
{
  const page = await loadedSocial(); assert.equal(page.read("hasUnsavedChanges"), false);
  page.set("maxOutputTokens", 16384); assert.equal(page.read("hasUnsavedChanges"), true);
  const saving = page.call("save"); const request = page.take(api(), "PATCH"); const body = request.options!.body as Record<string, unknown>;
  assert.equal(body.socialRelationshipAssessmentAssistantMaxOutputTokens, 16384); assert.equal(body.socialRelationshipAssessmentAssistantApiKey, "");
  assert(!("chatApiKey" in body)); assert(!("knowledgeAssistantModel" in body));
  request.resolve({ ...settings(), socialRelationshipAssessmentAssistantMaxOutputTokens: 16384 }); await saving;
  assert.equal(page.read("hasUnsavedChanges"), false); page.finish();
}
{
  const page = await loadedSocial(); const action = page.call("testConnection"); page.take(api(), "PATCH").resolve(settings()); await flushMicrotasks();
  const test = page.take(api() + "/growth/social/assessment-test", "POST"); page.switchRole("char-b"); page.take(api("char-b")).resolve(settings("char-b")); test.resolve({ ok: true, message: "old response" }); await action; await flushMicrotasks();
  assert(!page.successes.includes("old response")); assert.equal(page.read("model"), "model-char-b"); assert.equal(page.read("testing"), false); page.finish();
}
{
  const page = await loadedSocial(); const action = page.call("fetchModels"); page.take(api(), "PATCH").resolve(settings()); await flushMicrotasks();
  const request = page.take(api() + "/growth/social/assessment-models"); page.unmount(); request.resolve({ ok: true, models: ["late-model"], message: "late response" }); await action;
  assert(!Array.from(page.read<string[]>("models")).includes("late-model")); assert(!page.successes.includes("late response")); page.finish();
}
{
  const page = buildPageHarness("../app/components/KnowledgeAssistantSettings.vue"); page.take(api()).resolve({ id: "char-a", knowledgeAssistantModel: "knowledge-model", knowledgeAssistantEnabled: false }); await flushMicrotasks();
  assert.equal(page.read("hasUnsavedChanges"), false); page.set("apiKey", "new-draft-key"); assert.equal(page.read("hasUnsavedChanges"), true);
  const saving = page.call("save"); page.take(api(), "PATCH").resolve({ id: "char-a", knowledgeAssistantModel: "knowledge-model", knowledgeAssistantEnabled: false }); await saving;
  assert.equal(page.read("apiKey"), ""); assert.equal(page.read("hasUnsavedChanges"), false); page.finish();
}
for (const [path, section] of [["../app/pages/growth/knowledge/settings.vue", "knowledge"], ["../app/pages/growth/social/assessment-settings.vue", "social"]]) {
  const text = readFileSync(new URL(path!, import.meta.url), "utf8"); assert(text.includes('path: "/models"')); assert(text.includes(`section: "${section}"`)); assert(text.includes("...route.query")); assert(text.includes("hash: route.hash")); assert(!text.includes("$fetch"));
}
for (const component of ["../app/components/KnowledgeAssistantSettings.vue", social]) {
  const text = readFileSync(new URL(component, import.meta.url), "utf8"); assert(text.includes("props.characterId")); assert(!text.includes("useCharacterSelection")); assert(!text.includes("definePageMeta")); assert(text.includes('v-if="!props.embedded"')); assert(text.includes("defineExpose({ hasUnsavedChanges, busy })"));
}
console.log("Assistant settings components: prop-driven role ABA, isolated key payloads, drafts, late tests/models, unmount and legacy redirects passed (script-level).");
