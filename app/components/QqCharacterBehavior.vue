<script setup lang="ts">
/**
 * 一张卡对应「角色 ↔ QQ 号/群」的一条绑定。
 *
 * 卡里分两层：
 * - 绑定级：群号、群聊回复策略、发言限流、刷 B站 —— 存在 binding.config，随绑定走
 * - 角色级：发表情、主动找话 —— 存在角色 modelConfig，多绑定时每张卡复用（改的是同一个角色）
 *
 * 绑定级保存走 POST /bindings（按 characterId+connectionId upsert），
 * 角色级保存走 PATCH /characters/:id，互不干扰。
 */
import { ArrowRight, Promotion } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

type ProactiveSettings = {
  enabled: boolean;
  dailyMax: number;
  minGapMinutes: number;
  quietStart: string;
  quietEnd: string;
  userActiveMinutes: number;
  minConfidence: number;
};

/**
 * 群聊「冷场了自己找话题」。
 *
 * 与私聊的 ProactiveSettings 是两套：私聊的节奏是「这个人」，群里的节奏是「这个群」，
 * 共用一个阈值必然有一边是错的（一个群安静两小时，另一个群一分钟几十条）。
 */
type GroupInitiativeSettings = {
  enabled: boolean;
  idleMinutes: number;
  dailyMax: number;
  minGapMinutes: number;
  quietStart: string;
  quietEnd: string;
};

type GroupInitiativeSnapshot = {
  settings: GroupInitiativeSettings;
  status: {
    canSendNow: boolean;
    reason: string;
    reasonLabel: string;
    groups: Array<{
      groupId: string;
      idleMinutes: number;
      sentToday: number;
      lastInitiativeAt: string | null;
      canSendNow: boolean;
      reason: string;
      reasonLabel: string;
    }>;
  };
};

type ProactiveSnapshot = {
  settings: ProactiveSettings;
  /** 群聊「冷场了自己找话题」的现状：和私聊那条各自独立。 */
  group: GroupInitiativeSnapshot;
  status: {
    sentToday: number;
    pendingCount: number;
    recipient: string | null;
    lastSentAt: string | null;
    gapRemainingMinutes: number;
    quietNow: boolean;
    quotaExceeded: boolean;
    canSendNow: boolean;
    reason: string;
    reasonLabel: string;
  };
  recent: Array<{
    id: string;
    kind: string;
    goal: string;
    status: string;
    content: string | null;
    confidence: number;
    sentAt: string | null;
  }>;
};

const props = defineProps<{
  characterId: string;
  connectionId: string;
  routingKey: string | null;
  replyWindowMinutes: number;
  replyLimitPerWindow: number;
  replyOnlyWhenMentioned: boolean;
  /** 群聊策略：模式 + 攒批/闸门参数。后端已把默认值补齐，这里直接用。 */
  groupChat: {
    mode: "mention" | "ambient" | "all";
    batchWindowSeconds: number;
    mentionWindowSeconds: number;
    minGapSeconds: number;
    dailyMax: number;
    quietStart: string;
    quietEnd: string;
    ambientChance: number;
    aliases: string[];
  };
  /**
   * 按群覆盖的模式：`{ "<群号>": "mention" | "ambient" | "all" }`。
   * 一条绑定可以挂好几个群，而「一个群只看被 @、另一个群随便聊」很常见；
   * 没在这张表里的群沿 `groupChat.mode`。
   */
  groupChatModes?: Record<string, "mention" | "ambient" | "all">;
  groupBiliRunEnabled: boolean;
  emojiEnabled: boolean;
  /** 表情额度：多少分钟内最多贴几次（贴图与内置表情共用，按会话分别算）。 */
  emojiWindowMinutes?: number;
  emojiPerWindow?: number;
  /** 群友发的图要不要交给视觉模型读；角色级开关，默认关。 */
  imageUnderstanding: boolean;
  /** 群里的图要不要自动收进她的表情库；角色级开关，默认关。 */
  stickerAutoCollect: boolean;
  /** 群聊之后要不要自动扫一遍群里的梗；角色级开关，默认关。 */
  catchphraseAutoMine: boolean;
  /** 她的回复能不能发成语音条；角色级开关，默认关。 */
  voiceEnabled: boolean;
  /** 她听不听得懂别人发的语音；角色级开关，默认关。 */
  voiceTranscribe: boolean;
  /** 发语音的概率（0-100）。 */
  voiceChance: number;
  /** 两条语音之间至少隔多少分钟；0 = 不冷却。服务端会补默认值，这里留兜底。 */
  voiceCooldownMinutes?: number;
  /** 服务端总会带默认值；这里仍留兜底，避免老数据没有这段时表单是空的 */
  proactive?: ProactiveSettings;
  /** 群聊找话题；同样是服务端补默认值，这里只做兜底。 */
  groupInitiative?: GroupInitiativeSettings;
}>();

const emit = defineEmits<{ saved: [] }>();

const FALLBACK: ProactiveSettings = {
  enabled: false,
  dailyMax: 2,
  minGapMinutes: 180,
  quietStart: "23:00",
  quietEnd: "08:00",
  userActiveMinutes: 30,
  minConfidence: 0.4,
};

const GROUP_FALLBACK: GroupInitiativeSettings = {
  enabled: false,
  idleMinutes: 60,
  dailyMax: 3,
  minGapMinutes: 180,
  quietStart: "23:30",
  quietEnd: "07:30",
};

const KIND_LABELS: Record<string, string> = {
  SHARE: "分享",
  ASK: "想问",
  INVITE: "邀约",
  CONFIDE: "心里话",
  CURIOUS: "好奇",
  FOLLOWUP: "追问",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "待说",
  SENT: "已发",
  SKIPPED: "略过",
  EXPIRED: "过期",
};

// ── 角色级草稿 ─────────────────────────────────────────
const emoji = ref(props.emojiEnabled);
/**
 * 表情额度：每 N 分钟最多 N 张。
 *
 * 原来是「上一条贴过之后 X 分钟内不许再贴」，它跟聊天密度无关：群里刷得快，
 * 四分钟能过二十条消息。改成窗口内计数后，热聊时贴得出来、冷清时也不会攒着不用。
 */
const emojiWindow = ref(props.emojiWindowMinutes ?? 10);
const emojiPerWindow = ref(props.emojiPerWindow ?? 3);
const savingEmojiRate = ref(false);
const imageUnderstanding = ref(props.imageUnderstanding);
const stickerAutoCollect = ref(props.stickerAutoCollect);
const catchphraseAutoMine = ref(props.catchphraseAutoMine);
const savingCatchphraseAutoMine = ref(false);
// 语音开关与概率留在这里（这是「行为」，不是「模型配置」）；服务商、Key、音色在「模型设置 → 语音模型」。
const voice = reactive({
  enabled: props.voiceEnabled,
  transcribe: props.voiceTranscribe,
  chance: props.voiceChance,
  // 冷却也属于「行为」：它决定她多久才又肯开口，和用哪家服务商无关。
  cooldown: props.voiceCooldownMinutes ?? 20,
});
const draft = ref<ProactiveSettings>({ ...FALLBACK, ...(props.proactive ?? {}) });
const groupDraft = ref<GroupInitiativeSettings>({ ...GROUP_FALLBACK, ...(props.groupInitiative ?? {}) });
const snapshot = ref<ProactiveSnapshot | null>(null);
const savingEmoji = ref(false);
const savingImageUnderstanding = ref(false);
const savingStickerAutoCollect = ref(false);
const savingVoice = ref(false);
const savingProactive = ref(false);
const savingGroupInitiative = ref(false);
const trying = ref(false);
const tryingGroup = ref(false);

