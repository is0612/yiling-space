/**
 * 语音（TTS / ASR）链路的纯逻辑测试：段解析、silk 编解码、占位符回填、
 * 发语音判定、配置解析。
 *
 * 都不联网：真正调用 TTS / ASR 需要服务商凭据，不适合放进每次 verify:local。
 * silk 编解码是真的跑（wasm 在本地），因为「转码能不能用」正是这条链路最脆的地方。
 */

import assert from "node:assert/strict";

import {
  applyVoiceTranscripts,
  buildMinimaxEndpoint,
  buildWav,
  canSpeakReply,
  isVoiceReplyEnabled,
  isVoiceRequested,
  isVoiceTranscribeEnabled,
  MAX_VOICES_PER_TURN,
  normalizeSpeakableText,
  padWavSilence,
  planVoiceReply,
  readSilkDurationMs,
  repairWavSizes,
  resolveVoiceAsrSettings,
  resolveVoiceChance,
  resolveVoiceCooldownMinutes,
  resolveVoiceTtsSettings,
  sanitizeTranscript,
  shouldSendVoice,
  silkToWav,
  synthesizeSpeechSilk,
  VOICE_COOLDOWN_MS,
  VOICE_TEXT_MAX_CHARS,
  VOICE_UNTRANSCRIBED,
  voiceToWav,
  wavToSilk,
} from "../server/utils/voice";
import { readOnebotVoices } from "../server/utils/channel-adapter/onebot/types";
import { toCharacterDto } from "../server/utils/character-dto";
import {
  encryptApiKey,
  isVoiceApiKeySaved,
  resolveCharacterVoiceApiKey,
} from "../server/utils/credential-encryption";

// ── 1. 从段数组里取语音 ─────────────────────────────────
const voices = readOnebotVoices({
  message: [
    { type: "text", data: { text: "听我说" } },
    { type: "record", data: { url: "https://multimedia.nt.qq.com.cn/v?rkey=1", file: "a.amr", duration: 7 } },
    { type: "voice", data: { file: "b.silk", duration: 5200 } },
    { type: "record", data: { file: "c.amr" } },
  ],
});
assert.equal(voices.length, 3, "record 与 voice 段都算语音。");
assert.equal(voices[0]!.url, "https://multimedia.nt.qq.com.cn/v?rkey=1");
assert.equal(voices[0]!.durationSec, 7, "duration 是秒时按秒用。");
assert.equal(voices[1]!.url, "", "没有 url 时留空，不能拿 file 当路径去读。");
assert.equal(voices[1]!.durationSec, 5.2, "大于 1000 的 duration 按毫秒换算。");
assert.equal(voices[2]!.durationSec, -1, "网关没给时长记 -1。");

assert.deepEqual(readOnebotVoices({ message: "你好" }), []);
assert.deepEqual(readOnebotVoices({}), []);

// ── 2. 可读文本归一化 ──────────────────────────────────
assert.equal(normalizeSpeakableText("今天好累啊"), "今天好累啊");
assert.equal(normalizeSpeakableText("嗯[图片：一只猫]就这样"), "嗯 就这样", "段标记读出来是噪音。");
assert.equal(normalizeSpeakableText("@12345 在吗"), "在吗");
assert.equal(normalizeSpeakableText("……"), "", "只剩标点就不读了。");
assert.equal(normalizeSpeakableText("😀😀"), "", "纯表情没有可读内容。");
assert.equal(normalizeSpeakableText("啊".repeat(200)).length, VOICE_TEXT_MAX_CHARS, "超长截断。");

// ── 3. wav 头 ─────────────────────────────────────────
const pcm = Buffer.alloc(480, 0);
const wav = buildWav(pcm, 24000);
assert.equal(wav.length, 44 + 480);
assert.equal(wav.subarray(0, 4).toString(), "RIFF");
assert.equal(wav.subarray(8, 12).toString(), "WAVE");
assert.equal(wav.readUInt32LE(24), 24000, "采样率写在头里。");
assert.equal(wav.readUInt32LE(40), 480, "data 长度写在头里。");

// ── 4. silk 编解码（真跑 wasm）──────────────────────────
const silk = await wavToSilk(wav);
assert.ok(silk.length > 0, "wav 能编成 silk。");
const back = await silkToWav(silk);
assert.equal(back.subarray(0, 4).toString(), "RIFF", "silk 解回来是完整 wav。");
assert.ok(back.length > 44);

// 已经是 wav 的直链（有的网关转存成 wav）原样返回，不再解码。
assert.equal(await silkToWav(wav), wav);

