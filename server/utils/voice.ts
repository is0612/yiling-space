/**
 * QQ 语音：她「说话」（TTS → silk）与「听懂语音」（silk → ASR）。
 *
 * 为什么单独一条链路，而不是让聊天模型直接处理音频：
 *   聊天模型走的是文本 chat/completions，音频既进不去也出不来。所以语音只能发生在
 *   两个边界上 —— 发出前（文字 → 声音）和收到后（声音 → 文字）。中间那一段仍然是
 *   原来那套 chat-reply / pipeline，一个字都不用改。
 *
 * QQ 语音条只吃 **silk**（Tencent 私有编码），而 TTS 给的是 wav/mp3，所以这条链路上
 * 必然有一次转码。转码用 `silk-wasm`（纯 wasm，不需要 ffmpeg）：
 *   - 出站：TTS 直接要 `wav` → silk；要不到 wav 就当合成失败，退回发文字。
 *   - 入站：silk → pcm → 补一个 wav 头 → 交 ASR。
 * **不要再退回「让网关自己转码」**：网关不一定和适配器同机，也不一定装了 ffmpeg。
 *
 * 三件事必须在这里守住，别挪到调用方：
 *   1. **语音是钱**：TTS 按字符计费、ASR 按秒计费，且都不进 token 报表（见下）。
 *      所以打开开关、长度上限、冷却时间都在这一层定死。
 *   2. **url 是外部输入**：语音直链和图片直链一样可以指向内网，下载前过同一套白名单。
 *   3. **失败必须静默降级**：合成失败就发文字，识别失败就把 `[语音]` 换成
 *      `[语音（没转成文字）]`（见 `VOICE_UNTRANSCRIBED`），绝不能让一轮普通聊天变成失败事件。
 *
 * 关于记账：`model_usages` 是按 token 结算的表，语音按字符/秒计费，塞进去会污染
 * 「未定价 token」统计和金额报表（CLAUDE.md 那条「认不出的模型不许当 0 元」）。
 * 所以语音**不写 model_usages**，只在日志里留 `[voice]` 一行，便于按天估算。
 */

import {
  decode as decodeSilk,
  encode as encodeSilk,
  getDuration as getSilkDuration,
  isSilk,
  isWav,
} from "silk-wasm";

import { validateChatApiBaseUrl } from "./chat-model-config";
import { assertFetchableImageUrl, assertPublicHost } from "./image-understanding";

/** 这条回复最多合成多少字。再长就该用文字说：没人愿意听 40 秒的语音条。 */
export const VOICE_TEXT_MAX_CHARS = 60;

/**
 * 上一条发过语音后多久之内不再发（分钟）。连发两条语音像在读稿。
 *
 * 这个默认值是**给页面兜底**的：真实取值走 `modelConfig.voiceCooldownMinutes`，
 * 因为合理的间隔取决于服务商 —— MiniMax 合成 1~3 秒，20 分钟太死；硅基流动要
 * 16~21 秒（排队），那时候反而希望她别动不动就说。别顺手改这个常数。
 */
export const DEFAULT_VOICE_COOLDOWN_MINUTES = 20;

/** 上限一天：再长就等于永久关闭，那不如直接把「发语音」关掉。 */
const VOICE_COOLDOWN_MAX_MINUTES = 24 * 60;

/** 默认冷却的毫秒形式。测试与「没配时是多少」都以它为准。 */
export const VOICE_COOLDOWN_MS = DEFAULT_VOICE_COOLDOWN_MINUTES * 60 * 1000;

/**
 * 合成后在末尾补多少静音（毫秒）。**这不是为了好听，是为了不被切掉最后一个字。**
 *
 * QQ 语音的时长是整数秒，网关按帧数四舍五入自己算（实测 6.41s 报 6s、7.60s 报 8s，
 * 传进去的 `duration` 它根本不看）。四舍五入最多能把尾巴砍掉 0.5 秒，而 TTS 生成的
 * 音频最后一个音素紧贴 EOF，被砍掉的正好是半句话 —— 听感就是「说到一半没了」。
 *
 * 补 700ms 静音，误差就落在静音里，内容一个字都不会丢；顺带也让客户端有自然收尾，
 * 不至于在最后一帧硬停、吞掉尾音。
 */
export const VOICE_TAIL_SILENCE_MS = 700;

/**
 * 每秒最少说几个字 —— 低于这个数就认为音频只有半截。
 *
 * 中文 TTS 正常 3~5 字/秒，拉到 14 字/秒已经不属于「语速快」了，只可能是服务商
 * 只返回了前一半。这种情况下发出去就是「半拉」，用户只会怪她话没说完，所以宁可
 * 退回文字。
 */
const MIN_CHARS_PER_SEC = 14;

/** 一轮最多转写几条语音。群里一轮三条已经不少，再多就是在替群友开会。 */
export const MAX_VOICES_PER_TURN = 2;

/** 单条语音上限：15 分钟以外的语音基本没人发给她。超过就整条不转写。 */
const MAX_VOICE_BYTES = 6 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 60_000;

/**
 * QQ 语音的采样率。silk 文件头里不写采样率，解码时得由调用方告知；
 * QQ 移动端录的语音是 24kHz，与这里保持一致。
 */
export const VOICE_SAMPLE_RATE = 24_000;

const DOWNLOAD_TIMEOUT_MS = 8_000;
// 实测硅基流动 CosyVoice2 单次合成 16-21 秒（排队开销，与字数无关），
// 超时给 30 秒时偶尔会踩线失败 —— 那会变成「莫名其妙只发了文字」，放宽到 45 秒。
const TTS_TIMEOUT_MS = 45_000;
const ASR_TIMEOUT_MS = 30_000;
const MODEL_MAX_CHARS = 120;
const VOICE_NAME_MAX_CHARS = 100;

/** 她这条回复能不能发语音：角色级开关，默认关（同 emojiEnabled 的路子）。 */
export function isVoiceReplyEnabled(configValue: unknown): boolean {
  return asRecord(configValue).voiceEnabled === true;
}

/** 她听不听得懂语音：角色级开关，默认关。与「发语音」是两个开关。 */
export function isVoiceTranscribeEnabled(configValue: unknown): boolean {
  return asRecord(configValue).voiceTranscribe === true;
}