// ── 绑定级草稿 ─────────────────────────────────────────
/** 群号表在页面里是数组，库里是逗号分隔的一串；两处互转只走这一对函数。 */
function readRoutingKeys(routingKey: string | null): string[] {
  return routingKey ? routingKey.split(",").map((key) => key.trim()).filter(Boolean) : [];
}

const bind = reactive({
  routingKeys: readRoutingKeys(props.routingKey),
  replyWindowMinutes: props.replyWindowMinutes,
  replyLimitPerWindow: props.replyLimitPerWindow,
  groupChatMode: props.groupChat.mode,
  minGapSeconds: props.groupChat.minGapSeconds,
  dailyMax: props.groupChat.dailyMax,
  // 界面用百分比，存的是 0-1 的小数。
  ambientChancePercent: Math.round(props.groupChat.ambientChance * 100),
  quietStart: props.groupChat.quietStart,
  quietEnd: props.groupChat.quietEnd,
  groupAliases: props.groupChat.aliases.join("，"),
  groupBiliRunEnabled: props.groupBiliRunEnabled,
});
const savingBind = ref(false);

/** el-input-tag 清空时可能给 undefined，模板里到处 `length` 会炸；统一从这里取。 */
const groupKeyList = computed<string[]>(() => (Array.isArray(bind.routingKeys) ? bind.routingKeys : []));

// ── 按群覆盖的模式（群号 → 档位）──────────────────────
type GroupChatMode = "mention" | "ambient" | "all";

const MODE_SHORT: Record<GroupChatMode, string> = {
  mention: "只回 @",
  ambient: "自然接话",
  all: "全都回",
};

const MODE_OPTIONS: ReadonlyArray<{ value: GroupChatMode; label: string }> = [
  { value: "mention", label: "仅被 @ 时回复" },
  { value: "ambient", label: "自然接话" },
  { value: "all", label: "所有消息都回复" },
];

function isGroupChatMode(value: unknown): value is GroupChatMode {
  return value === "mention" || value === "ambient" || value === "all";
}

/**
 * 每个群自己的那一档，值是档位或 `INHERIT`（跟绑定默认档）。
 *
 * 为什么另开一份草稿而不是直接读 props：群号是手敲进去的，刚敲完还没保存时
 * props 里没有它，但用户这时就想选档位了 —— 要求「先保存一次才能设」很别扭。
 *
 * 为什么不用空串表示「跟默认」：Element 的下拉框把空串当没选，会显示占位符
 * 「请选择」，反而看不出「它跟默认一样」。
 */
const INHERIT = "inherit";
const modeOverrides = ref<Record<string, string>>({});

/**
 * 重建按群草稿。传了 `source` 就整份以它为准（保存后刷新时用），
 * 不传则保留已经选好的值、只补新群号、删已移除的群号（手改群号表时用）。
 */
function syncOverrides(keys: string[], source?: Record<string, string | undefined>) {
  const next: Record<string, string> = {};
  for (const key of keys) {
    const stored = source ? source[key] : modeOverrides.value[key];
    next[key] = isGroupChatMode(stored) ? stored : INHERIT;
  }
  modeOverrides.value = next;
}

syncOverrides(readRoutingKeys(props.routingKey), props.groupChatModes ?? {});

function setOverride(group: string, value: unknown) {
  modeOverrides.value = { ...modeOverrides.value, [group]: isGroupChatMode(value) ? value : INHERIT };
}

/** 已存的按群设置条目数：群号表空着时用它提示「东西还在，只是看不到」。 */
const overrideCount = computed(() => Object.keys(props.groupChatModes ?? {}).length);

// 群号表变了：新群号补一个「跟默认」，删掉的不再提交
watch(() => groupKeyList.value.join(","), () => {
  syncOverrides(groupKeyList.value);
});

/** 刻度上的位置：三档是顺序关系，不是三个并列开关 */
const modeIndex = computed(() => {
  const order = ["mention", "ambient", "all"] as const;
  const index = order.indexOf(bind.groupChatMode as (typeof order)[number]);
  return index < 0 ? 1 : index;
});

/** 刻度下面那一句：说清这一档会发生什么，而不是复述选项名 */
const modeNote = computed(() => {
  if (bind.groupChatMode === "mention") {
    return "只有 @ 她、或者叫到名字才会看；名字也可能是在叫别的鱼，拿不准就不接。参与过的话题还能接一句；私聊永远会回。";
  }
  if (bind.groupChatMode === "all") return "每轮都回（不再逐条），群里一热闹就会刷屏，也最容易一次把额度用完。";
  return "所有消息都可能看一眼：被 @ 一定会回，水群看上下文再决定说不说。";
});

/**
 * 参数区该显示哪些：只要**有一个群**会用到，就得放出来。
 * 默认档是「仅被 @」、某个群设成「自然接话」时，下面那堆节奏参数正是给那个群用的，
 * 藏起来等于「它在用、页面上看不到」。
 */
const needsAmbientParams = computed(() =>
  bind.groupChatMode === "ambient" || Object.values(modeOverrides.value).includes("ambient"));

const needsAliases = computed(() =>
  bind.groupChatMode !== "all"
  || Object.values(modeOverrides.value).some((mode) => mode !== INHERIT && mode !== "all"));

/**
 * 「节奏与限制」折叠头的一句话摘要。
 * 这批参数设一次就不管，所以收进折叠；摘要让人不展开也能看到当前值。
 * 值只有这一份（摘要即外观、展开即编辑）—— 上一版折叠失败正是因为
 * 外面摆一排只读数字、里面再编一遍，同一批值出现两次。
 */
const paceSummary = computed(() => {
  const parts: string[] = [];
  if (needsAmbientParams.value) {
    parts.push(`至少隔 ${bind.minGapSeconds} 秒`);
    parts.push(bind.dailyMax > 0 ? `每天最多 ${bind.dailyMax} 句` : "每天不限句数");
    parts.push(`${bind.quietStart}–${bind.quietEnd} 安静`);
    parts.push(`闲聊参与 ${bind.ambientChancePercent}%`);
  }
  parts.push(bind.replyLimitPerWindow > 0
    ? `每 ${bind.replyWindowMinutes} 分钟最多 ${bind.replyLimitPerWindow} 条`
    : "回复不限流");
  if (bind.groupBiliRunEnabled) parts.push("B站口令开");
  return parts.join(" · ");
});