// 喂一段垃圾进去必须报错，而不是产出一个坏文件发给 QQ。
await assert.rejects(() => wavToSilk(Buffer.from("not a wav")), /VOICE_NOT_WAV/);
await assert.rejects(() => voiceToWav(Buffer.from("not a silk nor amr")), /VOICE_NOT_SILK_OR_AMR/);

// ── 4.1 AMR 解码（真跑 wasm）──────────────────────────
// QQ 手机端/网页端的入站语音是 AMR 编码，最早只认 silk 导致「听不懂语音」。
// 用一帧合法 AMR-NB 语音帧（mode=0）验证能解出 wav。
{
  // `#!AMR\n` 头 + 一帧 mode=0 语音（帧头 0x04，95bit payload = 12 字节）。
  const amrHeader = Buffer.from("#!AMR\n", "latin1");
  const frame = Buffer.from([0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const amr = Buffer.concat([amrHeader, frame]);
  const amrWav = await voiceToWav(amr);
  assert.equal(amrWav.subarray(0, 4).toString(), "RIFF", "AMR 能解成 wav。");
  assert.equal(amrWav.readUInt32LE(24), 8000, "AMR-NB 采样率 8kHz 写在头里。");
  assert.ok(amrWav.length > 44, "AMR 解出来的 wav 有音频数据。");
}

// 服务商返回的 wav 头里长度字段是坏的（硅基流动实测 0xFFFFFFA6 / 0xFFFFFF00）：
// 格式字段都是对的，只是长度写成负值。这种必须能救回来，否则「合成了但发不出去」。
{
  const broken = Buffer.from(wav);
  broken.writeUInt32LE(0xffffffa6, 4);
  broken.writeUInt32LE(0xffffff00, 40);
  const repaired = repairWavSizes(broken);
  assert.equal(repaired.readUInt32LE(4), repaired.length - 8, "RIFF 长度按实际文件重算。");
  assert.equal(repaired.readUInt32LE(40), repaired.length - 44, "data 长度按实际文件重算。");
  assert.ok((await wavToSilk(broken)).length > 0, "坏头 wav 也能编成 silk。");

  // fmt/data 之外还夹了 LIST chunk 时也要能找到 data（服务商常塞元数据）。
  const withList = Buffer.concat([
    wav.subarray(0, 36),
    Buffer.from("LIST"), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from("INFO"),
    wav.subarray(36),
  ]);
  withList.writeUInt32LE(0, 4);
  const repairedList = repairWavSizes(withList);
  assert.ok((await wavToSilk(repairedList)).length > 0, "带 LIST chunk 的 wav 也能用。");
}

// ── 4.1 尾部补静音（防「半拉」）────────────────────────
// QQ 的时长是整数秒，网关按帧数四舍五入，最多切掉尾巴 0.5 秒。
// 补静音把这段误差垫进去，被切掉的只能是静音，不能是最后一个字。
{
  const padded = padWavSilence(wav, 100);
  const expected = Math.round(24000 * 0.1) * 2; // 24k × 100ms × 16bit 单声道
  assert.equal(padded.length, wav.length + expected, "补的字节数与采样率/位深对得上。");
  assert.equal(padded.readUInt32LE(4), padded.length - 8, "RIFF 长度跟着重算。");
  assert.equal(padded.readUInt32LE(40), padded.length - 44, "data 长度跟着重算。");
  assert.equal(padded.readUInt32LE(24), 24000, "采样率不许被改。");
  assert.equal(padded.readUInt16LE(34), 16, "位深不许被改。");
  assert.ok(padded.subarray(wav.length).every((byte) => byte === 0), "补的是静音，不是垃圾。");

  // 补完照样能编成 silk，而且确实变长了 —— 否则等于没补。
  const before = readSilkDurationMs(await wavToSilk(wav));
  const after = readSilkDurationMs(await wavToSilk(padded));
  assert.ok(after >= before + 90, `补静音后 silk 要变长（前 ${before}ms → 后 ${after}ms）。`);

  assert.equal(padWavSilence(wav, 0), wav, "0 毫秒原样返回，不白复制一次。");

  // 头部坏掉的 wav 也要能补：服务商回来的是负长度字段，先修再补。
  const broken = Buffer.from(wav);
  broken.writeUInt32LE(0xffffffa6, 4);
  broken.writeUInt32LE(0xffffff00, 40);
  assert.equal(padWavSilence(broken, 100).length, wav.length + expected, "坏头 wav 补静音前先修长度。");

  // data 后面还挂了 LIST chunk 时，重建要丢掉它 —— 留着会把元数据当采样点编进语音。
  const withTailList = Buffer.concat([
    wav,
    Buffer.from("LIST"), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from("INFO"),
  ]);
  withTailList.writeUInt32LE(withTailList.length - 8, 4);
  const paddedList = padWavSilence(withTailList, 100);
  assert.equal(paddedList.length, wav.length + expected, "尾部 LIST 被丢掉，只留 PCM + 静音。");
  assert.equal(paddedList.readUInt32LE(40), 480 + expected, "data 长度只算 PCM + 静音。");

  assert.throws(() => padWavSilence(Buffer.from("not a wav"), 100), /VOICE_NOT_WAV/);
}

// ── 6. 转写回填 ────────────────────────────────────────
assert.equal(applyVoiceTranscripts("早上好", []), "早上好");
assert.equal(applyVoiceTranscripts("听听[语音]", ["我今天不去"]), "听听[语音：我今天不去]");
assert.equal(
  applyVoiceTranscripts("[语音]和[语音]", ["第一句", "第二句"]),
  "[语音：第一句]和[语音：第二句]",
  "多条各回各的位置。",
);
// 转不出来时要明说「有语音、没听懂」，不能留裸的 `[语音]`（否则她会对着占位符编一段）。
assert.equal(
  applyVoiceTranscripts("[语音]", [null]),
  VOICE_UNTRANSCRIBED,
  "转写失败要填明确说明。",
);
// 转写文本里带 `[语音]` 时不能反复替换同一段。
assert.equal(applyVoiceTranscripts("[语音]好", ["他说[语音]"]), "[语音：他说[语音]]好");

assert.equal(sanitizeTranscript("  嗯\n\n就是这样  "), "嗯 就是这样");
assert.equal(sanitizeTranscript("   "), null);

// ── 6. 开关与概率 ──────────────────────────────────────
assert.equal(isVoiceReplyEnabled({}), false, "默认不发语音。");
assert.equal(isVoiceReplyEnabled({ voiceEnabled: true }), true);
assert.equal(isVoiceTranscribeEnabled({}), false, "默认不转写语音。");
assert.equal(isVoiceTranscribeEnabled({ voiceTranscribe: true }), true);
assert.equal(resolveVoiceChance({}), 0, "默认 0：合成太慢，不随机发。");
assert.equal(resolveVoiceChance({ voiceChance: 80 }), 80);
assert.equal(resolveVoiceChance({ voiceChance: 999 }), 100, "越界夹到 100。");
assert.equal(resolveVoiceChance({ voiceChance: -5 }), 0);

// ── 7. 要不要发语音 ────────────────────────────────────
const on = { voiceEnabled: true, voiceChance: 100 };
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "在的", random: () => 0 }),
  true,
  "开关开、概率 100、冷却已过 → 发。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceChance: 100 }, text: "在的", random: () => 0 }),
  false,
  "开关关着就不发，概率不起作用。",
);
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "啊".repeat(VOICE_TEXT_MAX_CHARS + 1), random: () => 0 }),
  false,
  "超长回复发语音=让人干等，宁可发文字。",
);
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "……", random: () => 0 }),
  false,
  "没有可读内容不发。",
);
assert.equal(
  shouldSendVoice({
    modelConfig: on,
    text: "在的",
    lastVoiceAt: new Date(Date.now() - VOICE_COOLDOWN_MS / 2),
    random: () => 0,
  }),
  false,
  "冷却期内不连发。",
);
assert.equal(
  shouldSendVoice({
    modelConfig: on,
    text: "在的",
    lastVoiceAt: new Date(Date.now() - VOICE_COOLDOWN_MS - 1000),
    random: () => 0,
  }),
  true,
  "冷却过了可以再发。",
);
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "在的", random: () => 0.999 }),
  true,
  "概率 100 时任何随机值都命中。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 0 }, text: "在的", random: () => 0 }),
  false,
  "概率 0 永不发语音。",
);

