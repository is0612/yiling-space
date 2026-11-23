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
import { emptyCharacterGrowthBundle } from "../server/utils/character-growth-portable";

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
  // v7 起这些「她是谁」的设置要跟着卡走
  emojiEnabled: true,
  emojiWindowMinutes: 1,
  emojiPerWindow: 2,
  voiceEnabled: true,
  voiceTranscribe: true,
  voiceChance: 10,
  voiceCooldownMinutes: 20,
  voiceApiBaseUrl: "https://api.example.com/v1",
  ttsProvider: "minimax",
  ttsVoice: "female-shaonv",
  ttsModel: "speech-2.5",
  ttsSpeed: 1,
  ttsGroupId: "2115988379945407115",
  ttsInstructions: "声音软软的、轻轻的",
  asrProvider: "minimax",
  asrModel: "asr-1.0",
  visionModel: "gpt-5.6-luna",
  imageUnderstanding: true,
  // 画图：设置跟卡走，Key 不跟
  imageEnabled: true,
  imageChance: 6,
  imageCooldownMinutes: 45,
  imageDailyLimit: 5,
  imageModel: "MiniMax-H3-Image",
  imageApiBaseUrl: "https://api.minimaxi.com/v1",
  imageProvider: "minimax",
  imageSize: "portrait",
  imageQuality: "quality",
  stickerAutoCollect: false,
  catchphraseAutoMine: true,
  dailyTokenLimit: 200000,
  eventRecentDays: 2,
  knowledgeCollectScope: "SELECTED",
  knowledgeAssistantModel: "private-knowledge-model",
  knowledgeAssistantTemperature: 0.1,
  memoryAssistantModel: "private-memory-model",
  // 下面这些都是不该进包的
  chatApiKeyEncrypted: "v1.aaa.bbb.ccc",
  voiceApiKeyEncrypted: "v1.ddd.eee.fff",
  imageApiKeyEncrypted: "v1.imagelegacy.key",
  memoryAssistantApiKeyEncrypted: "v1.ggg.hhh.iii",
  knowledgeAssistantApiKeyEncrypted: "v1.knowledge.key.secret",
  voiceApiKey: "sk-voice",
  asrApiKey: "sk-asr",
  visionApiKey: "sk-vision",
  imageApiKey: "sk-image",
  chatApiKey: "sk-plain",
  someToken: "abc",
  // 后台流水线的开关：会自己花钱，不跟卡走
  knowledgeAssistantEnabled: true,
  memoryAssistantEnabled: true,
  knowledgeAutoCollectEnabled: true,
  interactionExperienceAutoEnabled: true,
  proactive: { enabled: true, dailyMax: 99, quietStart: "23:00", quietEnd: "23:00", targetQq: "12345" },
  groupInitiative: { enabled: true, idleMinutes: 60, dailyMax: 3, quietStart: "23:30", quietEnd: "07:30" },
};

const stripped = stripPortableModelConfig(rawConfig);
assert.equal(Reflect.get(stripped, "chatApiKeyEncrypted"), undefined, "加密的聊天 Key 不能进包");
assert.equal(Reflect.get(stripped, "voiceApiKeyEncrypted"), undefined, "加密的语音 Key 不能进包");
assert.equal(Reflect.get(stripped, "memoryAssistantApiKeyEncrypted"), undefined, "记忆助手的加密 Key 不能进包");
assert.equal(Reflect.get(stripped, "knowledgeAssistantApiKeyEncrypted"), undefined, "知识处理助手的加密 Key 不能进包");
assert.equal(Reflect.get(stripped, "voiceApiKey"), undefined, "语音 Key 明文也不能进包");
assert.equal(Reflect.get(stripped, "asrApiKey"), undefined, "转写 Key 明文也不能进包");
assert.equal(Reflect.get(stripped, "visionApiKey"), undefined, "看图 Key 明文也不能进包");
assert.equal(Reflect.get(stripped, "imageApiKey"), undefined, "画图 Key 明文也不能进包");
assert.equal(Reflect.get(stripped, "imageApiKeyEncrypted"), undefined, "画图 Key 的旧密文也不能进包");
assert.equal("chatApiKey" in stripped, false, "明文 Key 字段不能进包");
assert.equal("someToken" in stripped, false, "白名单之外的字段一律不带走");

