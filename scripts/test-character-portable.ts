import "dotenv/config";
import assert from "node:assert/strict";
import {
  CHARACTER_BUNDLE_FORMAT,
  CHARACTER_BUNDLE_LIMITS,
  CHARACTER_BUNDLE_VERSION,
  normalizeBundleOriginId,
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
  memoryAssistantApiKeyEncrypted: "v1.ggg.hhh.iii",
  memoryAssistantModel: "private-memory-model",
  memoryAssistantEnabled: true,
  chatApiKey: "sk-plain",
  someToken: "abc",
  proactive: { enabled: true, targetQq: "12345" },
  emojiEnabled: true,
};

const stripped = stripPortableModelConfig(rawConfig);
assert.equal(Reflect.get(stripped, "chatApiKeyEncrypted"), undefined, "加密的聊天 Key 不能进包");
assert.equal(Reflect.get(stripped, "voiceApiKeyEncrypted"), undefined, "加密的语音 Key 不能进包");
assert.equal(Reflect.get(stripped, "memoryAssistantApiKeyEncrypted"), undefined, "记忆助手的加密 Key 不能进包");
assert.equal(Reflect.get(stripped, "memoryAssistantModel"), undefined, "记忆助手的专用模型配置不随角色卡导出");
assert.equal(Reflect.get(stripped, "memoryAssistantEnabled"), undefined, "导入角色卡时不自动启用记忆助手");
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
    originCharacterId: "11111111-1111-4111-8111-111111111111",
  },
  memorySetting: { snapshotIntervalDays: 8, timezone: "Asia/Shanghai", autoSnapshotEnabled: true },
  scopes: [
    {
      scopeType: "CHARACTER_GLOBAL",
      memoryItems: [
        { originId: "22222222-2222-4222-8222-222222222222", category: "FACT", content: "主人住在杭州", confidence: 0.9, importance: 0.7, validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, dedupeKey: "d1" },
      ],
      events: [
        {
          originId: "33333333-3333-4333-8333-333333333333",
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
          originId: "44444444-4444-4444-8444-444444444444",
          kind: "AUTOMATIC",
          periodStart: new Date("2026-10-01T00:00:00Z"),
          periodEnd: new Date("2026-10-08T00:00:00Z"),
          summary: "这一段她学会了游泳。",
          structuredContent: { highlights: ["游泳"] },
          generatedAt: new Date("2026-10-08T01:00:00Z"),
          createdAt: new Date("2026-10-08T01:00:00Z"),
        },
      ],
      eventDays: [
        {
          dayKey: "2026-10-30",
          state: "FINAL",
          eventCount: 3,
          extractedAt: new Date("2026-10-31T01:00:00Z"),
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
  journals: [
    {
      dayKey: "2026-10-30",
      status: "ACTIVE",
      skipReason: null,
      diaryState: "GENERATED",
      handbookState: "GENERATED",
      diaryDecidedAt: new Date("2026-10-31T02:00:00Z"),
      handbookDecidedAt: new Date("2026-10-31T02:00:00Z"),
      createdAt: new Date("2026-10-31T02:00:00Z"),
      revisions: [
        {
          kind: "DIARY",
          version: 1,
          title: "海边的风",
          content: "今天和小明去了海边。",
          thought: null,
          quote: null,
          tags: [],
          revisionType: "AI_GENERATED",
          promptVersion: "v1",
          model: "deepseek-chat",
          sourceDiaryVersion: null,
          createdAt: new Date("2026-10-31T02:00:00Z"),
        },
        {
          kind: "HANDBOOK",
          version: 1,
          title: null,
          content: "上午：读了两页书。",
          thought: "想再去一次。",
          quote: "今天和小明去了海边。",
          tags: ["海边"],
          revisionType: "AI_GENERATED",
          promptVersion: "v1",
          model: "deepseek-chat",
          sourceDiaryVersion: 1,
          createdAt: new Date("2026-10-31T02:00:00Z"),
        },
      ],
    },
  ],
  friends: [
    {
      platform: "qq-onebot",
      platformUid: "888888",
      displayName: "小明",
      aliases: ["小鱼干", "阿明"],
      firstSource: "GROUP",
      interactionCount: 12,
      lastInteractedAt: new Date("2026-10-30T10:00:00Z"),
      knownSince: new Date("2026-09-01T00:00:00Z"),
      memoryItems: [
        { originId: "55555555-5555-4555-8555-555555555555", category: "FACT", content: "小明住在北海", confidence: 0.8, importance: 0.6, validFrom: null, validTo: null, dedupeKey: "f1" },
      ],
      snapshots: [
        {
          originId: "66666666-6666-4666-8666-666666666666",
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
assert.equal(
  built.origin.characterId,
  "11111111-1111-4111-8111-111111111111",
  "血缘 id 必须跟着卡片走，否则没法认人合并",
);
assert.equal(built.formatVersion, CHARACTER_BUNDLE_VERSION, "导出用当前格式版本");
assert.equal(CHARACTER_BUNDLE_VERSION, 4, "v4 增加记忆、忆泡、阶段总结的跨设备血缘 ID");
assert.equal(built.exportedAt, "2026-10-31T13:00:00.000Z", "导出时间用注入的 now，便于测试");
assert.equal(built.character.name, "小鱼");
assert.equal(built.counts.memories, 2, "两条记忆（全局 + 私人）");
assert.equal(built.counts.privateMemories, 1, "其中一条是私人记忆");
assert.equal(built.counts.events, 1);
assert.equal(built.counts.eventDays, 1, "忆泡日历的天要单独计数");
assert.equal(built.counts.snapshots, 1);
assert.equal(built.counts.journals, 1, "一天一条手账");
assert.equal(built.counts.journalRevisions, 2, "日记与手账各一版");
assert.equal(built.counts.catchphrases, 1);
assert.equal(built.counts.friends, 1, "朋友单独成段");
assert.equal(built.counts.friendMemories, 1, "朋友名下的记忆单独计数");
assert.equal(built.counts.friendAliases, 2, "朋友名下的备注单独计数");
assert.equal(built.friends[0]?.displayName, "小明");
assert.equal(built.friends[0]?.interactionCount, 12);
assert.equal(built.friends[0]?.firstSource, "GROUP", "在哪儿认识的要保留");
assert.deepEqual(built.friends[0]?.aliases, ["小鱼干", "阿明"], "备注（她怎么叫他）要跟着卡走");
assert.ok(
  !built.memories.some((item) => item.content === "小明住在北海"),
  "朋友的记忆不能混进角色自己的记忆列表",
);
assert.equal(built.memories.filter((item) => item.scope === "private").length, 1, "私人记忆带 scope 标记");
assert.equal(built.memories[0]?.scope, "character", "全局记忆默认 scope=character");
assert.equal(Reflect.get(built.modelConfig, "chatApiKeyEncrypted"), undefined, "构建出的包不含密钥字段");

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
assert.equal(roundTrip.friends[0]?.memories[0]?.originId, "55555555-5555-4555-8555-555555555555", "朋友记忆血缘 ID 回环保留");
assert.equal(roundTrip.friends[0]?.snapshots[0]?.originId, "66666666-6666-4666-8666-666666666666", "朋友阶段总结血缘 ID 回环保留");
assert.deepEqual(roundTrip.friends[0]?.aliases, ["小鱼干", "阿明"], "备注要能原样解析回来");
assert.equal(roundTrip.friends[0]?.snapshots[0]?.summary, "他们一起去了海边。");
assert.equal(roundTrip.friends[0]?.knownSince, "2026-09-01T00:00:00.000Z", "认识的时间要保住");
assert.equal(roundTrip.originId, "11111111-1111-4111-8111-111111111111", "回环后角色血缘 id 一致");
assert.equal(roundTrip.memories[0]?.originId, "22222222-2222-4222-8222-222222222222", "长期记忆血缘 ID 回环保留");
assert.equal(roundTrip.events[0]?.originId, "33333333-3333-4333-8333-333333333333", "忆泡血缘 ID 回环保留");
assert.equal(roundTrip.snapshots[0]?.originId, "44444444-4444-4444-8444-444444444444", "阶段总结血缘 ID 回环保留");
assert.equal(roundTrip.eventDays[0]?.dayKey, "2026-10-30", "忆泡日历的天要跟着走");
assert.equal(roundTrip.eventDays[0]?.eventCount, 3);
assert.equal(roundTrip.eventDays[0]?.state, "FINAL");
assert.equal(roundTrip.eventDays[0]?.extractedAt, "2026-10-31T01:00:00.000Z", "整理时间要保住");
assert.equal(roundTrip.journals.length, 1, "日记/手账要能原样解析回来");
assert.equal(roundTrip.journals[0]?.dayKey, "2026-10-30");
assert.equal(roundTrip.journals[0]?.diaryState, "GENERATED");
assert.equal(roundTrip.journals[0]?.revisions.length, 2);
assert.equal(roundTrip.journals[0]?.revisions[1]?.quote, "今天和小明去了海边。", "今日一句要保留");
assert.equal(roundTrip.journals[0]?.revisions[1]?.sourceDiaryVersion, 1, "今日一句的出处按版本号表达");
assert.equal(
  JSON.stringify(built).includes("sourceMessageIds"),
  false,
  "原文/忆泡的 id 指针一律不进包",
);

// 老卡（v1）没有这两段：解析出来必须是空数组，而不是报错或 undefined
const legacy = parseCharacterBundle(minimal());
assert.equal(legacy.originId, null, "v1 老卡没有血缘信息 → 只能新建");
// 手改坏的血缘 id 当「没有」处理，不能因此让整张卡导不进来
assert.equal(normalizeBundleOriginId("not-a-uuid"), null);
assert.equal(normalizeBundleOriginId("  11111111-1111-4111-8111-111111111111  "), "11111111-1111-4111-8111-111111111111");
assert.equal(normalizeBundleOriginId(undefined), null);
assert.deepEqual(legacy.eventDays, [], "v1 老卡没有日历段");
assert.deepEqual(legacy.journals, [], "v1 老卡没有手账段");
assert.equal(legacy.counts.eventDays, 0);
assert.equal(legacy.counts.journals, 0);

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

// 归档周期：2026-11-03 上限从 365 收到 8，默认从 8 收到 3。
// 老卡里允许填到 365 的那批值要照旧读得进来，但不能原样落库 —— 否则会出现
// 「库里 30 天、设置页显示 8 天、一保存就 400」的死角。
const wideInterval = parseCharacterBundle(minimal({
  memorySetting: { snapshotIntervalDays: 30, timezone: "Asia/Shanghai" },
}));
assert.equal(wideInterval.memorySetting.snapshotIntervalDays, 8, "老卡里的 30 天收口到 8，而不是拒绝整张卡");

const defaultInterval = parseCharacterBundle(minimal({}));
assert.equal(defaultInterval.memorySetting.snapshotIntervalDays, 3, "卡里没写归档周期时默认 3 天");

assert.throws(
  () => parseCharacterBundle(minimal({
    memorySetting: { snapshotIntervalDays: 400 },
  })),
  /归档周期必须在/,
  "超出老范围（365）的值仍然拒绝，不当成可收口的数据",
);

const friendLenient = parseCharacterBundle(minimal({
  friends: [{ platform: "qq-onebot", platformUid: "1", firstSource: "WHATEVER" }],
}));
assert.equal(friendLenient.friends[0]?.firstSource, null, "不认识的来源标成 null，不当成私聊");

// 备注：老卡没有这一段 → 空数组；脏数据按「清洗 + 截断」处理，不让整张卡导不进来
assert.deepEqual(friendLenient.friends[0]?.aliases, [], "v2 老卡没有备注段，解析成空数组而不是报错");
const aliasCleaned = parseCharacterBundle(minimal({
  friends: [{ platform: "qq-onebot", platformUid: "1", displayName: "小明", aliases: " 小鱼干，阿明；小明 " }],
}));
assert.deepEqual(
  aliasCleaned.friends[0]?.aliases,
  ["小鱼干", "阿明"],
  "一整串备注要按分隔符切开，跟本名相同的叫法要剔掉",
);
const aliasTooLong = parseCharacterBundle(minimal({
  friends: [{ platform: "qq-onebot", platformUid: "1", displayName: "x", aliases: ["一".repeat(30)] }],
}));
assert.equal(aliasTooLong.friends[0]?.aliases[0]?.length, 12, "超长备注截断，而不是让整张卡导不进来");

// 密钥字段即使塞在包里也会被剥掉
const withSecrets = parseCharacterBundle(minimal({
  modelConfig: { chatModel: "m", chatApiKeyEncrypted: "v1.x.y.z", chatApiKey: "sk-x" },
}));
assert.equal(withSecrets.modelConfig.chatModel, "m");
assert.equal("chatApiKeyEncrypted" in withSecrets.modelConfig, false, "导入时也要剥一次密钥");
assert.equal("chatApiKey" in withSecrets.modelConfig, false);

// 每天最多日记 40 + 手账 40；必须通过真实 build → parse 回环，而非只测手写 JSON。
function buildJournalBoundary(diaryCount: number, handbookCount: number) {
  const revisions = (["DIARY", "HANDBOOK"] as const).flatMap((kind) =>
    Array.from({ length: kind === "DIARY" ? diaryCount : handbookCount }, (_, index) => ({
      kind, version: index + 1, title: "边界", content: `${kind}-${index + 1}`,
      thought: null, quote: null, tags: [], revisionType: "USER_EDITED" as const,
      promptVersion: null, model: null, sourceDiaryVersion: null, createdAt: new Date("2026-10-30T00:00:00Z"),
    })),
  );
  return buildCharacterBundle({
    character: { name: "版本边界", basePrompt: "边界测试", styleExamples: "", userAddress: "", modelConfig: {} },
    scopes: [], catchphrases: [],
    journals: [{
      dayKey: "2026-10-30", status: "ACTIVE", skipReason: null,
      diaryState: "GENERATED", handbookState: "GENERATED", diaryDecidedAt: null,
      handbookDecidedAt: null, createdAt: new Date("2026-10-30T00:00:00Z"), revisions,
    }],
  });
}
assert.equal(parseCharacterBundle(buildJournalBoundary(40, 1)).counts.journalRevisions, 41);
assert.equal(parseCharacterBundle(buildJournalBoundary(40, 40)).counts.journalRevisions, 80);
assert.throws(() => parseCharacterBundle(buildJournalBoundary(41, 0)), /DIARY 版本超过 40/);
assert.throws(() => parseCharacterBundle(buildJournalBoundary(0, 41)), /HANDBOOK 版本超过 40/);
assert.throws(() => parseCharacterBundle(buildJournalBoundary(40, 41)), /版本.*最多|版本.*超过|版本.*不能/);
const totalBoundary = buildJournalBoundary(40, 40);
totalBoundary.journals = Array.from({ length: 100 }, (_, index) => ({
  ...totalBoundary.journals[0]!, dayKey: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
}));
assert.equal(parseCharacterBundle(totalBoundary).counts.journalRevisions, 8000);
totalBoundary.journals.push({ ...totalBoundary.journals[0]!, dayKey: "2027-01-01" });
assert.throws(() => parseCharacterBundle(totalBoundary), /合计超过 8000/);

// ── 7. 文件名 ──────────────────────────────────────────────
const fileName = characterBundleFileName('小/鱼: "test"', new Date("2026-10-31T13:11:10Z"));
assert.match(fileName, /^yiling-character-小_鱼_ _test_-202610311311\.json$/, "文件名要过滤路径分隔符并带时间戳");

console.log("角色卡格式测试通过：密钥剥离、白名单、构建、朋友段、忆泡日历与日记手账回环、名称去重、非法输入拒绝、时区与分类兜底、归档周期收口、文件名。");