// 概率 50：random 0.4 命中、0.6 不命中。
assert.equal(shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 50 }, text: "在的", random: () => 0.4 }), true);
assert.equal(shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 50 }, text: "在的", random: () => 0.6 }), false);

// ── 7.1 用户明确要语音 ─────────────────────────────────
// 合成要十几秒，所以默认概率是 0；「发个语音」这条路径才是日常真正的入口。
for (const text of ["发个语音", "发条语音呗", "用语音说", "语音条呢", "给我说句话吧", "来一段语音"]) {
  assert.equal(isVoiceRequested(text), true, `应识别为要语音：${text}`);
}
for (const text of ["别发语音", "不要用语音", "语音没有，我只有打字", "这语音条音质不错", "在吗"]) {
  assert.equal(isVoiceRequested(text), false, `不该识别为要语音：${text}`);
}

// 「引用他说一句」这类没有「语音」二字，但就是在要她开口。
// 漏判的后果不是「识别错」，而是这一轮不 force → 落回冷却与概率 → 多数时候只发文字，
// 用户看到的是「引用别人的时候语音老是发不出去」。
for (const text of ["引用他说一句", "引用他念一段", "引用上面那条说一句", "引用他说几声"]) {
  assert.equal(isVoiceRequested(text), true, `引用 + 说/念 应该算要语音：${text}`);
}
// 但「回他一句」多半只是打字，不能被一起抢过来。
for (const text of ["引用他", "回他一句", "引用这条聊聊"]) {
  assert.equal(isVoiceRequested(text), false, `不能过度识别：${text}`);
}