/**
 * 随机发语音的概率（百分比，0-100）。**默认 0**。
 *
 * 为什么不默认随手发：合成实测 16-21 秒（服务商排队），随机触发等于随机让一条回复迟到。
 * 她仍然会在用户明确要语音时发（`isVoiceRequested`），这条概率只是「她自己偶尔也想说」的开关，
 * 由用户按自己用的服务商快慢决定要不要拧开。
 */
export function resolveVoiceChance(configValue: unknown): number {
  const raw = asRecord(configValue).voiceChance;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * 语音冷却（分钟）：距上一条她发过的语音多久之内不再发。**0 = 不冷却**。
 *
 * 原来这条是纯硬编码，页面上改不了 —— 但它其实是个「看服务商脸色」的参数：
 * MiniMax 1~3 秒合成，20 分钟的间隔等于大半轮对话都在打字；换成硅基流动那种
 * 16~21 秒的排队，用户又会希望她别太频繁。所以交给页面，默认值仍是 20。
 */
export function resolveVoiceCooldownMinutes(configValue: unknown): number {
  const raw = asRecord(configValue).voiceCooldownMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_VOICE_COOLDOWN_MINUTES;
  return Math.min(VOICE_COOLDOWN_MAX_MINUTES, Math.max(0, Math.round(raw)));
}

/** 同上的毫秒形式。`planVoiceReply` 用它，0 表示不设冷却。 */
export function resolveVoiceCooldownMs(configValue: unknown): number {
  return resolveVoiceCooldownMinutes(configValue) * 60 * 1000;
}

export type VoiceTtsProvider = "openai" | "minimax";

/**
 * 这两家的差别不只是端点：MiniMax 的 `data.audio` 是 **hex 字符串**（不是二进制），
 * 还要一个 `GroupId` 查询参数。所以不能"一个 OpenAI 兼容实现打天下"。
 */
export type VoiceTtsSettings = {
  provider: VoiceTtsProvider;
  model: string;
  voice: string;
  apiBaseUrl: string;
  apiKey: string;
  /** 仅 MiniMax 需要；留空就不拼查询参数（新账号改纯 Bearer 时也不至于卡住）。 */
  groupId: string;
  /** 语速。0.5–2.0，默认 1。 */
  speed: number;
  /**
   * 请求的采样率。**只有配了 `VOICE_TTS_SAMPLE_RATE` 才会带上** ——
   * OpenAI 官方不认这个字段（多传会 400），而 SiliconFlow 这类服务默认 44100，
   * 我们最终要转成 24k silk，直接要 24000 能省一半体积和一次重采样。
   */
  sampleRate?: number;
};

/** MiniMax 国内站默认端点。国际站是 api.minimax.io，靠地址推断。 */
const MINIMAX_DEFAULT_BASE = "https://api.minimaxi.com/v1";

/** MiniMax 语音识别的默认模型。仅当页面没配 `asrModel` 时兜底，不是写死覆盖用户配置。 */
const MINIMAX_ASR_DEFAULT_MODEL = "asr-1.0";

export type VoiceAsrSettings = {
  provider: VoiceTtsProvider;
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  /** 留空 = 让服务商自己判断语言。OpenAI 之外的兼容服务不一定认这个字段。 */
  language: string;
};

export type VoiceSettingsInput = {
  modelConfig?: unknown;
  chatModel?: string;
  chatApiBaseUrl?: string;
  chatApiKey?: string;
  /**
   * 角色级语音 Key（页面上填的那个，已解密）。优先级：
   * 它 > 环境变量 `VOICE_*_API_KEY` > 角色自己的聊天 Key。
   */
  voiceApiKey?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 有人把 /audio/speech 当成 Base URL 填进来是常见错误，这种值不能拿来拼端点。 */
const AUDIO_ENDPOINT_SUFFIX = /\/(audio\/speech|audio\/transcriptions)$/;

/**
 * 语音服务的 Base URL。
 *
 * 显式配了 `VOICE_*_BASE_URL` 就必须是对的：写错时**不**回落到聊天端点 ——
 * 那样用户会以为语音走的是另一个服务，实际却悄悄打到了聊天服务商，
 * 出问题时日志里一句解释都没有。宁可不发语音。
 */
function resolveVoiceBaseUrl(explicit: string, fallback: string): string | null {
  const primary = explicit.trim();
  if (primary) {
    try {
      const normalized = validateChatApiBaseUrl(primary);
      return normalized && !AUDIO_ENDPOINT_SUFFIX.test(normalized) ? normalized : null;
    } catch {
      return null;
    }
  }
  const secondary = fallback.trim();
  if (!secondary) return null;
  try {
    const normalized = validateChatApiBaseUrl(secondary);
    return normalized && !AUDIO_ENDPOINT_SUFFIX.test(normalized) ? normalized : null;
  } catch {
    // 地址写错当没配：语音不能因为一个坏 URL 整轮失败。
    return null;
  }
}

/**
 * 解析 TTS 配置。返回 null = 不发语音（这是默认状态，不是错误）。
 *
 * 模型优先级：角色 `modelConfig.ttsModel` > `VOICE_TTS_MODEL`。
 * 地址/密钥：`VOICE_TTS_*` > 角色自己的聊天模型地址与密钥。
 *
 * 回落到聊天模型是刻意的：OpenAI 官方与多数中转站的 chat 与 audio 共用同一份凭据，
 * 所以「填一个 VOICE_TTS_MODEL 就能用」，不必再准备第二套 key。
 */
export function resolveVoiceTtsSettings(input: VoiceSettingsInput): VoiceTtsSettings | null {
  const config = asRecord(input.modelConfig);
  const model = (readString(config.ttsModel)
    || readString(process.env.VOICE_TTS_MODEL)
    || "").slice(0, MODEL_MAX_CHARS);
  if (!model) return null;

  // 服务商：显式配了就用（`ttsProvider` / `VOICE_TTS_PROVIDER`），没配就看地址里的 minimax。
  // 自动推断是刻意的 —— 用户只想换一家服务，不该被逼着多填一个枚举。
  const explicitProvider = readString(config.ttsProvider) || readString(process.env.VOICE_TTS_PROVIDER);
  const explicitBase = readString(config.voiceApiBaseUrl) || readString(process.env.VOICE_TTS_BASE_URL);
  const chatBase = input.chatApiBaseUrl ?? "";
  const provider: VoiceTtsProvider = explicitProvider === "minimax" || explicitProvider === "openai"
    ? explicitProvider
    : (/minimax/i.test(explicitBase || chatBase) ? "minimax" : "openai");

  const apiBaseUrl = resolveVoiceBaseUrl(
    explicitBase || (provider === "minimax" ? MINIMAX_DEFAULT_BASE : ""),
    chatBase,
  );
  if (!apiBaseUrl) return null;

  // 页面填的 Key > 环境变量 > 角色聊天 Key。前两个是「语音专用」，最后一个只是同服务商时的便利。
  const apiKey = input.voiceApiKey?.trim()
    || readString(process.env.VOICE_TTS_API_KEY)
    || input.chatApiKey?.trim()
    || "";
  if (!apiKey) return null;

  const voice = (readString(config.ttsVoice)
    || readString(process.env.VOICE_TTS_VOICE)
    || (provider === "minimax" ? "female-shaonv" : "alloy")).slice(0, VOICE_NAME_MAX_CHARS);
  const speedRaw = Number(process.env.VOICE_TTS_SPEED ?? "1");
  const speed = Number.isFinite(speedRaw) ? Math.min(2, Math.max(0.5, speedRaw)) : 1;
  // 只接受 silk 认识的几档采样率，其余当没配（写错了不如不传）。
  const sampleRateRaw = Number(process.env.VOICE_TTS_SAMPLE_RATE ?? "");
  const sampleRate = [8000, 16000, 24000, 32000, 44100, 48000].includes(sampleRateRaw)
    ? sampleRateRaw
    : undefined;
  const groupId = (readString(config.ttsGroupId) || readString(process.env.VOICE_TTS_GROUP_ID))
    .slice(0, VOICE_NAME_MAX_CHARS);

  return {
    provider,
    model,
    voice,
    apiBaseUrl,
    apiKey,
    groupId,
    speed,
    ...(sampleRate ? { sampleRate } : {}),
  };
}

/** 解析 ASR 配置。返回 null = 不转写语音。优先级规则同 TTS。 */
export function resolveVoiceAsrSettings(input: VoiceSettingsInput): VoiceAsrSettings | null {
  const config = asRecord(input.modelConfig);
  const configuredModel = (readString(config.asrModel)
    || readString(process.env.VOICE_ASR_MODEL)
    || "").slice(0, MODEL_MAX_CHARS);

  // 服务商：和 TTS 同一个判定 —— 显式配了就认，没配就看地址里有没有 minimax。
  // MiniMax 的识别端点是 `/speech_to_text`（不是 OpenAI 的 `/audio/transcriptions`），
  // 两家不能混用；TTS 已经在这家，ASR 默认也该跟它走，否则「同一个 key 打错端点」。
  const explicitProvider = readString(config.asrProvider) || readString(process.env.VOICE_ASR_PROVIDER)
    || readString(config.ttsProvider) || readString(process.env.VOICE_TTS_PROVIDER);
  const envAsrBase = readString(process.env.VOICE_ASR_BASE_URL);
  const configVoiceBase = readString(config.voiceApiBaseUrl);
  const envTtsBase = readString(process.env.VOICE_TTS_BASE_URL);
  const chatBase = input.chatApiBaseUrl ?? "";
  const provider: VoiceTtsProvider = explicitProvider === "minimax" || explicitProvider === "openai"
    ? explicitProvider
    : (/minimax/i.test(envAsrBase || configVoiceBase || envTtsBase || chatBase) ? "minimax" : "openai");

  // 模型名：尊重页面/环境变量显式配置的 `asrModel`；只有没配时才按服务商兜默认值。
  //
  // 之前这里把 MiniMax 强制归一成 `asr-1.0`，等于写死了模型名、也盖掉了用户填的值 —— 不对。
  // 正确做法和 TTS 的 `ttsModel` 一致：用户配了就用用户的，没配才给服务商默认。
  let model = configuredModel || (provider === "minimax" ? MINIMAX_ASR_DEFAULT_MODEL : "");
  if (!model) return null;

  /*
   * 服务商与模型名必须配套：地址已经打到 MiniMax，模型名却还留着硅基流动那套
   * `FunAudioLLM/SenseVoiceSmall` 时，服务商直接 400 `invalid model ... must be one of
   * asr-1.0`（2026-11-02 实测）。表现就是「她听不懂语音」，而日志里只有一行 400。
   *
   * 这不是「替用户猜」——MiniMax 的识别模型就 `asr-*` 这一族，认出来不是它就没有第二解。
   * 反过来不兜底，`.env` 里一行换服务商时漏改的残留，就能让**所有角色**的识别静默坏掉：
   * 页面上早就切 MiniMax 了，谁也不会想到去翻 ASR_MODEL。
   *
   * 只拦「明显不属于 MiniMax」的名字：将来出 `asr-2.0` 照样能填进来。
   */
  if (provider === "minimax" && !/^asr-/i.test(model)) {
    console.warn(
      `[voice] ASR 模型「${model}」不是 MiniMax 的合法模型（只认 ${MINIMAX_ASR_DEFAULT_MODEL} 这一族），`
      + `本次改用 ${MINIMAX_ASR_DEFAULT_MODEL}；请把 .env 的 VOICE_ASR_MODEL 或页面的识别模型改掉`,
    );
    model = MINIMAX_ASR_DEFAULT_MODEL;
  }

  // ASR 地址必须和 provider 一致，否则「MiniMax 的 /speech_to_text 打到硅基流动域名」→ 404。
  //
  // 血泪教训：`.env` 里残留的 `VOICE_ASR_BASE_URL=硅基流动` 优先级比页面上的 `voiceApiBaseUrl`
  // 还高，而 TTS 早已换成 MiniMax —— provider 跟着 TTS 判成 minimax，地址却吃了硅基流动，
  // 两边打架，结果就是 404。所以这里按 provider 选地址，而不是无脑「环境变量优先」：
  //   - minimax：认页面 voiceApiBaseUrl，或显式 `VOICE_ASR_BASE_URL`（仅当它本身也是 minimax），
  //     再兜底 MINIMAX_DEFAULT_BASE。
  //   - openai：环境变量 `VOICE_ASR_BASE_URL` 优先，再回落页面/聊天地址。
  let asrBase: string;
  if (provider === "minimax") {
    asrBase = (/minimax/i.test(envAsrBase) ? envAsrBase : "")
      || configVoiceBase
      || (/minimax/i.test(envTtsBase) ? envTtsBase : "")
      || MINIMAX_DEFAULT_BASE;
  } else {
    asrBase = envAsrBase || configVoiceBase || envTtsBase;
  }
  const apiBaseUrl = resolveVoiceBaseUrl(asrBase, chatBase);
  if (!apiBaseUrl) return null;

  const apiKey = input.voiceApiKey?.trim()
    || readString(process.env.VOICE_ASR_API_KEY)
    || input.chatApiKey?.trim()
    || "";
  if (!apiKey) return null;

  return {
    provider,
    model,
    apiBaseUrl,
    apiKey,
    language: readString(process.env.VOICE_ASR_LANGUAGE).slice(0, 20),
  };
}

export function buildSpeechEndpoint(baseUrl: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写语音 API Base URL。");
  return new URL(normalized + "/audio/speech");
}

/**
 * MiniMax 的语音端点是 `/t2a_v2`，并且 **GroupId 在查询串里**而不是 body 里。
 * 留空就不带这个参数：新版账号可能只需要 Bearer，硬要求 GroupId 反而会把能用的配置卡死。
 */
export function buildMinimaxEndpoint(baseUrl: string, groupId: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写语音 API Base URL。");
  const url = new URL(normalized + "/t2a_v2");
  if (groupId) url.searchParams.set("GroupId", groupId);
  return url;
}

export function buildTranscriptionEndpoint(baseUrl: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写语音 API Base URL。");
  return new URL(normalized + "/audio/transcriptions");
}

/** MiniMax 的语音识别端点是 `/speech_to_text`，与 TTS 的 `/t2a_v2` 同域。 */
export function buildMinimaxTranscriptionEndpoint(baseUrl: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写语音 API Base URL。");
  return new URL(normalized + "/speech_to_text");
}

/** 16bit PCM 补一个标准 44 字节 wav 头。silk 解码结果没有头，ASR 要的是完整 wav。 */
export function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * 重算 wav 的长度字段。
 *
 * 为什么需要：好几家 TTS（硅基流动实测）返回的 wav 里 RIFF size 与 data size 是负值
 * （`0xFFFFFFA6` / `0xFFFFFF00`），文件本身能播，但严格校验的实现（`silk-wasm` 的 `isWav`）
 * 会直接判成「不是 wav」。长度是可以自己算的 —— 文件总长减去头，本来就不该信服务商填的数。
 *
 * 只修长度，不动格式字段：采样率/声道/位深写错的话那是另一回事，改不了也不该猜。
 */
export function repairWavSizes(buffer: Buffer): Buffer {
  if (buffer.length < 44) throw new Error("VOICE_NOT_WAV");
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF") throw new Error("VOICE_NOT_WAV");
  if (buffer.subarray(8, 12).toString("latin1") !== "WAVE") throw new Error("VOICE_NOT_WAV");

  const fixed = Buffer.from(buffer);
  fixed.writeUInt32LE(fixed.length - 8, 4);

  // 按 chunk id 找 data。不能靠「顺着 size 走」—— 坏掉的那个 size 正是我们要修的。
  let offset = 12;
  while (offset + 8 <= fixed.length) {
    const id = fixed.subarray(offset, offset + 4).toString("latin1");
    if (id === "data") {
      fixed.writeUInt32LE(fixed.length - offset - 8, offset + 4);
      return fixed;
    }
    const size = fixed.readUInt32LE(offset + 4);
    if (offset + 8 + size > fixed.length) break;
    offset += 8 + size + (size % 2);
  }
  return fixed;
}

type WavLayout = {
  dataOffset: number;
  dataLength: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
};

/**
 * 自己读 wav 的 chunk 布局。
 *
 * 为什么不用 `silk-wasm` 的 `getWavFileInfo()`：它返回的 `dataOffset` 会带上
 * 同一进程里前一次解析的偏移 —— 先解析过 22 万字节的 wav，再解析 524 字节的，
 * 报出来的 `dataOffset` 是 724（文件本身才 524 字节）。照它写会把长度字段写到
 * 文件外面去，写完看着"成功"、语音却被切。这点解析只有二十行，自己算更稳。
 *
 * 长度字段越界（服务商实测给负值）时夹到文件内，不因此判定「不是 wav」。
 */
function readWavLayout(wav: Buffer): WavLayout | null {
  if (wav.length < 44) return null;
  if (wav.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (wav.subarray(8, 12).toString("latin1") !== "WAVE") return null;

  let dataOffset = -1;
  let dataLength = 0;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;

  // 不能「顺着声明的 size 走」—— 坏掉的那个 size 正是我们要容错的。
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString("latin1");
    const body = offset + 8;
    const size = Math.min(wav.readUInt32LE(offset + 4), wav.length - body);
    if (id === "fmt " && size >= 16) {
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = size;
      // fmt 在 data 前面是常态；已经拿到采样率就不必再往后找。
      if (sampleRate > 0) break;
    }
    if (size <= 0) break;
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || dataLength <= 0 || sampleRate <= 0) return null;
  return {
    dataOffset,
    dataLength,
    sampleRate,
    channels: Math.max(1, channels),
    bitsPerSample: bitsPerSample || 16,
  };
}

/**
 * 在 wav 的 PCM 末尾追加一段静音。
 *
 * 为什么必须有它：QQ 语音条的长度元数据是整数秒，网关按帧数四舍五入算出来，
 * 传 `duration` 也不认（2026-10-31 实测：传 99，日志里还是它自己算的 8s）。
 * 于是 6.41 秒的语音会被标成 6 秒，客户端播到 6 秒就停 —— 而尾部正是最后一个字。
 * 补静音把这段误差垫进去，切掉的顶多是静音。
 *
 * 只动 data 的长度，格式字段一个都不碰：采样率/声道/位深全部从文件里读，
 * 服务商换成 44.1k 或立体声也不会读错。
 *
 * `data` 之后如果还有别的 chunk（个别服务商会塞 LIST），重建时丢掉 —— silk 只读
 * PCM，留着反而会把尾部元数据当采样。
 */
export function padWavSilence(wav: Buffer, ms: number): Buffer {
  if (!(ms > 0)) return wav;
  const layout = readWavLayout(wav);
  if (!layout) throw new Error("VOICE_NOT_WAV");

  const bytesPerSample = Math.max(1, Math.round(layout.bitsPerSample / 8));
  const frames = Math.round((layout.sampleRate * ms) / 1000);
  const silenceBytes = frames * layout.channels * bytesPerSample;
  if (silenceBytes <= 0) return wav;

  // 8bit PCM 是无符号的，静音是 0x80；16/24/32bit 整型与 float 的静音都是 0。
  const silence = Buffer.alloc(silenceBytes, layout.bitsPerSample === 8 ? 0x80 : 0x00);
  const pcm = wav.subarray(layout.dataOffset, layout.dataOffset + layout.dataLength);
  const body = Buffer.concat([pcm, silence]);
  const out = Buffer.concat([wav.subarray(0, layout.dataOffset), body]);

  // data 的长度字段就在 dataOffset 前 4 字节（chunkId 占 4 字节）。
  out.writeUInt32LE(body.length, layout.dataOffset - 4);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** 从 silk 读时长（毫秒）。读不出来返回 0 —— 调用方按「不知道」处理，不当作失败。 */
export function readSilkDurationMs(silk: Buffer): number {
  try {
    return getSilkDuration(silk) || 0;
  } catch {
    return 0;
  }
}


export async function wavToSilk(wav: Buffer): Promise<Buffer> {
  let input = wav;
  if (!isWav(input)) input = repairWavSizes(input);
  if (!isWav(input)) throw new Error("VOICE_NOT_WAV");
  // sampleRate 传 0：silk-wasm 会自己从 wav 头里读采样率。
  const result = await encodeSilk(input, 0);
  return Buffer.from(result.data);
}

/**
 * 入站语音 → wav。按字节头分诊，把 QQ 可能给的几种格式都转成 ASR 要的 wav。
 *
 * 三种来源：
 *   - **AMR**（`#!AMR\n` / `#!AMR-WB\n`）：QQ 手机端/网页端语音条的原始编码，这是最常见的情况。
 *   - **silk**（`#!SILK`）：个别网关或旧客户端会给 silk。
 *   - **wav**（RIFF/WAVE）：网关转存过的，原样返回（含坏长度字段的，先修一次）。
 *
 * 最早这里只认 silk，结果 QQ 手机发来的 AMR 全被 `VOICE_NOT_SILK` 一棍打死、
 * 又被 `transcribeOne` 静默吞掉 —— 表现就是「她听不懂语音」。
 */
export async function voiceToWav(input: Buffer): Promise<Buffer> {
  if (isWav(input)) return input;
  // 网关转存的 wav 可能同样带坏长度字段：先试修一次，再按 AMR/silk 解。
  if (isWavLenient(input)) return repairWavSizes(input);
  if (isAmr(input)) return amrToWav(input);
  if (!isSilk(input)) throw new Error("VOICE_NOT_SILK_OR_AMR");
  const result = await decodeSilk(input, VOICE_SAMPLE_RATE);
  return buildWav(Buffer.from(result.data), VOICE_SAMPLE_RATE);
}

/** 旧名保留：出站侧（silk→wav 的单测、以及旧调用）仍然用它，语义等价。 */
export async function silkToWav(input: Buffer): Promise<Buffer> {
  return voiceToWav(input);
}

/** AMR 文件头：`#!AMR\n`（窄带 8kHz）或 `#!AMR-WB\n`（宽带 16kHz）。 */
function isAmr(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 6).toString("latin1");
  return head.startsWith("#!AMR");
}

/**
 * AMR → wav。`@audio/decode-amr`（opencore-amr 编译成 wasm）解出浮点 PCM，
 * 再转 s16le、补 wav 头。采样率以解码器返回的为准（NB=8000 / WB=16000）。
 */
async function amrToWav(input: Buffer): Promise<Buffer> {
  const { default: decode } = await import("@audio/decode-amr");
  const decoded = await decode(new Uint8Array(input));
  const channel = decoded.channelData?.[0];
  if (!channel || channel.length === 0) throw new Error("VOICE_AMR_EMPTY");
  const pcm = float32ToS16le(channel);
  return buildWav(pcm, decoded.sampleRate || VOICE_SAMPLE_RATE);
}

/** 浮点 PCM（-1..1）→ 16bit 小端 PCM。clamp 到 s16 范围，越界处截断而非回绕。 */
function float32ToS16le(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2);
  }
  return out;
}

