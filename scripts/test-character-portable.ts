import "dotenv/config";
import assert from "node:assert/strict";
import {
  CHARACTER_BUNDLE_FORMAT,
  CHARACTER_BUNDLE_LIMITS,
  buildCharacterBundle,
  characterBundleFileName,
  computeImportedCharacterName,
  parseCharacterBundle,
  stripPortableModelConfig,
} from "../server/utils/character-portable";

/**
 * 角色卡格式的纯逻辑测试：脱敏、构建、校验、名称去重、文件名。
 * 不连数据库 —— 落库与「别人的私人记忆不进包」在 test-character-portable-db.ts 里测。
 */

// ── 1. 模型参数脱敏 ─────────────────────────────────────────
const rawConfig = {
  alias: "小鱼",
  description: "一条鱼",
  avatarTone: "purple",
  chatModel: "deepseek-chat",
  chatTemperature: 0.8,
  chatMaxTokens: 2048,
  chatApiBaseUrl: "https://api.deepseek.com/v1",
  memoryTokenBudget: 4000,
  snapshotTokenBudget: 1200,
  recentMessageLimit: 30,
  // 下面这些都是不该进包的
  chatApiKeyEncrypted: "v1.aaa.bbb.ccc",
  voiceApiKeyEncrypted: "v1.ddd.eee.fff",
  chatApiKey: "sk-plain",
  someToken: "abc",
  proactive: { enabled: true, targetQq: "12345" },
  emojiEnabled: true,
};

const stripped = stripPortableModelConfig(rawConfig);
assert.equal(stripped.chatApiKeyEncrypted, undefined, "加密的聊天 Key 不能进包");
assert.equal(stripped.voiceApiKeyEncrypted, undefined, "加密的语音 Key 不能进包");
assert.equal("chatApiKey" in stripped, false, "明文 Key 字段不能进包");
assert.equal("someToken" in stripped, false, "白名单之外的字段一律不带走");
assert.equal("proactive" in stripped, false, "依赖本机网关的行为设置不带走");
assert.equal("emojiEnabled" in stripped, false, "行为开关不带走");
assert.equal(stripped.chatModel, "deepseek-chat", "模型名保留");
assert.equal(stripped.memoryTokenBudget, 4000, "记忆预算保留");

// 伪装成普通字段的密文也要挡住
assert.equal(
  stripPortableModelConfig({ chatModel: "v1.aaa.bbb.ccc" }).chatModel,
  undefined,
  "以 v1. 开头的密文即使挂在对的字段上也不能带走",
);

// ── 2. 构建导出包 ───────────────────────────────────────────
const built = buildCharacterBundle({
  character: {
    name: "小鱼",
    basePrompt: "你是小鱼，说话很短。",
    styleExamples: "主人：在吗\n小鱼：在。",
    userAddress: "主人",
    modelConfig: rawConfig,
  },
  memorySetting: { snapshotIntervalDays: 8, timezone: "Asia/Shanghai", autoSnapshotEnabled: true },
  scopes: [
    {
      scopeType: "CHARACTER_GLOBAL",
      memoryItems: [
        { category: "FACT", content: "主人住在杭州", confidence: 0.9, importance: 0.7, validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, dedupeKey: "d1" },
      ],
      events: [
        {
          dayKey: "2026-10-30",
          state: "FINAL",
          occurredAt: new Date("2026-10-30T12:00:00Z"),
          timeOfDay: "下午",
          precision: "part_of_day",
          place: "海边",
          title: "去海边游泳",
          detail: "和小明一起",
          keywords: ["海边"],
          participants: ["小明"],
          confidence: 0.8,
        },
      ],
      snapshots: [
        {
          kind: "AUTOMATIC",
          periodStart: new Date("2026-10-01T00:00:00Z"),
          periodEnd: new Date("2026-10-08T00:00:00Z"),
          summary: "这一段她学会了游泳。",
          structuredContent: { highlights: ["游泳"] },
          generatedAt: new Date("2026-10-08T01:00:00Z"),
          createdAt: new Date("2026-10-08T01:00:00Z"),
        },
      ],
    },
    {
      scopeType: "USER_PRIVATE",
      userId: "u1",
      memoryItems: [
        { category: "PREFERENCE", content: "主人喜欢喝冰美式", confidence: 1, importance: 0.5, validFrom: null, validTo: null, dedupeKey: null },
      ],
    },
  ],
  catchphrases: [{ phrase: "不烧心吗", usage: "吃到辣的", enabled: true, source: "manual" }],
  friends: [
    {
      platform: "qq-onebot",
      platformUid: "888888",
      displayName: "小明",
      firstSource: "GROUP",
      interactionCount: 12,
      lastInteractedAt: new Date("2026-10-30T10:00:00Z"),
      knownSince: new Date("2026-09-01T00:00:00Z"),
      memoryItems: [
        { category: "FACT", content: "小明住在北海", confidence: 0.8, importance: 0.6, validFrom: null, validTo: null, dedupeKey: "f1" },
      ],
      snapshots: [
        {
          kind: "AUTOMATIC",
          periodStart: new Date("2026-10-25T00:00:00Z"),
          periodEnd: new Date("2026-10-26T00:00:00Z"),
          summary: "他们一起去了海边。",
          structuredContent: {},
          generatedAt: null,
          createdAt: new Date("2026-10-26T01:00:00Z"),
        },
      ],
    },
  ],
  now: new Date("2026-10-31T13:00:00Z"),
});