// 明确要求时跳过概率与冷却，但**不**跳过开关和长度。
assert.equal(
  shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 0 }, text: "在的", force: true, random: () => 0.99 }),
  true,
  "概率 0 也要发：他要的。",
);
assert.equal(
  shouldSendVoice({
    modelConfig: { voiceEnabled: true, voiceChance: 0 },
    text: "在的",
    force: true,
    lastVoiceAt: new Date(),
  }),
  true,
  "冷却期内被点名也要发。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceChance: 0 }, text: "在的", force: true }),
  false,
  "开关没开就不发，force 不能绕过开关。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 0 }, text: "啊".repeat(200), force: true }),
  false,
  "超长也不发，force 不能让人干等 20 秒。",
);

// 一轮最多转几条。
assert.equal(MAX_VOICES_PER_TURN, 2);

// ── 7.2 生成前「计划」与生成后「复核」是两步 ───────────
// 分成两步的唯一理由：模型要在生成之前就知道这一条会被念出来。
assert.equal(planVoiceReply({ modelConfig: { voiceEnabled: true, voiceChance: 0 } }), false, "概率 0 不计划。");
assert.equal(planVoiceReply({ modelConfig: { voiceEnabled: true, voiceChance: 0 }, force: true }), true, "用户要就计划发。");
assert.equal(planVoiceReply({ modelConfig: { voiceChance: 100 }, force: true }), false, "开关没开，force 也不能绕过。");
assert.equal(
  planVoiceReply({ modelConfig: { voiceEnabled: true, voiceChance: 100 }, lastVoiceAt: new Date() }),
  false,
  "冷却期内不计划（否则提示词会让她按语音写，最后却发文字）。",
);

// ── 7.3 冷却时长可配（默认 20 分钟，0 = 不冷却）────────
assert.equal(resolveVoiceCooldownMinutes({}), 20, "默认 20 分钟。");
assert.equal(resolveVoiceCooldownMinutes({ voiceCooldownMinutes: 5 }), 5);
assert.equal(resolveVoiceCooldownMinutes({ voiceCooldownMinutes: 0 }), 0, "0 = 不冷却。");
assert.equal(resolveVoiceCooldownMinutes({ voiceCooldownMinutes: -10 }), 0, "负数夹到 0。");
assert.equal(resolveVoiceCooldownMinutes({ voiceCooldownMinutes: 99999 }), 1440, "上限一天。");
assert.equal(resolveVoiceCooldownMinutes({ voiceCooldownMinutes: "5" }), 20, "非数字当没配。");
assert.equal(VOICE_COOLDOWN_MS, 20 * 60 * 1000, "老常量仍是 20 分钟，别被顺手改掉。");

{
  // 30 分钟前发过：默认 20 分钟该放行，配成 120 分钟就该拦住。
  const lastVoiceAt = new Date(Date.now() - 30 * 60 * 1000);
  assert.equal(
    planVoiceReply({ modelConfig: { voiceEnabled: true, voiceChance: 100 }, lastVoiceAt, random: () => 0 }),
    true,
    "默认 20 分钟：30 分钟前发过，可以再发。",
  );
  assert.equal(
    planVoiceReply({ modelConfig: { voiceEnabled: true, voiceChance: 100, voiceCooldownMinutes: 120 }, lastVoiceAt, random: () => 0 }),
    false,
    "配成 120 分钟：30 分钟前发过，这轮不发。",
  );
  // 0 = 不冷却：刚发过也照样发。
  assert.equal(
    planVoiceReply({ modelConfig: { voiceEnabled: true, voiceChance: 100, voiceCooldownMinutes: 0 }, lastVoiceAt: new Date(), random: () => 0 }),
    true,
    "冷却 0：刚发过也能发。",
  );
}

assert.equal(canSpeakReply("在的，怎么啦"), true);
assert.equal(canSpeakReply("啊".repeat(VOICE_TEXT_MAX_CHARS + 1)), false, "超长不读。");
assert.equal(canSpeakReply("……"), false, "没有可读内容不读。");
// 计划通过但写完太长：生成后这一步把它拦下来，降级发文字。
assert.equal(
  shouldSendVoice({
    modelConfig: { voiceEnabled: true, voiceChance: 0 },
    text: "啊".repeat(VOICE_TEXT_MAX_CHARS + 1),
    force: true,
  }),
  false,
);

