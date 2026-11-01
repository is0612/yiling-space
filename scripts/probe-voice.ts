/**
 * 探一探语音链路到底通不通：TTS 合成 → silk 转码 → 再解码成 wav 试听。
 *
 * 为什么需要它：`[voice]` 日志说"没配"和说"服务商不给 wav"是两个完全不同的问题，
 * 而页面上只会表现为"她还是只发文字"。这个脚本把两件事分开讲清楚：
 *   1. 配置齐不齐（模型名 / Base URL / Key）
 *   2. 服务商到底给不给 wav（这里没有 mp3 解码器，给 mp3 就等于失败）
 *   3. silk 转码能不能过（wasm 在生产产物里能不能加载）
 *
 * 用法（一次合成几十个字符，成本可忽略）：
 *   npx tsx scripts/probe-voice.ts
 *   npx tsx scripts/probe-voice.ts "要合成的句子"
 *   npx tsx scripts/probe-voice.ts --character <characterId>   # 用这个角色的模型与 Key
 *
 * 成功时会把语音写到 `.data/voice-probe.wav`，直接双击就能听效果。
 */

import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";

import { resolveChatModelSettings } from "../server/utils/chat-model-config";
import { resolveCharacterApiKey, resolveCharacterVoiceApiKey } from "../server/utils/credential-encryption";
import { getPrisma } from "../server/utils/prisma";
import {
  buildMinimaxEndpoint,
  buildSpeechEndpoint,
  resolveVoiceTtsSettings,
  silkToWav,
  synthesizeSpeechSilk,
} from "../server/utils/voice";

const DEFAULT_TEXT = "你好呀，我是小忆。今天过得怎么样？";

async function main() {
  const args = process.argv.slice(2);
  let characterId = "";
  let text = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--character") {
      characterId = args[index + 1] ?? "";
      index += 1;
    } else if (!arg.startsWith("--")) {
      text = arg;
    }
  }
  const spoken = text.trim() || DEFAULT_TEXT;

  let modelConfig: unknown = {};
  let chatModel = process.env.LLM_MODEL?.trim() || "gpt-4o-mini";
  let chatApiBaseUrl = process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
  let chatApiKey = process.env.LLM_API_KEY?.trim() || "";
  let voiceApiKey = "";

  if (characterId) {
    const character = await getPrisma().character.findUnique({
      where: { id: characterId },
      select: { name: true, modelConfig: true },
    });
    if (!character) {
      console.error("找不到这个角色：" + characterId);
      process.exit(1);
    }
    const settings = resolveChatModelSettings(character.modelConfig);
    modelConfig = character.modelConfig;
    chatModel = settings.model;
    chatApiBaseUrl = settings.apiBaseUrl;
    chatApiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);
    // 页面上填的那把语音 Key：不解密它就会退回聊天 Key，打到语音服务商就是 401。
    voiceApiKey = await resolveCharacterVoiceApiKey(character.modelConfig).catch(() => "");
    console.log("角色：" + character.name + (voiceApiKey ? "（用了页面上填的语音 Key）" : "（没在页面填语音 Key）"));
  }

  const settings = resolveVoiceTtsSettings({ modelConfig, chatModel, chatApiBaseUrl, chatApiKey, voiceApiKey });
  if (!settings) {
    console.error([
      "没有可用的 TTS 配置，所以她不会发语音。检查：",
      "  1. .env 里 VOICE_TTS_MODEL / VOICE_TTS_BASE_URL 有没有填",
      "  2. VOICE_TTS_API_KEY 有没有填 —— 留空时会尝试用角色的聊天 Key，",
      "     但 DeepSeek、通义这类纯文本服务商的 Key 在 /audio/speech 上是 404，光有 Key 也不够",
      "  3. 硅基流动（一个 Key 同时做 TTS 与 ASR，国内直连）：",
      "     https://cloud.siliconflow.cn/account/ak 拿 sk- 开头的 Key，填进 VOICE_TTS_API_KEY；",
      "     BASE_URL 填 https://api.siliconflow.cn/v1，MODEL 填 FunAudioLLM/CosyVoice2-0.5B",
      "  4. 填了 VOICE_TTS_BASE_URL 的话，它必须是能访问的 https 根地址（不要带 /audio/speech）",
    ].join("\n"));
    process.exit(1);
  }

  console.log("TTS 配置：" + JSON.stringify({
    provider: settings.provider,
    model: settings.model,
    voice: settings.voice,
    speed: settings.speed,
    sampleRate: settings.sampleRate ?? "(服务商默认)",
    endpoint: settings.provider === "minimax"
      ? buildMinimaxEndpoint(settings.apiBaseUrl, settings.groupId).toString()
      : buildSpeechEndpoint(settings.apiBaseUrl).toString(),
    keyPresent: Boolean(settings.apiKey),
    ...(settings.provider === "minimax" ? { groupIdPresent: Boolean(settings.groupId) } : {}),
  }));
  console.log("要合成：" + spoken);

  const started = Date.now();
  const silk = await synthesizeSpeechSilk(spoken, settings);
  if (!silk) {
    console.error(
      "\n合成失败。最常见的原因有两个：\n"
      + "  · 服务商不支持 /audio/speech（或此账号没有 TTS 权限）\n"
      + "  · 服务商返回的是 mp3 而不是 wav —— 这个项目没有 mp3 解码器，只能判失败\n"
      + "详细原因看上面那行 [voice] 日志。",
    );
    process.exit(1);
  }

  const wav = await silkToWav(silk);
  const outDir = path.join(process.cwd(), ".data");
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "voice-probe.wav");
  await fs.writeFile(outFile, wav);

  console.log("\n通过：");
  console.log("  silk  " + silk.length + " 字节（QQ 语音条就发这个）");
  console.log("  wav   " + wav.length + " 字节 / 约 " + (wav.length / 2 / 24000).toFixed(1) + " 秒");
  console.log("  耗时  " + (Date.now() - started) + " ms");
  console.log("  试听  " + outFile);
}

main()
  .catch((error) => {
    console.error("探测失败：", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    void getPrisma().$disconnect().catch(() => undefined);
  });