// 父级保存后会重新拉列表，这里跟着把草稿同步成库里的值
watch(() => props.emojiEnabled, (value) => {
  emoji.value = value;
});
watch(() => props.imageUnderstanding, (value) => {
  imageUnderstanding.value = value;
});
watch(() => props.stickerAutoCollect, (value) => {
  stickerAutoCollect.value = value;
});
watch(() => props.catchphraseAutoMine, (value) => {
  catchphraseAutoMine.value = value;
});
watch(
  () => [props.voiceEnabled, props.voiceTranscribe, props.voiceChance, props.voiceCooldownMinutes],
  () => {
    voice.enabled = props.voiceEnabled;
    voice.transcribe = props.voiceTranscribe;
    voice.chance = props.voiceChance;
    voice.cooldown = props.voiceCooldownMinutes ?? 20;
  },
);
// 保存成功后父级会重拉列表，额度跟着库里的值（服务端会把默认值补齐）
watch(() => [props.emojiWindowMinutes, props.emojiPerWindow], () => {
  emojiWindow.value = props.emojiWindowMinutes ?? 10;
  emojiPerWindow.value = props.emojiPerWindow ?? 3;
});
watch(() => props.proactive, (value) => {
  draft.value = { ...FALLBACK, ...(value ?? {}) };
}, { deep: true });
watch(() => props.groupInitiative, (value) => {
  groupDraft.value = { ...GROUP_FALLBACK, ...(value ?? {}) };
}, { deep: true });
watch(
  () => [
    props.routingKey,
    props.replyWindowMinutes,
    props.replyLimitPerWindow,
    props.replyOnlyWhenMentioned,
    props.groupChat,
    props.groupChatModes,
    props.groupBiliRunEnabled,
  ],
  () => {
    bind.routingKeys = readRoutingKeys(props.routingKey);
    bind.replyWindowMinutes = props.replyWindowMinutes;
    bind.replyLimitPerWindow = props.replyLimitPerWindow;
    bind.groupChatMode = props.groupChat.mode;
    bind.minGapSeconds = props.groupChat.minGapSeconds;
    bind.dailyMax = props.groupChat.dailyMax;
    bind.ambientChancePercent = Math.round(props.groupChat.ambientChance * 100);
    bind.quietStart = props.groupChat.quietStart;
    bind.quietEnd = props.groupChat.quietEnd;
    bind.groupAliases = props.groupChat.aliases.join("，");
    bind.groupBiliRunEnabled = props.groupBiliRunEnabled;
    // 保存成功后父级会重新拉列表，按群草稿跟着以库里的为准
    syncOverrides(bind.routingKeys, props.groupChatModes ?? {});
  },
  { deep: true },
);