assert.equal(built.format, CHARACTER_BUNDLE_FORMAT, "格式标记固定");
assert.equal(built.formatVersion, 1, "当前格式版本为 1");
assert.equal(built.exportedAt, "2026-10-31T13:00:00.000Z", "导出时间用注入的 now，便于测试");
assert.equal(built.character.name, "小鱼");
assert.equal(built.counts.memories, 2, "两条记忆（全局 + 私人）");
assert.equal(built.counts.privateMemories, 1, "其中一条是私人记忆");
assert.equal(built.counts.events, 1);
assert.equal(built.counts.snapshots, 1);
assert.equal(built.counts.catchphrases, 1);
assert.equal(built.counts.friends, 1, "朋友单独成段");
assert.equal(built.counts.friendMemories, 1, "朋友名下的记忆单独计数");
assert.equal(built.friends[0]?.displayName, "小明");
assert.equal(built.friends[0]?.interactionCount, 12);
assert.equal(built.friends[0]?.firstSource, "GROUP", "在哪儿认识的要保留");
assert.ok(
  !built.memories.some((item) => item.content === "小明住在北海"),
  "朋友的记忆不能混进角色自己的记忆列表",
);
assert.equal(built.memories.filter((item) => item.scope === "private").length, 1, "私人记忆带 scope 标记");
assert.equal(built.memories[0]?.scope, "character", "全局记忆默认 scope=character");
assert.equal(built.modelConfig.chatApiKeyEncrypted, undefined, "构建出的包不含密钥字段");

// ── 3. 回环：导出 → JSON → 导入解析 ──────────────────────────
const roundTrip = parseCharacterBundle(JSON.parse(JSON.stringify(built)));
assert.deepEqual(roundTrip.counts, built.counts, "回环后条数一致");
assert.equal(roundTrip.character.name, "小鱼");
assert.equal(roundTrip.character.styleExamples, "主人：在吗\n小鱼：在。", "对话示例的换行要原样保留");
assert.equal(roundTrip.memories[0]?.content, "主人住在杭州");
assert.equal(roundTrip.memories[0]?.importance, 0.7);
assert.equal(roundTrip.events[0]?.participants[0], "小明", "参与者是数组，不能被压成字符串");
assert.equal(roundTrip.snapshots[0]?.summary, "这一段她学会了游泳。");
assert.deepEqual(roundTrip.snapshots[0]?.structuredContent, { highlights: ["游泳"] });
assert.equal(roundTrip.memorySetting.snapshotIntervalDays, 8);
assert.equal(roundTrip.friends.length, 1, "朋友要能原样解析回来");
assert.equal(roundTrip.friends[0]?.platformUid, "888888");
assert.equal(roundTrip.friends[0]?.memories[0]?.content, "小明住在北海");
assert.equal(roundTrip.friends[0]?.snapshots[0]?.summary, "他们一起去了海边。");
assert.equal(roundTrip.friends[0]?.knownSince, "2026-09-01T00:00:00.000Z", "认识的时间要保住");

// ── 4. 名称去重 ────────────────────────────────────────────
assert.equal(computeImportedCharacterName("小鱼", []), "小鱼", "不撞名就用原名");
assert.equal(computeImportedCharacterName("小鱼", ["小鱼"]), "小鱼 副本", "撞名加后缀");
assert.equal(computeImportedCharacterName("小鱼", ["小鱼", "小鱼 副本"]), "小鱼 副本 2", "再撞就编号");
assert.equal(computeImportedCharacterName("   ", []), "导入的角色", "空名兜底");

// ── 5. 拒绝非法输入 ────────────────────────────────────────
function minimal(overrides: Record<string, unknown> = {}) {
  return {
    format: CHARACTER_BUNDLE_FORMAT,
    formatVersion: 1,
    character: { name: "小鱼", basePrompt: "你是小鱼" },
    ...overrides,
  };
}

