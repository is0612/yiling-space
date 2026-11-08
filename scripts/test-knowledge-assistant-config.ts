import assert from "node:assert/strict";
import { readKnowledgeAssistantSettingsPatch, validateKnowledgeAssistantEnabledConfig } from "../server/utils/knowledge-assistant-config";
import { encryptApiKey, isKnowledgeAssistantApiKeySaved, resolveCharacterKnowledgeAssistantApiKey } from "../server/utils/credential-encryption";
import { toCharacterDto } from "../server/utils/character-dto";

assert.deepEqual(readKnowledgeAssistantSettingsPatch({}), { config: {}, apiKey: "", clearApiKey: false });
const patch = readKnowledgeAssistantSettingsPatch({
  knowledgeAssistantEnabled: true, knowledgeAssistantModel: " model ", knowledgeAssistantApiKey: " key ",
  knowledgeAssistantApiBaseUrl: "https://api.example.com/v1/", knowledgeAssistantTemperature: 0.1,
  knowledgeAssistantMaxInputTokens: 12288, knowledgeAssistantMaxOutputTokens: 2048,
});
assert.equal(patch.apiKey, "key");
assert.equal(patch.config.knowledgeAssistantModel, "model");
assert.equal(patch.config.knowledgeAssistantApiBaseUrl, "https://api.example.com/v1");
assert.equal(patch.config.knowledgeAssistantApiKey, undefined);
for (const body of [
  { knowledgeAssistantEnabled: "true" }, { clearKnowledgeAssistantApiKey: 1 },
  { knowledgeAssistantModel: "x".repeat(121) }, { knowledgeAssistantApiKey: "x".repeat(8193) },
  { knowledgeAssistantApiBaseUrl: "https://10.0.0.1/v1" }, { knowledgeAssistantTemperature: 2.1 },
  { knowledgeAssistantMaxInputTokens: 4095 }, { knowledgeAssistantMaxInputTokens: 4096.5 },
  { knowledgeAssistantMaxOutputTokens: 511 }, { knowledgeAssistantMaxOutputTokens: "2048" },
]) assert.throws(() => readKnowledgeAssistantSettingsPatch(body));
assert.throws(() => validateKnowledgeAssistantEnabledConfig({ knowledgeAssistantEnabled: true }), /模型名称/);
assert.throws(() => validateKnowledgeAssistantEnabledConfig({
  knowledgeAssistantEnabled: true, knowledgeAssistantModel: "model",
  chatApiKeyEncrypted: "v1.chat", memoryAssistantApiKeyEncrypted: "v1.memory",
}), /专用 API Key/);
assert.doesNotThrow(() => validateKnowledgeAssistantEnabledConfig({ knowledgeAssistantEnabled: false }));
const encrypted = await encryptApiKey("knowledge-only-test-key");
assert.equal(await resolveCharacterKnowledgeAssistantApiKey({ knowledgeAssistantApiKeyEncrypted: encrypted }), "knowledge-only-test-key");
assert.equal(await resolveCharacterKnowledgeAssistantApiKey({ chatApiKeyEncrypted: encrypted, memoryAssistantApiKeyEncrypted: encrypted }), "");
assert.equal(isKnowledgeAssistantApiKeySaved({ knowledgeAssistantApiKeyEncrypted: "plaintext" }), false);
assert.equal(isKnowledgeAssistantApiKeySaved({ knowledgeAssistantApiKeyEncrypted: encrypted }), true);
validateKnowledgeAssistantEnabledConfig({ ...patch.config, knowledgeAssistantApiKeyEncrypted: encrypted });
const record = { id: "test", name: "角色", avatar: null, basePrompt: "", styleExamples: "", userAddress: "", status: "ACTIVE" as const, modelConfig: {}, updatedAt: new Date(), memorySetting: null, channelBindings: [], memoryScopes: [] };
const defaults = toCharacterDto(record);
assert.equal(defaults.knowledgeAssistantEnabled, false);
assert.equal(defaults.knowledgeAssistantConfigured, false);
assert.equal(defaults.knowledgeAssistantTemperature, 0.1);
assert.equal(defaults.knowledgeAssistantMaxInputTokens, 12288);
assert.equal(defaults.knowledgeAssistantMaxOutputTokens, 2048);
const configured = toCharacterDto({ ...record, modelConfig: { ...patch.config, knowledgeAssistantApiKeyEncrypted: encrypted } });
assert.equal(configured.knowledgeAssistantConfigured, true);
assert.equal(configured.knowledgeAssistantApiKeyConfigured, true);
assert.equal(Reflect.get(configured, "knowledgeAssistantApiKeyEncrypted"), undefined);
assert.equal(Reflect.get(configured, "knowledgeAssistantApiKey"), undefined);
console.log("Knowledge assistant config tests passed: validation, defaults, independent encrypted credentials and safe DTO.");