/** 只看 magic，不看长度字段：用来判断「这是个坏头的 wav」而不是「这根本不是 wav」。 */
function isWavLenient(buffer: Buffer): boolean {
  return buffer.length >= 44
    && buffer.subarray(0, 4).toString("latin1") === "RIFF"
    && buffer.subarray(8, 12).toString("latin1") === "WAVE";
}

/**
 * 文字 → wav 字节。两家服务商的请求形状完全不同，所以分成两支。
 *
 * 都只要 wav：mp3 需要额外的解码器才能进 silk 编码，多一个依赖只为了兜底不值得。
 * 服务商不支持 wav 时这条链路就是不工作，日志里会写清楚。
 */
async function requestWav(text: string, settings: VoiceTtsSettings): Promise<Buffer | null> {
  if (settings.provider === "minimax") return requestMinimaxWav(text, settings);
  return requestOpenaiWav(text, settings);
}

async function requestOpenaiWav(text: string, settings: VoiceTtsSettings): Promise<Buffer | null> {
  let endpoint: URL;
  try {
    endpoint = buildSpeechEndpoint(settings.apiBaseUrl);
  } catch {
    return null;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        voice: settings.voice,
        input: text,
        response_format: "wav",
        speed: settings.speed,
        ...(settings.sampleRate ? { sample_rate: settings.sampleRate } : {}),
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[voice] tts 失败：HTTP " + response.status + " " + (await safeText(response)).slice(0, 200));
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("[voice] tts 请求异常：", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** MiniMax 失败时 HTTP 可能仍是 200，真正的结果在 `base_resp.status_code` 里。 */
function readMinimaxError(payload: unknown): string {
  const record = asRecord(payload);
  const base = asRecord(record.base_resp);
  const code = base.status_code;
  if (code === 0 || code === undefined) return "";
  const message = typeof base.status_msg === "string" ? base.status_msg : "";
  return `code=${String(code)} ${message}`.trim();
}

/**
 * 打一次 MiniMax `t2a_v2`。
 *
 * 返回 `{ audio }` = 成功（hex 字符串）；`{ failure }` = 200 但业务上失败（余额、音色、GroupId 都走这里）；
 * `null` = HTTP 层就挂了（网络 / 401），日志已经写过，调用方不用再报。
 */
async function callMinimaxTts(
  endpoint: URL,
  settings: VoiceTtsSettings,
  text: string,
): Promise<{ audio?: string; failure?: string } | null> {
  let payload: unknown;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        text,
        stream: false, // wav 只在非流式下支持
        voice_setting: {
          voice_id: settings.voice,
          speed: settings.speed,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          format: "wav",
          // 文档示例用 32000；silk 编码这边认得，最终会转成 24k。
          sample_rate: settings.sampleRate ?? 32000,
          channel: 1,
        },
        language_boost: "auto",
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[voice] tts 失败：HTTP " + response.status + " " + (await safeText(response)).slice(0, 200));
      return null;
    }
    payload = await response.json();
  } catch (error) {
    console.error("[voice] tts 请求异常：", error instanceof Error ? error.message : String(error));
    return null;
  }

  const failure = readMinimaxError(payload);
  if (failure) return { failure };

  const audioHex = readString(asRecord(asRecord(payload).data).audio);
  if (!audioHex) return { failure: "返回里没有 data.audio" };
  return { audio: audioHex };
}

/**
 * 已经确认「这把 Key 不认这个 GroupId」的组合（baseUrl|groupId）。
 *
 * 命中之后直接不带 GroupId 请求，省掉每句语音都先失败一次再重试 —— 那是双倍请求和双倍日志。
 * 进程内缓存，重启即清：改完配置不用重启也能重新试一次。
 */
const groupIdMismatch = new Set<string>();

async function requestMinimaxWav(text: string, settings: VoiceTtsSettings): Promise<Buffer | null> {
  const mismatchKey = `${settings.apiBaseUrl}|${settings.groupId}`;
  const knownMismatch = Boolean(settings.groupId) && groupIdMismatch.has(mismatchKey);

  let endpoint: URL;
  try {
    endpoint = buildMinimaxEndpoint(settings.apiBaseUrl, knownMismatch ? "" : settings.groupId);
  } catch {
    return null;
  }

  let result = await callMinimaxTts(endpoint, settings, text);

  /*
   * `code=1004 token not match group` = Key 和 GroupId 不是同一个账号（2026-11-02 修）。
   *
   * MiniMax 有两种 Key：老的是 JWT，必须带 GroupId；新的是 `sk-` 开头的账号级 Key，
   * 带上别人的 GroupId 反而会被这句 1004 顶回来。实测：同一把 sk- Key 带 GroupId 报 1004，
   * 去掉 GroupId 立刻返回正常 wav。与其让人去分辨自己是哪种 Key，这里直接去掉 GroupId 再试一次 ——
   * 成功就说明「该留空」，日志里也写清楚，下次改配置知道改哪。
   *
   * 只认带 group 字样的 1004：同一个错误码也用于「invalid api key」，
   * 那是 Key 本身不对，去掉 GroupId 再打一次毫无意义。
   */
  const failureText = result?.failure ?? "";
  const groupMismatch = /^code=1004\b/i.test(failureText) && /group/i.test(failureText);
  if (groupMismatch && settings.groupId && !knownMismatch) {
    console.warn(
      `[voice] GroupId ${settings.groupId} 和这把 Key 不匹配（${failureText}），改成不带 GroupId 重试一次`,
    );
    const retry = await callMinimaxTts(buildMinimaxEndpoint(settings.apiBaseUrl, ""), settings, text);
    if (retry?.audio) {
      groupIdMismatch.add(mismatchKey);
      console.warn("[voice] 不带 GroupId 合成成功 —— 这把 Key 是账号级的，角色的「GroupId」应该留空（本次进程内不再重试）");
      result = retry;
    } else {
      // 两次都失败：把带 GroupId 那次的原因留着，那才是配置本身的问题
      console.error("[voice] tts 失败：" + (retry?.failure ?? "不带 GroupId 重试也失败"));
      return null;
    }
  }

  if (!result) return null;
  if (result.failure) {
    // 200 + 业务错误码是常态（余额不足、音色不存在、GroupId 不匹配都走这里）。
    console.error("[voice] tts 失败：" + result.failure);
    return null;
  }

  const audioHex = result.audio ?? "";
  // **MiniMax 给的是 hex 字符串**，不是二进制。直接当 buffer 写会得到一坨乱码。
  if (audioHex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(audioHex)) {
    console.error("[voice] tts 返回的 audio 不是合法 hex（长度 " + audioHex.length + "）");
    return null;
  }
  return Buffer.from(audioHex, "hex");
}

/**
 * 文字 → silk。任何一步失败都返回 null，调用方退回发文字。
 */
export async function synthesizeSpeechSilk(
  text: string,
  settings: VoiceTtsSettings,
): Promise<Buffer | null> {
  const spoken = normalizeSpeakableText(text);
  if (!spoken) return null;

  const audio = await requestWav(spoken, settings);
  if (!audio?.length) return null;

  // 补静音失败不许挡住语音：退回原音频顶多被切掉尾巴，好过一条都发不出去。
  let prepared = audio;
  try {
    prepared = padWavSilence(audio, VOICE_TAIL_SILENCE_MS);
  } catch {
    console.warn("[voice] wav 解析失败，跳过补静音（语音照发，尾部可能被切）");
  }

  try {
    const silk = await wavToSilk(prepared);
    const chars = Array.from(spoken).length;
    const durationMs = readSilkDurationMs(silk);

    /**
     * 时长兜底：TTS 偶尔只返回前一半的音频，发出去就是「说了半句话」。
     * 时长读不出来（0）时不做判断 —— 不能因为算不出时长就把语音干掉。
     */
    if (durationMs > 0 && chars > 0) {
      const charsPerSec = chars / (durationMs / 1000);
      if (charsPerSec > MIN_CHARS_PER_SEC) {
        console.error("[voice] 合成音频疑似只有一半，退回文字 " + JSON.stringify({
          chars,
          durationMs,
          charsPerSec: Number(charsPerSec.toFixed(1)),
        }));
        return null;
      }
    }

    console.log("[voice] tts ok " + JSON.stringify({
      provider: settings.provider,
      chars,
      silkBytes: silk.length,
      durationMs,
      // 有这一项，下次「半拉」就能一眼分出是合成短了还是播放端的问题：
      // 4~5 字/秒是正常语速，明显高于它是音频被截断，明显低于它是补的静音太多。
      charsPerSec: durationMs > 0 ? Number((chars / (durationMs / 1000)).toFixed(1)) : null,
    }));
    return silk;
  } catch {
    // 修过长度字段仍然不行 = 真的不是 wav（多半是 mp3/opus）。打头部 magic 出来，省得靠猜。
    const head = audio.subarray(0, 4).toString("latin1").replace(/[^\x20-\x7e]/g, "?");
    console.error(`[voice] tts 返回的不是 wav（头部 "${head}"，${audio.length} 字节），无法转 silk；请把输出格式配成 wav`);
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * 压成适合读出来的一句话（不截断）。
 *
 * 正文里的段标记（`[图片：…]`、`@123`、颜文字）读出来是一串噪音，
 * 所以先把方括号内容、@、以及控制字符去掉。
 */
function cleanSpeakable(raw: string): string {
  return raw
    .replace(/\[[^\]]{0,200}\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 只剩标点/表情就没有可读内容：读出来只有一个语气词，比不发更怪。 */
function hasReadableText(text: string): boolean {
  return Boolean(text.replace(/[\s\p{P}\p{S}]/gu, ""));
}

/** 真正送去合成的那段话：清洗 + 限长。 */
export function normalizeSpeakableText(raw: string): string {
  const text = cleanSpeakable(raw);
  if (!hasReadableText(text)) return "";
  return text.slice(0, VOICE_TEXT_MAX_CHARS);
}

/** 一条语音在 OneBot 事件里的样子。`url` 带 rkey 且有时效，只在收到消息的当口可用。 */
export type ChannelVoiceRef = {
  /** 直链；网关没给就是空字符串。 */
  url: string;
  /** 网关给的文件名 —— 只是文件名，不是本地路径。 */
  file?: string;
  /** 网关给的时长（秒）；没有就按字节数估。 */
  durationSec?: number;
};

/**
 * 下载一条语音。白名单与图片共用（`image-understanding` 里那两个函数），
 * 不另写一套 —— 两套白名单迟早会有一套漏掉某个私网段。
 */
export async function downloadVoice(rawUrl: string): Promise<Buffer> {
  const url = assertFetchableImageUrl(rawUrl);
  await assertPublicHost(url.hostname);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new Error("VOICE_DOWNLOAD_FAILED");
  }
  if (!response.ok) throw new Error("VOICE_HTTP_" + response.status);

  // 重定向后可能换了 host，最终地址要再过一遍。
  try {
    await assertPublicHost(new URL(response.url).hostname);
  } catch {
    throw new Error("VOICE_BLOCKED_HOST");
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VOICE_BYTES) throw new Error("VOICE_TOO_LARGE");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_VOICE_BYTES) throw new Error("VOICE_TOO_LARGE");
  if (!buffer.length) throw new Error("VOICE_EMPTY");
  return buffer;
}

/**
 * 转写一条语音。失败返回 null —— 调用方把 `[语音]` 原样留着。
 *
 * 先转 wav 再上传：silk/amr 都不在 ASR 服务商的 accepted 格式里，
 * `voiceToWav` 同时兜住「网关给的已经是 wav」这种情况。
 */
async function transcribeOne(
  ref: ChannelVoiceRef,
  settings: VoiceAsrSettings,
): Promise<string | null> {
  if (!ref.url) return null;
  if (typeof ref.durationSec === "number" && ref.durationSec * 1000 > MAX_VOICE_DURATION_MS) return null;

  let wav: Buffer;
  try {
    wav = await voiceToWav(await downloadVoice(ref.url));
  } catch (error) {
    console.error("[voice] asr 解码失败：", error instanceof Error ? error.message : String(error));
    return null;
  }

  const text = settings.provider === "minimax"
    ? await requestMinimaxTranscript(wav, settings)
    : await requestOpenaiTranscript(wav, settings);
  return sanitizeTranscript(text);
}

/** OpenAI 兼容的 `/audio/transcriptions`：multipart form，返回 `{text}` 或 `{result}`。 */
async function requestOpenaiTranscript(wav: Buffer, settings: VoiceAsrSettings): Promise<string> {
  let endpoint: URL;
  try {
    endpoint = buildTranscriptionEndpoint(settings.apiBaseUrl);
  } catch {
    return "";
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  form.append("model", settings.model);
  if (settings.language) form.append("language", settings.language);

  let payload: unknown;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey },
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[voice] asr 失败：HTTP " + response.status + " " + (await safeText(response)).slice(0, 200));
      return "";
    }
    payload = await response.json();
  } catch (error) {
    console.error("[voice] asr 请求异常：", error instanceof Error ? error.message : String(error));
    return "";
  }

  const record = asRecord(payload);
  return readString(record.text) || readString(record.result);
}

/** MiniMax 的 `/speech_to_text`：模型 `asr-1.0`，同样 multipart，返回 `{text}`。 */
async function requestMinimaxTranscript(wav: Buffer, settings: VoiceAsrSettings): Promise<string> {
  let endpoint: URL;
  try {
    endpoint = buildMinimaxTranscriptionEndpoint(settings.apiBaseUrl);
  } catch {
    return "";
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  form.append("model", settings.model || MINIMAX_ASR_DEFAULT_MODEL);

  // MiniMax 的 `language` 要求放在 HTTP header（不是表单字段）；留空就不带。
  const headers: Record<string, string> = { authorization: "Bearer " + settings.apiKey };
  if (settings.language) headers.language = settings.language;

  let payload: unknown;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers,
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[voice] asr 失败：HTTP " + response.status + " " + (await safeText(response)).slice(0, 200));
      return "";
    }
    payload = await response.json();
  } catch (error) {
    console.error("[voice] asr 请求异常：", error instanceof Error ? error.message : String(error));
    return "";
  }

  const record = asRecord(payload);
  // MiniMax 走 `{text}`，个别旧版给 `base_resp` + `text`，都认一下。
  return readString(record.text) || readString(record.result);
}

