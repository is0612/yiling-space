import { createError, getRouterParam } from "h3";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterApiKey, resolveCharacterVoiceApiKey } from "../../../../utils/credential-encryption";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { resolveVoiceTtsSettings, silkToWav, synthesizeSpeechSilk } from "../../../../utils/voice";

/** 测试产物写到哪：`.data/voice-probe.wav`，双击就能听。 */
const PROBE_PATH = resolve(process.cwd(), ".data", "voice-probe.wav");

/**
 * 测语音合成：真合成一句，验证 Key / 地址 / 模型 / 音色 / hex 解码 / silk 编码整条链路。
 *
 * 与 chat 的「保存并测试」不同，这一步不测识别（ASR），只测合成 —— 合成是发语音的主链路，
 * 也是最容易在「配置看着对、一调用就失败」的地方。失败的具体原因在服务端日志 `[voice]` 里。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let chatApiKey = "";
  let voiceApiKey = "";
  try {
    chatApiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
    voiceApiKey = await resolveCharacterVoiceApiKey(character.modelConfig);
  } catch {
    return { ok: false, message: "无法解密当前角色保存的 API Key。请重新输入并保存该 Key。" };
  }

  const settings = resolveVoiceTtsSettings({
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    chatApiKey,
    voiceApiKey,
  });
  if (!settings) {
    return {
      ok: false,
      message: "语音配置不完整：服务商、Key、合成模型、音色这几项都要配齐（在「模型设置 → 语音模型」）。",
    };
  }

  const providerLabel = settings.provider === "minimax" ? "MiniMax" : "OpenAI 兼容";
  const startedAt = Date.now();
  const silk = await synthesizeSpeechSilk("语音测试，听得见吗？", settings);
  const elapsedMs = Date.now() - startedAt;
  if (!silk) {
    return {
      ok: false,
      message: "合成失败。原因在服务端日志 `[voice]` 那行（401/403 是 Key，200+业务错误码看 base_resp，超时看网络）。",
      provider: settings.apiBaseUrl,
      elapsedMs,
    };
  }

  // 落一份可双击试听的 wav：用户点「测试」就是想听音色，只报「N 字节」等于没给结果。
  let probeWritten = false;
  try {
    await mkdir(resolve(process.cwd(), ".data"), { recursive: true });
    await writeFile(PROBE_PATH, await silkToWav(silk));
    probeWritten = true;
  } catch {
    // 写盘失败不影响「合成成功」这个结论，别因此报错。
  }

  return {
    ok: true,
    message: `语音合成成功（${providerLabel} / ${settings.model} / ${settings.voice}），${silk.length} 字节 silk。`
      + (probeWritten ? `试听文件已写到 .data/voice-probe.wav。` : ""),
    model: settings.model,
    voice: settings.voice,
    provider: providerLabel,
    elapsedMs,
    ...(probeWritten ? { probeFile: ".data/voice-probe.wav" } : {}),
  };
});
