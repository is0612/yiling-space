<script setup lang="ts">
import { CopyDocument, Promotion, Refresh, TopRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import type { Character } from "~/utils/mock-data";
import { MODEL_PROVIDERS, buildModelOptions, buildVisionModelOptions, providerByBaseUrl, providerByKey } from "~/utils/model-catalog";
import { applyAsrProviderPreset, applyVoiceProviderPreset } from "~/utils/voice-provider-preset";

// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "模型设置" },
});

/**
 * 模型设置：从「角色设置」弹窗里搬出来的。
 * 弹窗要装 9 个字段 + 6 段说明，在 1440×900 的笔记本上一屏放不下，
 * 而 el-dialog 是整层遮罩滚动 —— 打开后连保存按钮都看不到。这里跟「记忆设置」同形态。
 *
 * 页面排序（先分层，再谈样式）：
 *   主角  连接三件套（服务商 → API 地址 → API Key）。错一个整页都白配。
 *   次    模型名称。地址对了但模型选错，照样跑不起来。
 *   再次  五个参数。有「填入推荐值」，不理解也能用。
 *   背景  今日用量 / 说明。只在排查时才看，所以压到右栏。
 * 动作：主 = 保存设置（全页唯一实心按钮）；次 = 保存并测试、获取模型；
 *       三次 = 填入推荐值、刷新用量（文字按钮）。
 * 保存条吸底：这页往下滚两屏才到底，主操作不能跟着滚出视野。
 */
const route = useRoute();
const id = computed(() => String(route.params.id || ""));

const character = ref<Character | null>(null);
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const fetchingModels = ref(false);

const draftChatModel = ref("");
const draftChatTemperature = ref(0.7);
const draftChatMaxTokens = ref(4096);
const draftChatApiBaseUrl = ref("https://api.openai.com/v1");
const draftChatApiKey = ref("");
const draftProviderKey = ref("openai");
const draftDailyTokenLimit = ref(0);
const draftMemoryTokenBudget = ref(1800);
const draftSnapshotTokenBudget = ref(2500);
/** 一次注入多少条长期记忆。这个值以前写死 12，页面上没有入口，调预算却不见多记就是它卡住的。 */
const draftMemoryItemLimit = ref(20);
const draftRecentMessageLimit = ref(40);
/** 近期忆泡天数：0 = 不带。默认关，打开后每轮多背几百 token。 */
const draftEventRecentDays = ref(0);

// ── 语音模型：从「QQ 渠道 → 角色行为」搬过来的 ──
// 服务商、Key、模型名都属于「模型配置」，跟「她发不发语音」这种行为开关不该混在一个面板里。
// 这里的保存走同一个 PATCH 接口，跟上面对话模型一起「保存设置」。
const draftVoiceProvider = ref("auto");
const draftVoiceApiKey = ref("");
const draftVoiceApiBaseUrl = ref("");
const draftVoiceTtsModel = ref("");
const draftVoiceTtsVoice = ref("");
/** 语速 0.5–2.0；页面里始终是个具体数字，0 只存在于库里（= 用环境变量/默认 1） */
const draftVoiceSpeed = ref(1);
const draftVoiceAsrModel = ref("");
const draftVoiceGroupId = ref("");
/** Breeze 的演技指令：一句话决定她怎么说，不填就用 .env 里的 */
const draftVoiceInstructions = ref("");
// ── 识别（ASR）：和合成是两套配置 ──
// 合成分给 Breeze / MiniMax、识别分给另一家是常态（Breeze 根本没有识别端点），
// 共用一把 Key 只会拿 B 家的 Key 去打 A 家，换回一个看不出原因的 401。
const draftAsrProvider = ref("auto");
const draftAsrApiBaseUrl = ref("");
const draftAsrApiKey = ref("");
/** 点过「同语音合成」：保存时让服务端把合成那把 Key 复制到识别（Key 不回传网页，只能服务端抄）。 */
const syncAsrFromVoice = ref(false);
/** 语音模型下拉里「获取模型」拉回来的清单 */
const fetchedVoiceModels = ref<string[]>([]);
const fetchingVoiceModels = ref(false);
const testingVoice = ref(false);

// ── 图片模型：看图（以后还要生图）用的那一家 ──
// 和语音是同一套理由：视觉模型几乎必然不是聊天那一家（DeepSeek 没有视觉接口），
// 所以地址和 Key 都得能单独存，不能蹭聊天那把。
// 全部留空时的行为不变：回落到「对话模型」，也就是今天的样子。
const draftVisionModel = ref("");
const draftVisionApiBaseUrl = ref("");
const draftVisionApiKey = ref("");

// ── 记忆助手模型：独立地址、模型和 API Key，不借用聊天凭据 ──
const draftMemoryAssistantModel = ref("");
const draftMemoryAssistantTemperature = ref(0.1);
const draftMemoryAssistantMaxInputTokens = ref(12288);
const draftMemoryAssistantMaxOutputTokens = ref(2048);
const draftMemoryAssistantApiBaseUrl = ref("");
const draftMemoryAssistantApiKey = ref("");
const draftMemoryAssistantProviderKey = ref("custom");
const fetchedMemoryAssistantModels = ref<string[]>([]);
const fetchingMemoryAssistantModels = ref(false);
const draftContextAssistantModel = ref("");
const draftContextAssistantTemperature = ref(0.1);
const draftContextAssistantMaxInputTokens = ref(16384);
const draftContextAssistantMaxOutputTokens = ref(2048);
const draftContextAssistantApiBaseUrl = ref("");
const draftContextAssistantApiKey = ref("");
const draftContextAssistantProviderKey = ref("custom");
const fetchedContextAssistantModels = ref<string[]>([]);
const fetchingContextAssistantModels = ref(false);
const testingVision = ref(false);
const testingMemoryAssistant = ref(false);
const testingContextAssistant = ref(false);
const draftContextAssistantEnabled = ref(false);
/** 图片页「获取模型」拉回来的清单；换地址就作废（两家清单不通用） */
const fetchedVisionModels = ref<string[]>([]);
const fetchingVisionModels = ref(false);
/** 模型设置页签：对话 / 语音 / 图片 / 记忆助手。用 v-show 切换，切换不丢已填表单 */
const activeTab = ref<"chat" | "voice" | "vision" | "memoryAssistant" | "contextAssistant">("chat");

/** 本页「获取模型」拉回来的列表；换地址就作废 */
const fetchedModels = ref<string[]>([]);

/** 已写入数据库那一份表单的指纹，用来判断「有没有没保存的改动」 */
const savedSignature = ref("");
const lastSavedAt = ref<Date | null>(null);

type DailyUsage = {
  day: string;
  usage: { totalTokens: number; promptTokens: number; completionTokens: number; calls: number; byKind: Record<string, { totalTokens: number; calls: number }> };
  quota: { limit: number; used: number; remaining: number; exceeded: boolean };
};
const dailyUsage = ref<DailyUsage | null>(null);
const loadingUsage = ref(false);
const modelCallLogsOpen = ref(false);

const KIND_LABELS: Record<string, string> = {
  chat: "对话接口",
  channel: "QQ 回复",
  snapshot: "阶段总结",
  events: "忆泡整理",
  journal: "日记/手账",
  "bili-screening": "值班粗筛",
  "bili-judge": "值班终判",
  proactive: "主动找话",
  vision: "群图片识别",
  "sticker-label": "表情包打标",
  "memory-assistant": "记忆助手",
  "context-assistant": "语境助手",
  other: "其他",
};

/**
 * 表单指纹：只收「能看出改过没改过」的值。
 *
 * 各把 Key 的明文也进串（聊天、记忆助手、语境助手这几处是整串比），但语音 / 识别 / 图片
 * 那几把按「留空＝不改」的口径处理，只比有没有填，不进指纹 —— 明文进串会让
 * 「粘贴后又删掉」被当成改动。
 */
const draftSignature = computed(() => JSON.stringify([
  draftChatModel.value.trim(),
  draftChatTemperature.value,
  draftChatMaxTokens.value,
  draftChatApiBaseUrl.value.trim(),
  draftChatApiKey.value.trim(),
  draftDailyTokenLimit.value,
  draftMemoryTokenBudget.value,
  draftSnapshotTokenBudget.value,
  draftMemoryItemLimit.value,
  draftRecentMessageLimit.value,
  // 语音模型：Key 的明文不进指纹（留空=不改，没法从明文判断）
  draftVoiceProvider.value,
  draftVoiceApiBaseUrl.value.trim(),
  draftVoiceTtsModel.value.trim(),
  draftVoiceTtsVoice.value.trim(),
  draftVoiceSpeed.value,
  draftVoiceAsrModel.value.trim(),
  draftVoiceGroupId.value.trim(),
  draftVoiceInstructions.value.trim(),
  draftAsrProvider.value,
  draftAsrApiBaseUrl.value.trim(),
  syncAsrFromVoice.value,
  // 图片模型：Key 明文同样不进指纹
  draftVisionModel.value.trim(),
  draftVisionApiBaseUrl.value.trim(),
  // 记忆助手 Key 明文不进指纹（留空=不改）。
  draftMemoryAssistantModel.value.trim(),
  draftMemoryAssistantTemperature.value,
  draftMemoryAssistantMaxInputTokens.value,
  draftMemoryAssistantMaxOutputTokens.value,
  draftMemoryAssistantApiBaseUrl.value.trim(),
  draftMemoryAssistantApiKey.value.trim(),
  draftContextAssistantEnabled.value,
  draftContextAssistantModel.value.trim(),
  draftContextAssistantTemperature.value,
  draftContextAssistantMaxInputTokens.value,
  draftContextAssistantMaxOutputTokens.value,
  draftContextAssistantApiBaseUrl.value.trim(),
  draftContextAssistantApiKey.value.trim(),
]));
const dirty = computed(() => savedSignature.value !== "" && draftSignature.value !== savedSignature.value);

/** 手动刷新的最短加载时长：本地接口几十毫秒就回来了，转圈一闪而过等于没有反馈 */
const USAGE_REFRESH_MIN_MS = 1000;