// v7：她的声音、节奏、口味都跟着卡走 —— 换台机器不该变成另一个人
assert.equal(stripped.chatModel, "deepseek-chat", "模型名保留");
assert.equal(stripped.memoryTokenBudget, 4000, "记忆预算保留");
assert.equal(stripped.emojiEnabled, true, "表情开关跟卡走");
assert.equal(stripped.emojiPerWindow, 2, "表情额度跟卡走");
assert.equal(stripped.voiceEnabled, true, "语音开关跟卡走");
assert.equal(stripped.ttsVoice, "female-shaonv", "音色跟卡走（换机器不能换声）");
assert.equal(stripped.ttsInstructions, "声音软软的、轻轻的", "语气指令跟卡走");
assert.equal(stripped.visionModel, "gpt-5.6-luna", "看图模型跟卡走");
// 画图同理：换台机器她还是同一种画风，但画图 Key 得自己重填
assert.equal(stripped.imageEnabled, true, "画图开关跟卡走");
assert.equal(stripped.imageChance, 6, "画图概率跟卡走");
assert.equal(stripped.imageCooldownMinutes, 45, "画图冷却跟卡走");
assert.equal(stripped.imageDailyLimit, 5, "每日张数跟卡走");
assert.equal(stripped.imageModel, "MiniMax-H3-Image", "画图模型跟卡走");
assert.equal(stripped.imageSize, "portrait", "画面尺寸跟卡走");
assert.equal(stripped.imageProvider, "minimax", "画图服务商跟卡走");
assert.equal(stripped.imageQuality, "quality", "出图档位跟卡走（本地引擎靠它选模型）");
assert.equal(stripped.imageApiBaseUrl, "https://api.minimaxi.com/v1", "画图地址跟卡走");
assert.equal(stripped.dailyTokenLimit, 200000, "日额度是设置，不是密钥");
assert.equal(stripped.knowledgeAssistantModel, "private-knowledge-model", "助手用的模型选择跟卡走");

// 但「会自己花钱」的后台开关不跟：一张别人发来的卡不该替我跑起四条流水线
assert.equal(Reflect.get(stripped, "knowledgeAssistantEnabled"), undefined, "后台助手开关不随卡走");
assert.equal(Reflect.get(stripped, "memoryAssistantEnabled"), undefined, "后台助手开关不随卡走");
assert.equal(Reflect.get(stripped, "knowledgeAutoCollectEnabled"), undefined, "自动收集开关不随卡走");
assert.equal(Reflect.get(stripped, "interactionExperienceAutoEnabled"), undefined, "自动总结开关不随卡走");

