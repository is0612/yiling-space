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

/**
 * 2026-11-12：语境助手默认开启，模型名、地址、Key 都能留空沿用对话模型。
 * 所以「没填模型 / 没填 Key」不再报错 —— 那正是「同一个 Key 填五遍」的来源；
 * 只剩地址合法性还能拦人。
 */
assert.doesNotThrow(() => validateContextAssistantEnabledConfig({ contextAssistantEnabled: true }));
assert.doesNotThrow(() => validateContextAssistantEnabledConfig({}));
assert.doesNotThrow(() => validateContextAssistantEnabledConfig({ contextAssistantEnabled: false }));
assert.doesNotThrow(() => validateContextAssistantEnabledConfig({ contextAssistantEnabled: true, contextAssistantModel: "model" }));
assert.throws(
  () => validateContextAssistantEnabledConfig({ contextAssistantEnabled: true, contextAssistantApiBaseUrl: "https://10.0.0.1/v1" }),
  /私有网络|本机地址/,
);

/** Key 解析：明文优先，旧密文仍可读；**不**回落到聊天 Key（继承在 assistant-inheritance 里做）。 */
const encrypted = await encryptApiKey("context-only-test-key");
assert.equal(await resolveCharacterContextAssistantApiKey({ contextAssistantApiKeyEncrypted: encrypted }), "context-only-test-key");
assert.equal(await resolveCharacterContextAssistantApiKey({ contextAssistantApiKey: "plain-key" }), "plain-key");
assert.equal(
  await resolveCharacterContextAssistantApiKey({ contextAssistantApiKey: "plain-key", contextAssistantApiKeyEncrypted: encrypted }),
  "plain-key",
  "明文与密文同时存在时应以明文为准",
);
assert.equal(await resolveCharacterContextAssistantApiKey({ chatApiKey: "chat-key", memoryAssistantApiKey: "memory-key" }), "");
assert.equal(isContextAssistantApiKeySaved({ contextAssistantApiKeyEncrypted: "plaintext" }), false);
assert.equal(isContextAssistantApiKeySaved({ contextAssistantApiKeyEncrypted: encrypted }), true);
assert.equal(isContextAssistantApiKeySaved({ contextAssistantApiKey: "plain-key" }), true);
validateContextAssistantEnabledConfig({ ...patch.config, contextAssistantApiKey: "key" });

const record = { id: "test", name: "角色", avatar: null, basePrompt: "", styleExamples: "", userAddress: "", status: "ACTIVE", modelConfig: {}, updatedAt: new Date(), memorySetting: null, channelBindings: [], memoryScopes: [] };
const defaults = toCharacterDto(record);
assert.equal(defaults.contextAssistantEnabled, true, "语境助手默认开启");
assert.equal(defaults.contextAssistantConfigured, false, "既没有对话 Key 也没有自己的 Key 时不算就绪");
assert.equal(defaults.contextAssistantTemperature, 0.1);
assert.equal(defaults.contextAssistantMaxInputTokens, 16384);
assert.equal(defaults.contextAssistantMaxOutputTokens, 2048);

const configured = toCharacterDto({ ...record, modelConfig: { ...patch.config, contextAssistantApiKey: "plain-key" } });
assert.equal(configured.contextAssistantConfigured, true);
assert.equal(configured.contextAssistantApiKeyConfigured, true);
assert.equal(configured.contextAssistantApiKey, "plain-key", "明文 Key 应回显给页面");
assert.equal(Reflect.get(configured, "contextAssistantApiKeyEncrypted"), undefined);

/** 继承：只配对话模型的 Key，语境助手也算就绪 —— 这正是「不用再填一遍」的证明。 */
const inherited = toCharacterDto({ ...record, modelConfig: { chatApiKey: "chat-key" } });
assert.equal(inherited.contextAssistantConfigured, true);
assert.equal(inherited.contextAssistantApiKey, "", "继承时不该把对话 Key 抄进语境助手的字段");

console.log("Context assistant configuration tests passed: validation, inherit-by-default, plaintext credentials and DTO echo.");