/** 转写结果会原样进提示词：压成一行、限长，别让一句口误把整轮排版搅乱。 */
export function sanitizeTranscript(raw: string): string | null {
  const text = raw
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 400)
    .trim();
  return text || null;
}

/** 依次转写这一轮里的语音。并发跑：串行会让群聊那一轮拖到十几秒。 */
export async function transcribeVoices(
  refs: ChannelVoiceRef[],
  settings: VoiceAsrSettings,
): Promise<Array<string | null>> {
  const targets = refs.slice(0, MAX_VOICES_PER_TURN);
  if (!targets.length) return [];
  const settled = await Promise.allSettled(targets.map((ref) => transcribeOne(ref, settings)));
  return settled.map((item) => (item.status === "fulfilled" ? item.value : null));
}

/**
 * 转写确实失败了，正文里该留下什么。
 *
 * 以前失败就原样留 `[语音]`，本意是「降级成没接 ASR 时的样子」。但那是个谎：
 * 模型看到裸的 `[语音]`，以为对方只是发了个贴纸，于是自己编一段「本宝只收到个壳」
 * 「就听见个响，字没进来」——用户看到的是她在装傻，其实是她在猜。
 * 所以失败要**明说**：让模型知道「有语音，没听懂」，她才好老实回一句「没听清，再说一遍」。
 */