function readError(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

// ── 绑定级保存 ─────────────────────────────────────────
async function saveBind() {
  if (savingBind.value) return;
  savingBind.value = true;
  // 只提交当前群号列表里的覆盖项：群号删了，它那一档也就没意义了（后端不会再路由到它）。
  const groupChatModes: Record<string, GroupChatMode> = {};
  for (const key of groupKeyList.value) {
    const mode = modeOverrides.value[key];
    if (isGroupChatMode(mode)) groupChatModes[key] = mode;
  }
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(props.connectionId)}/bindings`, {
      method: "POST",
      body: {
        characterId: props.characterId,
        routingKey: groupKeyList.value.join(","),
        replyWindowMinutes: bind.replyWindowMinutes,
        replyLimitPerWindow: bind.replyLimitPerWindow,
        groupChatMode: bind.groupChatMode,
        // 群号列表空着（= 收所有群 + 私聊）时页面上看不到按群设置，顺手清掉等于一次
        // 看不见的数据丢失，所以原样带着；后端仍会按群号应用它们。
        groupChatModes: groupKeyList.value.length ? groupChatModes : { ...(props.groupChatModes ?? {}) },
        minGapSeconds: bind.minGapSeconds,
        dailyMax: bind.dailyMax,
        ambientChance: bind.ambientChancePercent / 100,
        quietStart: bind.quietStart,
        quietEnd: bind.quietEnd,
        groupAliases: bind.groupAliases,
        groupBiliRunEnabled: bind.groupBiliRunEnabled,
      },
    });
    ElMessage.success("群聊行为已保存。");
    emit("saved");
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingBind.value = false;
  }
}

// ── 角色级：发表情 / 主动找话 ───────────────────────────
async function loadSnapshot() {
  try {
    snapshot.value = await $fetch<ProactiveSnapshot>(
      `/api/characters/${encodeURIComponent(props.characterId)}/proactive`,
    );
  } catch {
    // 读不到状态不影响改设置
    snapshot.value = null;
  }
}

onMounted(loadSnapshot);

async function onEmojiChange(next: string | number | boolean) {
  if (savingEmoji.value) return;
  const value = next === true;
  savingEmoji.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { emojiEnabled: value },
    });
    ElMessage.success(value ? "已开启：QQ 回复偶尔会单独跟一张表情。" : "已关闭：QQ 回复不再带表情。");
    emit("saved");
  } catch (error) {
    emoji.value = !value;
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingEmoji.value = false;
  }
}

/**
 * 改额度就存。
 *
 * 两个数字是一组（每 N 分钟最多 M 张），所以一起提交 —— 只改一个的话，
 * 存的过程中会出现「10 分钟最多 20 张」这种半步状态。
 */
async function onEmojiRateChange() {
  if (savingEmojiRate.value) return;
  savingEmojiRate.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: {
        emojiWindowMinutes: emojiWindow.value,
        emojiPerWindow: emojiPerWindow.value,
      },
    });
    ElMessage.success(`已保存：每 ${emojiWindow.value} 分钟最多 ${emojiPerWindow.value} 张。`);
    emit("saved");
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingEmojiRate.value = false;
  }
}

async function onImageUnderstandingChange(next: string | number | boolean) {
  if (savingImageUnderstanding.value) return;
  const value = next === true;
  savingImageUnderstanding.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { imageUnderstanding: value },
    });
    ElMessage.success(value
      ? "已开启：群友发的图会先读成几句文字，再交给她回复。"
      : "已关闭：群里的图又变回 [图片]。");
    emit("saved");
  } catch (error) {
    imageUnderstanding.value = !value;
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingImageUnderstanding.value = false;
  }
}

async function onStickerAutoCollectChange(next: string | number | boolean) {
  if (savingStickerAutoCollect.value) return;
  const value = next === true;
  savingStickerAutoCollect.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { stickerAutoCollect: value },
    });
    ElMessage.success(value
      ? "已开启：群里发来的图会存进她的表情库，并自动起名。"
      : "已关闭：不再自动收群里的图。");
    emit("saved");
  } catch (error) {
    stickerAutoCollect.value = !value;
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingStickerAutoCollect.value = false;
  }
}

async function onCatchphraseAutoMineChange(next: string | number | boolean) {
  if (savingCatchphraseAutoMine.value) return;
  const value = next === true;
  savingCatchphraseAutoMine.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { catchphraseAutoMine: value },
    });
    ElMessage.success(value
      ? "已开启：群聊之后会顺手扫一遍，捡到的梗先待在「待确认」里，你点头她才会说。"
      : "已关闭：不再自动扫群里的梗。");
    emit("saved");
  } catch (error) {
    catchphraseAutoMine.value = !value;
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingCatchphraseAutoMine.value = false;
  }
}

/**
 * 语音开关与概率一起提交。服务商、Key、音色已经搬到「模型设置 → 语音模型」，
 * 这里只留「行为」这一半：她发不发语音、听不听得懂、随机发的概率。
 */
async function saveVoice() {
  if (savingVoice.value) return;
  savingVoice.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: {
        voiceEnabled: voice.enabled,
        voiceTranscribe: voice.transcribe,
        voiceChance: voice.chance,
        voiceCooldownMinutes: voice.cooldown,
      },
    });
    ElMessage.success(voice.enabled || voice.transcribe
      ? "语音设置已保存。"
      : "已关闭语音：她又只发文字、也不再转写别人的语音。");
    emit("saved");
  } catch (error) {
    // 回滚成服务端的值：保存失败时界面不能停在「已开启」。
    voice.enabled = props.voiceEnabled;
    voice.transcribe = props.voiceTranscribe;
    voice.chance = props.voiceChance;
    voice.cooldown = props.voiceCooldownMinutes ?? 20;
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingVoice.value = false;
  }
}

/** silent：试跑前要先落库，那一步不该再弹一次「已保存」 */
async function saveProactive(silent = false): Promise<boolean> {
  if (savingProactive.value) return false;
  savingProactive.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { proactive: { ...draft.value } },
    });
    if (!silent) ElMessage.success("主动找话设置已保存。");
    emit("saved");
    await loadSnapshot();
    return true;
  } catch (error) {
    ElMessage.error(readError(error, "保存失败：安静时段起止不能相同。"));
    return false;
  } finally {
    savingProactive.value = false;
  }
}

async function tryOnce() {
  if (trying.value || savingProactive.value) return;
  trying.value = true;
  try {
    const saved = await saveProactive(true);
    if (!saved) return;
    const result = await $fetch<{
      status: string;
      reason: string;
      reasonLabel: string;
      content: string | null;
      detail: string | null;
    }>(`/api/characters/${encodeURIComponent(props.characterId)}/proactive/try`, { method: "POST" });

    if (result.status === "sent") ElMessage.success(`发出去了：「${result.content ?? ""}」`);
    else if (result.status === "skipped") ElMessage.warning(`这次没发：${result.reasonLabel}`);
    else ElMessage.error(`这次失败：${result.reasonLabel}${result.detail ? `（${result.detail}）` : ""}`);
    await loadSnapshot();
  } catch (error) {
    ElMessage.error(readError(error, "试跑失败，请稍后重试。"));
  } finally {
    trying.value = false;
  }
}

/** 安静了多久：超过 60 分钟说成小时，页面上一排「137 分钟」读起来费劲。 */
function formatIdle(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

async function saveGroupInitiative(silent = false): Promise<boolean> {
  if (savingGroupInitiative.value) return false;
  savingGroupInitiative.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { groupInitiative: { ...groupDraft.value } },
    });
    if (!silent) ElMessage.success("群内找话题设置已保存。");
    emit("saved");
    await loadSnapshot();
    return true;
  } catch (error) {
    ElMessage.error(readError(error, "保存失败：安静时段起止不能相同。"));
    return false;
  } finally {
    savingGroupInitiative.value = false;
  }
}

/** 「立即试一次」会真往群里发一条，所以先落库再跑，跑完把结果原样说清楚。 */
async function tryGroupOnce() {
  if (tryingGroup.value || savingGroupInitiative.value) return;
  tryingGroup.value = true;
  try {
    const saved = await saveGroupInitiative(true);
    if (!saved) return;
    const result = await $fetch<{
      status: string;
      reason: string;
      reasonLabel: string;
      groupId: string | null;
      content: string | null;
      detail: string | null;
    }>(`/api/characters/${encodeURIComponent(props.characterId)}/proactive/group-try`, { method: "POST" });

    const where = result.groupId ? `（群 ${result.groupId}）` : "";
    if (result.status === "sent") ElMessage.success(`已经在群里说了${where}：「${result.content ?? ""}」`);
    else if (result.status === "skipped") ElMessage.warning(`这次没说：${result.reasonLabel}`);
    else ElMessage.error(`这次失败：${result.reasonLabel}${result.detail ? `（${result.detail}）` : ""}`);
    await loadSnapshot();
  } catch (error) {
    ElMessage.error(readError(error, "试跑失败，请稍后重试。"));
  } finally {
    tryingGroup.value = false;
  }
}
</script>

<template>
  <div class="beh">
    <!-- 一组：这个群。绑定级设置都收在这里，改它只影响这一行 -->
    <section class="grp">
      <div class="grp-h">
        <b>这个群</b>
        <span class="grp-tag">只对这条生效</span>
      </div>

      <!-- 刻度上面加一句「这是默认档」：一条绑定挂多个群时，下面的按群设置才是逐群的，
           不加这句会让人以为刻度只对第一个群生效。 -->
      <span
        v-if="groupKeyList.length >= 2"
        class="beh-label dial-lead"
      >默认档：没在下面单独设过的群用这一档</span>

      <!-- 一条刻度：三档是同一个维度的强弱，不该是三排开关 -->
      <div
        class="dial"
        :data-at="modeIndex"
        role="radiogroup"
        aria-label="群聊参与度"
      >
        <button
          type="button"
          class="dial-opt"
          role="radio"
          :aria-checked="bind.groupChatMode === 'mention'"
          @click="bind.groupChatMode = 'mention'"
        >
          <b>仅被 @ 时回复</b>
          <span>叫到才看，判断后回</span>
        </button>
        <button
          type="button"
          class="dial-opt"
          role="radio"
          :aria-checked="bind.groupChatMode === 'ambient'"
          @click="bind.groupChatMode = 'ambient'"
        >
          <b>自然接话</b>
          <span>被 @ 会回，水群看上下文</span>
        </button>
        <button
          type="button"
          class="dial-opt"
          role="radio"
          :aria-checked="bind.groupChatMode === 'all'"
          @click="bind.groupChatMode = 'all'"
        >
          <b>所有消息都回复</b>
          <span>每轮都接，群里会刷屏</span>
        </button>
      </div>

      <p class="dial-note">
        {{ modeNote }}
      </p>

      <!-- 明面上只留天天调的：群号 / 按群 / 别名。节奏、安静、限流这批设一次就不管的
           收进后面的「节奏与限制」折叠，折叠头直接显示当前值，不展开也知道现在是什么。 -->
      <div class="beh-grid is-bind">
        <div class="beh-field">
          <span class="beh-label">群号（可留空）</span>
          <el-input-tag
            v-model="bind.routingKeys"
            placeholder="留空 = 私聊 + 所有群"
            :max="50"
            clearable
          />
          <em>填了群号就只在这些群里回复；可填多个群号，回车或输入逗号确认一个。</em>
        </div>

        <!-- 一条绑定挂多个群时，各群的「存在感」经常不一样（大群只看被 @、小群随便聊）。
             这里逐群覆盖上面那档；只有一个群就不显示 —— 那跟刻度重复，白占一行。 -->
        <div
          v-if="groupKeyList.length >= 2"
          class="beh-field is-wide"
        >
          <span class="beh-label">按群分别设</span>
          <div class="pg">
            <div
              v-for="group in groupKeyList"
              :key="group"
              class="pg-row"
            >
              <span class="pg-id">{{ group }}</span>
              <el-select
                :model-value="modeOverrides[group] ?? INHERIT"
                class="pg-sel"
                @change="(value: unknown) => setOverride(group, value)"
              >
                <el-option
                  :label="`跟默认一样（${MODE_SHORT[bind.groupChatMode]}）`"
                  :value="INHERIT"
                />
                <el-option
                  v-for="option in MODE_OPTIONS"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </div>
          </div>
          <em>只改这一个群的档位；节奏、安静、限流仍在下面「节奏与限制」里（所有群共用）。</em>
        </div>

        <!-- 群号表空着 = 收所有群，按群设置没有群号可展示。存过的条目留着不动，
             这里只把「东西还在」说出来，免得以后填上群号看到一堆旧档位以为见了鬼。 -->
        <div
          v-else-if="overrideCount > 0"
          class="beh-field is-wide"
        >
          <em>这条绑定现在收所有群；之前按群设过的 {{ overrideCount }} 项还在，填上群号就能看到并修改。</em>
        </div>

        <!-- 别名在「仅被 @」下也生效：后端把「叫到名字」当成弱线索，
             会结合上下文判断是不是在叫她；只有「每条都回」用不上 -->
        <div
          v-if="needsAliases"
          class="beh-field"
        >
          <span class="beh-label">群里怎么叫她</span>
          <el-input
            v-model="bind.groupAliases"
            placeholder="小鱼，大傻鱼，小鲸鱼"
          />
          <em>逗号分隔。没 @ 但叫到这些名字，她会看一眼再决定：群里同名的鱼可能不止一条。</em>
        </div>
      </div>

      <!-- 设一次就不管的参数全在这条折叠里；头上的摘要就是当前值 -->
      <details class="more is-toggle">
        <summary>
          <span class="more-sum">节奏与限制</span>
          <span class="more-sub">{{ paceSummary }}</span>
          <span class="grow" />
          <el-icon class="more-caret">
            <ArrowRight />
          </el-icon>
        </summary>

        <div class="more-body">
          <div class="beh-grid">
            <div
              v-if="needsAmbientParams"
              class="beh-field"
            >
              <span class="beh-label">说话节奏</span>
              <div class="beh-limit">
                <span>两条之间至少隔</span>
                <el-input-number
                  v-model="bind.minGapSeconds"
                  :min="0"
                  :max="3600"
                  :step="30"
                />
                <span>秒，每天最多</span>
                <el-input-number
                  v-model="bind.dailyMax"
                  :min="0"
                  :max="1000"
                  :step="10"
                />
                <span>句</span>
              </div>
              <em>0 句 = 不限。觉得她太吵就先调小「每天最多」。</em>
            </div>

            <div
              v-if="needsAmbientParams"
              class="beh-field"
            >
              <span class="beh-label">安静时段</span>
              <div class="beh-quiet">
                <el-time-select
                  v-model="bind.quietStart"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="23:30"
                />
                <span class="beh-quiet-sep">到</span>
                <el-time-select
                  v-model="bind.quietEnd"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="07:30"
                />
              </div>
              <em>这段时间里，除了有人 @ 她，都不主动接话。允许跨午夜。</em>
            </div>

            <div
              v-if="needsAmbientParams"
              class="beh-field"
            >
              <span class="beh-label">无关闲聊的参与概率</span>
              <div class="beh-limit">
                <el-input-number
                  v-model="bind.ambientChancePercent"
                  :min="0"
                  :max="100"
                  :step="5"
                />
                <span>%</span>
              </div>
              <em>跟她完全没关系的聊天，按这个比例放进去看一眼再说。调高更活跃，也更费 token。</em>
            </div>

            <div class="beh-field">
              <span class="beh-label">群聊发言限流</span>
              <div class="beh-limit">
                <span>每</span>
                <el-input-number
                  v-model="bind.replyWindowMinutes"
                  :min="1"
                  :max="1440"
                  :step="5"
                />
                <span>分钟最多回复</span>
                <el-input-number
                  v-model="bind.replyLimitPerWindow"
                  :min="0"
                  :max="100"
                  :step="1"
                />
                <span>条</span>
              </div>
              <em>0 条 = 不限。按群分别计数，只统计她自己的回复。</em>
            </div>
          </div>

          <!-- 绑定级开关：只在这个号/群生效，所以留在第一组 -->
          <div class="toggle">
            <span class="toggle-copy">
              <b>主人的 B站 口令</b>
              <span>主人在群里说口令时跑一轮 B站 值班；主人 QQ 在连接设置里填</span>
            </span>
            <el-switch v-model="bind.groupBiliRunEnabled" />
          </div>
        </div>
      </details>
    </section>

    <!-- 二组：这个角色。角色级开关改一次影响所有绑定，所以单独成组、标题写明 -->
    <section class="grp">
      <div class="grp-h">
        <b>这个角色</b>
        <span class="grp-tag">所有群共用</span>
      </div>

      <div class="toggle">
        <span class="toggle-copy">
          <b>发表情</b>
          <span>回复时偶尔单独跟一张表情；只影响 QQ。</span>
        </span>
        <el-switch
          v-model="emoji"
          :loading="savingEmoji"
          @change="onEmojiChange"
        />
      </div>

      <!-- 额度挂在开关下面：它只在开着的时候有意义，摆平了会像是另一个独立开关 -->
      <div
        v-if="emoji"
        class="beh-field emoji-rate"
      >
        <span class="beh-label">表情额度</span>
        <div class="beh-limit">
          <span>每</span>
          <el-input-number
            v-model="emojiWindow"
            :min="1"
            :max="1440"
            :step="5"
            :disabled="savingEmojiRate"
            @change="onEmojiRateChange"
          />
          <span>分钟最多</span>
          <el-input-number
            v-model="emojiPerWindow"
            :min="1"
            :max="20"
            :step="1"
            :disabled="savingEmojiRate"
            @change="onEmojiRateChange"
          />
          <span>张</span>
        </div>
        <em>贴图和内置表情共用这一个额度，按每个群 / 每个私聊分别算：A 群贴满了不影响 B 群。</em>
      </div>

      <div class="toggle">
        <span class="toggle-copy">
          <b>看群里的图</b>
          <span>群友发图先读成几句文字再回，一轮最多读 3 张；不开只看到「[图片]」。</span>
        </span>
        <el-switch
          v-model="imageUnderstanding"
          :loading="savingImageUnderstanding"
          @change="onImageUnderstandingChange"
        />
      </div>

      <div class="toggle">
        <span class="toggle-copy">
          <b>偷表情包</b>
          <span>自动把群里的图存进她的表情库并起名（一轮最多 1 张）；她自己的图不偷。</span>
        </span>
        <el-switch
          v-model="stickerAutoCollect"
          :loading="savingStickerAutoCollect"
          @change="onStickerAutoCollectChange"
        />
      </div>

      <div class="toggle">
        <span class="toggle-copy">
          <b>捡群里的梗</b>
          <span>把群里反复出现的说法收进梗语录页，等你点头她才会用。</span>
        </span>
        <el-switch
          v-model="catchphraseAutoMine"
          :loading="savingCatchphraseAutoMine"
          @change="onCatchphraseAutoMineChange"
        />
      </div>
    </section>

    <!-- 三组：更多能力。语音 / 主动找话 / 群里找话题都是「她主动做的、带一整套参数」，
         既不是纯绑定级开关也不是纯角色级开关，单独成组，别再塞回「这个角色」里
         —— 那会让整张面板变成一条分不清层级的长列表。 -->
    <section class="grp grp-caps">
      <div class="grp-h">
        <b>更多能力</b>
        <span class="grp-tag">她主动开口 / 发语音，各自带一套参数</span>
      </div>

      <!-- 语音：说话与听懂是两个开关，但同属一件事；带概率参数，所以是可展开行 -->
      <details class="more is-toggle">
        <summary>
          <span class="more-sum">语音</span>
          <span class="grp-tag">她发语音条 / 听懂别人发的语音</span>
          <span class="grow" />
          <span
            class="pill"
            :class="voice.enabled || voice.transcribe ? 'pill-green' : 'pill-gray'"
          >{{ voice.enabled || voice.transcribe ? "已开启" : "默认关闭" }}</span>
          <el-icon class="more-caret">
            <ArrowRight />
          </el-icon>
        </summary>

        <div class="more-body">
          <p class="beh-lead">
            语音要单独一家服务商：DeepSeek 这类纯文本服务商的
            <code>/audio/speech</code> 直接 404。服务商、Key、音色、识别模型都在
            <b>「模型设置 → 语音模型」</b>里配，这里只管「她发不发、听不听得懂」。
          </p>

          <div class="beh-field">
            <div class="beh-inline">
              <span class="beh-label">发语音</span>
              <el-switch v-model="voice.enabled" />
            </div>
            <em>打开后，群里/私聊里有人让她「发个语音」时她会真的发一条（60 字以内）。合成失败就退回发文字，不会让这一轮没声。</em>
          </div>

          <div class="beh-field">
            <div class="beh-inline">
              <span class="beh-label">她自己随机发语音</span>
              <span class="beh-value">{{ voice.chance }}%</span>
            </div>
            <el-slider
              v-model="voice.chance"
              :min="0"
              :max="100"
              :step="5"
              :disabled="!voice.enabled"
            />
            <em>
              默认 0 = 只有被要求时才发。语音合成实测要十几秒（服务商的排队开销，与字数无关），
              所以随机发等于随机让一条回复迟到 —— 除非你的服务商很快，否则别调高。
            </em>
          </div>

          <div class="beh-field">
            <span class="beh-label">两条语音至少隔</span>
            <div class="beh-limit">
              <el-input-number
                v-model="voice.cooldown"
                :min="0"
                :max="1440"
                :step="5"
                :disabled="!voice.enabled"
              />
              <span>分钟</span>
            </div>
            <em>
              默认 20 分钟。它只挡「她自己随机开口」那部分：被明确要求「发个语音」时冷却不生效，直接发。
              填 0 = 不冷却 —— 用 MiniMax 这类 1~3 秒合成的服务商可以调小，合成慢的别调。
              概率是 0 时这条本来也不起作用。
            </em>
          </div>

          <div class="beh-field">
            <div class="beh-inline">
              <span class="beh-label">听懂语音</span>
              <el-switch v-model="voice.transcribe" />
            </div>
            <em>群友发语音条时先转成文字再交给她，正文里的「[语音]」会变成「[语音：转写]」。一轮最多转 2 条、单条不超过 60 秒，转写失败就当没听见。</em>
          </div>

          <div class="beh-state">
            <span class="beh-meta">语音按字符/秒计费，不进 token 额度报表。</span>
            <span class="grow" />
            <button
              type="button"
              class="beh-btn is-lead"
              :disabled="savingVoice"
              @click="saveVoice"
            >
              {{ savingVoice ? "保存中…" : "保存语音设置" }}
            </button>
          </div>
        </div>
      </details>

      <!-- 主动找话带一整套闸门参数，所以它是个可展开的开关行，不是纯开关 -->
      <details class="more is-toggle">
        <summary>
          <span class="more-sum">主动找话</span>
          <span class="grp-tag">她自己先发一条 QQ 私信</span>
          <span class="grow" />
          <span
            class="pill"
            :class="draft.enabled ? 'pill-green' : 'pill-gray'"
          >{{ draft.enabled ? "已开启" : "默认关闭" }}</span>
          <el-icon class="more-caret">
            <ArrowRight />
          </el-icon>
        </summary>

        <div class="more-body">
          <p class="beh-lead">
            不是定时群发：先攒「想做但还没做的事」，再由闸门决定这一刻能不能说。
            收件人取这个角色最近一次 QQ 私聊的对象，没私聊过就不会发。
          </p>

          <div class="beh-field">
            <div class="beh-inline">
              <span class="beh-label">开启主动找话</span>
              <el-switch v-model="draft.enabled" />
            </div>
            <em>这是唯一一条「她先开口」的路径；打开前先确认你能接受她突然找你。</em>
          </div>

          <template v-if="draft.enabled">
            <div class="beh-grid">
              <div class="beh-field">
                <span class="beh-label">每天最多几条</span>
                <el-input-number
                  v-model="draft.dailyMax"
                  :min="0"
                  :max="24"
                />
                <em>0 = 关掉这个口子。按东八区自然日算。</em>
              </div>
              <div class="beh-field">
                <span class="beh-label">两条之间至少隔多久（分钟）</span>
                <el-input-number
                  v-model="draft.minGapMinutes"
                  :min="15"
                  :max="1440"
                  :step="15"
                />
                <em>默认 180；太短会变成「刚聊完又凑上来」。</em>
              </div>
            </div>

            <div class="beh-field">
              <span class="beh-label">安静时段</span>
              <div class="beh-quiet">
                <el-time-select
                  v-model="draft.quietStart"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="23:00"
                />
                <span class="beh-quiet-sep">到</span>
                <el-time-select
                  v-model="draft.quietEnd"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="08:00"
                />
              </div>
              <em>允许跨午夜（23:00 到 08:00 就是整夜闭嘴）。起止填成一样会被拒绝保存。</em>
            </div>

            <div class="beh-grid">
              <div class="beh-field">
                <span class="beh-label">刚聊过就先不打扰（分钟）</span>
                <el-input-number
                  v-model="draft.userActiveMinutes"
                  :min="0"
                  :max="720"
                  :step="10"
                />
                <em>你在这段时间内说过话，她就不主动开口 —— 那样叫接话。0 = 不判这条。</em>
              </div>
              <div class="beh-field">
                <!-- 数字放在标签行右侧，不用 show-input：Element 那条会把轨道挤成一小截 -->
                <div class="beh-inline">
                  <span class="beh-label">最低置信度</span>
                  <span class="beh-value">{{ draft.minConfidence.toFixed(2) }}</span>
                </div>
                <el-slider
                  v-model="draft.minConfidence"
                  :min="0"
                  :max="1"
                  :step="0.05"
                />
                <em>她给每件「想做的事」打 0–1 分，低于这个值就不开口。调高更安静。</em>
              </div>
            </div>
          </template>

          <div class="beh-state">
            <template v-if="snapshot">
              <span
                class="pill"
                :class="snapshot.status.canSendNow ? 'pill-green' : 'pill-gray'"
              >{{ snapshot.status.reasonLabel }}</span>
              <span class="beh-meta">
                今天 {{ snapshot.status.sentToday }} / {{ snapshot.settings.dailyMax }} 条 ·
                池子 {{ snapshot.status.pendingCount }} 条 ·
                收件人 {{ snapshot.status.recipient ?? "还没有" }}
              </span>
            </template>
            <span
              v-else
              class="beh-meta"
            >还读不到当前状态，保存后刷新一次。</span>
            <span class="grow" />
            <button
              type="button"
              class="beh-btn"
              :disabled="trying || savingProactive"
              @click="tryOnce"
            >
              <el-icon><Promotion /></el-icon>{{ trying ? "试跑中…" : "立即试一次" }}
            </button>
            <button
              type="button"
              class="beh-btn is-lead"
              :disabled="savingProactive"
              @click="saveProactive()"
            >
              {{ savingProactive ? "保存中…" : "保存" }}
            </button>
          </div>

          <p class="beh-hint">
            「立即试一次」只跳过时间类限制（安静时段 / 间隔 / 每日上限）；开关、收件人和当日额度照判，
            否则这个按钮就等于绕过所有保护。
          </p>

          <div
            v-if="snapshot?.recent.length"
            class="beh-recent"
          >
            <div
              v-for="item in snapshot.recent.slice(0, 3)"
              :key="item.id"
              class="beh-recent-row"
            >
              <span class="beh-kind">{{ KIND_LABELS[item.kind] ?? item.kind }}</span>
              <span class="beh-recent-text">{{ item.status === "SENT" ? (item.content ?? item.goal) : item.goal }}</span>
              <span class="beh-recent-status">{{ STATUS_LABELS[item.status] ?? item.status }}</span>
            </div>
          </div>
        </div>
      </details>

      <!-- 群聊「冷场了自己找话题」：和上面私聊那条并列，参数各一套 -->
      <details class="more is-toggle">
        <summary>
          <span class="more-sum">群里自己找话题</span>
          <span class="grp-tag">冷下来了她起个头</span>
          <span class="grow" />
          <span
            class="pill"
            :class="groupDraft.enabled ? 'pill-green' : 'pill-gray'"
          >{{ groupDraft.enabled ? "已开启" : "默认关闭" }}</span>
          <el-icon class="more-caret">
            <ArrowRight />
          </el-icon>
        </summary>

        <div class="more-body">
          <p class="beh-lead">
            群安静够久之后，她会自己说一句起个头。不是定时播报：先看这个群有没有冷下来、
            今天已经说过几次，最后还要她真写得出话说 —— 想不出就不发。
          </p>

          <div class="beh-field">
            <div class="beh-inline">
              <span class="beh-label">开启群内找话题</span>
              <el-switch v-model="groupDraft.enabled" />
            </div>
            <em>作用范围是这条绑定挂的所有群，但<strong>设成「仅被 @ 时回复」的群不参与</strong> —— 那是你对那个群的明确要求，她不该自己冒头。她在群里说的那句话会记进该群的聊天记录，之后接着聊也知道自己说过什么。</em>
          </div>

          <template v-if="groupDraft.enabled">
            <div class="beh-grid">
              <div class="beh-field">
                <span class="beh-label">安静多久算冷场（分钟）</span>
                <el-input-number
                  v-model="groupDraft.idleMinutes"
                  :min="15"
                  :max="1440"
                  :step="15"
                />
                <em>取「最后一条群消息」和「她最后一次说话」里更近的那个算。默认 60。</em>
              </div>
              <div class="beh-field">
                <span class="beh-label">每个群每天最多几条</span>
                <el-input-number
                  v-model="groupDraft.dailyMax"
                  :min="0"
                  :max="24"
                />
                <em>0 = 关掉这个口子。按群、按东八区自然日分别算。</em>
              </div>
            </div>

            <div class="beh-field">
              <span class="beh-label">同一个群两次至少隔多久（分钟）</span>
              <el-input-number
                v-model="groupDraft.minGapMinutes"
                :min="30"
                :max="1440"
                :step="30"
              />
              <em>她判定「这轮没什么想说的」也算一次尝试，所以不会每个 tick 都在心里嘀咕一遍。</em>
            </div>

            <div class="beh-field">
              <span class="beh-label">安静时段</span>
              <div class="beh-quiet">
                <el-time-select
                  v-model="groupDraft.quietStart"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="23:30"
                />
                <span class="beh-quiet-sep">到</span>
                <el-time-select
                  v-model="groupDraft.quietEnd"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="07:30"
                />
              </div>
              <em>凌晨的群不需要被叫醒。允许跨午夜（23:30 到 07:30 就是整夜闭嘴）；起止填成一样会被拒绝保存。</em>
            </div>
          </template>

          <div class="beh-state">
            <template v-if="snapshot?.group">
              <span
                class="pill"
                :class="snapshot.group.status.canSendNow ? 'pill-green' : 'pill-gray'"
              >{{ snapshot.group.status.reasonLabel }}</span>
              <span class="beh-meta">
                {{ snapshot.group.status.groups.length }} 个群 ·
                每群每天 {{ snapshot.group.settings.dailyMax }} 条
              </span>
            </template>
            <span
              v-else
              class="beh-meta"
            >还读不到当前状态，保存后刷新一次。</span>
            <span class="grow" />
            <button
              type="button"
              class="beh-btn"
              :disabled="tryingGroup || savingGroupInitiative"
              @click="tryGroupOnce"
            >
              <el-icon><Promotion /></el-icon>{{ tryingGroup ? "试跑中…" : "立即试一次" }}
            </button>
            <button
              type="button"
              class="beh-btn is-lead"
              :disabled="savingGroupInitiative"
              @click="saveGroupInitiative()"
            >
              {{ savingGroupInitiative ? "保存中…" : "保存" }}
            </button>
          </div>

          <p class="beh-hint">
            「立即试一次」会挑安静最久的那个群，跳过时间类限制，真往群里发一条；
            开关、每群条数与当日额度照判。
          </p>

          <div
            v-if="snapshot?.group?.status.groups.length"
            class="beh-recent"
          >
            <div
              v-for="item in snapshot.group.status.groups.slice(0, 5)"
              :key="item.groupId"
              class="beh-recent-row"
            >
              <span class="beh-kind">{{ item.groupId }}</span>
              <span class="beh-recent-text">{{ item.reasonLabel }} · 今天 {{ item.sentToday }} 条</span>
              <span class="beh-recent-status">安静 {{ formatIdle(item.idleMinutes) }}</span>
            </div>
          </div>
        </div>
      </details>
    </section>

    <!-- 保存条：解绑由外面的行给（它属于行，不属于这张表单） -->
    <div class="beh-foot">
      <span class="beh-meta">保存后立刻生效，不用重启适配器</span>
      <span class="grow" />
      <slot name="actions" />
      <button
        type="button"
        class="beh-btn is-primary"
        :disabled="savingBind"
        @click="saveBind"
      >
        {{ savingBind ? "保存中…" : "保存" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 这一段是「行的肚子」，不是卡：外面已经有白砖和 16px 内边距，
   这里只负责把两组内容分开 —— 组间一条 1px，组内靠 12 的间距。 */
.beh { display: block; }
.grow { flex: 1; }

.grp + .grp {
  margin-top: var(--sp-4);
  border-top: 1px solid var(--line);
  padding-top: var(--sp-4);
}

.grp-h { display: flex; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.grp-h b { color: var(--text); font-size: 14px; font-weight: 700; }
.grp-tag { color: var(--dim); font-size: 12px; }

/* ── 参与度刻度：一条轨道上三个位置 ─────────────────── */
.dial {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-1);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  padding: var(--sp-1);
}
/* 选中的那块白底滑块：位置由 data-at 决定，动的是它而不是三个按钮各变各的 */
.dial::before {
  position: absolute;
  top: var(--sp-1);
  bottom: var(--sp-1);
  left: var(--sp-1);
  width: calc((100% - 16px) / 3);
  border-radius: 6px;
  background: var(--surface);
  content: "";
  transition: transform .2s var(--ease);
}
.dial[data-at="1"]::before { transform: translateX(calc(100% + var(--sp-1))); }
.dial[data-at="2"]::before { transform: translateX(calc(200% + 8px)); }

.dial-opt {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 7px 10px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dial-opt b { color: var(--text-2); font-size: 14px; font-weight: 600; }
.dial-opt span { color: var(--dim); font-size: 12px; }
.dial-opt[aria-checked="true"] b { color: var(--brand-strong); font-weight: 700; }
.dial-opt:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

.dial-note { margin: var(--sp-2) 0 0; color: var(--dim); font-size: 12px; line-height: 1.65; }

/* 刻度上面的「默认档」说明：只在绑定挂了多个群时出现 */
.dial-lead { display: block; margin-bottom: var(--sp-2); }

/* ── 按群分别设：一行一个群，档位选在右侧 ─────────── */
.pg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 8px 10px;
}
.pg-row { display: flex; align-items: center; gap: 10px; }
.pg-id {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pg-sel { width: 210px; flex: none; }

/* ── 群参数：两列铺开，标签在上、说明在下 ─────────── */
.beh-grid.is-bind { margin-top: var(--sp-4); align-items: start; }
/* 跨两列：按群设置是一整块列表，挤在半列里群号和档位都会换行 */
.beh-grid.is-bind .is-wide { grid-column: 1 / -1; }

/* 「节奏与限制」折叠头里的当前值摘要：一长串，超出就省略，不换行 */
.more-sub {
  min-width: 0;
  overflow: hidden;
  color: var(--dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 折叠块：改参数的人才展开 ───────────────────────── */
.more { margin-top: var(--sp-3); border-top: 1px solid var(--line); }
.more > summary {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
  list-style: none;
  cursor: pointer;
}
.more > summary::-webkit-details-marker { display: none; }
.more-sum { color: var(--text-2); font-size: 14px; font-weight: 600; }
.more > summary .grow { flex: 1; }
/* 折叠符号跟页面其它地方一致：一个 >，展开时转 90° */
.more-caret {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  font-size: 12px;
  transition: transform .18s var(--ease), color .14s var(--ease);
}
.more[open] .more-caret { transform: rotate(90deg); color: var(--text-2); }
.more > summary:hover .more-caret { color: var(--brand-strong); }
.more > summary:hover .more-sum { color: var(--brand-strong); }
.more-body { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-3); }

/* 开关行：文案在左、开关贴右，中间留白由 flex 撑开 */
.toggle { display: flex; align-items: center; gap: var(--sp-3); padding: 7px 0; }
.toggle + .toggle,
.more + .toggle,
.more.is-toggle { border-top: 1px solid var(--line); }
/* 「更多能力」单独成组后，组里第一个折叠块不再紧跟前一组，顶部的分隔线由 .grp + .grp 给，
   它自己再画一条就成双线了 */
.grp-caps .more.is-toggle:first-of-type { border-top: 0; }
.toggle-copy { min-width: 0; flex: 1; }
.toggle-copy b { display: block; color: var(--text); font-size: 14px; font-weight: 600; }
.toggle-copy span { color: var(--dim); font-size: 12px; line-height: 1.65; }
.toggle :deep(.el-switch) { flex: none; }

/* 表情额度：缩进半格挂在「发表情」下面，说明它属于那一行而不是新的一行 */
.emoji-rate {
  border-left: 2px solid var(--line);
  margin: 0 0 var(--sp-3) 2px;
  padding: 0 0 0 12px;
  gap: 6px;
}
.emoji-rate :deep(.el-input-number) { width: 110px; }
/* 中间夹了额度块之后，「看群里的图」那条上边线要自己补回来（.toggle + .toggle 不成立了） */
.emoji-rate + .toggle { border-top: 1px solid var(--line); }

/* 主动找话：折叠头的形状跟开关行一致，右侧多一个状态药丸 */
.more.is-toggle { margin-top: 0; }
.more.is-toggle > summary { padding: var(--sp-3) 0; }
.more.is-toggle > summary .pill { margin-left: var(--sp-1); }

.beh-field { display: flex; flex-direction: column; gap: 5px; }
.beh-label { color: var(--text-2); font-size: 12px; font-weight: 600; }
.beh-field em { color: var(--dim); font-size: 12px; font-style: normal; line-height: 1.6; }
.beh-field :deep(.el-input-number) { width: 140px; }
.beh-lead code { font-size: 12px; padding: 0 4px; border-radius: 4px; background: var(--surface-3); }

.beh-limit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--text-2); font-size: 12px; }
.beh-limit :deep(.el-input-number) { width: 120px; }
.beh-quiet { display: flex; align-items: center; gap: 8px; }
.beh-quiet :deep(.el-select) { width: 120px; }
.beh-quiet-sep { color: var(--dim); font-size: 12px; }

.beh-body { display: flex; flex-direction: column; gap: 12px; }
.beh-lead { max-width: 68ch; margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.75; }
.beh-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; }
.beh-inline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.beh-value { color: var(--text-2); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.beh-field :deep(.el-slider) { width: 100%; }

/* 状态行：能不能发、今天发了几条，然后才是两个动作 */
.beh-state {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: var(--sp-2) 10px;
}
.beh-state .grow { flex: 1; }
.beh-meta { color: var(--dim); font-size: 12px; line-height: 1.6; }
.beh-hint { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }

.beh-recent { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line); padding-top: 8px; }
.beh-recent-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.6; }
.beh-kind { flex: none; color: var(--dim); }
.beh-recent-text { min-width: 0; flex: 1; overflow: hidden; color: var(--text-2); text-overflow: ellipsis; white-space: nowrap; }
.beh-recent-status { flex: none; color: var(--dim); }

/* ── 保存条 ───────────────────────────────────────── */
.beh-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  /* 不要 margin-top：保存条上面的那条线就是「主动找话」这一行的下边界，
     给它留 margin 会让那一行的文字看着贴在上边界上 */
  border-top: 1px solid var(--line);
  padding-top: var(--sp-3);
}
.beh-foot .grow { flex: 1; }

.beh-btn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  padding: 0 10px;
  color: var(--text-2);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.beh-btn .el-icon { color: var(--faint); font-size: 13px; }
.beh-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--brand-strong); }
.beh-btn:hover:not(:disabled) .el-icon { color: var(--brand); }
.beh-btn.is-lead { background: var(--brand-soft); color: var(--brand-strong); }
.beh-btn.is-lead:hover:not(:disabled) { background: var(--brand-line); }
.beh-btn.is-primary { height: 32px; background: var(--brand-btn); padding: 0 14px; color: #fff; }
.beh-btn.is-primary:hover:not(:disabled) { background: var(--brand-btn-h); color: #fff; }
.beh-btn:disabled { opacity: .5; cursor: not-allowed; }

@media (max-width: 860px) {
  /* 窄屏刻度改纵向列表：滑块会挡住文字，直接换成选中项白底 */
  .dial { grid-template-columns: minmax(0, 1fr); }
  .dial::before { display: none; }
  .dial-opt[aria-checked="true"] { background: var(--surface); }

  .beh-grid { grid-template-columns: minmax(0, 1fr); }
  /* 窄屏把档位选到群号下一行：210px 的下拉框会把群号挤成省略号 */
  .pg-row { flex-direction: column; align-items: stretch; gap: 4px; }
  .pg-sel { width: 100%; }
  .beh-state .grow { display: none; }
  .toggle-copy span { display: block; margin-top: 2px; }
}
</style>