// 对象型设置：只留白名单字段，坏值收口而不是整卡失败
const proactive = stripped.proactive!;
assert.equal(proactive.enabled, true, "私聊主动的开关跟卡走");
assert.equal(proactive.dailyMax, 24, "越界的每天条数收口到 24");
assert.equal(Reflect.get(proactive, "targetQq"), undefined, "对象里的未知字段不带走");
assert.equal(Reflect.get(proactive, "quietStart"), undefined, "起止相同的安静时段按「没配」处理");
const groupInitiative = stripped.groupInitiative!;
assert.equal(groupInitiative.idleMinutes, 60);
assert.equal(groupInitiative.quietStart, "23:30", "合法安静时段照留");

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
  interactionGuidance: [
    { kind: "UNDERSTANDING", content: "她是他养的鱼，不是客服。", context: "被问「你是谁」时", chatScope: "ALL" },
  ],
  channelPolicies: [
    { kind: "GROUP_AT_DISABLED", content: "被动群聊回复不发送 @ 提醒，引用仍保留。", chatScope: "GROUP" },
  ],
  expressionHabits: [
    {
      kind: "TONE",
      content: "说话带一点气声，尾音往上扬。",
      context: "私聊撒娇时",
      chatScope: "PRIVATE",
      status: "ACTIVE",
      reason: "主人说这样好听",
    },
    {
      kind: "LENGTH",
      content: "群里一次不超过两行。",
      context: "大群里接话",
      chatScope: "GROUP",
      status: "DISABLED",
      reason: "之前刷屏被说过",
    },
  ],
  goals: [
    { kind: "GOAL", title: "学会做红烧肉", description: "做给主人吃一次", reason: "他上周提过想吃", status: "ACTIVE" },
    { kind: "WISH", title: "去看一次海", description: "想亲眼看看海有多大", reason: "她记得海边那次", status: "COMPLETED" },
  ],
  preferences: [
    { kind: "LIKE", topic: "冰美式", reason: "喝过一次就喜欢上了", status: "ACTIVE" },
  ],
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
  /**
   * 形象档案（v8）：文字、装扮、版本、参考图清单。
   * 素材行故意带 `id` / `relativePath` —— 导出必须把它们剥掉，否则新机器会以为图还在。
   */
  visualProfile: {
    coreAppearance: "浅紫长发，蓝眼睛，鲸鱼耳与鲸鱼尾",
    corePrompt: "1girl, purple long hair, blue eyes, whale ears, whale tail",
    negativePrompt: "lowres, bad anatomy",
    currentPublishedRevision: 2,
    outfits: [
      { name: "白裙", prompt: "white dress", isDefault: true, sortOrder: 0 },
      { name: "雨衣", prompt: "yellow raincoat", isDefault: false, sortOrder: 1 },
    ],
    versions: [
      {
        revision: 1,
        status: "ARCHIVED",
        note: "第一版",
        snapshot: { coreAppearance: "紫发", outfits: [{ name: "白裙", prompt: "white dress", isDefault: true, sortOrder: 0, id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }] },
        createdAt: new Date("2026-10-20T10:00:00Z"),
        publishedAt: new Date("2026-10-20T11:00:00Z"),
      },
      {
        revision: 2,
        status: "PUBLISHED",
        note: "加了鲸鱼尾",
        snapshot: {
          coreAppearance: "紫发，鲸鱼尾",
          assets: [{ id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", kind: "STANDARD", label: "正面", relativePath: "visual-profile/x/a.png", sortOrder: 0 }],
        },
        createdAt: new Date("2026-10-22T10:00:00Z"),
        publishedAt: new Date("2026-10-22T11:00:00Z"),
      },
    ],
    assets: [
      { kind: "STANDARD", label: "正面", width: 1024, height: 1024, sortOrder: 0 },
      { kind: "EXPRESSION", label: "笑", width: 512, height: 512, sortOrder: 1 },
    ],
  },
  stickers: [
    { name: "无语", usage: "被怼的时候", enabled: true, source: "collected" },
    { name: "点赞", usage: "夸主人的时候", enabled: false, source: "manual" },
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
assert.equal(CHARACTER_BUNDLE_VERSION, 8, "v8 补上形象档案与表情包清单");
assert.equal(built.counts.interactionGuidance, 1, "互动经验单独成段并计数");
assert.equal(built.counts.channelPolicies, 1, "渠道行为策略单独成段并计数");
assert.equal(built.counts.expressionHabits, 2, "表达习惯单独成段并计数（含被关掉的那条）");
assert.equal(built.counts.goals, 2, "目标单独成段并计数（含已完成的）");
assert.equal(built.counts.preferences, 1, "偏好单独成段并计数");
// v8：形象档案与表情包清单
assert.equal(built.counts.hasVisualProfile, true, "形象档案整段带走");
assert.equal(built.counts.visualOutfits, 2, "装扮计数");
assert.equal(built.counts.visualVersions, 2, "版本历史计数");
assert.equal(built.counts.visualAssets, 2, "参考图清单计数（只有清单，没有图）");
assert.equal(built.counts.stickers, 2, "表情包清单计数");
assert.equal(built.visualProfile?.coreAppearance, "浅紫长发，蓝眼睛，鲸鱼耳与鲸鱼尾", "形象描述要带走");
assert.equal(built.visualProfile?.negativePrompt, "lowres, bad anatomy", "负面提示也要带走");
assert.equal(built.visualProfile?.currentPublishedRevision, 2, "当前正式版本号跟着走");
assert.equal(built.visualProfile?.outfits[0]?.isDefault, true, "默认装扮标记保留");
assert.equal(built.stickers[0]?.usage, "被怼的时候", "表情包的用途要带走");
assert.equal(built.stickers[1]?.enabled, false, "关闭状态也照实带走（导入端会先停用）");
{
  const snapshot = built.visualProfile?.versions[1]?.snapshot as Record<string, unknown>;
  const assets = (snapshot.assets as Array<Record<string, unknown>>) ?? [];
  assert.equal(assets.length, 1);
  assert.equal(Reflect.get(assets[0] ?? {}, "id"), undefined, "版本快照里的素材 id 必须剥掉（旧机器的主键）");
  assert.equal(Reflect.get(assets[0] ?? {}, "relativePath"), undefined, "版本快照里的磁盘路径必须剥掉");
  assert.equal(assets[0]?.label, "正面", "快照里该留的是清单信息");
  const outfitSnapshot = (built.visualProfile?.versions[0]?.snapshot.outfits as Array<Record<string, unknown>>) ?? [];
  assert.equal(Reflect.get(outfitSnapshot[0] ?? {}, "id"), undefined, "快照里的装扮 id 同样要剥掉");
}
assert.equal(
  JSON.stringify(built).includes("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"),
  false,
  "整份包里不该出现任何素材主键",
);
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
assert.equal(built.modelConfig.imageModel, "MiniMax-H3-Image", "构建出的包要带画图设置");
assert.equal(Reflect.get(built.modelConfig, "imageApiKey"), undefined, "构建出的包不含画图 Key");

// ── 3. 回环：导出 → JSON → 导入解析 ──────────────────────────
const roundTrip = parseCharacterBundle(JSON.parse(JSON.stringify(built)));
assert.deepEqual(roundTrip.counts, built.counts, "回环后条数一致");
assert.deepEqual(roundTrip.interactionGuidance, built.interactionGuidance, "互动经验回环后内容不变");
assert.deepEqual(roundTrip.channelPolicies, built.channelPolicies, "渠道策略回环后内容不变");
assert.deepEqual(roundTrip.expressionHabits, built.expressionHabits, "表达习惯回环后内容不变（含 DISABLED）");
assert.deepEqual(roundTrip.goals, built.goals, "目标回环后内容不变（含已完成的愿望）");
assert.deepEqual(roundTrip.preferences, built.preferences, "偏好回环后内容不变");
assert.equal(roundTrip.expressionHabits[0]?.chatScope, "PRIVATE", "表达习惯的适用范围要保留");
assert.equal(roundTrip.expressionHabits[1]?.status, "DISABLED", "被关掉过的那条不该回滚成 ACTIVE");
assert.equal(roundTrip.interactionGuidance[0]?.kind, "UNDERSTANDING");
assert.equal(roundTrip.interactionGuidance[0]?.chatScope, "ALL");
assert.equal(roundTrip.interactionGuidance[0]?.content, "她是他养的鱼，不是客服。");
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
// v8 的两段也要能原样回来
assert.equal(roundTrip.counts.hasVisualProfile, true, "回环后形象档案还在");
assert.equal(roundTrip.visualProfile?.corePrompt, built.visualProfile?.corePrompt, "形象提示词回环不变");
assert.equal(roundTrip.visualProfile?.outfits.length, 2, "装扮回环不变");
assert.equal(roundTrip.visualProfile?.versions[1]?.status, "PUBLISHED", "版本状态回环不变");
assert.equal(roundTrip.visualProfile?.versions[1]?.publishedAt, "2026-10-22T11:00:00.000Z", "发布时间回环不变");
assert.equal(roundTrip.visualProfile?.assets[1]?.kind, "EXPRESSION", "参考图清单的用途回环不变");
assert.equal(roundTrip.visualProfile?.assets[0]?.width, 1024, "清单里的尺寸要保住（补图时知道找多大的）");
assert.deepEqual(roundTrip.stickers, built.stickers, "表情包清单回环不变");

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

/**
 * 互动经验 / 渠道策略（v6）。
 * 关键点：不认识的 kind 要直接拒绝 —— 悄悄改成默认值等于把一条准则改坏，比没有更糟。
 */
assert.throws(
  () => parseCharacterBundle(minimal({ formatVersion: 6, channelPolicies: [] })),
  /缺少互动经验或渠道策略段/,
  "v6 卡必须声明这两段，缺了会让人以为「她本来就没被教过」",
);
assert.throws(
  () => parseCharacterBundle(minimal({
    interactionGuidance: [{ kind: "UNDERSTANDING", content: "x", context: "y", chatScope: "ALL" }],
  })),
  /需要v6角色卡/,
  "旧版本卡不许夹带互动经验，否则会被静默丢掉",
);
assert.throws(
  () => parseCharacterBundle(minimal({
    formatVersion: 6,
    interactionGuidance: [{ kind: "MADE_UP", content: "x", context: "y", chatScope: "ALL" }],
    channelPolicies: [],
  })),
  /类型无法识别/,
  "认不出来的互动经验类型要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({
    formatVersion: 6,
    interactionGuidance: [{ kind: "UNDERSTANDING", content: "x", context: "y", chatScope: "EVERYWHERE" }],
    channelPolicies: [],
  })),
  /聊天范围无法识别/,
  "认不出来的聊天范围要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({
    formatVersion: 6,
    interactionGuidance: [{ kind: "UNDERSTANDING", content: "", context: "y", chatScope: "ALL" }],
    channelPolicies: [],
  })),
  /不能为空/,
  "空的互动经验要拒绝",
);
assert.throws(
  () => parseCharacterBundle(minimal({ formatVersion: 6, interactionGuidance: [], channelPolicies: [] })),
  /成长数据段/,
  "v6 卡声明了两段新内容后，仍要过 v5 的成长段检查",
);