export const VOICE_UNTRANSCRIBED = "[语音（没转成文字）]";

/**
 * 把转写填回正文里的 `[语音]` 占位符。
 *
 * 用游标而不是从头 indexOf：转写文本里本身可能带 `[语音]` 这几个字时，
 * 从头找会反复替换同一段，最后得到嵌套括号。
 *
 * `null` 不是「跳过」，而是「这条转不出来」——填成 `VOICE_UNTRANSCRIBED`。
 * 只有 `transcripts` 长度覆盖不到的那些 `[语音]`（超过 `MAX_VOICES_PER_TURN`、
 * 或者压根没尝试转写）才保持原样。
 */
export function applyVoiceTranscripts(content: string, transcripts: Array<string | null>): string {
  if (!transcripts.length || !content.includes("[语音]")) return content;
  let text = content;
  let cursor = 0;
  for (const transcript of transcripts) {
    const index = text.indexOf("[语音]", cursor);
    if (index < 0) break;
    const value = transcript?.trim();
    const replacement = value ? `[语音：${value}]` : VOICE_UNTRANSCRIBED;
    text = text.slice(0, index) + replacement + text.slice(index + "[语音]".length);
    cursor = index + replacement.length;
  }
  return text;
}

/**
 * 这句话是不是在让她「发语音」。
 *
 * 为什么要认这个：TTS 合成实测要 16-21 秒（硅基流动 CosyVoice2 的排队开销，与文本长度无关），
 * **随机触发一条语音就等于随机让一条回复迟到十几秒**。所以默认不走概率，
 * 而是等用户明确开口要 —— 他会愿意等，没要的时候她照常打字。
 *
 * 判定要窄：只有「发/来/用/录 + 语音/声音」这类明确搭配才算，
 * 并且先排除「别发语音」这种否定句（否则越不让她发，她越要发）。
 */
