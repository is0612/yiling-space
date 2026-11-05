import assert from "node:assert/strict";
import { readContextAssistantSettingsPatch, validateContextAssistantEnabledConfig } from "../server/utils/context-assistant-config";
import { encryptApiKey, isContextAssistantApiKeySaved, resolveCharacterContextAssistantApiKey } from "../server/utils/credential-encryption";
import { toCharacterDto } from "../server/utils/character-dto";

assert.deepEqual(readContextAssistantSettingsPatch({}), { config: {}, apiKey: "", clearApiKey: false });
const patch = readContextAssistantSettingsPatch({ contextAssistantEnabled: true, contextAssistantModel: " model ", contextAssistantApiKey: " key ", contextAssistantApiBaseUrl: "https://api.example.com/v1/", contextAssistantTemperature: 0.1, contextAssistantMaxInputTokens: 16384, contextAssistantMaxOutputTokens: 2048 });
assert.equal(patch.apiKey, "key");
assert.equal(patch.config.contextAssistantModel, "model");
assert.equal(patch.config.contextAssistantApiBaseUrl, "https://api.example.com/v1");
assert.equal(patch.config.contextAssistantApiKey, undefined);
for (const body of [
  { contextAssistantEnabled: "true" }, { clearContextAssistantApiKey: 1 }, { contextAssistantModel: "x".repeat(121) },
  { contextAssistantApiKey: "x".repeat(8193) }, { contextAssistantApiBaseUrl: "https://10.0.0.1/v1" },
  { contextAssistantTemperature: null }, { contextAssistantTemperature: 2.1 }, { contextAssistantTemperature: Number.NaN },
  { contextAssistantMaxInputTokens: 4095 }, { contextAssistantMaxInputTokens: 32769 }, { contextAssistantMaxInputTokens: 4096.5 },
  { contextAssistantMaxOutputTokens: 511 }, { contextAssistantMaxOutputTokens: 8193 }, { contextAssistantMaxOutputTokens: "2048" },
]) assert.throws(() => readContextAssistantSettingsPatch(body));
for (const [contextAssistantMaxInputTokens, contextAssistantMaxOutputTokens] of [[4096, 512], [32768, 8192]]) {
  assert.doesNotThrow(() => readContextAssistantSettingsPatch({ contextAssistantMaxInputTokens, contextAssistantMaxOutputTokens }));
}
assert.throws(() => validateContextAssistantEnabledConfig({ contextAssistantEnabled: true }), /模型名称/);
assert.throws(() => validateContextAssistantEnabledConfig({ contextAssistantEnabled: true, contextAssistantModel: "model", chatApiKeyEncrypted: "v1.chat", memoryAssistantApiKeyEncrypted: "v1.memory" }), /专用 API Key/);
assert.doesNotThrow(() => validateContextAssistantEnabledConfig({ contextAssistantEnabled: false }));
const encrypted = await encryptApiKey("context-only-test-key");
assert.equal(await resolveCharacterContextAssistantApiKey({ contextAssistantApiKeyEncrypted: encrypted }), "context-only-test-key");
assert.equal(await resolveCharacterContextAssistantApiKey({ chatApiKeyEncrypted: encrypted, memoryAssistantApiKeyEncrypted: encrypted }), "");
assert.equal(isContextAssistantApiKeySaved({ contextAssistantApiKeyEncrypted: "plaintext" }), false);
assert.equal(isContextAssistantApiKeySaved({ contextAssistantApiKeyEncrypted: encrypted }), true);
validateContextAssistantEnabledConfig({ ...patch.config, contextAssistantApiKeyEncrypted: encrypted });
const record = { id: "test", name: "角色", avatar: null, basePrompt: "", styleExamples: "", userAddress: "", status: "ACTIVE", modelConfig: {}, updatedAt: new Date(), memorySetting: null, channelBindings: [], memoryScopes: [] };
const defaults = toCharacterDto(record);
assert.equal(defaults.contextAssistantEnabled, false);
assert.equal(defaults.contextAssistantConfigured, false);
assert.equal(defaults.contextAssistantTemperature, 0.1);
assert.equal(defaults.contextAssistantMaxInputTokens, 16384);
assert.equal(defaults.contextAssistantMaxOutputTokens, 2048);
const configured = toCharacterDto({ ...record, modelConfig: { ...patch.config, contextAssistantApiKeyEncrypted: encrypted } });
assert.equal(configured.contextAssistantConfigured, true);
assert.equal(configured.contextAssistantApiKeyConfigured, true);
assert.equal(Reflect.get(configured, "contextAssistantApiKeyEncrypted"), undefined);
assert.equal(Reflect.get(configured, "contextAssistantApiKey"), undefined);
console.log("Context assistant configuration tests passed: validation, defaults, independent encrypted credentials and safe DTO.");
