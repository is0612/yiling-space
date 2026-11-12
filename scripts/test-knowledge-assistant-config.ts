import assert from "node:assert/strict";
import { readKnowledgeAssistantSettingsPatch, validateKnowledgeAssistantEnabledConfig } from "../server/utils/knowledge-assistant-config";
import { encryptApiKey, isKnowledgeAssistantApiKeySaved, resolveCharacterKnowledgeAssistantApiKey } from "../server/utils/credential-encryption";
import { toCharacterDto } from "../server/utils/character-dto";

assert.deepEqual(readKnowledgeAssistantSettingsPatch({}), { config: {}, apiKey: "", clearApiKey: false });
const patch = readKnowledgeAssistantSettingsPatch({
  knowledgeAutoCollectEnabled: true, knowledgeAssistantEnabled: true, knowledgeAssistantModel: " model ", knowledgeAssistantApiKey: " key ",
  knowledgeAssistantApiBaseUrl: "https://api.example.com/v1/", knowledgeAssistantTemperature: 0.1,
  knowledgeAssistantMaxInputTokens: 12288, knowledgeAssistantMaxOutputTokens: 2048,
});
assert.equal(patch.apiKey, "key");
assert.equal(patch.config.knowledgeAutoCollectEnabled, true);
assert.equal(patch.config.knowledgeAssistantModel, "model");
assert.equal(patch.config.knowledgeAssistantApiBaseUrl, "https://api.example.com/v1");
assert.equal(patch.config.knowledgeAssistantApiKey, undefined);
for (const body of [
  { knowledgeAutoCollectEnabled: "true" }, { knowledgeAssistantEnabled: "true" }, { clearKnowledgeAssistantApiKey: 1 },
  { knowledgeAssistantModel: "x".repeat(121) }, { knowledgeAssistantApiKey: "x".repeat(8193) },
  { knowledgeAssistantApiBaseUrl: "https://10.0.0.1/v1" }, { knowledgeAssistantTemperature: 2.1 },
  { knowledgeAssistantMaxInputTokens: 4095 }, { knowledgeAssistantMaxInputTokens: 4096.5 },
  { knowledgeAssistantMaxOutputTokens: 511 }, { knowledgeAssistantMaxOutputTokens: "2048" },
]) assert.throws(() => readKnowledgeAssistantSettingsPatch(body));

/**
 * 2026-11-12：知识处理助手默认开启，模型名 / 地址 / Key 都能留空沿用对话模型。
 * 「没填模型或 Key」不再拦截，只剩地址合法性。
 */
assert.doesNotThrow(() => validateKnowledgeAssistantEnabledConfig({ knowledgeAssistantEnabled: true }));
assert.doesNotThrow(() => validateKnowledgeAssistantEnabledConfig({}));
assert.doesNotThrow(() => validateKnowledgeAssistantEnabledConfig({ knowledgeAssistantEnabled: false }));
assert.doesNotThrow(() => validateKnowledgeAssistantEnabledConfig({ knowledgeAssistantEnabled: true, knowledgeAssistantModel: "model" }));
assert.throws(
  () => validateKnowledgeAssistantEnabledConfig({ knowledgeAssistantEnabled: true, knowledgeAssistantApiBaseUrl: "https://10.0.0.1/v1" }),
  /私有网络|本机地址/,
);

const encrypted = await encryptApiKey("knowledge-only-test-key");
assert.equal(await resolveCharacterKnowledgeAssistantApiKey({ knowledgeAssistantApiKeyEncrypted: encrypted }), "knowledge-only-test-key");
assert.equal(await resolveCharacterKnowledgeAssistantApiKey({ knowledgeAssistantApiKey: "plain-key" }), "plain-key");
assert.equal(await resolveCharacterKnowledgeAssistantApiKey({ chatApiKey: "chat-key", memoryAssistantApiKey: "memory-key" }), "");
assert.equal(isKnowledgeAssistantApiKeySaved({ knowledgeAssistantApiKeyEncrypted: "plaintext" }), false);
assert.equal(isKnowledgeAssistantApiKeySaved({ knowledgeAssistantApiKeyEncrypted: encrypted }), true);
assert.equal(isKnowledgeAssistantApiKeySaved({ knowledgeAssistantApiKey: "plain-key" }), true);
validateKnowledgeAssistantEnabledConfig({ ...patch.config, knowledgeAssistantApiKey: "key" });

const record = { id: "test", name: "角色", avatar: null, basePrompt: "", styleExamples: "", userAddress: "", status: "ACTIVE" as const, modelConfig: {}, updatedAt: new Date(), memorySetting: null, channelBindings: [], memoryScopes: [] };
const defaults = toCharacterDto(record);
assert.equal(defaults.knowledgeAutoCollectEnabled, false);
assert.equal(defaults.knowledgeAssistantEnabled, true, "知识处理助手默认开启");
assert.equal(defaults.knowledgeAssistantConfigured, false);
assert.equal(defaults.knowledgeAssistantTemperature, 0.1);
assert.equal(defaults.knowledgeAssistantMaxInputTokens, 12288);
assert.equal(defaults.knowledgeAssistantMaxOutputTokens, 4096);
assert.equal(toCharacterDto({ ...record, modelConfig: { knowledgeAssistantMaxOutputTokens: 2048, knowledgeAssistantTemperature: 0 } }).knowledgeAssistantMaxOutputTokens, 2048, "Saved explicit values must remain unchanged");

const configured = toCharacterDto({ ...record, modelConfig: { ...patch.config, knowledgeAssistantApiKey: "plain-key" } });
assert.equal(configured.knowledgeAssistantConfigured, true);
assert.equal(configured.knowledgeAutoCollectEnabled, true);
assert.equal(configured.knowledgeAssistantApiKeyConfigured, true);
assert.equal(configured.knowledgeAssistantApiKey, "plain-key", "明文 Key 应回显给页面");
assert.equal(Reflect.get(configured, "knowledgeAssistantApiKeyEncrypted"), undefined);

/** 继承：只配了对话模型的 Key，知识助手也算就绪。 */
const inherited = toCharacterDto({ ...record, modelConfig: { chatApiKey: "chat-key" } });
assert.equal(inherited.knowledgeAssistantConfigured, true);
assert.equal(inherited.knowledgeAssistantApiKey, "");

console.log("Knowledge assistant config tests passed: validation, inherit-by-default, plaintext credentials and DTO echo.");