async function loadUsage(silent = true) {
  if (!id.value || loadingUsage.value) return;
  loadingUsage.value = true;
  const startedAt = Date.now();
  try {
    dailyUsage.value = await $fetch<DailyUsage>(`/api/characters/${encodeURIComponent(id.value)}/usage`);
  } catch (error) {
    // 载入/保存时顺带刷新，读不到不影响改设置；手动点「刷新用量」才提示
    dailyUsage.value = null;
    if (!silent) ElMessage.error(readError(error, "读取用量失败，请稍后重试。"));
  } finally {
    // 只有手动点「刷新用量」才压时长；载入页面和保存后的顺带刷新不该拖着
    if (!silent) {
      const remaining = USAGE_REFRESH_MIN_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    loadingUsage.value = false;
  }
}

/** 保存条上的状态：说明「现在按下去会写什么」，而不是复述按钮文案 */
const saveStateLabel = computed(() => {
  if (dirty.value) return "有未保存的改动";
  const at = lastSavedAt.value;
  if (!at) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `已保存 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
});

/** 额度条：两个数字并排比不出「还剩多少」，加一条进度才算回答了这个问题 */
const quotaPercent = computed(() => {
  const quota = dailyUsage.value?.quota;
  if (!quota || !quota.limit) return null;
  return Math.min(100, Math.round((quota.used / quota.limit) * 100));
});

const usageKinds = computed(() => Object.entries(dailyUsage.value?.usage.byKind ?? {}));

/** 两个入口各回各家：角色管理页、角色记忆页 */
const backTarget = computed(() => {
  if (route.query.from === "characters") return "/characters";
  return `/memory?c=${id.value}`;
});
const backLabel = computed(() => {
  if (route.query.from === "characters") return "返回角色管理";
  return "返回角色记忆";
});

/**
 * 六个 API Key 输入框共用的文案，只在这里定义一次。
 *
 * 之前六处各写各的：同一个状态有的有徽标、有的没有；说明有的写「AES-256-GCM」、
 * 有的写「不会回显原文」、有的两样都不写。用户看到的是六套说法，还以为是六个功能。
 */
const API_KEY_SAVED_PLACEHOLDER = "已加密保存；留空表示保持不变";
const API_KEY_EMPTY_PLACEHOLDER = "填写 API Key";
const API_KEY_HELP =
  "使用本机凭据加密密钥进行 AES-256-GCM 加密保存；留空表示不修改已有 Key，不会回传原文。";

/**
 * 字段上**不再标「必填 / 可选」**（2026-11-06 用户决定）。
 *
 * 理由：这些字段本来就是「要用这个功能就得填」，标「可选」等于暗示不填也能用，
 * 反而要再写一段说明解释回落到哪 —— 越标越乱。哪个字段其实有回落，
 * 直接写在它自己的说明里就够了，不需要一个额外的徽标。
 */

const apiKeySource = computed(() => character.value?.chatApiKeySource ?? "missing");
const apiKeyPlaceholder = computed(() => {
  if (apiKeySource.value === "character") return API_KEY_SAVED_PLACEHOLDER;
  if (apiKeySource.value === "environment") return "当前使用服务端默认 Key；填写可覆盖";
  return API_KEY_EMPTY_PLACEHOLDER;
});

const currentProvider = computed(() => providerByKey(draftProviderKey.value));
const memoryAssistantEffectiveBaseUrl = computed(
  () => draftMemoryAssistantApiBaseUrl.value.trim() || draftChatApiBaseUrl.value.trim(),
);
const memoryAssistantProviderPreset = computed(() => providerByKey(draftMemoryAssistantProviderKey.value));
const memoryAssistantProviderLabel = computed(() => memoryAssistantProviderPreset.value?.name ?? "自定义");
const memoryAssistantConsoleUrl = computed(() => memoryAssistantProviderPreset.value?.consoleUrl ?? "");
const memoryAssistantKeyConfigured = computed(() => character.value?.memoryAssistantApiKeyConfigured === true);
const memoryAssistantModelOptions = computed(() => buildModelOptions({
  baseUrl: memoryAssistantEffectiveBaseUrl.value,
  current: draftMemoryAssistantModel.value,
  fetched: fetchedMemoryAssistantModels.value,
}));

const contextAssistantEffectiveBaseUrl = computed(
  () => draftContextAssistantApiBaseUrl.value.trim() || draftChatApiBaseUrl.value.trim(),
);
const contextAssistantProviderPreset = computed(() => providerByKey(draftContextAssistantProviderKey.value));
const contextAssistantProviderLabel = computed(() => contextAssistantProviderPreset.value?.name ?? "自定义");
const contextAssistantConsoleUrl = computed(() => contextAssistantProviderPreset.value?.consoleUrl ?? "");
const contextAssistantKeyConfigured = computed(() => character.value?.contextAssistantApiKeyConfigured === true);
const contextAssistantModelOptions = computed(() => buildModelOptions({
  baseUrl: contextAssistantEffectiveBaseUrl.value,
  current: draftContextAssistantModel.value,
  fetched: fetchedContextAssistantModels.value,
}));

// ── 语音模型的计算属性 ──
const voiceKeyConfigured = computed(() => character.value?.voiceApiKeyConfigured === true);
/** 识别专用 Key 是否已保存（和语音那把分开两把） */
const asrKeyConfigured = computed(() => character.value?.asrApiKeyConfigured === true);
/**
 * "auto" 是前端哨兵值，保存时映射回空字符串（= 交给后端按地址推断）。
 * 不能用空串当下拉值：Element Plus 把空串当「未选择」，那个选项会显示不出来。
 */
const voiceUsesMinimax = computed(() => {
  if (draftVoiceProvider.value === "minimax") return true;
  if (draftVoiceProvider.value === "openai") return false;
  return /minimax/i.test(draftVoiceApiBaseUrl.value);
});
/** Breeze 与前两家不是一套协议：地址、音色、语气指令都只在它这里生效。 */
const voiceUsesBreeze = computed(() => {
  if (draftVoiceProvider.value === "breeze") return true;
  if (draftVoiceProvider.value === "minimax" || draftVoiceProvider.value === "openai") return false;
  return /breeze\.blue/i.test(draftVoiceApiBaseUrl.value);
});
const voiceKeyPlaceholder = computed(() => {
  if (voiceKeyConfigured.value) return API_KEY_SAVED_PLACEHOLDER;
  if (voiceUsesBreeze.value) return "brz_...（Breeze 开发者后台创建）";
  return voiceUsesMinimax.value ? "sk-...（MiniMax 接口密钥页创建）" : "sk-...（服务商后台复制）";
});

// ── 图片模型的计算属性 ──
const visionKeyConfigured = computed(() => character.value?.visionApiKeyConfigured === true);
/** 没填地址时按「对话模型那家」算：占位符与开放平台链接都跟着走 */
const visionEffectiveBaseUrl = computed(() => draftVisionApiBaseUrl.value.trim() || draftChatApiBaseUrl.value.trim());
const visionProviderPreset = computed(() => providerByBaseUrl(visionEffectiveBaseUrl.value));
const visionConsoleUrl = computed(() => visionProviderPreset.value?.consoleUrl ?? "");
const visionProviderName = computed(() => visionProviderPreset.value?.name ?? "");
/**
 * 选项 = 服务商真实清单在前，内置视觉清单兜底。
 *
 * 拉回来的 `/models` 不分能不能读图，里面混着聊天模型，所以**不自动选中第一个** ——
 * 「帮你猜一个」在对话页还行，在这里会让人以为配好了一个读不了图的模型。
 */
const visionModelOptions = computed(() => {
  const catalog = buildVisionModelOptions({ baseUrl: visionEffectiveBaseUrl.value, current: "" });
  const merged = [...new Set([...fetchedVisionModels.value, ...catalog])];
  const current = draftVisionModel.value.trim();
  return current && !merged.includes(current) ? [current, ...merged] : merged;
});
const visionKeyPlaceholder = computed(() => {
  if (visionKeyConfigured.value) return API_KEY_SAVED_PLACEHOLDER;
  const name = visionProviderName.value;
  return name ? `sk-...（${name} 后台复制）` : "sk-...（服务商后台复制）";
});
/** 选服务商时只带地址：视觉模型名各家的叫法差太多，替用户猜一个反而要改 */
function applyVisionProvider(key: string) {
  const preset = providerByKey(key);
  if (!preset?.baseUrl) return;
  draftVisionApiBaseUrl.value = preset.baseUrl;
  const model = draftVisionModel.value.trim();
  // 还填着别家的模型名（比如深度求索的 deepseek-flash）就换成这家的第一个视觉模型
  const belongsToOther = MODEL_PROVIDERS.some(
    (provider) => provider.key !== key && provider.models.includes(model),
  );
  if (!model || belongsToOther) draftVisionModel.value = preset.visionModels?.[0] ?? "";
}
/** 换了看图那一家，上一家拉回来的模型清单立刻作废 —— 别让下拉里留着调不通的名字 */
watch(draftVisionApiBaseUrl, () => {
  fetchedVisionModels.value = [];
});
const visionProviderKey = computed(() => providerByBaseUrl(draftVisionApiBaseUrl.value)?.key ?? "custom");

/** 记忆助手与对话模型同用服务商目录，但 API Key 和模型列表请求完全独立。 */
function applyMemoryAssistantProvider(key: string) {
  draftMemoryAssistantProviderKey.value = key;
  const preset = providerByKey(key);
  if (!preset?.baseUrl) return;
  draftMemoryAssistantApiBaseUrl.value = preset.baseUrl;

  const model = draftMemoryAssistantModel.value.trim();
  const belongsToOther = MODEL_PROVIDERS.some(
    (provider) => provider.key !== key && provider.models.includes(model),
  );
  const nextModel = preset.models[0] ?? "";
  if (nextModel && (!model || belongsToOther)) {
    draftMemoryAssistantModel.value = nextModel;
  } else if (belongsToOther) {
    ElMessage.info(`${preset.name}没有内置模型清单，点「获取模型」拉取后再选。`);
  }
  fetchedMemoryAssistantModels.value = [];
}

/** 改了记忆助手实际使用的地址（包括跟随对话地址时），旧模型列表就失效。 */
watch(memoryAssistantEffectiveBaseUrl, (value) => {
  fetchedMemoryAssistantModels.value = [];
  draftMemoryAssistantProviderKey.value = providerByBaseUrl(value)?.key ?? "custom";
});
function applyContextAssistantProvider(key: string) {
  draftContextAssistantProviderKey.value = key;
  const preset = providerByKey(key);
  if (!preset?.baseUrl) return;
  draftContextAssistantApiBaseUrl.value = preset.baseUrl;

  const model = draftContextAssistantModel.value.trim();
  const belongsToOther = MODEL_PROVIDERS.some(
    (provider) => provider.key !== key && provider.models.includes(model),
  );
  const nextModel = preset.models[0] ?? "";
  if (nextModel && (!model || belongsToOther)) {
    draftContextAssistantModel.value = nextModel;
  } else if (belongsToOther) {
    ElMessage.info(`${preset.name}没有内置模型清单，点「获取模型」拉取后再选。`);
  }
  fetchedContextAssistantModels.value = [];
}

/** 改了语境助手实际使用的地址（包括跟随对话地址时），旧模型列表就失效。 */
watch(contextAssistantEffectiveBaseUrl, (value) => {
  fetchedContextAssistantModels.value = [];
  draftContextAssistantProviderKey.value = providerByBaseUrl(value)?.key ?? "custom";
});

/**
 * 语音的开放平台入口：和对话模型那块对齐 —— 用户卡住的点不是「填什么」，而是「去哪拿 Key」。
 * 优先按地址认服务商（改了路径也认得出），地址还空着时按下拉框兜底：
 * MiniMax 走 MiniMax，其余（OpenAI 兼容 / 自动判断）跟着占位符那家（硅基流动）。
 */
const voiceProviderPreset = computed(() => {
  const byUrl = providerByBaseUrl(draftVoiceApiBaseUrl.value);
  if (byUrl) return byUrl;
  if (draftVoiceProvider.value === "minimax") return providerByKey("minimax");
  return providerByKey("siliconflow");
});
const voiceConsoleUrl = computed(() => voiceProviderPreset.value?.consoleUrl ?? "");
const voiceProviderName = computed(() => voiceProviderPreset.value?.name ?? "");

/** 三家的默认三件套在 `~/utils/voice-provider-preset` 里（带单测），这里只负责写回输入框 */

/**
 * 选服务商时把地址 / 模型 / 音色一起带过去（规则见 `~/utils/voice-provider-preset`，
 * 那边的「像不像别家」判断有单测，别再在这里分方向写 if）。
 */
function applyVoiceProviderTemplate(provider: string) {
  const next = applyVoiceProviderPreset(
    {
      baseUrl: draftVoiceApiBaseUrl.value,
      model: draftVoiceTtsModel.value,
      voice: draftVoiceTtsVoice.value,
    },
    provider,
  );
  if (!next) return;

  draftVoiceApiBaseUrl.value = next.baseUrl;
  draftVoiceTtsModel.value = next.model;
  draftVoiceTtsVoice.value = next.voice;

  // 换了一家用，「获取模型」上一家拉回来的清单就不作数了
  fetchedVoiceModels.value = [];
}

/** 识别侧选服务商：带出地址和模型（和合成同一套规则） */
function applyAsrProviderTemplate(provider: string) {
  const next = applyAsrProviderPreset(
    { baseUrl: draftAsrApiBaseUrl.value, model: draftVoiceAsrModel.value },
    provider,
  );
  if (!next) return;
  draftAsrApiBaseUrl.value = next.baseUrl;
  draftVoiceAsrModel.value = next.model;
  // 换了服务商，之前点过「同语音合成」的意图就不成立了
  syncAsrFromVoice.value = false;
}

/**
 * 「同语音合成」：把合成的服务商/地址抄过来，并让服务端保存时把 Key 也复制一份。
 * Key 本身不回传网页，所以复制只能发生在服务端 —— 前端只送一个开关。
 */
function useSameAsVoice() {
  if (voiceUsesBreeze.value) {
    ElMessage.warning("合成用的是 Breeze，它只有合成、没有识别端点；识别得单独配一家。");
    return;
  }
  // 服务商取合成的；「自动判断」时按地址认，认不出来就算 OpenAI 兼容
  const provider = voiceUsesMinimax.value || /minimax/i.test(draftVoiceApiBaseUrl.value)
    ? "minimax"
    : "openai";
  draftAsrProvider.value = provider;
  draftAsrApiBaseUrl.value = draftVoiceApiBaseUrl.value.trim();
  draftAsrApiKey.value = "";
  syncAsrFromVoice.value = true;
  // 识别模型不能抄合成的（breeze-tts-2 拿去做识别只会 400），按服务商给默认
  const next = applyAsrProviderPreset({ baseUrl: draftAsrApiBaseUrl.value, model: "" }, provider);
  if (next) draftVoiceAsrModel.value = next.model;
}

/** 语音模型下拉选项：已保存的值 + 拉回来的清单，去重 */
const voiceModelOptions = computed(() => {
  const set = new Set<string>(fetchedVoiceModels.value);
  if (draftVoiceTtsModel.value.trim()) set.add(draftVoiceTtsModel.value.trim());
  return Array.from(set);
});

async function fetchVoiceModels() {
  if (fetchingVoiceModels.value || saving.value || testingVoice.value || !character.value) return;
  fetchingVoiceModels.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; models: string[]; message: string; unsupported?: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/voice/models`,
    );
    if (!result.ok) {
      if (result.unsupported) ElMessage.warning(result.message);
      else ElMessage.error(result.message);
      return;
    }
    fetchedVoiceModels.value = result.models;
    if (!draftVoiceTtsModel.value.trim() && result.models.length) {
      draftVoiceTtsModel.value = result.models[0] ?? "";
    }
    ElMessage.success(result.message);
  } catch (error) {
    ElMessage.error(readError(error, "获取语音模型列表失败。"));
  } finally {
    fetchingVoiceModels.value = false;
  }
}

