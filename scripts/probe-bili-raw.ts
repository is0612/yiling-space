/**
 * 值班模型调用的体检脚本 —— 排查「粗筛 0 条 / LLM_EMPTY_REPLY」先跑这个。
 *
 * 它做的是一件很笨但很有效的事：**把真实配置、真实候选、真实预算打到模型上，把原始响应摊开**。
 * 重点关注三列：finish_reason / reasoning_tokens / content 长度。
 *   - finish_reason=length 且 content 空 ⇒ 思考型模型把预算吃光了（调大 max_tokens，见 llm.ts 注释）
 *   - finish_reason=stop 且 content 空   ⇒ 内容过滤或模型抽风
 *   - content 有值但不是 BV 数组         ⇒ 提示词/解析的问题，不是模型的问题
 *
 * 候选优先取「最近一轮真实刷到的」，没有就退化成内置样例。
 * 用法：npx tsx scripts/probe-bili-raw.ts
 */

import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { resolveChatModelSettings, buildChatCompletionsEndpoint } from "../server/utils/chat-model-config";
import { resolveCharacterApiKey } from "../server/utils/credential-encryption";
import { parseDutyInput } from "../server/utils/channel-adapter/bili/configure";
import { buildDutyPrompt } from "../server/utils/channel-adapter/bili/duty-prompt";
import { resolveProbeCharacterId } from "./probe-target";

const CHARACTER_ID = resolveProbeCharacterId();
const BUDGETS = (process.env.BUDGETS || "1024,4096").split(",").map(Number).filter((n) => Number.isFinite(n));

const prisma = getPrisma();
const character = await prisma.character.findUnique({
  where: { id: CHARACTER_ID },
  select: { basePrompt: true, modelConfig: true, userAddress: true },
});
if (!character) throw new Error(`找不到角色 ${CHARACTER_ID}（可用 CHAR_ID 指定）`);

const connection = await prisma.platformConnection.findFirst({ where: { platform: "bili" }, select: { metadata: true } });
const duty = parseDutyInput(((connection?.metadata ?? {}) as Record<string, unknown>).duty);
const dutyPrompt = buildDutyPrompt(duty, {
  today: new Date().toLocaleDateString("sv-SE"),
  remaining: 5,
  perDay: duty.perDay,
  keywords: duty.keywords,
  zone: duty.zone,
  frames: duty.frames,
  dmMode: duty.dmMode,
  autoComment: duty.autoComment,
  commentPerRound: duty.commentPerRound,
  mentionName: duty.mentionName,
  userAddress: character.userAddress ?? "",
  watchLimit: 5,
});
const systemPrompt = `${character.basePrompt.slice(0, 12_000)}\n\n${dutyPrompt}`;

const seen = await prisma.biliSeenVideo.findMany({
  orderBy: { seenAt: "desc" },
  take: 25,
  select: { bvid: true, title: true, author: true },
});
const cards = seen.length
  ? seen
  : [
      { bvid: "BV1xx411c7m0", title: "「星港纪年」6.3 前瞻：新角色实机", author: "某UP" },
      { bvid: "BV1xx411c7m1", title: "这游戏我不玩了，退坑了", author: "某UP" },
    ];
const candidates = cards.map((c, i) => `${i + 1}. [${c.bvid}] ${c.title}（UP：${c.author || "未知"}）`).join("\n");

const prompt = [
  "这是我这轮刷到的候选视频。",
  "",
  "先粗筛一遍：把明显不值得花时间的剔掉，只留最值得细看的，最多 5 条。",
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
const endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);

console.log(`模型：${settings.model} @ ${settings.apiBaseUrl}`);
console.log(`候选：${cards.length} 条（${seen.length ? "最近一轮真实候选" : "内置样例"}）｜system ${systemPrompt.length} 字`);
console.log(`当前默认预算：${process.env.BILI_MODEL_MIN_TOKENS ?? "见 llm.ts（4096）"}`);

for (const maxTokens of BUDGETS) {
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    console.log(`\n=== max_tokens=${maxTokens} HTTP ${response.status} ===\n${(await response.text()).slice(0, 300)}`);
    continue;
  }
  const payload = await response.json() as Record<string, any>;
  const choice = payload.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  console.log(`\n=== max_tokens=${maxTokens}（${Math.round((Date.now() - started) / 1000)}s）===`);
  console.log("finish_reason :", choice.finish_reason);
  console.log("completion    :", payload.usage?.completion_tokens, "｜reasoning:", reasoningTokens);
  console.log("content 长度  :", (message.content ?? "").length);
  console.log("content       :", JSON.stringify(String(message.content ?? "").slice(0, 200)));
}

await prisma.$disconnect();
