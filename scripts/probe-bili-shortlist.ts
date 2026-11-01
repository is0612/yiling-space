/**
 * 粗筛体感检查：把一批候选视频喂给模型，看它挑得对不对。
 *
 * 候选是用一份**手写夹具**模拟的（BV 号、UP 主、播放量都是循环拼的假数据），
 * 作品名也是编的 —— 只为凑出「前瞻 / 吐槽 / 解析 / 争议 / 日常」几种不同形态，
 * 不指向任何真实作品。
 *
 * 目标角色见 probe-target.ts。
 */

import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { callBiliModel } from "../server/utils/channel-adapter/bili/llm";
import { resolveChatModelSettings } from "../server/utils/chat-model-config";
import { resolveCharacterApiKey } from "../server/utils/credential-encryption";
import { parseDutyInput } from "../server/utils/channel-adapter/bili/configure";
import { buildDutyPrompt } from "../server/utils/channel-adapter/bili/duty-prompt";
import { extractBvids } from "../server/utils/channel-adapter/bili/cards";
import { parseJsonLoose } from "../server/utils/loose-json";
import { resolveProbeCharacterId } from "./probe-target";

const CHARACTER_ID = resolveProbeCharacterId();

const prisma = getPrisma();
const character = await prisma.character.findUnique({
  where: { id: CHARACTER_ID },
  select: { name: true, basePrompt: true, modelConfig: true, status: true, userAddress: true },
});
if (!character) throw new Error(`找不到角色 ${CHARACTER_ID}（可用 CHAR_ID 指定）`);

const connection = await prisma.platformConnection.findFirst({
  where: { platform: "bili" },
  select: { id: true, metadata: true },
});
const metadata = (connection?.metadata ?? {}) as Record<string, unknown>;
const duty = parseDutyInput(metadata.duty);
console.log("=== duty ===");
console.log("taste length:", duty.taste.length);
console.log("taste head:", duty.taste.slice(0, 160).replace(/\n/g, " | "));
console.log("keywords:", JSON.stringify(duty.keywords), "zone:", duty.zone, "perDay:", duty.perDay);

const dutyPrompt = buildDutyPrompt(duty, {
  today: "2026-10-28", remaining: 5, perDay: duty.perDay, keywords: duty.keywords, zone: duty.zone,
  frames: duty.frames, dmMode: duty.dmMode, autoComment: duty.autoComment, commentPerRound: duty.commentPerRound,
  mentionName: duty.mentionName, userAddress: character.userAddress ?? "", watchLimit: 3,
});
const characterPrompt = `${character.basePrompt.slice(0, 12_000)}\n\n${dutyPrompt}`;
console.log("characterPrompt length:", characterPrompt.length);

/**
 * 夹具只是为了让提示词里有东西可挑：结构差异（前瞻 / 吐槽 / 解析 / 争议 / 日常）
 * 才是被测对象，作品名本身不影响结果。
 */
const titles = [
  "「星港纪年」6.3 前瞻：新角色实机",
  "这游戏我不玩了，退坑了",
  "「云端旅人」2.5 剧情解析",
  "「回声之城」1.5 版本全角色展示",
  "「长夜行」3.8 版本 PV",
  "「争议」某角色强度到底行不行",
  "「旧日档案」主线剧情录屏",
  "「海隅小镇」家园装修分享",
  "「星港纪年」音乐会现场",
  "某工作室 新作预告",
];
const candidates = titles.map((t, i) => `${i + 1}. [BV1xx411c7m${i}] ${t}（UP：某UP）\n   时长 10:0${i} · 播放 ${(i + 1) * 7}万`).join("\n");

const prompt = [
  "这是我这轮刷到的候选视频。",
  "",
  "我记得这些：\n- [EVENT] 昨天看过星港纪年前瞻",
  "",
  "先粗筛一遍：把明显不值得花时间的剔掉，只留最值得细看的，最多 3 条。",
  "拿不准的可以留，后面我会真的去看内容再定。",
  "",
  "只输出一个 JSON 数组，元素是 BV 号，按值得看的程度从高到低排，不要任何别的文字。",
  '例如：["BV1xx411c7mD"]',
  "",
  "候选：",
  candidates,
].join("\n");

const settings = resolveChatModelSettings(character.modelConfig);
const apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);

try {
  const reply = await callBiliModel({
    systemPrompt: characterPrompt,
    userPrompt: prompt,
    model: settings.model,
    apiKey,
    apiBaseUrl: settings.apiBaseUrl,
    temperature: 0.3,
    maxTokens: 800,
  });
  console.log("\n=== reply ===\n" + JSON.stringify(reply));
  console.log("parseJsonLoose:", JSON.stringify(parseJsonLoose(reply)));
  console.log("extractBvids:", JSON.stringify(extractBvids(reply)));
} catch (error) {
  console.log("\n=== ERROR === ", error instanceof Error ? error.message : error);
}

await prisma.$disconnect();