async function testVoice() {
  if (testingVoice.value || saving.value || fetchingVoiceModels.value || !character.value) return;
  testingVoice.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; elapsedMs?: number; voice?: string }>(
      `/api/characters/${encodeURIComponent(id.value)}/voice/test-connection`,
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : ""));
    } else {
      ElMessage.error(result.message);
    }
  } catch (error) {
    ElMessage.error(readError(error, "语音合成测试失败，请检查服务商、Key、合成模型与音色。"));
  } finally {
    testingVoice.value = false;
  }
}

/**
 * 测试看图：服务端会现画一张「上红 / 中绿 / 下蓝」的图，
 * 答对三种颜色才算真的能看见 —— 只测文本连通性测不出「收到图但没看」。
 */
async function testVision() {
  if (testingVision.value || saving.value || !character.value) return;
  testingVision.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; detail?: string; elapsedMs?: number; model?: string }>(
      `/api/characters/${encodeURIComponent(id.value)}/vision/test-connection`,
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : ""));
    } else {
      // 服务商原文跟着一起显示：429 / 403 这类状态码单看没有任何信息量
      ElMessage.error({ message: result.message + (result.detail ? `｜${result.detail.slice(0, 120)}` : ""), duration: 8000 });
    }
  } catch (error) {
    ElMessage.error(readError(error, "看图测试失败，请检查地址、Key 与模型名。"));
  } finally {
    testingVision.value = false;
  }
}

/** 记忆助手「获取模型」只读取它自己的已保存 Key；不会复用对话模型凭据。 */
async function fetchMemoryAssistantModels() {
  if (fetchingMemoryAssistantModels.value || testingMemoryAssistant.value || testing.value
    || testingVision.value || testingVoice.value || saving.value || !character.value) return;
  fetchingMemoryAssistantModels.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; models: string[]; message: string; unsupported?: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/memory-assistant/models`,
    );
    if (!result.ok) {
      if (result.unsupported) ElMessage.warning(result.message);
      else ElMessage.error(result.message);
      return;
    }
    fetchedMemoryAssistantModels.value = result.models;
    if (!draftMemoryAssistantModel.value.trim() && result.models.length) {
      draftMemoryAssistantModel.value = result.models[0] ?? "";
    }
    ElMessage.success(result.message);
  } catch (error) {
    ElMessage.error(readError(error, "获取记忆助手模型列表失败，请检查独立 API 地址和 Key。"));
  } finally {
    fetchingMemoryAssistantModels.value = false;
  }
}

/** 记忆助手连接测试使用独立凭据；即使尚未开启助手，也可以先验证配置。 */
async function testMemoryAssistant() {
  if (testingMemoryAssistant.value || fetchingMemoryAssistantModels.value || testing.value
    || testingVision.value || testingVoice.value || saving.value || !character.value) return;
  testingMemoryAssistant.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; elapsedMs?: number }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/test-memory-assistant-connection`,
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : ""));
    } else {
      ElMessage.error(result.message || "记忆助手 API 连通性测试失败。");
    }
  } catch (error) {
    ElMessage.error(readError(error, "记忆助手连接测试失败，请检查独立 API 地址、Key 和模型名称。"));
  } finally {
    testingMemoryAssistant.value = false;
  }
}
async function fetchContextAssistantModels() {
  if (fetchingContextAssistantModels.value || testingContextAssistant.value || testing.value
    || testingVision.value || testingVoice.value || saving.value || !character.value) return;
  fetchingContextAssistantModels.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; models: string[]; message: string; unsupported?: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/context-assistant/models`,
    );
    if (!result.ok) {
      if (result.unsupported) ElMessage.warning(result.message);
      else ElMessage.error(result.message);
      return;
    }
    fetchedContextAssistantModels.value = result.models;
    if (!draftContextAssistantModel.value.trim() && result.models.length) {
      draftContextAssistantModel.value = result.models[0] ?? "";
    }
    ElMessage.success(result.message);
  } catch (error) {
    ElMessage.error(readError(error, "获取语境助手模型列表失败，请检查独立 API 地址和 Key。"));
  } finally {
    fetchingContextAssistantModels.value = false;
  }
}

/** 语境助手连接测试使用独立凭据；即使尚未开启助手，也可以先验证配置。 */
async function testContextAssistant() {
  if (testingContextAssistant.value || fetchingContextAssistantModels.value || testing.value
    || testingVision.value || testingVoice.value || saving.value || !character.value) return;
  testingContextAssistant.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; elapsedMs?: number }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/test-context-assistant-connection`,
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : ""));
    } else {
      ElMessage.error(result.message || "语境助手 API 连通性测试失败。");
    }
  } catch (error) {
    ElMessage.error(readError(error, "语境助手连接测试失败，请检查独立 API 地址、Key 和模型名称。"));
  } finally {
    testingContextAssistant.value = false;
  }
}

const providerLabel = computed(() => currentProvider.value?.name ?? "自定义");/** 开放平台入口：跟着当前服务商走；自定义没有固定入口，链接就不出现 */
const consoleUrl = computed(() => currentProvider.value?.consoleUrl ?? "");
const modelOptions = computed(() => buildModelOptions({
  baseUrl: draftChatApiBaseUrl.value,
  current: draftChatModel.value,
  fetched: fetchedModels.value,
}));

function readError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function applyProvider(key: string) {
  draftProviderKey.value = key;
  const preset = providerByKey(key);
  if (preset?.baseUrl) draftChatApiBaseUrl.value = preset.baseUrl;

  // 换了一家，模型名不能还停在上一家的清单里（deepseek-flash 配通义的地址必然调不通）。
  // 只换「空着」或「属于别家内置清单」的值：自己手填的名字、以及新家没有内置清单
  // （硅基流动、自定义）时都不动 —— 那种情况本来就得先「获取模型」再看。
  const model = draftChatModel.value.trim();
  const belongsToOther = MODEL_PROVIDERS.some(
    (provider) => provider.key !== key && provider.models.includes(model),
  );
  const nextModel = preset?.models[0] ?? "";
  if (nextModel && (!model || belongsToOther)) draftChatModel.value = nextModel;
  else if (belongsToOther) ElMessage.info(`${preset?.name ?? "这家"}没有内置模型清单，点「获取模型」拉一份再选。`);

  // 上一家「获取模型」拉回来的清单跟着作废
  fetchedModels.value = [];
}

function resetRecommendedGenerationSettings() {
  draftChatTemperature.value = 0.8;
  draftChatMaxTokens.value = 4096;
  draftDailyTokenLimit.value = 0;
  draftMemoryTokenBudget.value = 1800;
  draftSnapshotTokenBudget.value = 2500;
  draftMemoryItemLimit.value = 20;
  draftRecentMessageLimit.value = 40;
  // 「推荐参数」不碰近期忆泡的开关：那是用户显式打开的记忆功能。被一个「恢复推荐」
  // 顺手关掉，表现就是「她突然不记得昨天了」，而且完全看不出是在哪一步被关的。
  ElMessage.success("已填入日常陪伴推荐参数，点击保存设置后生效。");
}

/** 地址能反推服务商：直接把地址粘进来时下拉要跟着对上，否则一直停在「自定义」 */
watch(draftChatApiBaseUrl, (value) => {
  const nextKey = providerByBaseUrl(value)?.key ?? "custom";
  if (nextKey === draftProviderKey.value) return;
  draftProviderKey.value = nextKey;
  fetchedModels.value = [];
});

