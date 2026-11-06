/**
 * 语音服务商的默认值（服务商 → 地址 / 模型 / 音色）。
 *
 * 为什么单独抽出来：这段逻辑出过一次线上 bug —— Breeze → MiniMax 方向漏了判断，
 * 地址停在 `api.breeze.blue`，界面上写着 MiniMax、实际还打 Breeze，合成一律 4xx。
 * 三家两两组合是 6 个方向，靠「A 换 B 时改什么」写死枚举一定会漏，
 * 所以改成「这个值看着像别家的吗」：以后再加一家，判断不用动。
 * 抽成纯函数是为了能单测（`yarn test:voice-provider`）。
 */

export type VoiceProviderKey = "minimax" | "breeze" | "openai";

export type VoicePreset = {
  baseUrl: string;
  model: string;
  voice: string;
};

/** 三家的默认三件套。Breeze 没有默认音色：它的 voice 是用户克隆出来的 `voc_` id。 */
export const VOICE_PRESET: Record<VoiceProviderKey, VoicePreset> = {
  minimax: {
    baseUrl: "https://api.minimaxi.com/v1",
    model: "speech-2.5-turbo-preview",
    voice: "female-shaonv",
  },
  breeze: {
    baseUrl: "https://api.breeze.blue",
    model: "breeze-tts-2",
    voice: "",
  },
  openai: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/CosyVoice2-0.5B",
    voice: "FunAudioLLM/CosyVoice2-0.5B:claire",
  },
};

type Field = "url" | "model" | "voice";

/** 每家默认值的指纹。用户自己填的第三方地址（如中转站）不匹配任何一条，会被保留。 */
const VOICE_SIGNATURE: Record<VoiceProviderKey, Record<Field, RegExp>> = {
  minimax: {
    url: /minimax/i,
    model: /^speech-|minimax/i,
    voice: /^(female|male)-/i,
  },
  breeze: {
    url: /breeze\.blue/i,
    model: /^breeze-tts/i,
    voice: /^voc_/i,
  },
  openai: {
    url: /siliconflow|api\.openai\.com/i,
    model: /cosyvoice|^tts-|gpt-4o-mini-tts|moss/i,
    voice: /funaudiollm|^(alloy|nova|shimmer|echo|fable|onyx|sage|coral)$/i,
  },
};

/** 这个值看着像别家的默认值吗？空值不算 —— 空着就该被填上。 */
export function looksLikeOtherProvider(
  value: string,
  provider: VoiceProviderKey,
  field: Field,
): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (Object.keys(VOICE_SIGNATURE) as VoiceProviderKey[]).some(
    (key) => key !== provider && VOICE_SIGNATURE[key][field].test(trimmed),
  );
}

export type VoiceProviderDraft = VoicePreset;

function isProviderKey(value: string): value is VoiceProviderKey {
  return value === "minimax" || value === "breeze" || value === "openai";
}

/**
 * 选服务商时算出该填的三件套。
 *
 * 规则：空着、或还填着**别家**的默认值时替换；用户自己改过的不动。
 * 返回 null = 不认识的选项（比如「自动判断」）：一个字段都不改 ——
 * 它的定义就是「看下面填的地址」，替用户改写地址等于替它下判断。
 */
export function applyVoiceProviderPreset(
  current: VoiceProviderDraft,
  provider: string,
): VoiceProviderDraft | null {
  if (!isProviderKey(provider)) return null;
  const preset = VOICE_PRESET[provider];

  const url = current.baseUrl.trim();
  const model = current.model.trim();
  const voice = current.voice.trim();

  return {
    baseUrl: !url || looksLikeOtherProvider(url, provider, "url") ? preset.baseUrl : current.baseUrl,
    model: !model || looksLikeOtherProvider(model, provider, "model") ? preset.model : current.model,
    voice: !voice || looksLikeOtherProvider(voice, provider, "voice") ? preset.voice : current.voice,
  };
}

/** 识别只有这两家（Breeze 没有识别端点），模型名也和合成完全不同。 */
export type VoiceAsrProviderKey = "minimax" | "openai";

export const ASR_PRESET: Record<VoiceAsrProviderKey, { baseUrl: string; model: string }> = {
  minimax: {
    baseUrl: "https://api.minimaxi.com/v1",
    model: "asr-1.0",
  },
  openai: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/SenseVoiceSmall",
  },
};

export type VoiceAsrDraft = { baseUrl: string; model: string };

/**
 * 识别侧选服务商时带出地址和模型。
 *
 * 和合成同一套规则（空着 / 像别家的才覆盖），只是候选只有两家：
 * 合成选 Breeze 时识别不能用它，用户切回 MiniMax 时那个 `api.breeze.blue`
 * 属于「像别家的地址」，照样会被换掉。
 */
export function applyAsrProviderPreset(
  current: VoiceAsrDraft,
  provider: string,
): VoiceAsrDraft | null {
  if (provider !== "minimax" && provider !== "openai") return null;
  const preset = ASR_PRESET[provider];

  const url = current.baseUrl.trim();
  const model = current.model.trim();

  return {
    baseUrl: !url || looksLikeOtherProvider(url, provider, "url") ? preset.baseUrl : current.baseUrl,
    model: !model || looksLikeOtherProvider(model, provider, "model") ? preset.model : current.model,
  };
}
