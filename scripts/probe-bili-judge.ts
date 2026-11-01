/**
 * 单条判定体感检查：拿一条**手写夹具**视频，看模型给出「值得 / 跳过 + 理由 + 评论」的表现。
 *
 * 夹具里的作品名、UP 主、BV 号都是编的，只保留「官方前瞻」这种形态特征 ——
 * 被测的是判定口径，不是这条视频本身。
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
import { formatWatchedForModel, parseVerdict, type BiliWatchedVideo } from "../server/utils/channel-adapter/bili/cards";
import { resolveProbeCharacterId } from "./probe-target";

const CHARACTER_ID = resolveProbeCharacterId();

const prisma = getPrisma();
const character = await prisma.character.findUnique({
  where: { id: CHARACTER_ID },
  select: { name: true, basePrompt: true, modelConfig: true, userAddress: true },
});
if (!character) throw new Error(`找不到角色 ${CHARACTER_ID}（可用 CHAR_ID 指定）`);

const connection = await prisma.platformConnection.findFirst({ where: { platform: "bili" }, select: { metadata: true } });
const duty = parseDutyInput(((connection?.metadata ?? {}) as Record<string, unknown>).duty);

const dutyPrompt = buildDutyPrompt(duty, {
  today: "2026-10-28", remaining: 5, perDay: duty.perDay, keywords: duty.keywords, zone: duty.zone,
  frames: duty.frames, dmMode: duty.dmMode, autoComment: duty.autoComment, commentPerRound: duty.commentPerRound,
  mentionName: duty.mentionName, userAddress: character.userAddress ?? "", watchLimit: 3,
});
const systemPrompt = `${character.basePrompt.slice(0, 12_000)}\n\n${dutyPrompt}`;

const watched: BiliWatchedVideo = {
  bvid: "BV1xx411c7m0",
  title: "「星港纪年」6.3 版本前瞻：新角色实机演示",
  author: { mid: 1, name: "某UP" },
  desc: "官方前瞻直播剪辑，包含新角色技能与地图介绍。",
  tags: ["星港纪年", "前瞻", "游戏"],
  aiSummary: "介绍 6.3 版本新角色技能、新地图与活动安排。",
  transcriptSource: "字幕",
  transcriptText: "大家好，这期我们来看 6.3 版本的前瞻内容。新角色……（略）……以上就是本期的全部内容。",
  chapters: [],
  hotComments: [{ user: "观众A", content: "新角色好可爱", like: 320 }],
  danmakuPeaks: [],
  framesSheet: "",
  duration: 750,
  stat: { view: 881000, danmaku: 2100, like: 20000, reply: 800, favorite: 5000, coin: 3000, share: 400 },
};

const prompt = [
  "我把这条视频看完了，材料如下：",
  "",
  formatWatchedForModel(watched),
  "",
  "---",
  "判断：这条值不值得占主人的注意力？拿不准就跳过，别反复权衡。",
  "按下面三行回答，一行一个字段，不要用 JSON、不要加别的解释：",
  "判断：值得  或  判断：跳过",
  "理由：一句话，30 字内，说清为什么。跳过也要写；口味里规定了写法的（比如只写两个字），按口味写",
  "评论：如果要公开评论，写一句 60 字内、像自己刷到随口说一句的话；不需要就写「无」",
].join("\n");

const settings = resolveChatModelSettings(character.modelConfig);
const apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);

const reply = await callBiliModel({
  systemPrompt,
  userPrompt: prompt,
  model: settings.model,
  apiKey,
  apiBaseUrl: settings.apiBaseUrl,
  temperature: 0.4,
  maxTokens: 600,
});
console.log("=== judge reply ===\n" + reply);
console.log("parseVerdict:", JSON.stringify(parseVerdict(reply)));

await prisma.$disconnect();
