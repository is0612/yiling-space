import assert from "node:assert/strict";
import {
  readSocialRelationshipAssessmentAssistantSettingsPatch,
  validateSocialRelationshipAssessmentAssistantEnabledConfig,
} from "../server/utils/social-relationship-assessment-config";
import {
  encryptApiKey,
  isSocialRelationshipAssessmentAssistantApiKeySaved,
  resolveCharacterSocialRelationshipAssessmentAssistantApiKey,
} from "../server/utils/credential-encryption";
import { toCharacterDto } from "../server/utils/character-dto";

assert.deepEqual(readSocialRelationshipAssessmentAssistantSettingsPatch({}), { config: {}, apiKey: "", clearApiKey: false });
const patch = readSocialRelationshipAssessmentAssistantSettingsPatch({
  socialRelationshipAssessmentAssistantEnabled: true,
  socialRelationshipAssessmentAssistantModel: " assessment-model ",
  socialRelationshipAssessmentAssistantApiBaseUrl: "https://api.example.com/v1/",
  socialRelationshipAssessmentAssistantApiKey: " assessment-secret ",
  socialRelationshipAssessmentAssistantTemperature: 0.2,
  socialRelationshipAssessmentAssistantMaxInputTokens: 16384,
  socialRelationshipAssessmentAssistantMaxOutputTokens: 2048,
});
assert.equal(patch.apiKey, "assessment-secret");
assert.equal(patch.config.socialRelationshipAssessmentAssistantModel, "assessment-model");
assert.equal(patch.config.socialRelationshipAssessmentAssistantApiBaseUrl, "https://api.example.com/v1");
assert.equal(patch.config.socialRelationshipAssessmentAssistantApiKey, undefined);

for (const body of [
  { socialRelationshipAssessmentAssistantEnabled: "true" },
  { socialRelationshipAssessmentAssistantModel: "x".repeat(121) },
  { socialRelationshipAssessmentAssistantApiBaseUrl: "https://10.0.0.1/v1" },
  { socialRelationshipAssessmentAssistantApiKey: "x".repeat(8193) },
  { socialRelationshipAssessmentAssistantTemperature: Number.NaN },
  { socialRelationshipAssessmentAssistantTemperature: 2.1 },
  { socialRelationshipAssessmentAssistantMaxInputTokens: 4095 },
  { socialRelationshipAssessmentAssistantMaxInputTokens: 4096.5 },
  { socialRelationshipAssessmentAssistantMaxOutputTokens: 511 },
  { socialRelationshipAssessmentAssistantMaxOutputTokens: 32769 },
  { clearSocialRelationshipAssessmentAssistantApiKey: 1 },
]) assert.throws(() => readSocialRelationshipAssessmentAssistantSettingsPatch(body));

/**
 * 2026-11-12：关系评估助手默认开启，模型名 / 地址 / Key 都可留空沿用对话模型。
 * 「没填模型、没填地址、没填 Key」都不再拦截 —— 用户想换一家时才会填。
 */
assert.doesNotThrow(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({ socialRelationshipAssessmentAssistantEnabled: true }));
assert.doesNotThrow(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({}));
assert.doesNotThrow(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({ socialRelationshipAssessmentAssistantEnabled: false }));
assert.doesNotThrow(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({
  socialRelationshipAssessmentAssistantEnabled: true,
  socialRelationshipAssessmentAssistantModel: "model",
  socialRelationshipAssessmentAssistantApiBaseUrl: "",
}));
assert.throws(
  () => validateSocialRelationshipAssessmentAssistantEnabledConfig({
    socialRelationshipAssessmentAssistantEnabled: true,
    socialRelationshipAssessmentAssistantApiBaseUrl: "https://10.0.0.1/v1",
  }),
  /私有网络|本机地址/,
);

const encrypted = await encryptApiKey("assessment-only-test-key");
assert.equal(await resolveCharacterSocialRelationshipAssessmentAssistantApiKey({ socialRelationshipAssessmentAssistantApiKeyEncrypted: encrypted }), "assessment-only-test-key");
assert.equal(await resolveCharacterSocialRelationshipAssessmentAssistantApiKey({ socialRelationshipAssessmentAssistantApiKey: "plain-key" }), "plain-key");
assert.equal(await resolveCharacterSocialRelationshipAssessmentAssistantApiKey({
  chatApiKey: "chat-key",
  memoryAssistantApiKey: "memory-key",
  contextAssistantApiKey: "context-key",
  knowledgeAssistantApiKey: "knowledge-key",
}), "", "只读自己那把，继承由 assistant-inheritance 决定");
assert.equal(isSocialRelationshipAssessmentAssistantApiKeySaved({ socialRelationshipAssessmentAssistantApiKeyEncrypted: "plaintext" }), false);
assert.equal(isSocialRelationshipAssessmentAssistantApiKeySaved({ socialRelationshipAssessmentAssistantApiKeyEncrypted: encrypted }), true);
assert.equal(isSocialRelationshipAssessmentAssistantApiKeySaved({ socialRelationshipAssessmentAssistantApiKey: "plain-key" }), true);

const character = {
  id: "test", name: "测试角色", avatar: null, basePrompt: "", styleExamples: "", userAddress: "",
  status: "ACTIVE" as const, modelConfig: {}, updatedAt: new Date(), memorySetting: null,
  channelBindings: [], memoryScopes: [],
};
const dto = toCharacterDto(character);
assert.equal(dto.socialRelationshipAssessmentAssistantEnabled, true, "关系评估助手默认开启");
assert.equal(dto.socialRelationshipAssessmentAssistantConfigured, false);
assert.equal(dto.socialRelationshipAssessmentAssistantApiKeyConfigured, false);
assert.equal(dto.socialRelationshipAssessmentAssistantTemperature, 0.1);
assert.equal(dto.socialRelationshipAssessmentAssistantMaxInputTokens, 16384);
assert.equal(dto.socialRelationshipAssessmentAssistantMaxOutputTokens, 8192);

const configuredDto = toCharacterDto({
  ...character,
  modelConfig: {
    socialRelationshipAssessmentAssistantModel: "assessment-model",
    socialRelationshipAssessmentAssistantApiBaseUrl: "https://api.example.com/v1",
    socialRelationshipAssessmentAssistantApiKey: "plain-key",
  },
});
assert.equal(configuredDto.socialRelationshipAssessmentAssistantConfigured, true);
assert.equal(configuredDto.socialRelationshipAssessmentAssistantApiKey, "plain-key", "明文 Key 应回显");
assert.equal("socialRelationshipAssessmentAssistantApiKeyEncrypted" in configuredDto, false);

/** 只填了对话模型的 Key：关系评估也算就绪（留空即继承）。 */
const inheritedDto = toCharacterDto({ ...character, modelConfig: { chatApiKey: "chat-key" } });
assert.equal(inheritedDto.socialRelationshipAssessmentAssistantConfigured, true);
assert.equal(inheritedDto.socialRelationshipAssessmentAssistantApiKey, "");

console.log("PASS: social relationship assessment assistant config, inherit-by-default, plaintext credentials and DTO echo");