// ── 8. MiniMax：hex 音频 + GroupId 查询参数 ────────────
// 这家跟 OpenAI 兼容协议完全不是一回事：端点叫 /t2a_v2、GroupId 在查询串里、
// 返回的 data.audio 是 **hex 字符串**（当二进制写会得到一坨乱码）。
{
  assert.equal(
    buildMinimaxEndpoint("https://api.minimaxi.com/v1", "123").toString(),
    "https://api.minimaxi.com/v1/t2a_v2?GroupId=123",
  );
  assert.equal(
    buildMinimaxEndpoint("https://api.minimaxi.com/v1", "").toString(),
    "https://api.minimaxi.com/v1/t2a_v2",
    "没配 GroupId 就不带参数，而不是拼一个空值。",
  );

  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const minimaxSettings = {
    provider: "minimax" as const,
    model: "speech-2.5-turbo-preview",
    voice: "female-shaonv",
    apiBaseUrl: "https://api.minimaxi.com/v1",
    apiKey: "sk-minimax-test",
    groupId: "group-1",
    speed: 1,
  };
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calledUrl = String(input);
      calledBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({
        data: { audio: wav.toString("hex") },
        base_resp: { status_code: 0, status_msg: "success" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const silk = await synthesizeSpeechSilk("你好呀", minimaxSettings);
    assert.ok(silk && silk.length > 0, "hex 音频要能解出来并转成 silk。");
    assert.ok(calledUrl.includes("/t2a_v2"), "走的是 t2a_v2 而不是 OpenAI 的 /audio/speech。");
    assert.ok(calledUrl.includes("GroupId=group-1"), "GroupId 拼在查询串里。");
    const voiceSetting = calledBody.voice_setting as Record<string, unknown>;
    const audioSetting = calledBody.audio_setting as Record<string, unknown>;
    assert.equal(voiceSetting.voice_id, "female-shaonv");
    assert.equal(audioSetting.format, "wav", "只要 wav：mp3 这边没有解码器。");
    assert.equal(calledBody.stream, false, "wav 只在非流式下支持。");

    // 200 + 业务错误码（余额不足、音色不存在、GroupId 不匹配都这样）必须当失败。
    globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify({
      base_resp: { status_code: 1004, status_msg: "invalid api key" },
    }), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(await synthesizeSpeechSilk("你好呀", minimaxSettings), null);

    // 1004「token not match group」= Key 和 GroupId 不在同一个账号。MiniMax 的 sk- 账号级 Key
    // 带上别人的 GroupId 就是这句，去掉 GroupId 就能合成 —— 所以这里要能自己重试成功。
    const urls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.includes("GroupId=")) {
        return new Response(JSON.stringify({
          base_resp: { status_code: 1004, status_msg: "token not match group" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: { audio: wav.toString("hex") },
        base_resp: { status_code: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const retried = await synthesizeSpeechSilk("你好呀", minimaxSettings);
    assert.ok(retried && retried.length > 0, "去掉 GroupId 重试成功时应当按成功返回。");
    assert.equal(urls.length, 2, "带 GroupId 失败一次、不带的一次。");
    assert.ok(!urls[1]!.includes("GroupId="), "重试那次不能还带着 GroupId。");

    // audio 不是合法 hex 时也不能硬转，否则发给 QQ 的是一条坏语音。
    globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify({
      data: { audio: "not-a-hex-string" },
      base_resp: { status_code: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(await synthesizeSpeechSilk("你好呀", minimaxSettings), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 9. 配置解析 ────────────────────────────────────────
const VOICE_ENV_KEYS = [
  "VOICE_TTS_MODEL", "VOICE_TTS_BASE_URL", "VOICE_TTS_API_KEY", "VOICE_TTS_VOICE", "VOICE_TTS_SPEED",
  "VOICE_TTS_PROVIDER", "VOICE_TTS_GROUP_ID", "VOICE_TTS_INSTRUCTIONS", "VOICE_TTS_LANGUAGE", "VOICE_TTS_INSTRUCTIONS", "VOICE_TTS_LANGUAGE",
  "VOICE_ASR_MODEL", "VOICE_ASR_BASE_URL", "VOICE_ASR_API_KEY", "VOICE_ASR_LANGUAGE",
] as const;
const savedEnv = new Map<string, string | undefined>(VOICE_ENV_KEYS.map((key) => [key, process.env[key]]));
const clearVoiceEnv = () => {
  for (const key of VOICE_ENV_KEYS) delete process.env[key];
};

try {
  clearVoiceEnv();
  assert.equal(resolveVoiceTtsSettings({}), null, "没配模型就不发语音（默认状态）。");
  assert.equal(resolveVoiceAsrSettings({}), null);

  // 地址里带 minimax 就自动走 MiniMax 协议 —— 换服务商不该被逼着多填一个枚举。
  process.env.VOICE_TTS_MODEL = "speech-2.5-turbo-preview";
  process.env.VOICE_TTS_BASE_URL = "https://api.minimaxi.com/v1";
  process.env.VOICE_TTS_API_KEY = "sk-minimax";
  const autoMinimax = resolveVoiceTtsSettings({});
  assert.equal(autoMinimax!.provider, "minimax");
  assert.equal(autoMinimax!.voice, "female-shaonv", "MiniMax 的默认音色不该是 OpenAI 的 alloy。");
  // 显式指定优先于推断（比如用中转站域名，地址里看不出是哪家）。
  assert.equal(
    resolveVoiceTtsSettings({ modelConfig: { ttsProvider: "minimax" } })!.provider,
    "minimax",
  );

  // 页面上「自动判断」+ 地址填 minimax：provider 自动识别成 minimax，
  // 而且填的 GroupId 必须真的带上 —— 这条路径最容易漏（UI 上曾经连输入框都不显示）。
  const pageMinimax = resolveVoiceTtsSettings({
    modelConfig: {
      voiceApiBaseUrl: "https://api.minimaxi.com/v1",
      ttsModel: "speech-2.5-turbo-preview",
      ttsVoice: "female-yujie",
      ttsGroupId: "1234567890123456789",
    },
    voiceApiKey: "sk-page",
  });
  assert.equal(pageMinimax!.provider, "minimax", "地址里带 minimax 就该走 MiniMax 协议。");
  assert.equal(pageMinimax!.groupId, "1234567890123456789", "页面填的 GroupId 要带下来。");
  assert.equal(pageMinimax!.voice, "female-yujie");
  clearVoiceEnv();

  // Breeze：地址里带 breeze.blue 就该走它的协议；它没有默认音色，voice_id 必须显式给。
  process.env.VOICE_TTS_MODEL = "breeze-tts-2";
  process.env.VOICE_TTS_BASE_URL = "https://api.breeze.blue";
  process.env.VOICE_TTS_API_KEY = "brz-key";
  assert.equal(
    resolveVoiceTtsSettings({}),
    null,
    "Breeze 没有默认音色：没填 voc_ id 就不该发语音（拿 alloy 打过去只会 404）。",
  );
  const breeze = resolveVoiceTtsSettings({ modelConfig: { ttsVoice: "voc_abc123", ttsInstructions: "软软的" } });
  assert.equal(breeze!.provider, "breeze", "地址里带 breeze.blue 就该走 Breeze 协议。");
  assert.equal(breeze!.voice, "voc_abc123");
  assert.equal(breeze!.instructions, "软软的", "页面填的语气指令要带下来。");
  assert.equal(breeze!.language, "zh", "默认中文。");
  // 没填地址也不该回落到角色的聊天地址 —— 那会把请求打到别家去。
  delete process.env.VOICE_TTS_BASE_URL;
  const breezeDefaultBase = resolveVoiceTtsSettings({
    modelConfig: { ttsProvider: "breeze", ttsVoice: "voc_abc123" },
    chatApiBaseUrl: "https://api.deepseek.com/v1",
  });
  assert.equal(breezeDefaultBase!.apiBaseUrl, "https://api.breeze.blue", "Breeze 用自己的默认根地址。");
  clearVoiceEnv();

  // 合成换成 MiniMax 之后，识别不能跟着搬过去 —— MiniMax 没有 /audio/transcriptions。
  // 所以 ASR 地址以 VOICE_ASR_BASE_URL 为准，页面上那个「服务地址」只服务合成。
  process.env.VOICE_ASR_MODEL = "FunAudioLLM/SenseVoiceSmall";
  process.env.VOICE_ASR_BASE_URL = "https://api.siliconflow.cn/v1";
  process.env.VOICE_ASR_API_KEY = "sk-asr";
  const splitProviders = resolveVoiceAsrSettings({
    modelConfig: { voiceApiBaseUrl: "https://api.minimaxi.com/v1" },
  });
  assert.equal(splitProviders!.apiBaseUrl, "https://api.siliconflow.cn/v1", "识别仍留在原服务商。");
  delete process.env.VOICE_ASR_BASE_URL;
  const fallbackAsr = resolveVoiceAsrSettings({
    modelConfig: { voiceApiBaseUrl: "https://api.minimaxi.com/v1" },
  });
  assert.equal(fallbackAsr!.apiBaseUrl, "https://api.minimaxi.com/v1", "没单独配时才复用页面地址。");
  clearVoiceEnv();

  // 识别和合成不是同一家：合成在 Breeze、识别在 MiniMax，Key 必须能分开两把。
  process.env.VOICE_ASR_MODEL = "asr-1.0";
  process.env.VOICE_ASR_BASE_URL = "https://api.minimaxi.com/v1";
  const splitKey = resolveVoiceAsrSettings({
    modelConfig: { voiceApiBaseUrl: "https://api.breeze.blue", ttsProvider: "breeze" },
    voiceApiKey: "brz-tts-key",
    asrApiKey: "sk-minimax-asr",
  });
  assert.equal(splitKey!.provider, "minimax", "识别地址是 minimax 就该走它的端点。");
  assert.equal(splitKey!.apiKey, "sk-minimax-asr", "识别专用 Key 不能被合成的 Key 盖掉。");

  // 同一家（合成与识别都是 MiniMax）才复用原来那把 Key —— 一家全包时只填一次。
  const sharedKey = resolveVoiceAsrSettings({
    modelConfig: { ttsProvider: "minimax" },
    voiceApiKey: "shared-key",
  });
  assert.equal(sharedKey!.apiKey, "shared-key", "同一家才复用合成的 Key。");

  // 不同家时绝不能复用：Breeze 的 Key 拿去打 MiniMax 只会 401，而报错只说鉴权失败。
  // 所以这里宁可不识别（返回 null），也不拿一把不相干的 Key 去试。
  const crossVendor = resolveVoiceAsrSettings({
    modelConfig: { ttsProvider: "breeze", voiceApiBaseUrl: "https://api.breeze.blue" },
    voiceApiKey: "brz-tts-key",
  });
  assert.equal(crossVendor, null, "合成在 Breeze、识别在 MiniMax 时不能拿合成的 Key 顶上。");

  const pageAsrBase = resolveVoiceAsrSettings({
    modelConfig: { asrApiBaseUrl: "https://api.minimaxi.com/v1", asrModel: "asr-1.0" },
    asrApiKey: "k",
  });
  assert.equal(pageAsrBase!.apiBaseUrl, "https://api.minimaxi.com/v1", "页面填的识别地址优先。");
  clearVoiceEnv();

  // 页面上填的那一套优先于环境变量：换服务商不该逼人去改 .env。
  const fromPage = resolveVoiceTtsSettings({
    modelConfig: {
      voiceApiBaseUrl: "https://api.siliconflow.cn/v1",
      ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
      ttsVoice: "FunAudioLLM/CosyVoice2-0.5B:claire",
    },
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "sk-chat",
    voiceApiKey: "sk-voice",
  });
  assert.ok(fromPage, "页面上填齐了就该能用，不必先配 .env。");
  assert.equal(fromPage!.apiBaseUrl, "https://api.siliconflow.cn/v1", "语音地址独立于聊天地址。");
  assert.equal(fromPage!.apiKey, "sk-voice", "语音 Key 与聊天 Key 是两把。");
  assert.equal(fromPage!.voice, "FunAudioLLM/CosyVoice2-0.5B:claire");

  const asrFromPage = resolveVoiceAsrSettings({
    modelConfig: { voiceApiBaseUrl: "https://api.siliconflow.cn/v1", asrModel: "FunAudioLLM/SenseVoiceSmall" },
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "sk-chat",
    voiceApiKey: "sk-voice",
  });
  assert.ok(asrFromPage);
  assert.equal(asrFromPage!.apiKey, "sk-voice");
  assert.equal(asrFromPage!.model, "FunAudioLLM/SenseVoiceSmall");

  // 只配模型 + 走角色自己的聊天地址与 key：OpenAI 官方这类「同一份凭据」的场景。
  process.env.VOICE_TTS_MODEL = "tts-1";
  process.env.VOICE_ASR_MODEL = "whisper-1";
  const chatInput = { chatApiBaseUrl: "https://api.openai.com/v1", chatApiKey: "sk-test" };
  const tts = resolveVoiceTtsSettings(chatInput);
  assert.ok(tts);
  assert.equal(tts!.model, "tts-1");
  assert.equal(tts!.apiBaseUrl, "https://api.openai.com/v1");
  assert.equal(tts!.voice, "alloy", "没指定音色用默认值。");
  assert.equal(tts!.speed, 1);

  // 语速：页面 > 环境变量 > 1。页面没这个旋钮之前，调快只能改 .env 再重启适配器。
  process.env.VOICE_TTS_SPEED = "1.3";
  assert.equal(resolveVoiceTtsSettings(chatInput)!.speed, 1.3, "环境变量生效。");
  assert.equal(
    resolveVoiceTtsSettings({ ...chatInput, modelConfig: { ttsSpeed: 1.1 } })!.speed,
    1.1,
    "页面填的语速优先于环境变量。",
  );
  assert.equal(
    resolveVoiceTtsSettings({ ...chatInput, modelConfig: { ttsSpeed: 9 } })!.speed,
    2,
    "超出范围要夹到上限，不能原样发给服务商。",
  );
  delete process.env.VOICE_TTS_SPEED;
  assert.equal(resolveVoiceTtsSettings(chatInput)!.speed, 1, "都没配就回到 1。");

  const asr = resolveVoiceAsrSettings(chatInput);
  assert.ok(asr);
  assert.equal(asr!.model, "whisper-1");
  assert.equal(asr!.language, "", "没配语言就交给服务商自己判断。");

  // 角色级覆盖环境变量。
  const overridden = resolveVoiceTtsSettings({
    modelConfig: { ttsModel: "gpt-4o-mini-tts", ttsVoice: "shimmer" },
    ...chatInput,
  });
  assert.equal(overridden!.model, "gpt-4o-mini-tts");
  assert.equal(overridden!.voice, "shimmer");

  // 独立端点优先于聊天端点。
  process.env.VOICE_TTS_BASE_URL = "https://tts.example.com/v1";
  process.env.VOICE_TTS_API_KEY = "tts-key";
  const separate = resolveVoiceTtsSettings(chatInput);
  assert.equal(separate!.apiBaseUrl, "https://tts.example.com/v1");
  assert.equal(separate!.apiKey, "tts-key");

  // 地址写错当没配，不能让整轮聊天失败。
  process.env.VOICE_TTS_BASE_URL = "not-a-url";
  assert.equal(resolveVoiceTtsSettings(chatInput), null);

  // 没有 key 就发不出去，当作没配。
  delete process.env.VOICE_TTS_BASE_URL;
  delete process.env.VOICE_TTS_API_KEY;
  assert.equal(resolveVoiceTtsSettings({ chatApiBaseUrl: "https://api.openai.com/v1" }), null);
} finally {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── 9. DTO 透传 ────────────────────────────────────────
const dto = toCharacterDto({
  id: "c1",
  name: "测试",
  avatar: null,
  basePrompt: "",
  styleExamples: "",
  userAddress: "",
  status: "ACTIVE",
  modelConfig: { voiceEnabled: true, voiceTranscribe: true, voiceChance: 60 },
  updatedAt: new Date(),
  memorySetting: null,
  channelBindings: [],
  memoryScopes: [],
} as never);
assert.equal(dto.voiceEnabled, true);
assert.equal(dto.voiceTranscribe, true);
assert.equal(dto.voiceChance, 60);

const dtoDefault = toCharacterDto({
  id: "c2",
  name: "默认",
  avatar: null,
  basePrompt: "",
  styleExamples: "",
  userAddress: "",
  status: "ACTIVE",
  modelConfig: {},
  updatedAt: new Date(),
  memorySetting: null,
  channelBindings: [],
  memoryScopes: [],
} as never);
assert.equal(dtoDefault.voiceEnabled, false);
assert.equal(dtoDefault.voiceTranscribe, false);
assert.equal(dtoDefault.voiceChance, 0);

// ── 10. 页面填的 Key：加密存、解密用 ───────────────────
// 这一段会读写 .data/credentials-encryption.key（本机已有的那把密钥），
// 不碰数据库、不联网：验证的是「存进去的是一坨密文，取出来还能用」。
{
  const encrypted = await encryptApiKey("sk-voice-from-page");
  assert.ok(encrypted.startsWith("v1."), "落库的是加密串，不是明文。");
  assert.ok(!encrypted.includes("sk-voice-from-page"), "密文里不能出现明文片段。");

  const config = {
    voiceApiKeyEncrypted: encrypted,
    voiceApiBaseUrl: "https://api.siliconflow.cn/v1",
    ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
  };
  assert.equal(isVoiceApiKeySaved(config), true);
  assert.equal(isVoiceApiKeySaved({}), false);

  const decrypted = await resolveCharacterVoiceApiKey(config);
  assert.equal(decrypted, "sk-voice-from-page", "解密后能直接用。");

  // 解密出来的 Key 必须压过聊天 Key —— 否则「语音另一家服务商」这件事就不成立。
  const resolved = resolveVoiceTtsSettings({
    modelConfig: config,
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "sk-chat-key",
    voiceApiKey: decrypted,
  });
  assert.equal(resolved!.apiKey, "sk-voice-from-page");
  assert.equal(resolved!.apiBaseUrl, "https://api.siliconflow.cn/v1");

  // 没存过 Key 时是空字符串，不是抛错。
  assert.equal(await resolveCharacterVoiceApiKey({}), "");
}

console.log("test:voice —— 全部通过");