assert.throws(() => parseCharacterBundle({ hello: 1 }), /不是忆灵空间的角色卡/, "没有 format 标记直接拒绝");
assert.throws(() => parseCharacterBundle(minimal({ formatVersion: 99 })), /请先升级程序/, "版本高于当前程序要拒绝");
assert.throws(() => parseCharacterBundle(minimal({ character: { name: "" } })), /角色名称不能为空/, "没有名字不能导入");
assert.throws(
  () => parseCharacterBundle(minimal({ memories: [{ content: 42 }] })),
  /第 1 条记忆必须是文本/,
  "记忆内容不是文本要拒绝",
);

const tooMany = Array.from({ length: CHARACTER_BUNDLE_LIMITS.memories + 1 }, () => ({ content: "x" }));
assert.throws(
  () => parseCharacterBundle(minimal({ memories: tooMany })),
  /最多 4000 条/,
  "超过记忆条数上限要拒绝而不是慢慢跑",
);

assert.throws(
  () => parseCharacterBundle(minimal({ events: [{ title: "没有时间" }] })),
  /缺少发生时间/,
  "忆泡没有发生时间要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({ events: [{ title: "x", occurredAt: "2026-10-30T00:00:00Z", dayKey: "10-30" }] })),
  /YYYY-MM-DD/,
  "dayKey 格式不对要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({
    snapshots: [{ summary: "s", periodStart: "2026-10-08T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z" }],
  })),
  /早于开始时间/,
  "周期倒置要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({ memories: [{ content: "x", importance: 9 }] })),
  /必须在 0 到 1 之间/,
  "重要度越界要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({ catchphrases: [{ phrase: "" }] })),
  /台词不能为空/,
  "空梗要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({ friends: [{ platform: "qq-onebot" }] })),
  /平台账号不能为空/,
  "朋友没有账号要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({
    friends: [
      { platform: "qq-onebot", platformUid: "123" },
      { platform: "qq-onebot", platformUid: "123" },
    ],
  })),
  /重复的 qq-onebot 账号/,
  "同一个账号出现两次会撞唯一键，必须在解析阶段就拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({
    friends: [{ platform: "qq-onebot", platformUid: "123", interactionCount: -1 }],
  })),
  /互动次数必须在/,
  "负的互动次数要拒绝",
);

// ── 6. 宽容但不含糊的字段 ──────────────────────────────────
const lenient = parseCharacterBundle(minimal({
  memorySetting: { snapshotIntervalDays: 8, timezone: "Mars/Base", autoSnapshotEnabled: true },
  memories: [{ content: "x", category: "WHATEVER", scope: "private" }],
  events: [{
    title: "就记得是那天",
    occurredAt: "2026-10-30T00:00:00Z",
    dayKey: "2026-10-30",
    precision: "???",
    state: "???",
  }],
}));
assert.equal(lenient.memorySetting.timezone, "Asia/Shanghai", "无效时区回落到默认，而不是拒绝整张卡");
assert.equal(lenient.memories[0]?.category, "OTHER", "不认识的分类归到 OTHER");
assert.equal(lenient.memories[0]?.scope, "private");
assert.equal(lenient.events[0]?.precision, "day", "不认识的精度回落到 day");
assert.equal(lenient.events[0]?.state, "FINAL", "不认识的状态回落到 FINAL");
assert.equal(lenient.snapshots.length, 0, "没有阶段总结时不报错，就是空数组");
assert.equal(lenient.friends.length, 0, "老角色卡没有 friends 段，解析成空数组而不是报错");

const friendLenient = parseCharacterBundle(minimal({
  friends: [{ platform: "qq-onebot", platformUid: "1", firstSource: "WHATEVER" }],
}));
assert.equal(friendLenient.friends[0]?.firstSource, null, "不认识的来源标成 null，不当成私聊");

// 密钥字段即使塞在包里也会被剥掉
const withSecrets = parseCharacterBundle(minimal({
  modelConfig: { chatModel: "m", chatApiKeyEncrypted: "v1.x.y.z", chatApiKey: "sk-x" },
}));
assert.equal(withSecrets.modelConfig.chatModel, "m");
assert.equal("chatApiKeyEncrypted" in withSecrets.modelConfig, false, "导入时也要剥一次密钥");
assert.equal("chatApiKey" in withSecrets.modelConfig, false);

// ── 7. 文件名 ──────────────────────────────────────────────
const fileName = characterBundleFileName('小/鱼: "test"', new Date("2026-10-31T13:11:10Z"));
assert.match(fileName, /^yiling-character-小_鱼_ _test_-202610311311\.json$/, "文件名要过滤路径分隔符并带时间戳");

console.log("角色卡格式测试通过：密钥剥离、白名单、构建、朋友段、回环、名称去重、非法输入拒绝、时区与分类兜底、文件名。");
