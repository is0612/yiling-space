export type CharacterStatus = "运行中" | "已暂停" | "未连接";
export type TimelineType = "message" | "memory" | "snapshot" | "event" | "memoryEvent";

export type Character = {
  id: string;
  name: string;
  alias: string;
  description: string;
  avatar: string;
  avatarTone: "purple" | "peach" | "mint" | "blue";
  status: CharacterStatus;
  channels: string[];
  intervalDays: number;
  nextSnapshot: string;
  memoryCount: number;
  latestSnapshot: string;
  personality: string;
  /** 对话示例：只用于对齐语气（聊天 / QQ / B站 被动回复注入，值班判断不注入）。 */
  examples?: string;
  /** 这个角色在对话里怎么称呼你；空字符串 = 不特意称呼。 */
  userAddress?: string;
  /** ISO 时间：角色资料弹窗页脚左侧显示「上次保存」。 */
  updatedAt?: string;
  // 模型参数：接口一直有返回，之前类型里漏了，导致「模型设置」拿不到。
  // 全部可选 —— 列表接口和详情接口返回的字段并不完全一致。
  chatModel?: string;
  chatTemperature?: number;
  chatMaxTokens?: number;
  chatApiBaseUrl?: string;
  chatApiKeyConfigured?: boolean;
  chatApiKeySource?: "character" | "environment" | "missing";
  /** 每日 token 额度，0 = 不限。 */
  dailyTokenLimit?: number;
  /** 每次对话注入记忆 / 快照的 token 预算。 */
  memoryTokenBudget?: number;
  snapshotTokenBudget?: number;
  /** 每次回复回看多少条已落库消息；网页对话约等于「轮数 × 2」。 */
  recentMessageLimit?: number;
  /** QQ 渠道回复是否附一张表情。 */
  emojiEnabled?: boolean;
  /** 表情额度：多少分钟内最多贴几张（滑动窗口，按每个群 / 私聊分别算）。 */
  emojiWindowMinutes?: number;
  emojiPerWindow?: number;
  /** QQ 群里发来的图是否交给视觉模型读。 */
  imageUnderstanding?: boolean;
  /** 群里发来的图是否自动收进她的表情库。 */
  stickerAutoCollect?: boolean;
  /** 群聊之后是否自动扫一遍群里的梗（捡到的先进待确认）。 */
  catchphraseAutoMine?: boolean;
  /** 她的回复能否发成语音条。 */
  voiceEnabled?: boolean;
  /** 她听不听得懂别人发的语音。 */
  voiceTranscribe?: boolean;
  /** 发语音的概率（0-100）。 */
  voiceChance?: number;
  /** 两条语音之间至少隔多少分钟；0 = 不冷却。 */
  voiceCooldownMinutes?: number;
  /** 语音服务地址；空 = 用环境变量或角色聊天地址。 */
  voiceApiBaseUrl?: string;
  /** 语音 Key 是否已保存（只回布尔）。 */
  voiceApiKeyConfigured?: boolean;
  /** 语音合成模型 / 音色 / 识别模型。 */
  ttsModel?: string;
  ttsVoice?: string;
  asrModel?: string;
  /** 语音服务商：openai（含兼容接口）/ minimax；空 = 按地址自动判断。 */
  ttsProvider?: string;
  /** MiniMax 的 GroupId。 */
  ttsGroupId?: string;
  /** 主动找话设置；服务端返回时一定带默认值填充。 */
  proactive?: {
    enabled: boolean;
    dailyMax: number;
    minGapMinutes: number;
    quietStart: string;
    quietEnd: string;
    userActiveMinutes: number;
    minConfidence: number;
  };
  /** 群聊「冷场了自己找话题」；同样由服务端补齐默认值。 */
  groupInitiative?: {
    enabled: boolean;
    idleMinutes: number;
    dailyMax: number;
    minGapMinutes: number;
    quietStart: string;
    quietEnd: string;
  };
};

export type TimelineEntry = {
  id: string;
  type: TimelineType;
  title: string;
  summary: string;
  time: string;
  channel: string;
  tag: string;
  tagTone: "green" | "purple" | "blue" | "amber" | "gray";
  source: string;
};

