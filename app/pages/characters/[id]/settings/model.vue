<script setup lang="ts">
import { Promotion, Refresh, TopRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import type { Character } from "~/utils/mock-data";
import { MODEL_PROVIDERS, buildModelOptions, buildVisionModelOptions, providerByBaseUrl, providerByKey } from "~/utils/model-catalog";

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
const clearSavedApiKey = ref(false);
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
const clearVoiceApiKey = ref(false);
const draftVoiceApiBaseUrl = ref("");
const draftVoiceTtsModel = ref("");
const draftVoiceTtsVoice = ref("");
const draftVoiceAsrModel = ref("");
const draftVoiceGroupId = ref("");
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
const clearVisionApiKey = ref(false);

// ── 记忆助手模型：独立地址、模型和 API Key，不借用聊天凭据 ──
const draftMemoryAssistantModel = ref("");
const draftMemoryAssistantApiBaseUrl = ref("");
const draftMemoryAssistantApiKey = ref("");
const clearMemoryAssistantApiKey = ref(false);
const testingVision = ref(false);
/** 图片页「获取模型」拉回来的清单；换地址就作废（两家清单不通用） */
const fetchedVisionModels = ref<string[]>([]);
const fetchingVisionModels = ref(false);
/** 模型设置页签：对话 / 语音 / 图片 / 记忆助手。用 v-show 切换，切换不丢已填表单 */
const activeTab = ref<"chat" | "voice" | "vision" | "memoryAssistant">("chat");

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

const KIND_LABELS: Record<string, string> = {
  chat: "AI 对话",
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
  other: "其他",
};

/**
 * 表单指纹。值 + 「移除 Key」的勾选都要进串：只比有没有填 Key，
 * 会漏掉「勾了移除但还没保存」这一种改动。
 */
const draftSignature = computed(() => JSON.stringify([
  draftChatModel.value.trim(),
  draftChatTemperature.value,
  draftChatMaxTokens.value,
  draftChatApiBaseUrl.value.trim(),
  draftChatApiKey.value.trim(),
  clearSavedApiKey.value,
  draftDailyTokenLimit.value,
  draftMemoryTokenBudget.value,
  draftSnapshotTokenBudget.value,
  draftMemoryItemLimit.value,
  draftRecentMessageLimit.value,
  // 语音模型：Key 的明文不进指纹（留空=不改，没法从明文判断），布尔勾选要进
  draftVoiceProvider.value,
  draftVoiceApiBaseUrl.value.trim(),
  draftVoiceTtsModel.value.trim(),
  draftVoiceTtsVoice.value.trim(),
  draftVoiceAsrModel.value.trim(),
  draftVoiceGroupId.value.trim(),
  clearVoiceApiKey.value,
  // 图片模型：Key 明文同样不进指纹，勾选要进
  draftVisionModel.value.trim(),
  draftVisionApiBaseUrl.value.trim(),
  clearVisionApiKey.value,
  // 记忆助手 Key 明文不进指纹（留空=不改），清除勾选要进。
  draftMemoryAssistantModel.value.trim(),
  draftMemoryAssistantApiBaseUrl.value.trim(),
  draftMemoryAssistantApiKey.value.trim(),
  clearMemoryAssistantApiKey.value,
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

/** 三个入口各回各家：对话页、角色管理页、角色记忆页 */
const backTarget = computed(() => {
  if (route.query.from === "chat") return `/chat?c=${id.value}`;
  if (route.query.from === "characters") return "/characters";
  return `/memory?c=${id.value}`;
});
const backLabel = computed(() => {
  if (route.query.from === "chat") return "返回对话";
  if (route.query.from === "characters") return "返回角色管理";
  return "返回角色记忆";
});

const apiKeySource = computed(() => character.value?.chatApiKeySource ?? "missing");
const apiKeyPlaceholder = computed(() => {
  if (apiKeySource.value === "character") return "已加密保存；留空表示保持不变";
  if (apiKeySource.value === "environment") return "当前使用服务端默认 Key；填写可覆盖";
  return "请填写 API Key";
});
const apiKeyHint = computed(() => {
  if (apiKeySource.value === "character") return "此角色已保存 API Key。留空可保持现有 Key，不会在网页中显示原文。";
  if (apiKeySource.value === "environment") return "当前使用服务端默认 Key。输入新 Key 后会为本角色单独保存。";
  return "Key 只提交到本机服务端，使用 AES-256-GCM 加密后保存，不会回传给网页。";
});

const currentProvider = computed(() => providerByKey(draftProviderKey.value));

// ── 语音模型的计算属性 ──
const voiceKeyConfigured = computed(() => character.value?.voiceApiKeyConfigured === true);
/**
 * "auto" 是前端哨兵值，保存时映射回空字符串（= 交给后端按地址推断）。
 * 不能用空串当下拉值：Element Plus 把空串当「未选择」，那个选项会显示不出来。
 */
const voiceUsesMinimax = computed(() => {
  if (draftVoiceProvider.value === "minimax") return true;
  if (draftVoiceProvider.value === "openai") return false;
  return /minimax/i.test(draftVoiceApiBaseUrl.value);
});
const voiceKeyPlaceholder = computed(() => {
  if (voiceKeyConfigured.value) return "已加密保存；留空表示保持不变";
  return voiceUsesMinimax.value ? "sk-...（MiniMax 接口密钥页创建）" : "sk-...（服务商后台复制）";
});
const voiceKeyHint = computed(() => {
  if (voiceKeyConfigured.value) return "此角色已保存语音 Key。留空保持现有 Key，不会回显原文。";
  return "语音模型用的 Key，加密保存、不回传网页；与对话模型那把 Key 分开两把。";
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
  if (visionKeyConfigured.value) return "已加密保存；留空表示保持不变";
  const name = visionProviderName.value;
  return name ? `sk-...（${name} 后台复制）` : "sk-...（服务商后台复制）";
});
const visionKeyHint = computed(() => {
  if (visionKeyConfigured.value) return "此角色已保存看图 Key。留空保持现有 Key，不会回显原文。";
  return "留空 = 用服务端 VISION_API_KEY，再退一步用对话模型那把 Key。换了一家服务商就必须单独填。";
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

/** 两家的默认三件套：选服务商时一键带过去（和对话模型「选服务商自动填地址」同一套思路） */
const VOICE_PRESET: Record<string, { baseUrl: string; model: string; voice: string }> = {
  minimax: { baseUrl: "https://api.minimaxi.com/v1", model: "speech-2.5-turbo-preview", voice: "female-shaonv" },
  openai: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B", voice: "FunAudioLLM/CosyVoice2-0.5B:claire" },
};

/**
 * 选服务商时把地址 / 模型 / 音色一起带过去。
 * 只在「空着」或「还填着另一家的默认值」时才替换 —— 用户自己调过的参数不能被一次下拉冲掉。
 * 「自动判断」一个字段都不改：它的定义就是「看下面填的地址」，替用户改写地址等于替它下判断。
 *
 * ⚠️ 两个方向都要处理。以前只在 provider === "minimax" 时填，切回 OpenAI 兼容时地址和模型
 * 仍停在 MiniMax，界面上写着 OpenAI 兼容、实际打的是 MiniMax 的接口，合成必然失败。
 */
function applyVoiceProviderTemplate(provider: string) {
  const preset = VOICE_PRESET[provider];
  if (!preset) return;
  const toMinimax = provider === "minimax";

  const url = draftVoiceApiBaseUrl.value.trim();
  if (!url || (toMinimax ? /siliconflow|api\.openai\.com/i.test(url) : /minimax/i.test(url))) {
    draftVoiceApiBaseUrl.value = preset.baseUrl;
  }

  const model = draftVoiceTtsModel.value.trim();
  if (!model || (toMinimax ? /cosyvoice|^tts-|gpt-4o-mini-tts|moss/i.test(model) : /^speech-|minimax/i.test(model))) {
    draftVoiceTtsModel.value = preset.model;
  }

  const voice = draftVoiceTtsVoice.value.trim();
  if (!voice || (toMinimax ? /funaudiollm|^(alloy|nova|shimmer|echo|fable|onyx|sage|coral)$/i.test(voice) : /^(female|male)-/i.test(voice))) {
    draftVoiceTtsVoice.value = preset.voice;
  }

  // 换了一家用，「获取模型」上一家拉回来的清单就不作数了
  fetchedVoiceModels.value = [];
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

const providerLabel = computed(() => currentProvider.value?.name ?? "自定义");/** 开放平台入口：跟着当前服务商走；自定义没有固定入口，链接就不出现 */
const consoleUrl = computed(() => currentProvider.value?.consoleUrl ?? "");
const modelOptions = computed(() => buildModelOptions({
  baseUrl: draftChatApiBaseUrl.value,
  current: draftChatModel.value,
  fetched: fetchedModels.value,
}));
const providerHint = computed(() => {
  const preset = currentProvider.value;
  if (!preset || preset.key === "custom") return "没有列出的平台选「自定义」，手填 API 地址和模型名即可。";
  if (!preset.supportsModelList) return preset.name + " 不提供模型列表接口，下面的选项来自内置清单，也可以直接手填。";
  return "已填入 " + preset.name + " 的公开兼容地址；点「获取模型」可拉取该 Key 能用的全部模型。";
});

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
    clearSavedApiKey.value = false;
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
    clearVoiceApiKey.value = false;
    draftVoiceApiBaseUrl.value = data.voiceApiBaseUrl ?? "";
    draftVoiceTtsModel.value = data.ttsModel ?? "";
    draftVoiceTtsVoice.value = data.ttsVoice ?? "";
    draftVoiceAsrModel.value = data.asrModel ?? "";
    draftVoiceGroupId.value = data.ttsGroupId ?? "";
    // 图片模型
    draftVisionModel.value = data.visionModel ?? "";
    draftVisionApiBaseUrl.value = data.visionApiBaseUrl ?? "";
    draftVisionApiKey.value = "";
    clearVisionApiKey.value = false;
    draftMemoryAssistantModel.value = data.memoryAssistantModel ?? "";
    draftMemoryAssistantApiBaseUrl.value = data.memoryAssistantApiBaseUrl ?? "";
    draftMemoryAssistantApiKey.value = "";
    clearMemoryAssistantApiKey.value = false;
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
        chatApiKey: draftChatApiKey.value,
        clearApiKey: clearSavedApiKey.value && !draftChatApiKey.value.trim(),
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
        asrModel: draftVoiceAsrModel.value.trim(),
        ttsProvider: draftVoiceProvider.value === "auto" ? "" : draftVoiceProvider.value,
        ttsGroupId: draftVoiceGroupId.value.trim(),
        ...(draftVoiceApiKey.value.trim() ? { voiceApiKey: draftVoiceApiKey.value.trim() } : {}),
        ...(clearVoiceApiKey.value ? { clearVoiceApiKey: true } : {}),
        // 图片模型
        visionModel: draftVisionModel.value.trim(),
        visionApiBaseUrl: draftVisionApiBaseUrl.value.trim(),
        ...(draftVisionApiKey.value.trim() ? { visionApiKey: draftVisionApiKey.value.trim() } : {}),
        ...(clearVisionApiKey.value ? { clearVisionApiKey: true } : {}),
        // 记忆助手模型：独立凭据，Key 留空不改，明确勾选才删除。
        memoryAssistantModel: draftMemoryAssistantModel.value.trim(),
        memoryAssistantApiBaseUrl: draftMemoryAssistantApiBaseUrl.value.trim(),
        ...(draftMemoryAssistantApiKey.value.trim()
          ? { memoryAssistantApiKey: draftMemoryAssistantApiKey.value.trim() }
          : {}),
        ...(clearMemoryAssistantApiKey.value ? { clearMemoryAssistantApiKey: true } : {}),
      },
    });
    character.value = updated;
    draftChatApiKey.value = "";
    clearSavedApiKey.value = false;
    draftVoiceApiKey.value = "";
    clearVoiceApiKey.value = false;
    draftVisionApiKey.value = "";
    clearVisionApiKey.value = false;
    draftMemoryAssistantApiKey.value = "";
    clearMemoryAssistantApiKey.value = false;
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
      title="模型设置"
      description="决定这个角色使用哪些模型：对话、语音、看图和记忆助手可以分别配置。API Key 加密保存、不回传给网页。"
      :back-to="backTarget"
      :back-label="backLabel"
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
                    连接
                  </h2>
                </div>
                <p class="brick-desc">
                  选服务商会自动填好公开兼容地址和常用模型，也可以完全手填。
                </p>
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
                <p class="field-help">
                  {{ providerHint }}
                </p>
              </div>

              <div class="field">
                <!-- 标签行右侧挂开放平台入口：用户卡住的点不是「填什么」，而是「去哪拿 Key」 -->
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                  <span class="field-req">必填</span>
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
                <p class="field-help">
                  填 API 根地址，不要追加 /chat/completions。必须 HTTPS；HTTP 仅允许本机地址。
                </p>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                </div>
                <el-input
                  v-model="draftChatApiKey"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  maxlength="8192"
                  aria-label="API Key"
                  :placeholder="apiKeyPlaceholder"
                />
                <p class="field-help">
                  {{ apiKeyHint }}
                </p>
                <el-checkbox
                  v-if="apiKeySource === 'character'"
                  v-model="clearSavedApiKey"
                  class="field-check"
                >
                  移除此角色单独保存的 API Key
                </el-checkbox>
              </div>
            </div>
          </section>

          <!-- ② 模型 -->
          <section class="brick">
            <div class="brick-head">
              <div class="brick-head-txt">
                <div class="brick-heading">
                  <h2 class="brick-title">
                    模型
                  </h2>
                </div>
                <p class="brick-desc">
                  选项来自内置目录；「获取模型」会先保存再向服务商拉取真实列表，失败的原始提示会直接显示。
                </p>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">模型名称</span>
                  <span class="field-req">必填</span>
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
                    语音服务商
                  </h2>
                </div>
                <p class="brick-desc">
                  她发语音条、听懂别人语音时用的服务，与上面的对话模型可以是两家。
                  开关在「QQ 渠道 → 角色行为 → 语音」，这里只管「用哪家、哪把 Key、哪个音色」。
                </p>
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
                </el-select>
                <p class="field-help">
                  两家协议不一样（MiniMax 要 GID、返回的音频是 hex）。选 MiniMax 会自动带好地址、模型和音色。
                </p>
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
                  :placeholder="voiceUsesMinimax ? 'https://api.minimaxi.com/v1' : 'https://api.siliconflow.cn/v1'"
                />
                <p class="field-help">
                  填 API 根地址，不要追加 /audio/speech 或 /t2a_v2。
                </p>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="voiceKeyConfigured ? 'pill-green' : 'pill-rose'"
                  >{{ voiceKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <el-input
                  v-model="draftVoiceApiKey"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  maxlength="8192"
                  aria-label="语音 API Key"
                  :placeholder="voiceKeyPlaceholder"
                />
                <p class="field-help">
                  {{ voiceKeyHint }}
                </p>
                <el-checkbox
                  v-if="voiceKeyConfigured"
                  v-model="clearVoiceApiKey"
                  class="field-check"
                >
                  移除此角色单独保存的语音 Key
                </el-checkbox>
              </div>

              <div
                v-if="voiceUsesMinimax"
                class="field"
              >
                <div class="field-head">
                  <span class="field-label">MiniMax 空间 ID（GID）</span>
                  <span class="field-req">可选，先留空</span>
                </div>
                <el-input
                  v-model="draftVoiceGroupId"
                  maxlength="100"
                  aria-label="MiniMax 空间 ID（GID）"
                  placeholder="留空即可；报 GroupId 不匹配时再填"
                />
                <p class="field-help">
                  新版接口（<code>sk-</code> 开头的账号级 Key）不需要它。填了不属于这把 Key 的空间 ID，
                  MiniMax 会回 <code>1004 token not match group</code> —— 服务端会自动去掉 GID 再试一次，
                  但最好是留空。老版 JWT 形式的 Key 才必须填。
                  要找的话在 platform.minimaxi.com → 个人信息 → 空间管理 → 个人空间那一行的「管理」，页里叫「空间 ID（GID）」。
                </p>
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
                <p
                  v-if="voiceUsesMinimax"
                  class="field-help"
                >
                  聊天用 turbo 就够；hd 贵一倍、更慢，4 秒的群语音听不出差别。
                </p>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">音色</span>
                </div>
                <el-input
                  v-model="draftVoiceTtsVoice"
                  maxlength="100"
                  aria-label="语音音色"
                  :placeholder="voiceUsesMinimax ? 'female-shaonv' : 'FunAudioLLM/CosyVoice2-0.5B:claire'"
                />
                <p class="field-help">
                  <template v-if="voiceUsesMinimax">
                    female-shaonv 少女 / female-yujie 御姐 / female-chengshu 成熟。
                  </template>
                  <template v-else>
                    要带模型前缀。claire 温柔 / anna 沉稳 / bella 热情 / diana 活泼。
                  </template>
                </p>
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
                <p class="field-help">
                  听懂语音用。识别跟着「服务商」走（MiniMax 用 /speech_to_text，OpenAI 兼容用
                  /audio/transcriptions）。留空时 MiniMax 自动用 asr-1.0；OpenAI 兼容服务商
                  必须填（如硅基流动 SenseVoiceSmall、OpenAI whisper-1）。
                </p>
              </div>
            </div>

            <!-- 语音的验证：真合成一句，走完整链路（Key/地址/模型/音色/hex/silk） -->
            <div class="voice-test-bar">
              <el-button
                :loading="testingVoice"
                :disabled="saving || fetchingVoiceModels"
                @click="testVoice"
              >
                <el-icon><Promotion /></el-icon>{{ testingVoice ? "合成中…" : "测试语音合成" }}
              </el-button>
              <span class="voice-test-note">会真合成一句，按字符计费；成功会显示耗时，失败原因在服务端日志 [voice] 那行。</span>
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
                    图片服务商
                  </h2>
                </div>
                <p class="brick-desc">
                  她「看图」时用的那一家，和对话模型可以是两家。四项全留空就是今天的样子：交给对话模型顺便看 ——
                  但思考型模型会把输出预算全烧在思考上，最后正文为空，你只看到一句「[图片]」。
                  所以建议单独配一个不思考的视觉模型。开关仍在「QQ 渠道 → 角色行为 → 看群里的图」。
                </p>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">服务商</span>
                  <span class="field-req">可选</span>
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
                <p class="field-help">
                  选中会自动填好这家的地址与常用视觉模型；没有列出的选「自定义」，手填即可。
                </p>
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
                <p class="field-help">
                  填 API 根地址，不要追加 /chat/completions。留空即用对话模型那个地址。
                </p>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">API Key</span>
                  <span
                    class="pill"
                    :class="visionKeyConfigured ? 'pill-green' : 'pill-rose'"
                  >{{ visionKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <el-input
                  v-model="draftVisionApiKey"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  maxlength="8192"
                  aria-label="图片 API Key"
                  :placeholder="visionKeyPlaceholder"
                />
                <p class="field-help">
                  {{ visionKeyHint }}
                </p>
                <el-checkbox
                  v-if="visionKeyConfigured"
                  v-model="clearVisionApiKey"
                  class="field-check"
                >
                  移除此角色单独保存的看图 Key
                </el-checkbox>
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
                    :disabled="saving || testing || testingVision"
                    @click="fetchVisionModels"
                  >
                    <el-icon><Refresh /></el-icon>{{ fetchingVisionModels ? "获取中…" : "获取模型" }}
                  </el-button>
                </div>
                <p class="field-help">
                  只负责把图读成两三句中文，不需要推理能力。智谱的 <code>glm-4v-flash</code> 免费且不挤，
                  通义 <code>qwen3-vl-flash</code> 百万 token 一毛五，都够用；<code>glm-4.6v-flash</code> 更新，但晚上常被挤到 429。
                  「获取模型」拉的是填写地址那一家（留空就是对话那家）的清单，里面混着聊天模型，挑名字里带 <code>vl</code> / <code>vision</code> 的。
                </p>
              </div>
            </div>

            <!-- 看图必须实测：只测文本连通性测不出「收下图但没看」 -->
            <div class="vision-test-bar">
              <el-button
                :loading="testingVision"
                :disabled="saving"
                @click="testVision"
              >
                <el-icon><Promotion /></el-icon>{{ testingVision ? "测试中…" : "测试看图" }}
              </el-button>
              <span class="voice-test-note">会现画一张上红 / 中绿 / 下蓝的图发过去，答对三种颜色才算能用；一次调用，几乎不花钱。</span>
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
                    记忆助手模型
                  </h2>
                </div>
                <p class="brick-desc">
                  记忆助手使用独立模型和独立 API Key，负责检索时分析历史材料；不会借用大肥鱼的聊天 Key。
                  当前阶段先完成配置，启用开关位于「角色管理」的角色档案中。
                </p>
              </div>
            </div>

            <div class="fields">
              <div class="field">
                <div class="field-head">
                  <span class="field-label">API 地址</span>
                  <span class="field-req">可选</span>
                </div>
                <el-input
                  v-model="draftMemoryAssistantApiBaseUrl"
                  maxlength="500"
                  aria-label="记忆助手 API 地址"
                  :placeholder="draftChatApiBaseUrl + '（留空 = 跟随对话模型地址）'"
                />
                <p class="field-help">
                  填 API 根地址，不要追加 /chat/completions。留空时沿用这个角色的对话模型地址。
                </p>
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">模型名称</span>
                  <span class="field-req">必填</span>
                </div>
                <el-input
                  v-model="draftMemoryAssistantModel"
                  maxlength="120"
                  aria-label="记忆助手模型名称"
                  placeholder="填写专门用于记忆检索的模型名称"
                />
              </div>

              <div class="field">
                <div class="field-head">
                  <span class="field-label">独立 API Key</span>
                  <span
                    class="pill"
                    :class="character?.memoryAssistantApiKeyConfigured ? 'pill-green' : 'pill-rose'"
                  >{{ character?.memoryAssistantApiKeyConfigured ? "已保存" : "未填写" }}</span>
                </div>
                <el-input
                  v-model="draftMemoryAssistantApiKey"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  maxlength="8192"
                  aria-label="记忆助手 API Key"
                  placeholder="填写记忆助手专用 API Key"
                />
                <p class="field-help">
                  使用本机凭据加密密钥进行 AES-256-GCM 加密保存。留空表示不修改已有 Key，不会回传 Key 原文。
                  <template v-if="character?.memoryAssistantEnabled">记忆助手开启中；如需移除 Key 或清空模型，请先到角色管理关闭助手。</template>
                </p>
                <el-checkbox
                  v-if="character?.memoryAssistantApiKeyConfigured"
                  v-model="clearMemoryAssistantApiKey"
                  :disabled="character?.memoryAssistantEnabled === true"
                  class="field-check"
                >
                  移除记忆助手单独保存的 API Key
                </el-checkbox>
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
                  当前阶段只接入配置和开关，实际检索调用将在下一阶段接入；关闭它不会影响大肥鱼现有的记忆检索和正常聊天。
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
        </div>

        <!-- 吸底操作条：往下滚也能按到主操作 -->
        <div class="act-bar">
          <span
            class="act-state"
            :class="{ dirty }"
          >{{ saveStateLabel }}</span>
          <el-button
            :loading="testing"
            :disabled="saving"
            @click="testConnection"
          >
            {{ testing ? "测试中…" : "保存并测试" }}
          </el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="testing"
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
            这里的配置只影响该角色的 AI 对话与自动归档提炼，不改变其他角色。
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
.brick-head-txt { min-width: 0; flex: 1; }
.brick-heading { display: flex; align-items: center; gap: var(--sp-2); }
.brick-title { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; letter-spacing: -.01em; line-height: 1.4; }
.brick-desc { max-width: 44em; margin: var(--sp-1) 0 0; color: var(--dim); font-size: 12px; line-height: 1.65; }
.head-act { flex: none; }

/* ── 字段（竖排：标签 → 控件 → 一句解释） ───────────── */
.fields { display: flex; flex-direction: column; gap: var(--sp-4); margin-top: var(--sp-4); }
.field { display: flex; min-width: 0; flex-direction: column; gap: var(--sp-2); }
/* 标签行：左标签 + 右侧开放平台入口。基线对齐，链接不能比标签高出一截 */
.field-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-2); }
.field-label { color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; }
.field-req { color: var(--dim); font-size: 12px; font-weight: 500; }
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
/* main.css 的 .form-help 落在 --faint 上，那是装饰色；说明文字要读得清，改 --dim */
/* 行宽用 em 不用 ch：中文一个字的宽度也是 1em，62ch 只够放 ~31 个汉字 */
.ms-a .field-help { max-width: 44em; margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.field-check { align-self: flex-start; height: 20px; }

/* 模型下拉 + 「获取模型」同行：select 吃掉剩余宽度，按钮不吃 */
.model-row { display: flex; width: 100%; align-items: center; gap: var(--sp-2); }
.model-select { min-width: 0; flex: 1; }

/* 语音的验证条：按钮 + 一句成本提示，与字段区用上边框隔开 */
.voice-test-bar, .vision-test-bar { display: flex; align-items: center; gap: var(--sp-3); margin-top: var(--sp-2); border-top: 1px solid var(--surface-3); padding-top: var(--sp-4); }
.voice-test-note { flex: 1; color: var(--dim); font-size: 12px; line-height: 1.7; }

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
.knob .field-help { grid-area: help; }
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