/**
 * 表达习惯 / 目标 / 偏好（v7）。
 * 和 v6 同一个态度：新卡必须声明这几段；旧卡夹带一律拒绝，别指望它被静默丢掉。
 * 状态白名单是硬的 —— 带一个 PENDING 过去，导入后会变成「她本来就需要确认的事」。
 */
function v7(overrides: Record<string, unknown> = {}) {
  return minimal({
    formatVersion: 7,
    interactionGuidance: [],
    channelPolicies: [],
    growth: emptyCharacterGrowthBundle(),
    expressionHabits: [],
    goals: [],
    preferences: [],
    ...overrides,
  });
}

assert.throws(
  () => parseCharacterBundle(v7({ expressionHabits: undefined })),
  /缺少表达习惯、目标或偏好段/,
  "v7 卡必须声明这三段，缺了会让人以为「她本来就没被教过怎么说」",
);
assert.throws(
  () => parseCharacterBundle(minimal({ goals: [] })),
  /需要v7角色卡/,
  "旧版本卡不许夹带目标，否则会被静默丢掉",
);
assert.throws(
  () => parseCharacterBundle(v7({ expressionHabits: [{ kind: "TONE", content: "x", context: "", chatScope: "ALL", status: "PENDING", reason: "" }] })),
  /状态无法识别/,
  "PENDING 属于本机决策现场，不该跨机器",
);
assert.throws(
  () => parseCharacterBundle(v7({ expressionHabits: [{ kind: "MADE_UP", content: "x", context: "", chatScope: "ALL", status: "ACTIVE", reason: "" }] })),
  /类型无法识别/,
  "认不出来的表达习惯类型要拒绝",
);
assert.throws(
  () => parseCharacterBundle(v7({ goals: [{ kind: "GOAL", title: "", status: "ACTIVE" }] })),
  /标题不能为空/,
  "没有标题的目标要拒绝",
);
assert.throws(
  () => parseCharacterBundle(v7({ goals: [{ kind: "GOAL", title: "x", status: "REJECTED" }] })),
  /状态无法识别/,
  "被否决过的目标不该跨机器",
);
assert.throws(
  () => parseCharacterBundle(v7({ preferences: [{ kind: "LOVE", topic: "x", status: "ACTIVE" }] })),
  /类型无法识别/,
  "认不出来的偏好类型要拒绝",
);