export function isVoiceRequested(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (!compact) return false;
  if (/(别|不要|不用|不许|不准|不想听)[^，。！？]{0,4}(语音|声音)/.test(compact)) return false;
  return /(发|来|给|用|整|录|说)[^，。！？]{0,4}(语音|声音)/.test(compact)
    /**
     * 「来条」「发条」后面跟语音或直接收尾才算。
     *
     * 不能把裸「条」算进上面那组动词：旧写法 `(发|来|…)…条` 会让「引用**这条**聊聊」
     * 借「用 + 这条」命中 —— 一引用就无缘无故发语音，正是「引用时语音行为很怪」的另一半。
     */
    || /(来|发|整)条(语音|声音)?[呢吧呗啊嘛]?[？?！!。]*$/.test(compact)
    // 「语音条呢」「语音？听听」：没有动词但句尾在催。只认句尾，避免「这语音条音质不错」被当成要求。
    || /(语音|声音)(条)?[呢吧呗啊嘛]?[？?！!。]*$/.test(compact)
    || /(语音|声音)(说|回|发)/.test(compact)
    || /说(一)?句话/.test(compact)
    /**
     * 「引用他说一句」「引用他念一段」：整句里没有「语音」两个字，但「说/念 + 量词」
     * 就是要她开口。这类说法集中在**要她引用某人**的时候（平时直接说「发个语音」），
     * 漏掉它的后果是这一轮不会被 force —— 落回冷却与概率，于是多数时候只发文字，
     * 用户看到的就是「引用别人的时候语音老是发不出去」。
     *
     * 只认「引用」开头：「回他一句」这种多半只是打字，不能一并抢过来。
     */
    || /引用[^，。！？]{0,6}(说|念|来)(一|几)?(句|段|声)/.test(compact);
}