async function loadCharacter() {
  loading.value = true;
  try {
    const data = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`);
    character.value = data;
    draftChatModel.value = data.chatModel ?? "";
    draftChatTemperature.value = data.chatTemperature ?? 0.7;
    draftChatMaxTokens.value = data.chatMaxTokens ?? 4096;
    draftChatApiBaseUrl.value = data.chatApiBaseUrl || "https://api.openai.com/v1";
    draftChatApiKey.value = "";
    draftDailyTokenLimit.value = data.dailyTokenLimit ?? 0;
    draftMemoryTokenBudget.value = data.memoryTokenBudget ?? 1800;
    draftSnapshotTokenBudget.value = data.snapshotTokenBudget ?? 2500;
    draftMemoryItemLimit.value = data.memoryItemLimit ?? 20;
    draftRecentMessageLimit.value = data.recentMessageLimit ?? 40;
    draftEventRecentDays.value = data.eventRecentDays ?? 0;
    draftProviderKey.value = providerByBaseUrl(draftChatApiBaseUrl.value)?.key ?? "custom";
    // 语音模型
    draftVoiceProvider.value = data.ttsProvider || "auto";
    draftVoiceApiKey.value = "";
    draftVoiceApiBaseUrl.value = data.voiceApiBaseUrl ?? "";
    draftVoiceTtsModel.value = data.ttsModel ?? "";
    draftVoiceTtsVoice.value = data.ttsVoice ?? "";
    draftVoiceSpeed.value = data.ttsSpeed && data.ttsSpeed > 0 ? data.ttsSpeed : 1;
    draftVoiceAsrModel.value = data.asrModel ?? "";
    draftVoiceGroupId.value = data.ttsGroupId ?? "";
    draftVoiceInstructions.value = data.ttsInstructions ?? "";
    draftAsrProvider.value = data.asrProvider || "auto";
    draftAsrApiBaseUrl.value = data.asrApiBaseUrl ?? "";
    draftAsrApiKey.value = "";
    syncAsrFromVoice.value = false;
    // 图片模型
    draftVisionModel.value = data.visionModel ?? "";
    draftVisionApiBaseUrl.value = data.visionApiBaseUrl ?? "";
    draftVisionApiKey.value = "";
    draftMemoryAssistantModel.value = data.memoryAssistantModel ?? "";
    draftMemoryAssistantTemperature.value = data.memoryAssistantTemperature ?? 0.1;
    draftMemoryAssistantMaxInputTokens.value = data.memoryAssistantMaxInputTokens ?? 12288;
    draftMemoryAssistantMaxOutputTokens.value = data.memoryAssistantMaxOutputTokens ?? 2048;
    draftMemoryAssistantApiBaseUrl.value = data.memoryAssistantApiBaseUrl ?? "";
    draftMemoryAssistantProviderKey.value = providerByBaseUrl(
      draftMemoryAssistantApiBaseUrl.value || draftChatApiBaseUrl.value,
    )?.key ?? "custom";
    draftMemoryAssistantApiKey.value = "";
    fetchedMemoryAssistantModels.value = [];
    draftContextAssistantEnabled.value = data.contextAssistantEnabled === true;
    draftContextAssistantModel.value = data.contextAssistantModel ?? "";
    draftContextAssistantTemperature.value = data.contextAssistantTemperature ?? 0.1;
    draftContextAssistantMaxInputTokens.value = data.contextAssistantMaxInputTokens ?? 16384;
    draftContextAssistantMaxOutputTokens.value = data.contextAssistantMaxOutputTokens ?? 2048;
    draftContextAssistantApiBaseUrl.value = data.contextAssistantApiBaseUrl ?? "";
    draftContextAssistantProviderKey.value = providerByBaseUrl(
      draftContextAssistantApiBaseUrl.value || draftChatApiBaseUrl.value,
    )?.key ?? "custom";
    draftContextAssistantApiKey.value = "";
    fetchedContextAssistantModels.value = [];
    fetchedModels.value = [];
    savedSignature.value = draftSignature.value;
    lastSavedAt.value = data.updatedAt ? new Date(data.updatedAt) : null;
    await loadUsage();
  } catch {
    character.value = null;
    ElMessage.error("加载角色失败，请确认角色仍存在且本地数据库已初始化。");
  } finally {
    loading.value = false;
  }
}

/** silent：测试连接和拉取模型都要先保存，那两步不该再弹一次「已保存」 */
async function save(silent = false): Promise<boolean> {
  if (saving.value || !character.value) return false;
  if (draftChatModel.value.trim().length > 120) {
    ElMessage.warning("模型名称不能超过 120 个字符。");
    return false;
  }
  saving.value = true;
  try {
    const updated = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`, {
      method: "PATCH",
      body: {
        chatModel: draftChatModel.value.trim(),
        chatTemperature: draftChatTemperature.value,
        chatMaxTokens: draftChatMaxTokens.value,
        chatApiBaseUrl: draftChatApiBaseUrl.value.trim(),
        // 不再发 clearApiKey：清除入口已下线（2026-11-07），已有 Key 只能被新的覆盖。
        // 服务端仍接受这个字段（脚本和迁移在用），页面不传就是「不动」。
        chatApiKey: draftChatApiKey.value,
        dailyTokenLimit: draftDailyTokenLimit.value,
        memoryTokenBudget: draftMemoryTokenBudget.value,
        snapshotTokenBudget: draftSnapshotTokenBudget.value,
        memoryItemLimit: draftMemoryItemLimit.value,
        recentMessageLimit: draftRecentMessageLimit.value,
        eventRecentDays: draftEventRecentDays.value,
        // 语音模型
        voiceApiBaseUrl: draftVoiceApiBaseUrl.value.trim(),
        ttsModel: draftVoiceTtsModel.value.trim(),
        ttsVoice: draftVoiceTtsVoice.value.trim(),
        ttsSpeed: draftVoiceSpeed.value,
        asrModel: draftVoiceAsrModel.value.trim(),
        ttsProvider: draftVoiceProvider.value === "auto" ? "" : draftVoiceProvider.value,
        ttsGroupId: draftVoiceGroupId.value.trim(),
        ttsInstructions: draftVoiceInstructions.value.trim(),
        asrProvider: draftAsrProvider.value === "auto" ? "" : draftAsrProvider.value,
        asrApiBaseUrl: draftAsrApiBaseUrl.value.trim(),
        ...(draftAsrApiKey.value.trim() ? { asrApiKey: draftAsrApiKey.value.trim() } : {}),
        ...(syncAsrFromVoice.value ? { syncAsrFromVoice: true } : {}),
        ...(draftVoiceApiKey.value.trim() ? { voiceApiKey: draftVoiceApiKey.value.trim() } : {}),
        // 图片模型
        visionModel: draftVisionModel.value.trim(),
        visionApiBaseUrl: draftVisionApiBaseUrl.value.trim(),
        ...(draftVisionApiKey.value.trim() ? { visionApiKey: draftVisionApiKey.value.trim() } : {}),
        // 记忆助手模型：独立凭据，Key 留空不改，明确勾选才删除。
        memoryAssistantModel: draftMemoryAssistantModel.value.trim(),
        memoryAssistantTemperature: draftMemoryAssistantTemperature.value,
        memoryAssistantMaxInputTokens: draftMemoryAssistantMaxInputTokens.value,
        memoryAssistantMaxOutputTokens: draftMemoryAssistantMaxOutputTokens.value,
        memoryAssistantApiBaseUrl: draftMemoryAssistantApiBaseUrl.value.trim(),
        ...(draftMemoryAssistantApiKey.value.trim()
          ? { memoryAssistantApiKey: draftMemoryAssistantApiKey.value.trim() }
          : {}),
        contextAssistantEnabled: draftContextAssistantEnabled.value,
        contextAssistantModel: draftContextAssistantModel.value.trim(),
        contextAssistantTemperature: draftContextAssistantTemperature.value,
        contextAssistantMaxInputTokens: draftContextAssistantMaxInputTokens.value,
        contextAssistantMaxOutputTokens: draftContextAssistantMaxOutputTokens.value,
        contextAssistantApiBaseUrl: draftContextAssistantApiBaseUrl.value.trim(),
        ...(draftContextAssistantApiKey.value.trim()
          ? { contextAssistantApiKey: draftContextAssistantApiKey.value.trim() }
          : {}),
      },
    });
    character.value = updated;
    draftChatApiKey.value = "";
    draftVoiceApiKey.value = "";
    draftVisionApiKey.value = "";
    draftMemoryAssistantApiKey.value = "";
    draftContextAssistantApiKey.value = "";
    // 清空 Key 输入框之后才取指纹，否则刚存的这份会一直被当成「未保存」
    savedSignature.value = draftSignature.value;
    lastSavedAt.value = new Date();
    if (!silent) ElMessage.success("模型设置已保存。");
    await loadUsage();
    return true;
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
    return false;
  } finally {
    saving.value = false;
  }
}

/** 服务端只认已保存的配置（Key 加密存放），所以步调统一为「先存再测 / 先存再拉」 */
async function testConnection() {
  if (testing.value || saving.value || fetchingModels.value || !character.value) return;
  testing.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; elapsedMs?: number }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/test-connection`,
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : ""));
    } else {
      ElMessage.error(result.message || "API 连通性测试失败。");
    }
  } catch (error) {
    ElMessage.error(readError(error, "API 连通性测试失败，请检查地址、Key 和模型名称。"));
  } finally {
    testing.value = false;
  }
}

async function fetchModels() {
  if (fetchingModels.value || saving.value || testing.value || !character.value) return;
  fetchingModels.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; models: string[]; message: string; unsupported?: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/models`,
    );
    if (!result.ok) {
      if (result.unsupported) ElMessage.warning(result.message);
      else ElMessage.error(result.message);
      return;
    }
    fetchedModels.value = result.models;
    if (!draftChatModel.value.trim() && result.models.length) {
      draftChatModel.value = result.models[0] ?? "";
    }
    ElMessage.success(result.message);
  } catch (error) {
    ElMessage.error(readError(error, "获取模型列表失败，请稍后重试。"));
  } finally {
    fetchingModels.value = false;
  }
}

/**
 * 图片页的「获取模型」：拉的是**看图那一家**的清单（`?target=vision`）。
 *
 * 和对话页那条的区别只有两点：
 *   1. 不自动选中第一个 —— `/models` 不分能不能读图，第一个多半是聊天模型；
 *   2. 拉失败时把服务商原文显示出来（429 / 403 光看状态码没有信息量）。
 */