const okV7 = parseCharacterBundle(v7({
  expressionHabits: [{ kind: "TONE", content: "尾音上扬", context: "私聊", chatScope: "PRIVATE", status: "DISABLED", reason: "被说过" }],
  goals: [{ kind: "WISH", title: "看海", description: "想亲眼看看", reason: "她记得海边那次", status: "ABANDONED" }],
  preferences: [{ kind: "DISLIKE", topic: "香菜", reason: "闻到就皱眉", status: "ACTIVE" }],
}));
assert.equal(okV7.expressionHabits[0]?.status, "DISABLED", "关掉过的习惯要能带回来");
assert.equal(okV7.goals[0]?.status, "ABANDONED", "放弃过的目标也是她经历过的事");
assert.equal(okV7.counts.expressionHabits, 1);
assert.equal(okV7.counts.goals, 1);
assert.equal(okV7.counts.preferences, 1);

/**
 * 形象档案 / 表情包清单（v8）。
 *
 * 门禁与 v6 / v7 同一套：新卡必须声明这两段（`null` 是合法值，表示她没建过形象档案），
 * 旧卡夹带一律拒绝。另有两条自己的规矩：
 *   - 装扮重名要拒绝（库里是唯一键，包里带两份就得猜哪份算数）
 *   - `currentPublishedRevision` 指向包里没有的版本时收口成 0，不能留一个指空的版本号
 */
function v8(overrides: Record<string, unknown> = {}) {
  return v7({ formatVersion: 8, visualProfile: null, stickers: [], ...overrides });
}