/** 这段话能不能读出来：有可读内容，且长度在限度内（超长不截断，直接不读）。 */
export function canSpeakReply(text: string): boolean {
  const cleaned = cleanSpeakable(text);
  if (!hasReadableText(cleaned)) return false;
  return cleaned.length <= VOICE_TEXT_MAX_CHARS;
}

/**
 * 这一轮打不打算发语音 —— **在生成回复之前调用**。
 *
 * 分成两步是因为顺序很关键：必须先决定「这轮要说语音」，再生成内容，
 * 模型才知道要按说话的方式写（短句、口语、不带表情和括号动作）。
 * 反过来「先生成再判定」的话，模型以为自己只是在打字 ——
 * 实测她会写出「我这打字声你当语音听吧」这种话，因为提示词里压根没提语音。
 *
 * 这里不看回复内容（还不知道），只看开关、冷却与概率；长度在生成后用 `canSpeakReply` 复核。
 * 冷却时长走 `modelConfig.voiceCooldownMinutes`（默认 20 分钟，0 = 不冷却，见 `resolveVoiceCooldownMinutes`）。
 */
export function planVoiceReply(input: {
  modelConfig: unknown;
  lastVoiceAt?: Date | null;
  now?: Date;
  random?: () => number;
  /** 用户在消息里明确要语音：跳过概率与冷却（但不跳过开关）。 */
  force?: boolean;
}): boolean {
  if (!isVoiceReplyEnabled(input.modelConfig)) return false;
  if (input.force === true) return true;

  const now = input.now ?? new Date();
  const lastVoiceAt = input.lastVoiceAt ?? null;
  // 0 分钟 = 不冷却（页面上可以关掉这条闸门）。
  const cooldownMs = resolveVoiceCooldownMs(input.modelConfig);
  if (cooldownMs > 0 && lastVoiceAt && now.getTime() - lastVoiceAt.getTime() < cooldownMs) return false;

  const chance = resolveVoiceChance(input.modelConfig);
  if (chance <= 0) return false;
  const random = input.random ?? Math.random;
  return random() * 100 < chance;
}

/**
 * 生成之后复核：这一段真的能发成语音吗。
 *
 * `shouldSendVoice` 是「计划 + 复核」的合并版，保留给只想知道结果、不需要提前告诉模型的场景。
 */
export function shouldSendVoice(input: {
  modelConfig: unknown;
  text: string;
  lastVoiceAt?: Date | null;
  now?: Date;
  random?: () => number;
  force?: boolean;
}): boolean {
  if (!planVoiceReply(input)) return false;
  return canSpeakReply(input.text);
}