async function fetchVisionModels() {
  if (fetchingVisionModels.value || saving.value || testing.value || testingVision.value || !character.value) return;
  fetchingVisionModels.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; models: string[]; message: string; unsupported?: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/models?target=vision`,
    );
    if (!result.ok) {
      if (result.unsupported) ElMessage.warning(result.message);
      else ElMessage.error(result.message);
      return;
    }
    fetchedVisionModels.value = result.models;
    ElMessage.success(`${result.message}从里面挑一个能读图的。`);
  } catch (error) {
    ElMessage.error(readError(error, "获取模型列表失败，请稍后重试。"));
  } finally {
    fetchingVisionModels.value = false;
  }
}

onMounted(() => void loadCharacter());
watch(id, () => void loadCharacter());
</script>

<template>
  <div class="page-wrap ms-a">
    <PageHeader
      :eyebrow="'角色管理 / ' + (character?.name ?? '角色') + ' / 模型设置'"
      description="决定这个角色使用哪些模型：对话、语音、看图、记忆助手和语境助手可以分别配置。API Key 加密保存、不回传给网页。"
      :back-to="backTarget"
      :back-label="backLabel"
    >
      <template #actions>
        <el-button
          :disabled="!character"
          @click="modelCallLogsOpen = true"
        >
          调用日志
        </el-button>
      </template>
    </PageHeader>
    <ModelCallLogsDialog
      v-model="modelCallLogsOpen"
      :character-id="id"
    />

    <div
      v-if="!loading && !character"
      class="empty-block"
    >
      <h4>读不到这个角色</h4>
      <p>角色可能已被删除，或本地数据库还没迁移。返回列表重新选择一个。</p>
      <el-button @click="navigateTo('/characters')">
        返回角色列表
      </el-button>
    </div>

    <div
      v-else
      v-loading="loading"
      class="ms-grid"
    >
      <div class="ms-main">
        <!-- 四个页签：对话、语音、图片、记忆助手。 -->
        <div
          class="model-tabs"
          role="tablist"
        >
          <button
            id="model-tab-chat"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'chat'"
            class="model-tab"
            :class="{ 'is-on': activeTab === 'chat' }"
            @click="activeTab = 'chat'"
          >
            对话模型
          </button>
          <button
            id="model-tab-voice"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'voice'"
            class="model-tab"
            :class="{ 'is-on': activeTab === 'voice' }"
            @click="activeTab = 'voice'"
          >
            语音模型
          </button>
          <button
            id="model-tab-vision"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'vision'"
            class="model-tab"
            :class="{ 'is-on': activeTab === 'vision' }"
            @click="activeTab = 'vision'"
          >
            图片模型
          </button>
          <button
            id="model-tab-memory-assistant"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'memoryAssistant'"
            class="model-tab"
            :class="{ 'is-on': activeTab === 'memoryAssistant' }"
            @click="activeTab = 'memoryAssistant'"
          >
            记忆助手
          </button>          <button
            id="model-tab-context-assistant"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'contextAssistant'"
            class="model-tab"
            :class="{ 'is-on': activeTab === 'contextAssistant' }"
            @click="activeTab = 'contextAssistant'"
          >
            语境助手
          </button>
        </div>

        <div
          v-show="activeTab === 'chat'"
          class="model-pane"
        >
          <!-- ① 连接：三件套共同决定「能不能调通」，放同一块砖里 -->
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    对话模型
                  </h2>
                </div>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">服务商</span>
                </div>
                <el-select
                  :model-value="draftProviderKey"
                  class="field-ctl"
                  aria-label="服务商"
                  placeholder="选择服务商，自动填好地址与常用模型"
                  @change="applyProvider"
                >
                  <el-option
                    v-for="preset in MODEL_PROVIDERS"
                    :key="preset.key"
                    :label="preset.name"
                    :value="preset.key"
                  />
                </el-select>
              </div>

              <div class="field">
                <!-- 标签行右侧挂开放平台入口：用户卡住的点不是「填什么」，而是「去哪拿 Key」 -->
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                  <a
                    v-if="consoleUrl"
                    class="field-link"
                    :href="consoleUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    去 {{ providerLabel }} 开放平台取 Key
                    <el-icon><TopRight /></el-icon>
                  </a>
                </div>
                <el-input
                  v-model="draftChatApiBaseUrl"
                  maxlength="500"
                  aria-label="API 地址"
                  placeholder="https://api.deepseek.com/v1"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="apiKeySource === 'missing' ? 'pill-rose' : 'pill-green'"
                  >{{ apiKeySource === "character" ? "已保存" : apiKeySource === "environment" ? "服务端默认" : "未填写" }}</span>
                </div>
                <ApiKeyInput
                  v-model="draftChatApiKey"
                  aria-label="API Key"
                  :placeholder="apiKeyPlaceholder"
                />
              </div>

              <!-- 模型和「服务商 / 地址 / Key」本来是同一件事：连接通不通取决于这四项配套。
                   以前单独一块砖，看起来像两个独立步骤，实际选完服务商就要在这里选模型 -->
              <div class="field">
                <div class="field-head">
                  <span class="field-label">模型名称</span>
                </div>
                <div class="model-row">
                  <el-select
                    v-model="draftChatModel"
                    class="model-select"
                    filterable
                    allow-create
                    default-first-option
                    aria-label="模型名称"
                    placeholder="选择，或直接输入模型名"
                  >
                    <el-option
                      v-for="model in modelOptions"
                      :key="model"
                      :label="model"
                      :value="model"
                    />
                  </el-select>
                  <el-button
                    :loading="fetchingModels"
                    :disabled="saving || testing"
                    @click="fetchModels"
                  >
                    <el-icon><Refresh /></el-icon>{{ fetchingModels ? "获取中…" : "获取模型" }}
                  </el-button>
                </div>
              </div>
            </div>

            <div class="voice-test-bar">
              <el-button
                :loading="testing"
                :disabled="saving || testingMemoryAssistant || fetchingMemoryAssistantModels || testingContextAssistant || fetchingContextAssistantModels"
                @click="testConnection"
              >
                <el-icon><Promotion /></el-icon>{{ testing ? "测试中…" : "测试" }}
              </el-button>
            </div>
          </section>

          <!-- ③ 生成参数：每个旋钮都是「标签 + 一句为什么 + 控件」 -->
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    生成参数
                  </h2>
                </div>
                <p class="brick-desc">
                  推荐方案适合日常陪伴与角色对话，兼顾表达变化、记忆和用量。点「填入推荐值」，再保存生效。
                </p>
              </div>
              <el-button
                text
                class="head-act"
                @click="resetRecommendedGenerationSettings"
              >
                填入推荐值
              </el-button>
            </div>

            <div class="knob-group">
              <div class="knob-group-head">
                <h3 class="knob-group-title">
                  回复表现
                </h3>
                <span class="knob-group-note">从日常陪伴推荐方案开始，再按实际效果微调</span>
              </div>

              <div class="knob">
                <div class="knob-label">
                  温度
                </div>
                <p class="field-help">
                  推荐 0.8：为角色聊天保留一些表达变化。若容易跑题或人设不稳，可降到 0.6；不同模型效果会有差异。
                </p>
                <div class="knob-ctl">
                  <el-slider
                    v-model="draftChatTemperature"
                    class="knob-slider"
                    :min="0"
                    :max="2"
                    :step="0.1"
                    :aria-label="'温度'"
                  />
                  <el-input-number
                    v-model="draftChatTemperature"
                    class="knob-number narrow"
                    :min="0"
                    :max="2"
                    :step="0.1"
                    :precision="1"
                    :controls="false"
                    aria-label="温度数值"
                  />
                </div>
              </div>

              <div class="knob">
                <div class="knob-label">
                  最大输出 Token
                </div>
                <p class="field-help">
                  推荐 4096：思考 token 也算在这个上限里，给窄了会出现「思考完没正文」。这是单次输出上限，不代表每次都会用满，用多少算多少。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftChatMaxTokens"
                    class="knob-number"
                    :min="256"
                    :max="8192"
                    :step="256"
                    aria-label="最大输出 Token"
                  />
                </div>
              </div>
            </div>

            <div class="knob-group">
              <div class="knob-group-head">
                <h3 class="knob-group-title">
                  用量与记忆
                </h3>
                <span class="knob-group-note">预算越高，上下文越多，用量也可能增加</span>
              </div>

              <div class="knob">
                <div class="knob-label">
                  每日 token 额度
                </div>
                <p class="field-help">
                  默认不限（0）。想设上限时再填：按东八区统计所有调用，达到额度后会暂停相关调用；这不是金额上限，建议先观察几天「用量与花费」再决定。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftDailyTokenLimit"
                    class="knob-number"
                    :min="0"
                    :max="10000000"
                    :step="10000"
                    aria-label="每日 token 额度"
                  />
                </div>
              </div>

              <div class="knob">
                <div class="knob-label">
                  最近对话保留（条）
                </div>
                <p class="field-help">
                  推荐 40 条（网页对话约 20 轮）。群里一轮就有好几条，同样的条数覆盖的轮次会少一些，可以调大；范围 20–200。调得太大不只是费 token，真正相关的几句反而会被稀释。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftRecentMessageLimit"
                    class="knob-number"
                    :min="20"
                    :max="200"
                    :step="10"
                    aria-label="最近对话保留条数"
                  />
                </div>
              </div>

              <div class="knob">
                <div class="knob-label">
                  近期忆泡（天）
                </div>
                <p class="field-help">
                  0 = 不带。填 2 表示把最近两天发生的事无条件带进每一轮，和问不问无关——群里没人会问日期，不这么带，她对昨天就是一片空白。代价是每轮多几百 token；提示词里已经写明「只当背景、不主动提」，但调大后仍可能翻旧账。范围 0–14。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftEventRecentDays"
                    class="knob-number"
                    :min="0"
                    :max="14"
                    :step="1"
                    aria-label="近期忆泡天数"
                  />
                </div>
              </div>

              <div class="knob">
                <div class="knob-label">
                  记忆注入预算（token）
                </div>
                <p class="field-help">
                  推荐 1800：约 20 条长期记忆的量，适合持续陪伴。预算并非严格硬上限，首条记忆始终放行；0 回退到系统默认 1800。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftMemoryTokenBudget"
                    class="knob-number"
                    :min="0"
                    :max="20000"
                    :step="200"
                    aria-label="记忆注入预算"
                  />
                </div>
              </div>

              <div class="knob">
                <div class="knob-label">
                  记忆注入条数
                </div>
                <p class="field-help">
                  推荐 20 条。它比预算更早卡住：记忆平均 74 字，12 条才 888 token，1800 的预算有一半用不上。上限 50，再多每条的注意力会被摊薄。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftMemoryItemLimit"
                    class="knob-number"
                    :min="1"
                    :max="50"
                    :step="1"
                    aria-label="记忆注入条数"
                  />
                </div>
              </div>

              <div class="knob">
                <div class="knob-label">
                  阶段总结注入预算（token）
                </div>
                <p class="field-help">
                  推荐 2500：约 1.5 份周期总结，与长期记忆预算独立。首条总结始终放行，可能超出预算；0 回退到系统默认 2500。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftSnapshotTokenBudget"
                    class="knob-number"
                    :min="0"
                    :max="20000"
                    :step="200"
                    aria-label="阶段总结注入预算"
                  />
                </div>
              </div>
            </div>
          </section>
        </div>

        <div
          v-show="activeTab === 'voice'"
          class="model-pane"
        >
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    语音合成
                  </h2>
                </div>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">服务商</span>
                </div>
                <el-select
                  v-model="draftVoiceProvider"
                  class="field-ctl"
                  aria-label="语音服务商"
                  @change="applyVoiceProviderTemplate"
                >
                  <el-option
                    label="自动判断（看下面的地址）"
                    value="auto"
                  />
                  <el-option
                    label="OpenAI 兼容（硅基流动 / OpenAI）"
                    value="openai"
                  />
                  <el-option
                    label="MiniMax（中文女声好、延迟 1-3 秒）"
                    value="minimax"
                  />
                  <el-option
                    label="Breeze（可写语气指令、要克隆音色）"
                    value="breeze"
                  />
                </el-select>
              </div>

              <!-- 顺序与右边的对话模型一致：服务商 → API 地址 → API Key。
                   填地址的人八成手里还没有 Key，所以先把「去哪拿」摆在这一行 -->
              <div class="field">
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                  <a
                    v-if="voiceConsoleUrl"
                    class="field-link"
                    :href="voiceConsoleUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    去 {{ voiceProviderName }} 开放平台取 Key
                    <el-icon><TopRight /></el-icon>
                  </a>
                </div>
                <el-input
                  v-model="draftVoiceApiBaseUrl"
                  maxlength="500"
                  aria-label="语音 API 地址"
                  :placeholder="voiceUsesBreeze ? 'https://api.breeze.blue' : voiceUsesMinimax ? 'https://api.minimaxi.com/v1' : 'https://api.siliconflow.cn/v1'"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="voiceKeyConfigured ? 'pill-green' : 'pill-rose'"
                  >{{ voiceKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <ApiKeyInput
                  v-model="draftVoiceApiKey"
                  aria-label="语音 API Key"
                  :placeholder="voiceKeyPlaceholder"
                />
              </div>

              <div
                v-if="voiceUsesMinimax"
                class="field"
              >
                <div class="field-head">
                  <span class="field-label">MiniMax 空间 ID（GID）</span>
                </div>
                <el-input
                  v-model="draftVoiceGroupId"
                  maxlength="100"
                  aria-label="MiniMax 空间 ID（GID）"
                  placeholder="留空即可；报 GroupId 不匹配时再填"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">合成模型</span>
                </div>
                <div class="model-row">
                  <el-select
                    v-model="draftVoiceTtsModel"
                    class="model-select"
                    filterable
                    allow-create
                    default-first-option
                    aria-label="语音合成模型"
                    :placeholder="voiceUsesMinimax ? 'speech-2.5-turbo-preview' : 'FunAudioLLM/CosyVoice2-0.5B'"
                  >
                    <el-option
                      v-for="model in voiceModelOptions"
                      :key="model"
                      :label="model"
                      :value="model"
                    />
                  </el-select>
                  <el-button
                    :loading="fetchingVoiceModels"
                    :disabled="saving || testingVoice"
                    @click="fetchVoiceModels"
                  >
                    <el-icon><Refresh /></el-icon>{{ fetchingVoiceModels ? "获取中…" : "获取模型" }}
                  </el-button>
                </div>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">音色</span>
                </div>
                <el-input
                  v-model="draftVoiceTtsVoice"
                  maxlength="100"
                  aria-label="语音音色"
                  :placeholder="voiceUsesBreeze ? 'voc_...（Breeze 里克隆出来的音色 id）' : voiceUsesMinimax ? 'female-shaonv' : 'FunAudioLLM/CosyVoice2-0.5B:claire'"
                />

              <div class="field">
                <div class="field-head">
                  <span class="field-label">语速</span>
                </div>
                <div class="knob-ctl">
                  <el-slider
                    v-model="draftVoiceSpeed"
                    class="knob-slider"
                    :min="0.5"
                    :max="2"
                    :step="0.05"
                    aria-label="语音语速"
                  />
                  <el-input-number
                    v-model="draftVoiceSpeed"
                    class="knob-number narrow"
                    :min="0.5"
                    :max="2"
                    :step="0.05"
                    :precision="2"
                    :controls="false"
                    aria-label="语音语速数值"
                  />
                </div>
              </div>
              </div>

              <!-- Breeze 独有：语气是「写出来」的，不是靠音色自带 -->
              <div
                v-if="voiceUsesBreeze"
                class="field"
              >
                <div class="field-head">
                  <span class="field-label">语气指令</span>
                </div>
                <el-input
                  v-model="draftVoiceInstructions"
                  type="textarea"
                  :rows="2"
                  maxlength="400"
                  show-word-limit
                  aria-label="语音语气指令"
                  placeholder="例：声音软软的、轻轻的，带一点气声，说话有点黏，语气温柔"
                />
              </div>
            </div>

            <!-- 语音的验证：真合成一句，走完整链路（Key/地址/模型/音色/hex/silk） -->
            <div class="voice-test-bar">
              <el-button
                :loading="testingVoice"
                :disabled="saving || fetchingVoiceModels"
                @click="testVoice"
              >
                <el-icon><Promotion /></el-icon>{{ testingVoice ? "测试中…" : "测试" }}
              </el-button>
            </div>
          </section>

          <!-- 识别和合成是两套配置：Breeze 只做合成，共用一把 Key 只会 401 -->
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    语音识别
                  </h2>
                </div>
              </div>
              <el-button
                :disabled="saving"
                @click="useSameAsVoice"
              >
                <el-icon><CopyDocument /></el-icon>同语音合成
              </el-button>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">服务商</span>
                </div>
                <el-select
                  v-model="draftAsrProvider"
                  class="field-ctl"
                  aria-label="识别服务商"
                  placeholder="自动判断（看下面的地址）"
                  @change="applyAsrProviderTemplate"
                >
                  <el-option
                    label="自动判断（看下面的地址）"
                    value="auto"
                  />
                  <el-option
                    label="OpenAI 兼容（硅基流动 / OpenAI whisper）"
                    value="openai"
                  />
                  <el-option
                    label="MiniMax（asr-1.0，中文识别好）"
                    value="minimax"
                  />
                </el-select>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                </div>
                <el-input
                  v-model="draftAsrApiBaseUrl"
                  maxlength="500"
                  aria-label="识别 API 地址"
                  placeholder="https://api.minimaxi.com/v1"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="asrKeyConfigured || syncAsrFromVoice ? 'pill-green' : 'pill-rose'"
                  >{{ syncAsrFromVoice ? "保存后同步" : asrKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <ApiKeyInput
                  v-model="draftAsrApiKey"
                  aria-label="识别 API Key"
                  :placeholder="asrKeyConfigured ? API_KEY_SAVED_PLACEHOLDER : API_KEY_EMPTY_PLACEHOLDER"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">识别模型</span>
                </div>
                <el-input
                  v-model="draftVoiceAsrModel"
                  maxlength="120"
                  aria-label="语音识别模型"
                  placeholder="留空 = 用服务商默认（MiniMax 是 asr-1.0）"
                />
              </div>
            </div>
          </section>
        </div>

        <div
          v-show="activeTab === 'vision'"
          class="model-pane"
        >
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    图片模型
                  </h2>
                </div>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">服务商</span>
                </div>
                <el-select
                  :model-value="visionProviderKey"
                  class="field-ctl"
                  aria-label="图片服务商"
                  @change="applyVisionProvider"
                >
                  <el-option
                    v-for="provider in MODEL_PROVIDERS"
                    :key="provider.key"
                    :label="provider.name"
                    :value="provider.key"
                  />
                </el-select>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                  <a
                    v-if="visionConsoleUrl"
                    class="field-link"
                    :href="visionConsoleUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    去 {{ visionProviderName }} 开放平台取 Key
                    <el-icon><TopRight /></el-icon>
                  </a>
                </div>
                <el-input
                  v-model="draftVisionApiBaseUrl"
                  maxlength="500"
                  aria-label="图片 API 地址"
                  :placeholder="draftChatApiBaseUrl + '（留空 = 跟随对话模型）'"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="visionKeyConfigured ? 'pill-green' : 'pill-rose'"
                  >{{ visionKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <ApiKeyInput
                  v-model="draftVisionApiKey"
                  aria-label="图片 API Key"
                  :placeholder="visionKeyPlaceholder"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">看图模型</span>
                </div>
                <div class="model-row">
                  <el-select
                    v-model="draftVisionModel"
                    class="model-select"
                    filterable
                    allow-create
                    default-first-option
                    aria-label="看图模型"
                    :placeholder="'留空 = 用对话模型（' + (draftChatModel || '未填') + '）'"
                  >
                    <el-option
                      v-for="model in visionModelOptions"
                      :key="model"
                      :label="model"
                      :value="model"
                    />
                  </el-select>
                  <el-button
                    :loading="fetchingVisionModels"
                    :disabled="saving || testing || testingVision || testingVoice"
                    @click="fetchVisionModels"
                  >
                    <el-icon><Refresh /></el-icon>{{ fetchingVisionModels ? "获取中…" : "获取模型" }}
                  </el-button>
                </div>
              </div>
            </div>

            <!-- 看图必须实测：只测文本连通性测不出「收下图但没看」 -->
            <div class="vision-test-bar">
              <el-button
                :loading="testingVision"
                :disabled="saving"
                @click="testVision"
              >
                <el-icon><Promotion /></el-icon>{{ testingVision ? "测试中…" : "测试" }}
              </el-button>
            </div>
          </section>
        </div>

        <div
          v-show="activeTab === 'memoryAssistant'"
          class="model-pane"
        >
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    记忆助手
                  </h2>
                </div>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">服务商</span>
                </div>
                <el-select
                  v-model="draftMemoryAssistantProviderKey"
                  class="field-ctl"
                  aria-label="记忆助手服务商"
                  placeholder="选择服务商，自动填好 API 地址"
                  @change="applyMemoryAssistantProvider"
                >
                  <el-option
                    v-for="provider in MODEL_PROVIDERS"
                    :key="provider.key"
                    :label="provider.name"
                    :value="provider.key"
                  />
                </el-select>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                  <a
                    v-if="memoryAssistantConsoleUrl"
                    class="field-link"
                    :href="memoryAssistantConsoleUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    去 {{ memoryAssistantProviderLabel }} 开放平台取 Key
                    <el-icon><TopRight /></el-icon>
                  </a>
                </div>
                <el-input
                  v-model="draftMemoryAssistantApiBaseUrl"
                  maxlength="500"
                  aria-label="记忆助手 API 地址"
                  :placeholder="draftChatApiBaseUrl + '（留空 = 跟随对话模型地址）'"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="memoryAssistantKeyConfigured ? 'pill-green' : 'pill-rose'"
                  >{{ memoryAssistantKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <ApiKeyInput
                  v-model="draftMemoryAssistantApiKey"
                  aria-label="记忆助手 API Key"
                  :placeholder="memoryAssistantKeyConfigured ? API_KEY_SAVED_PLACEHOLDER : '填写记忆助手专用 API Key'"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">模型名称</span>
                </div>
                <div class="model-row">
                  <el-select
                    v-model="draftMemoryAssistantModel"
                    class="model-select"
                    filterable
                    allow-create
                    default-first-option
                    aria-label="记忆助手模型名称"
                    placeholder="选择，或直接输入模型名"
                  >
                    <el-option
                      v-for="model in memoryAssistantModelOptions"
                      :key="model"
                      :label="model"
                      :value="model"
                    />
                  </el-select>
                  <el-button
                    :loading="fetchingMemoryAssistantModels"
                    :disabled="saving || testing || testingMemoryAssistant || testingVision || testingVoice"
                    @click="fetchMemoryAssistantModels"
                  >
                    <el-icon><Refresh /></el-icon>{{ fetchingMemoryAssistantModels ? "获取中…" : "获取模型" }}
                  </el-button>
                </div>
              </div>
            </div>
          </section>

          <section class="brick">
            <div class="brick-head"><div class="brick-head-txt">
              <div class="brick-heading"><h2 class="brick-title">检索参数</h2></div>
              <p class="brick-desc">只影响记忆助手，不会改变大肥鱼的对话模型参数。输入预算是估算上限，实际 Token 数以模型供应商统计为准。</p>
            </div></div>
            <div class="knob-group">
              <div class="knob">
                <div class="knob-label">温度</div>
                <p class="field-help">默认 0.1。较低温度让来源筛选更稳定，范围 0–2。</p>
                <div class="knob-ctl">
                  <el-slider v-model="draftMemoryAssistantTemperature" class="knob-slider" :min="0" :max="2" :step="0.1" aria-label="记忆助手温度" />
                  <el-input-number v-model="draftMemoryAssistantTemperature" class="knob-number narrow" :min="0" :max="2" :step="0.1" :precision="1" :controls="false" aria-label="记忆助手温度数值" />
                </div>
              </div>
              <div class="knob">
                <div class="knob-label">最大输入 Token</div>
                <p class="field-help">默认 12288。系统提示词和问题会先预留预算，剩余部分用于候选记忆资料；这是估算上限。范围 4096–32768。</p>
                <div class="knob-ctl"><el-input-number v-model="draftMemoryAssistantMaxInputTokens" class="knob-number" :min="4096" :max="32768" :step="1024" aria-label="记忆助手最大输入 Token" /></div>
              </div>
              <div class="knob">
                <div class="knob-label">最大输出 Token</div>
                <p class="field-help">默认 2048。首次请求使用约 80%，若响应被截断再使用完整上限；重试不会超过这里设置的值。范围 512–8192。</p>
                <div class="knob-ctl"><el-input-number v-model="draftMemoryAssistantMaxOutputTokens" class="knob-number" :min="512" :max="8192" :step="256" aria-label="记忆助手最大输出 Token" /></div>
              </div>
            </div>
          </section>

          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    启用说明
                  </h2>
                </div>
                <p class="brick-desc">
                  模型配置保存后，还需要到「角色管理」为这个角色打开记忆助手。未配置模型名称或独立 Key 时，开关不可用。
                  记忆助手只在大肥鱼判断现有上下文不足、需要回看历史细节时才额外调用；普通聊天不会多发一次模型请求。关闭它不会影响大肥鱼现有的记忆检索和正常聊天。
                </p>
              </div>
            </div>
            <div class="metric-row">
              <span>模型配置</span>
              <span class="metric-value">
                {{ draftMemoryAssistantModel.trim() && character?.memoryAssistantApiKeyConfigured ? "已具备启用条件" : "尚未完整配置" }}
              </span>
            </div>
          </section>

          <section class="brick">
            <div class="vision-test-bar">
              <el-button
                :loading="testingMemoryAssistant"
                :disabled="saving || testing || testingVision || testingVoice || fetchingMemoryAssistantModels"
                @click="testMemoryAssistant"
              >
                <el-icon><Promotion /></el-icon>{{ testingMemoryAssistant ? "测试中…" : "测试" }}
              </el-button>
            </div>
          </section>
        </div>
        <div
          v-show="activeTab === 'contextAssistant'"
          class="model-pane"
        >
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    语境助手
                  </h2>
                </div>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">服务商</span>
                </div>
                <el-select
                  v-model="draftContextAssistantProviderKey"
                  class="field-ctl"
                  aria-label="语境助手服务商"
                  placeholder="选择服务商，自动填好 API 地址"
                  @change="applyContextAssistantProvider"
                >
                  <el-option
                    v-for="provider in MODEL_PROVIDERS"
                    :key="provider.key"
                    :label="provider.name"
                    :value="provider.key"
                  />
                </el-select>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                  <a
                    v-if="contextAssistantConsoleUrl"
                    class="field-link"
                    :href="contextAssistantConsoleUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    去 {{ contextAssistantProviderLabel }} 开放平台取 Key
                    <el-icon><TopRight /></el-icon>
                  </a>
                </div>
                <el-input
                  v-model="draftContextAssistantApiBaseUrl"
                  maxlength="500"
                  aria-label="语境助手 API 地址"
                  :placeholder="draftChatApiBaseUrl + '（留空 = 跟随对话模型地址）'"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="contextAssistantKeyConfigured ? 'pill-green' : 'pill-rose'"
                  >{{ contextAssistantKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <ApiKeyInput
                  v-model="draftContextAssistantApiKey"
                  aria-label="语境助手 API Key"
                  :placeholder="contextAssistantKeyConfigured ? API_KEY_SAVED_PLACEHOLDER : '填写语境助手专用 API Key'"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">模型名称</span>
                </div>
                <div class="model-row">
                  <el-select
                    v-model="draftContextAssistantModel"
                    class="model-select"
                    filterable
                    allow-create
                    default-first-option
                    aria-label="语境助手模型名称"
                    placeholder="选择，或直接输入模型名"
                  >
                    <el-option
                      v-for="model in contextAssistantModelOptions"
                      :key="model"
                      :label="model"
                      :value="model"
                    />
                  </el-select>
                  <el-button
                    :loading="fetchingContextAssistantModels"
                    :disabled="saving || testing || testingContextAssistant || testingVision || testingVoice"
                    @click="fetchContextAssistantModels"
                  >
                    <el-icon><Refresh /></el-icon>{{ fetchingContextAssistantModels ? "获取中…" : "获取模型" }}
                  </el-button>
                </div>
              </div>
            </div>
          </section>

          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    语境整理参数
                  </h2>
                </div>
                <p class="brick-desc">
                  只影响语境助手，不会改变角色的对话模型参数。输入预算是估算上限，实际 Token 数以模型供应商统计为准。
                </p>
              </div>
            </div>
            <div class="knob-group">
              <div class="knob">
                <div class="knob-label">
                  温度
                </div>
                <p class="field-help">
                  默认 0.1。较低温度让语境整理更稳定，范围 0–2。
                </p>
                <div class="knob-ctl">
                  <el-slider
                    v-model="draftContextAssistantTemperature"
                    class="knob-slider"
                    :min="0"
                    :max="2"
                    :step="0.1"
                    aria-label="语境助手温度"
                  />
                  <el-input-number
                    v-model="draftContextAssistantTemperature"
                    class="knob-number narrow"
                    :min="0"
                    :max="2"
                    :step="0.1"
                    :precision="1"
                    :controls="false"
                    aria-label="语境助手温度数值"
                  />
                </div>
              </div>
              <div class="knob">
                <div class="knob-label">
                  最大输入 Token
                </div>
                <p class="field-help">
                  默认 16384。系统提示词和当前对话材料共用此估算输入预算。范围 4096–32768。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftContextAssistantMaxInputTokens"
                    class="knob-number"
                    :min="4096"
                    :max="32768"
                    :step="1024"
                    aria-label="语境助手最大输入 Token"
                  />
                </div>
              </div>
              <div class="knob">
                <div class="knob-label">
                  最大输出 Token
                </div>
                <p class="field-help">
                  默认 2048。语境助手输出的最大 Token 数。范围 512–8192。
                </p>
                <div class="knob-ctl">
                  <el-input-number
                    v-model="draftContextAssistantMaxOutputTokens"
                    class="knob-number"
                    :min="512"
                    :max="8192"
                    :step="256"
                    aria-label="语境助手最大输出 Token"
                  />
                </div>
              </div>
            </div>
          </section>

          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    启用说明
                  </h2>
                </div>
                <p class="brick-desc">
                  模型配置保存后，还需要到「角色管理」为这个角色打开记忆助手。未配置模型名称或独立 Key 时，开关不可用。
                  记忆助手只在大肥鱼判断现有上下文不足、需要回看历史细节时才额外调用；普通聊天不会多发一次模型请求。关闭它不会影响大肥鱼现有的记忆检索和正常聊天。
                </p>
              </div>
            </div>
            <div class="metric-row">
              <span>模型配置</span>
              <span class="metric-value">
                {{ draftMemoryAssistantModel.trim() && character?.memoryAssistantApiKeyConfigured ? "已具备启用条件" : "尚未完整配置" }}
              </span>
            </div>
          </section>

          <section class="brick">
            <div class="vision-test-bar">
              <el-button
                :loading="testingContextAssistant"
                :disabled="saving || testing || testingVision || testingVoice || fetchingContextAssistantModels"
                @click="testContextAssistant"
              >
                <el-icon><Promotion /></el-icon>{{ testingContextAssistant ? "测试中…" : "测试" }}
              </el-button>
            </div>
          </section>
        </div>

        <!-- 吸底操作条：只留保存。测试按钮跟在各自的模型下面，不再从这里统一触发 -->
        <div class="act-bar">
          <span
            class="act-state"
            :class="{ dirty }"
          >{{ saveStateLabel }}</span>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="testing || testingMemoryAssistant || fetchingMemoryAssistantModels || testingContextAssistant || fetchingContextAssistantModels"
            @click="save(false)"
          >
            {{ saving ? "保存中…" : "保存设置" }}
          </el-button>
        </div>
      </div>

      <aside class="ms-side">
        <section class="brick">
          <div class="card-head">
            <h2>当前配置</h2>
            <span class="sub">已写入数据库</span>
          </div>
          <div class="metric-row">
            <span>模型</span><span class="metric-value">{{ character?.chatModel || "未配置" }}</span>
          </div>
          <div class="metric-row">
            <span>服务商</span><span class="metric-value">{{ providerLabel }}</span>
          </div>
          <div class="metric-row">
            <span>API Key</span><span
              class="pill"
              :class="apiKeySource === 'missing' ? 'pill-rose' : 'pill-green'"
            >{{ apiKeySource === "character" ? "角色独立 Key" : apiKeySource === "environment" ? "服务端默认 Key" : "未配置" }}</span>
          </div>
          <div class="metric-row">
            <span>温度 / 上限</span><span class="metric-value">{{ character?.chatTemperature ?? "—" }} · {{ character?.chatMaxTokens ?? "—" }} tokens</span>
          </div>
          <div class="metric-row">
            <span>看图模型</span><span class="metric-value">{{ character?.visionModel || "跟随对话模型" }}</span>
          </div>
          <div class="metric-row">
            <span>记忆助手</span><span class="metric-value">{{ character?.memoryAssistantConfigured ? character.memoryAssistantModel : "未配置" }}</span>
          </div>
          <p class="side-note">
            模型未配置时，对话与自动归档会留在队列里，不会用规则摘要冒充 AI 输出。
          </p>
        </section>

        <section class="brick">
          <div class="card-head">
            <h2>今日用量</h2>
            <span class="sub">{{ dailyUsage?.day ?? "—" }}</span>
          </div>

          <div class="usage-top">
            <span class="usage-value">{{ dailyUsage ? dailyUsage.usage.totalTokens.toLocaleString() : "—" }}</span>
            <span
              v-if="dailyUsage?.quota.limit"
              class="usage-limit"
            >/ {{ dailyUsage.quota.limit.toLocaleString() }} · {{ quotaPercent }}%</span>
            <span
              v-else
              class="usage-limit"
            >不限额度</span>
          </div>
          <div
            v-if="quotaPercent !== null"
            class="usage-bar"
            role="img"
            :aria-label="`今日用量 ${quotaPercent}%`"
          >
            <div
              class="usage-fill"
              :class="{ warn: quotaPercent >= 90 }"
              :style="{ width: quotaPercent + '%' }"
            />
          </div>

          <div class="metric-row">
            <span>调用次数</span><span class="metric-value">{{ dailyUsage?.usage.calls ?? 0 }}</span>
          </div>
          <div
            v-for="[kind, value] in usageKinds"
            :key="kind"
            class="metric-row"
          >
            <span>{{ KIND_LABELS[String(kind)] ?? kind }}</span>
            <span class="metric-value">{{ value.totalTokens.toLocaleString() }} · {{ value.calls }} 次</span>
          </div>

          <div class="usage-foot">
            <el-button
              text
              :loading="loadingUsage"
              @click="loadUsage(false)"
            >
              {{ loadingUsage ? "刷新中…" : "刷新用量" }}
            </el-button>
            <span class="usage-note">额度用完不会自动清零：统计的是真实花费，调高额度或等次日恢复。</span>
          </div>
        </section>

        <section class="brick">
          <div class="card-head">
            <h2>几个要知道的点</h2>
          </div>
          <div class="rule">
            <span class="rule-number">01</span>
            <div>
              <strong>Key 不会回传网页</strong>
              <p>保存后页面只显示「已保存」，原文无法再读出；留空即保持不变。</p>
            </div>
          </div>
          <div class="rule">
            <span class="rule-number">02</span>
            <div>
              <strong>测试与拉取都先保存</strong>
              <p>两步都用服务端已存的配置发起请求，所以会先写入数据库。</p>
            </div>
          </div>
          <div class="rule">
            <span class="rule-number">03</span>
            <div>
              <strong>内置清单会过期</strong>
              <p>厂商改名很常见，清单只作起点；能拉取就以拉取结果为准。</p>
            </div>
          </div>
          <p class="side-note">
            这里的配置只影响该角色在 QQ 上的回复与自动归档提炼，不改变其他角色。
          </p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用 A 套「色块平铺」：白砖、零描边、零阴影，
   层次只靠明度差 + 间距。需要盖掉全局类的地方带 `.ms-a` 前缀（(0,3,0)），
   Element 内部结构走 :deep()，两条都靠组件样式晚于 main.css 加载取胜。
   取值只从 token 取：间距 --sp-1..7、圆角 10/8/6、
   字号 12 / 14 / 16 / 22（六档里的四档）、正文色 text / text-2 / dim。
   --faint（2.52:1）只留给序号和分隔符，不承载信息。
   ══════════════════════════════════════════════════════════════ */

.ms-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--sp-5); align-items: start; }
.ms-main { display: flex; min-width: 0; flex-direction: column; gap: var(--sp-4); }
/* 页签：对话模型 / 语音模型。下划线选中态，与侧栏「当前项」同一套语汇 */
.model-tabs { display: flex; flex-wrap: wrap; gap: var(--sp-1); border-bottom: 1px solid var(--line); }
.model-tab {
  margin-bottom: -1px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  padding: var(--sp-2) var(--sp-3);
  color: var(--dim);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: color .14s var(--ease), border-color .14s var(--ease);
}
.model-tab:hover { color: var(--text-2); }
.model-tab.is-on { color: var(--brand-strong); border-bottom-color: var(--brand); }
.model-tab:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: var(--radius-xs); }
/* 页签内容：一块 pane 就是一组 brick，v-show 切换不丢已填的表单 */
.model-pane { display: flex; min-width: 0; flex-direction: column; gap: var(--sp-4); }

/* 一块砖 = 一组「同一件事」的字段。砖与砖 16，砖内字段也 16，
   但砖头（标题 + 说明）靠字号与颜色差就能认出来，不再多画一条分隔线 */
.ms-a .brick { border-radius: 10px; background: var(--surface); padding: var(--sp-5); }

.brick-head { display: flex; align-items: flex-start; gap: var(--sp-4); }
.brick-desc { max-width: 44em; margin: var(--sp-1) 0 0; color: var(--dim); font-size: 12px; line-height: 1.65; }
/* 行宽用 em 不用 ch：中文一个字也是 1em，62ch 只够放 ~31 个汉字 */
.ms-a .field-help { max-width: 44em; margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.knob .field-help { grid-area: help; }
.brick-head-txt { min-width: 0; flex: 1; }
.brick-heading { display: flex; align-items: center; gap: var(--sp-2); }
.brick-title { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; letter-spacing: -.01em; line-height: 1.4; }
.head-act { flex: none; }

/* ── 字段（竖排：标签 → 控件 → 一句解释） ───────────── */
.fields { display: flex; flex-direction: column; gap: var(--sp-4); margin-top: var(--sp-4); }
.field { display: flex; min-width: 0; flex-direction: column; gap: var(--sp-2); }
/* 标签行：左标签 + 右侧开放平台入口。基线对齐，链接不能比标签高出一截 */
.field-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-2); }
.field-label { color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; }
/* 12px 文字链接只能用 --brand-strong（#bf3a63）：--brand 只有 3.2:1，不到 AA */
.field-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  border-radius: var(--radius-xs);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  transition: color .14s var(--ease);
}
.field-link:hover { color: var(--brand-btn-h); text-decoration: underline; }
.field-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.field-link .el-icon { font-size: 13px; }
.field-ctl { width: 100%; }

/* 模型下拉 + 「获取模型」同行：select 吃掉剩余宽度，按钮不吃 */
.model-row { display: flex; width: 100%; align-items: center; gap: var(--sp-2); }
.model-select { min-width: 0; flex: 1; }

/* 语音的验证条：按钮 + 一句成本提示，与字段区用上边框隔开 */
.voice-test-bar, .vision-test-bar { display: flex; align-items: center; gap: var(--sp-3); margin-top: var(--sp-2); border-top: 1px solid var(--surface-3); padding-top: var(--sp-4); }

/* ── 参数（横排：左边说「调它有什么用」，右边落控件） ── */
/* 分两列改成一行一条：说明在半个卡片宽里会折成五六行，把控件挤出视线；
   换成行之后所有控件落在同一条竖线上，扫一眼就知道当前值 */
.knob-group { margin-top: var(--sp-4); border-top: 1px solid var(--surface-3); padding-top: var(--sp-4); }
.knob-group + .knob-group { margin-top: var(--sp-5); }
.knob-group-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-3); }
.knob-group-title { margin: 0; color: var(--text); font-size: 14px; font-weight: 700; }
.knob-group-note { color: var(--dim); font-size: 12px; }
.knob {
  display: grid;
  grid-template-areas:
    "label ctl"
    "help  help";
  grid-template-columns: minmax(0, 1fr) 268px;
  align-items: start;
  gap: var(--sp-2) var(--sp-5);
  padding: var(--sp-3) 0;
}
.knob-label { grid-area: label; color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; }
.knob-ctl { display: flex; grid-area: ctl; align-items: center; gap: var(--sp-2); }
.knob + .knob { border-top: 1px solid var(--surface-3); }
.knob-slider { min-width: 88px; flex: 1; }
.knob-number { width: 100%; }
.knob-number.narrow { width: 84px; flex: none; }
.knob-ctl :deep(.el-input-number .el-input__inner) { text-align: left; font-variant-numeric: tabular-nums; }
.ms-a :deep(.el-slider) { --el-slider-height: 4px; }
.ms-a :deep(.el-slider__button) { width: 14px; height: 14px; border-width: 2px; }

/* ── 吸底操作条 ─────────────────────────────────── */
/* 页面要滚两屏多，主操作必须留在视线里。--bg 不透明垫底，
   上方补 16px 渐隐，避免控件「贴边被切断」的错觉 */
.act-bar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  background: var(--bg);
  padding: var(--sp-3) 0 var(--sp-4);
}
.act-bar::before {
  content: "";
  position: absolute;
  right: 0;
  bottom: 100%;
  left: 0;
  height: var(--sp-4);
  background: linear-gradient(to bottom, rgba(244, 246, 249, 0), var(--bg));
  pointer-events: none;
}
.act-state { margin-right: auto; color: var(--dim); font-size: 12px; font-weight: 600; }
.act-state.dirty { color: var(--brand-strong); }

/* 按钮：36px 与输入框同高；主按钮用 --brand-btn 实色（--brand 只做图标/焦点环） */
.ms-a :deep(.el-button) {
  height: var(--ctl-h);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-4);
  font-size: 14px;
  font-weight: 600;
}
.ms-a :deep(.el-button--primary) { background: var(--brand-btn); border-color: var(--brand-btn); }
.ms-a :deep(.el-button--primary:hover),
.ms-a :deep(.el-button--primary:focus-visible) { background: var(--brand-btn-h); border-color: var(--brand-btn-h); }
.ms-a :deep(.el-button.is-text) { padding: 0 6px; color: var(--brand-strong); }
.ms-a :deep(.el-button.is-text:hover) { background: var(--brand-soft); color: var(--brand-btn-h); }
.ms-a :deep(.el-button .el-icon) { font-size: 14px; }

/* ── 右栏 ───────────────────────────────────────── */
.ms-side { display: flex; flex-direction: column; gap: var(--sp-4); }
.ms-side .brick { padding: var(--sp-4) var(--sp-5); }
.card-head { display: flex; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.card-head h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.card-head .sub { margin-left: auto; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }

/* 行线用最淡的 --surface-3，读数区不描边 */
.ms-a .metric-row { border-bottom: 0; padding: var(--sp-2) 0; color: var(--dim); }
.ms-a .metric-row + .metric-row { border-top: 1px solid var(--surface-3); }
.ms-side .metric-value { max-width: 62%; color: var(--text-2); text-align: right; word-break: break-word; }
.ms-a .pill { border: 0; }

.usage-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); margin: var(--sp-2) 0 var(--sp-2); }
/* 用量数字是这一栏的主角：比旁边的限值大两档 */
.usage-value { color: var(--text); font-size: 22px; font-weight: 700; letter-spacing: -.015em; font-variant-numeric: tabular-nums; }
.usage-limit { color: var(--dim); font-size: 12px; font-weight: 600; }
.usage-bar { height: 6px; overflow: hidden; border-radius: 3px; background: var(--surface-3); }
.usage-fill { height: 100%; border-radius: 3px; background: var(--brand); transition: width .3s var(--ease); }
.usage-fill.warn { background: var(--amber); }
.usage-foot { display: flex; align-items: flex-start; gap: var(--sp-2); margin-top: var(--sp-3); }
.usage-note { flex: 1; color: var(--dim); font-size: 12px; line-height: 1.6; }
.side-note { margin: var(--sp-3) 0 0; border-radius: var(--radius-sm); background: var(--surface-2); padding: var(--sp-3); color: var(--dim); font-size: 12px; line-height: 1.7; }

.rule { display: flex; gap: var(--sp-3); margin-top: var(--sp-3); }
.rule-number { flex: 0 0 auto; color: var(--faint); font: 700 12px/1.7 Consolas, monospace; }
.rule strong { color: var(--text-2); font-size: 14px; font-weight: 600; }
.rule p { margin: 3px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }

/* 空态：一句话 + 一颗按钮，不围虚线框 */
.empty-block { border-radius: 10px; background: var(--surface); padding: var(--sp-6) var(--sp-5); }
.empty-block h4 { margin: 0 0 6px; color: var(--text); font-size: 16px; font-weight: 600; }
.empty-block p { max-width: 34em; margin: 0 0 var(--sp-4); color: var(--dim); font-size: 14px; line-height: 1.7; }

/* 1050 以下右栏掉到主内容下面：先读配置，再看数据 */
@media (max-width: 1050px) {
  .ms-grid { grid-template-columns: minmax(0, 1fr); }
  .ms-side { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
  .ms-side .brick:last-child { grid-column: 1 / -1; }
}
@media (max-width: 720px) {
  .ms-a .brick { padding: var(--sp-4); }
  .knob {
    grid-template-areas: "label" "ctl" "help";
    grid-template-columns: minmax(0, 1fr);
  }
  .knob-ctl { justify-content: flex-start; }
  .knob-number { max-width: 200px; }
  .model-row { flex-wrap: wrap; }
}
@media (max-width: 640px) {
  .ms-side { grid-template-columns: minmax(0, 1fr); }
  .field-link { margin-left: 0; }
  .act-bar { flex-wrap: wrap; }
  .act-state { width: 100%; }
}
</style>