assert.throws(
  () => parseCharacterBundle(v8({ visualProfile: undefined })),
  /缺少形象档案或表情包段/,
  "v8 卡必须声明这两段，缺了会让人以为「她本来就没有形象档案」",
);
assert.throws(
  () => parseCharacterBundle(v8({ stickers: undefined })),
  /缺少形象档案或表情包段/,
  "表情包清单同样必须声明（空数组也是声明）",
);
assert.throws(
  () => parseCharacterBundle(v7({ visualProfile: null })),
  /需要v8角色卡/,
  "旧版本卡不许夹带形象档案，否则会被静默丢掉",
);
assert.throws(
  () => parseCharacterBundle(v8({
    visualProfile: {
      coreAppearance: "紫发",
      outfits: [
        { name: "白裙", prompt: "white dress" },
        { name: "白裙", prompt: "another" },
      ],
    },
  })),
  /重名/,
  "装扮重名要拒绝：库里是唯一键，不能猜哪一套算数",
);
assert.throws(
  () => parseCharacterBundle(v8({
    visualProfile: {
      coreAppearance: "紫发",
      outfits: [
        { name: "白裙", prompt: "a", isDefault: true },
        { name: "雨衣", prompt: "b", isDefault: true },
      ],
    },
  })),
  /不止一套默认装扮/,
  "两套默认装扮要拒绝：进提示词时不知道该穿哪套",
);
assert.throws(
  () => parseCharacterBundle(v8({ stickers: [{ name: "" }] })),
  /不能为空/,
  "没有名字的表情包条目要拒绝（名字是她挑图时唯一的线索）",
);

const okV8 = parseCharacterBundle(v8({
  visualProfile: {
    coreAppearance: "浅紫长发，鲸鱼耳",
    corePrompt: "1girl, purple hair",
    negativePrompt: "lowres",
    // 指向不存在的版本号 → 必须收口成 0
    currentPublishedRevision: 9,
    outfits: [{ name: "白裙", prompt: "white dress", isDefault: true }],
    versions: [{ revision: 1, status: "PUBLISHED", note: "首版", snapshot: { coreAppearance: "紫发" } }],
    assets: [{ kind: "STANDARD", label: "正面" }, { kind: "MADE_UP", label: "怪图" }],
  },
  stickers: [{ name: "无语", usage: "被怼时", enabled: true, source: "collected" }],
}));
assert.equal(okV8.visualProfile?.currentPublishedRevision, 0, "版本号指向包里没有的版本时收口成 0");
assert.equal(okV8.visualProfile?.assets[1]?.kind, "STANDARD", "认不出的素材用途退回默认，不整卡失败");
assert.equal(okV8.counts.visualOutfits, 1);
assert.equal(okV8.counts.visualVersions, 1);
assert.equal(okV8.counts.visualAssets, 2);
assert.equal(okV8.counts.stickers, 1);
assert.equal(okV8.visualProfile?.versions[0]?.createdAt, null, "没写创建时间就是 null，不编一个");

// 原文保留策略：老卡（没有这一格）按 30 天兜；显式 null 才是「永久」
assert.equal(parseCharacterBundle(minimal()).memorySetting.rawMessageRetentionDays, 30, "老卡沿用导入端默认值");
assert.equal(parseCharacterBundle(minimal()).memorySetting.rawMessageCleanupEnabled, false, "默认不自动清理");
assert.equal(
  parseCharacterBundle(v7({ memorySetting: { rawMessageRetentionDays: null, rawMessageCleanupEnabled: true } }))
    .memorySetting.rawMessageRetentionDays,
  null,
  "显式写 null 才是永久保留",
);
assert.equal(
  parseCharacterBundle(v7({ memorySetting: { rawMessageRetentionDays: null, rawMessageCleanupEnabled: true } }))
    .memorySetting.rawMessageCleanupEnabled,
  false,
  "永久保留时不允许同时开着自动清理",
);
assert.equal(
  parseCharacterBundle(v7({ memorySetting: { rawMessageRetentionDays: 7 } })).memorySetting.rawMessageRetentionDays,
  30,
  "页面没有的档位收口到 30，不是拒绝整张卡",
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
  modelConfig: { chatModel: "m", chatApiKeyEncrypted: "v1.x.y.z", chatApiKey: "sk-x", imageApiKey: "sk-image" },
}));
assert.equal(withSecrets.modelConfig.chatModel, "m");
assert.equal("chatApiKeyEncrypted" in withSecrets.modelConfig, false, "导入时也要剥一次密钥");
assert.equal("chatApiKey" in withSecrets.modelConfig, false);
assert.equal("imageApiKey" in withSecrets.modelConfig, false, "别人塞进包的画图 Key 也不读");

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