export type SnapshotAnalysis = {
  importantEvents: Array<{ title: string; detail: string; evidenceMessageIds: string[] }>;
  factAndPreferenceChanges: Array<{ description: string; changeType: string; evidenceMessageIds: string[] }>;
  relationshipChanges: Array<{ description: string; evidenceMessageIds: string[] }>;
  goalsAndCommitments: Array<{ description: string; status: string; evidenceMessageIds: string[] }>;
  unresolvedTopics: Array<{ description: string; evidenceMessageIds: string[] }>;
  differencesFromPrevious: string[];
  memoryChangesApplied: Array<{
    action: string;
    result: string;
    category?: string;
    content?: string;
    memoryItemId?: string;
    supersededMemoryId?: string;
    /** 被这条建议指向的旧记忆当前的内容 / 类别，用来做「改成什么 vs 现在是什么」的对照 */
    supersededCategory?: string;
    supersededContent?: string;
    confidence?: number;
    evidenceMessageIds?: string[];
    /** 人工处置结果；undefined 表示还没人处理过 */
    reviewDecision?: "ACCEPTED" | "IGNORED";
    reviewMemoryItemId?: string;
    reviewOutcome?: string;
  }>;
};

export type SnapshotSourceMessage = {
  id: string;
  role: string;
  eventType: string;
  content: string;
  occurredAt: string;
  conversationTitle: string | null;
};

export type Snapshot = {
  id: string;
  number: number;
  version: number;
  date: string;
  range: string;
  summary: string;
  events: number;
  messages: number;
  status: "当前版本" | "已被替代";
  statusTone: "green" | "gray";
  kind?: "AUTOMATIC" | "MANUAL";
  generatedBy?: string;
  model?: { name?: string; provider?: string; promptTemplateVersion?: string };
  analysis?: SnapshotAnalysis;
  reviewRejected?: number;
  sourceMessages?: SnapshotSourceMessage[];
};

export type DemoTask = {
  id: string;
  name: string;
  character: string;
  range: string;
  status: "等待执行" | "成功" | "失败待重试" | "跳过" | "运行中";
  tone: "amber" | "green" | "rose" | "gray" | "blue";
  tries: number;
  time: string;
};

export const initialCharacters: Character[] = [
  {
    id: "big-fish",
    name: "大肥鱼",
    alias: "日常陪伴型",
    description: "有点懒散但很贴心，喜欢和熟悉的人分享生活。",
    avatar: "鱼",
    avatarTone: "purple",
    status: "运行中",
    channels: ["QQ", "B站"],
    intervalDays: 8,
    nextSnapshot: "明天 09:00",
    memoryCount: 128,
    latestSnapshot: "10 月 21 日",
    personality: "温柔、爱吐槽、偶尔犯懒，对熟悉的人很有耐心。",
  },
  {
    id: "dragon-girl",
    name: "龙娘",
    alias: "幻想陪伴型",
    description: "自信又好奇，对新鲜事物充满探索欲。",
    avatar: "龙",
    avatarTone: "peach",
    status: "运行中",
    channels: ["QQ"],
    intervalDays: 14,
    nextSnapshot: "11 月 03 日 20:00",
    memoryCount: 76,
    latestSnapshot: "10 月 20 日",
    personality: "有一点傲娇，喜欢探索未知，也很珍惜建立的羁绊。",
  },
  {
    id: "stargazer",
    name: "星海旅人",
    alias: "自定义角色",
    description: "记录旅途见闻的观察者，安静而富有想象力。",
    avatar: "星",
    avatarTone: "blue",
    status: "已暂停",
    channels: [],
    intervalDays: 8,
    nextSnapshot: "暂停中",
    memoryCount: 34,
    latestSnapshot: "10 月 14 日",
    personality: "理性、温和、喜欢把零散见闻整理成故事。",
  },
];

