/**
 * Character 响应契约回归。
 *
 * 守四件事：
 * 1. `toCharacterDto` 的输出字段集 = `shared/types/character.ts` 的 `Character`；
 * 2. 不泄漏内部字段：`modelConfig`（原始大 JSON）、`basePrompt`、`ownerId`、`originCharacterId`；
 * 3. `asrProvider` 必须从 modelConfig 读出来 —— 这是修过的一个真 bug：patch 一直能写，
 *    DTO 一直不回，页面回显永远退回「自动」；
 * 4. 两个嵌套设置（proactive / groupInitiative）未配置时给默认值，不是 undefined。
 *
 * 所有接口都走同一个 include + 同一个整形函数，所以只测这一处就覆盖了
 * 列表 / 详情 / 创建 / 修改 / 导入五条路径。
 */
import assert from "node:assert/strict";
import { toCharacterDto } from "../server/utils/character-dto";
import type { Character } from "../shared/types/character";

const at = new Date("2026-11-22T00:00:00.000Z");

const record = {
  id: "11111111-1111-4111-8111-111111111111",
  originCharacterId: null,
  name: "测试角色",
  avatar: "测",
  basePrompt: "base-prompt-marker",
  styleExamples: "示例台词",
  userAddress: "你",
  status: "ACTIVE",
  // modelConfig 是内部大 JSON：其中 private-marker 字段不该出现在响应里。
  modelConfig: {
    chatModel: "deepseek-chat",
    chatTemperature: 1.2,
    chatMaxTokens: 4096,
    asrModel: "asr-1.0",
    asrProvider: "minimax",
    ttsProvider: "breeze",
    voiceEnabled: true,
    emojiEnabled: true,
    privateMarker: "should-not-leak",
    proactive: { enabled: true, dailyMax: 2, minGapMinutes: 90, quietStart: "23:00", quietEnd: "08:00", userActiveMinutes: 30, minConfidence: 0.7 },
    groupInitiative: { enabled: true, idleMinutes: 45, dailyMax: 3, minGapMinutes: 120, quietStart: "00:00", quietEnd: "07:00" },
  },
  updatedAt: at,
  memorySetting: {
    snapshotIntervalDays: 3,
    pendingSnapshotIntervalDays: null,
    timezone: "Asia/Shanghai",
    nextSnapshotAt: at,
    autoSnapshotEnabled: true,
  },
  channelBindings: [{ connection: { displayName: "主连接" } }],
  memoryScopes: [
    { _count: { memoryItems: 12 }, snapshots: [{ createdAt: at }] },
  ],
};

const dto = toCharacterDto(record) as Character & Record<string, unknown>;

// 1) 契约里的关键字段都在（不逐字段列全 90 个，但覆盖每一类）
for (const field of [
  "id", "originId", "name", "alias", "description", "avatar", "avatarTone", "status", "channels",
  "intervalDays", "pendingIntervalDays", "nextSnapshot", "memoryCount", "latestSnapshot", "personality",
  "examples", "userAddress", "updatedAt",
  "chatModel", "chatTemperature", "chatMaxTokens", "chatThinking", "chatApiBaseUrl", "chatApiKey", "chatApiKeyConfigured", "chatApiKeySource",
  "memoryAssistantEnabled", "memoryAssistantConfigured",
  "contextAssistantEnabled", "contextAssistantConfigured",
  "knowledgeAutoCollectEnabled", "knowledgeCollectScope",
  "socialRelationshipAssessmentAssistantEnabled",
  "dailyTokenLimit", "memoryTokenBudget", "snapshotTokenBudget", "memoryItemLimit", "recentMessageLimit", "eventRecentDays",
  "emojiEnabled", "emojiWindowMinutes", "emojiPerWindow", "imageUnderstanding", "stickerAutoCollect", "catchphraseAutoMine",
  "voiceEnabled", "voiceTranscribe", "voiceChance", "voiceCooldownMinutes", "ttsModel", "ttsVoice", "asrModel", "asrProvider",
  "visionModel", "proactive", "groupInitiative",
]) {
  assert.ok(field in dto, `Character 缺少契约字段 ${field}`);
}

// 2) 内部字段不能漏出去
for (const leaked of ["modelConfig", "basePrompt", "ownerId", "originCharacterId", "memorySetting", "channelBindings", "memoryScopes"]) {
  assert.ok(!(leaked in dto), `Character 不应带内部字段 ${leaked}`);
}
assert.ok(!JSON.stringify(dto).includes("should-not-leak"), "modelConfig 里的私有键不能出现在响应里");
// `basePrompt` 的**内容**是有意通过 `personality` 暴露的（前端字段名不同），
// 这里断的是映射关系，不是「内容不能出现」。
assert.equal(dto.personality, "base-prompt-marker", "personality 应映射自 basePrompt");
assert.equal(dto.examples, "示例台词", "examples 应映射自 styleExamples");

// 3) asrProvider 必须读出来（修过的真 bug，防回退）
assert.equal(dto.asrProvider, "minimax", "asrProvider 必须从 modelConfig 读出来，否则页面回显会退回「自动」");
assert.equal(toCharacterDto({ ...record, modelConfig: {} }).asrProvider, "", "没配时是空串，不是 undefined");

// 4) 两个设置未配置时给默认值
const bare = toCharacterDto({ ...record, modelConfig: {} });
assert.equal(typeof bare.proactive.enabled, "boolean", "proactive 未配置时也要有默认值");
assert.equal(bare.proactive.enabled, false, "主动找话默认关闭");
assert.equal(typeof bare.groupInitiative.enabled, "boolean");
assert.equal(bare.groupInitiative.enabled, false, "群内主动默认关闭");

// 状态与色调都在契约枚举内
assert.ok(["运行中", "已暂停", "未连接"].includes(dto.status));
assert.ok(["purple", "peach", "mint", "blue"].includes(dto.avatarTone));
// memoryCount 来自 memoryScopes 聚合，不是模型上的计数列
assert.equal(dto.memoryCount, 12);

// 明文 Key 字段仍按既有设计回传（本地应用、页面密码框回显）；
// 这条断言是"记录下来"，不是"认可"——若将来改成脱敏，这里会失败并提醒同步改页面。
assert.equal(typeof dto.chatApiKey, "string");

console.log("Character contract: 字段集、内部字段隔离、asrProvider 回显、proactive/groupInitiative 默认值均符合 shared/types/character.ts。");
