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
  { clearSocialRelationshipAssessmentAssistantApiKey: 1 },
]) assert.throws(() => readSocialRelationshipAssessmentAssistantSettingsPatch(body));

assert.throws(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({ socialRelationshipAssessmentAssistantEnabled: true }), /模型名称/);
assert.throws(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({ ...patch.config, socialRelationshipAssessmentAssistantApiBaseUrl: "" }), /独立 API 地址/);
assert.throws(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({
  socialRelationshipAssessmentAssistantEnabled: true,
  socialRelationshipAssessmentAssistantModel: "model",
  socialRelationshipAssessmentAssistantApiBaseUrl: "https://api.example.com/v1",
  chatApiKeyEncrypted: "v1.chat",
  memoryAssistantApiKeyEncrypted: "v1.memory",
  contextAssistantApiKeyEncrypted: "v1.context",
  knowledgeAssistantApiKeyEncrypted: "v1.knowledge",
}), /专用 API Key/);
assert.doesNotThrow(() => validateSocialRelationshipAssessmentAssistantEnabledConfig({ socialRelationshipAssessmentAssistantEnabled: false }));

const encrypted = await encryptApiKey("assessment-only-test-key");
assert.equal(await resolveCharacterSocialRelationshipAssessmentAssistantApiKey({ socialRelationshipAssessmentAssistantApiKeyEncrypted: encrypted }), "assessment-only-test-key");
assert.equal(await resolveCharacterSocialRelationshipAssessmentAssistantApiKey({
  chatApiKeyEncrypted: encrypted,
  memoryAssistantApiKeyEncrypted: encrypted,
  contextAssistantApiKeyEncrypted: encrypted,
  knowledgeAssistantApiKeyEncrypted: encrypted,
}), "");
assert.equal(isSocialRelationshipAssessmentAssistantApiKeySaved({ socialRelationshipAssessmentAssistantApiKeyEncrypted: "plaintext" }), false);
assert.equal(isSocialRelationshipAssessmentAssistantApiKeySaved({ socialRelationshipAssessmentAssistantApiKeyEncrypted: encrypted }), true);

const character = {
  id: "test", name: "测试角色", avatar: null, basePrompt: "", styleExamples: "", userAddress: "",
  status: "ACTIVE" as const, modelConfig: {}, updatedAt: new Date(), memorySetting: null,
  channelBindings: [], memoryScopes: [],
};
const dto = toCharacterDto(character);
assert.equal(dto.socialRelationshipAssessmentAssistantEnabled, false);
assert.equal(dto.socialRelationshipAssessmentAssistantConfigured, false);
assert.equal(dto.socialRelationshipAssessmentAssistantApiKeyConfigured, false);
assert.equal(dto.socialRelationshipAssessmentAssistantTemperature, 0.1);
assert.equal(dto.socialRelationshipAssessmentAssistantMaxInputTokens, 16384);
assert.equal(dto.socialRelationshipAssessmentAssistantMaxOutputTokens, 2048);

const configuredDto = toCharacterDto({
  ...character,
  modelConfig: {
    socialRelationshipAssessmentAssistantEnabled: true,
    socialRelationshipAssessmentAssistantModel: "assessment-model",
    socialRelationshipAssessmentAssistantApiBaseUrl: "https://api.example.com/v1",
    socialRelationshipAssessmentAssistantApiKeyEncrypted: encrypted,
  },
});
assert.equal(configuredDto.socialRelationshipAssessmentAssistantConfigured, true);
assert.equal("socialRelationshipAssessmentAssistantApiKey" in configuredDto, false);
assert.equal("socialRelationshipAssessmentAssistantApiKeyEncrypted" in configuredDto, false);

console.log("PASS: social relationship assessment assistant config, credentials isolation, and DTO redaction");