export const initialTimeline: TimelineEntry[] = [
  {
    id: "evt-1",
    type: "event",
    title: "一起看了《孤独摇滚！》的剪辑",
    summary: "大肥鱼分享了最近收藏的片段，并聊到自己最喜欢的演出桥段。",
    time: "今天 08:42",
    channel: "QQ",
    tag: "互动事件",
    tagTone: "blue",
    source: "QQ 私聊 · 消息 #msg-2081",
  },
  {
    id: "evt-2",
    type: "memory",
    title: "记住了：用户喜欢深夜分享视频",
    summary: "连续几次互动都发生在晚上，用户更喜欢轻松、有趣而不太正式的交流。",
    time: "昨天 22:16",
    channel: "QQ",
    tag: "长期记忆",
    tagTone: "purple",
    source: "由 4 条对话提炼 · 记忆 #mem-0148",
  },
  {
    id: "evt-3",
    type: "message",
    title: "聊到周末想做的事情",
    summary: "用户说周末想找一部新番看，大肥鱼答应整理一份轻松向的片单。",
    time: "昨天 19:32",
    channel: "QQ",
    tag: "对话记录",
    tagTone: "green",
    source: "QQ 私聊 · 会话 #conv-041",
  },
  {
    id: "evt-4",
    type: "snapshot",
    title: "第 12 份阶段总结已生成",
    summary: "本阶段共整理 46 条消息、5 个重要事件和 2 项需要继续跟进的约定。",
    time: "10 月 21 日 09:00",
    channel: "全部渠道",
    tag: "阶段总结",
    tagTone: "amber",
    source: "阶段总结 #snap-0012 · 版本 1",
  },
  {
    id: "evt-5",
    type: "event",
    title: "关注了一个新的音乐频道",
    summary: "从 B 站内容摘要中发现用户最近开始关注轻音乐和 Lo-fi 播放列表。",
    time: "10 月 20 日 21:08",
    channel: "B站",
    tag: "内容事件",
    tagTone: "blue",
    source: "B站内容摘要 · 来源 #bv-381",
  },
];

export const initialSnapshots: Snapshot[] = [
  {
    id: "snap-12",
    number: 12,
    version: 1,
    date: "2026-10-21 09:00",
    range: "10 月 13 日 — 10 月 21 日",
    summary: "最近更习惯在晚间分享视频；已答应整理一份轻松向片单，尚待跟进。",
    events: 5,
    messages: 46,
    status: "当前版本",
    statusTone: "green",
  },
  {
    id: "snap-11",
    number: 11,
    version: 2,
    date: "2026-10-13 09:02",
    range: "10 月 5 日 — 10 月 13 日",
    summary: "重新生成的第 11 份阶段总结，修正了关于用户音乐偏好的描述，保留原版本供追溯。",
    events: 4,
    messages: 39,
    status: "当前版本",
    statusTone: "green",
  },
  {
    id: "snap-10",
    number: 10,
    version: 1,
    date: "2026-10-05 09:00",
    range: "9 月 27 日 — 10 月 5 日",
    summary: "首次记录到用户开始规律分享 B 站收藏，并更喜欢简洁直接的聊天方式。",
    events: 3,
    messages: 31,
    status: "已被替代",
    statusTone: "gray",
  },
];

export const initialTasks: DemoTask[] = [
  { id: "job-204", name: "生成阶段总结", character: "大肥鱼", range: "10/21 09:00 — 10/29 09:00", status: "等待执行", tone: "amber", tries: 0, time: "计划于明天 09:00" },
  { id: "job-203", name: "整理长期记忆", character: "大肥鱼", range: "当前周期", status: "成功", tone: "green", tries: 1, time: "今天 08:45" },
  { id: "job-202", name: "生成阶段总结", character: "龙娘", range: "10/20 20:00 — 11/03 20:00", status: "等待执行", tone: "amber", tries: 0, time: "计划于 11/03 20:00" },
  { id: "job-201", name: "同步外部事件", character: "大肥鱼", range: "B站内容摘要", status: "失败待重试", tone: "rose", tries: 2, time: "上次失败：10:14" },
  { id: "job-200", name: "检查周期活动", character: "星海旅人", range: "10/06 — 10/14", status: "跳过", tone: "gray", tries: 1, time: "10 月 14 日 09:00" },
];

export const channels = [
  { name: "QQ", description: "聊天消息与会话事件", status: "规划中", color: "purple" },
  { name: "B 站", description: "收藏、动态与内容摘要", status: "规划中", color: "blue" },
  { name: "Telegram", description: "机器人会话与命令", status: "预留", color: "green" },
];
