/**
 * 探一探「她现在到底愿不愿意发表情包」。
 *
 * 为什么需要它：表情包发不出去有三层原因 —— 开关没开、素材库空、模型不挑。
 * 前两层查库就知道，第三层只能真发一次请求才看得见。这里直接用**生产同一条**
 * 提示词与同一个挑选函数（`pickStickerCatalog` + `generateConversationReply`），
 * 拿几句话试她挑不挑、挑得对不对。
 *
 * 用法（几句话的成本，不会打印 Key）：
 *   node_modules/.bin/tsx scripts/probe-sticker-pick.ts                # 第一个有表情包的角色
 *   node_modules/.bin/tsx scripts/probe-sticker-pick.ts <characterId>  # 指定角色
 *
 * 判读：「该挑的都挑了、不该挑的没挑」才算好。全都空 → 提示词还是太保守；
 * 该庄重的时候也贴图 → 反向过头了。
 */

import "dotenv/config";

import { generateConversationReply } from "../server/utils/chat-reply";
import { resolveChatModelSettings } from "../server/utils/chat-model-config";
import { resolveCharacterApiKey } from "../server/utils/credential-encryption";
import { getPrisma } from "../server/utils/prisma";
import { loadStickerCatalog, pickStickerCatalog } from "../server/utils/stickers";

/** 一句台词配一个预期：true = 这种语气下贴一张很自然，false = 贴了就是没分寸。 */
const SAMPLES: ReadonlyArray<{ text: string; expectSticker: boolean; note: string }> = [
  { text: "哈哈哈哈你今天怎么这么可爱", expectSticker: true, note: "被夸、心情好" },
  { text: "我想你了，什么时候回来", expectSticker: true, note: "撒娇" },
  { text: "无语，他又放我鸽子", expectSticker: true, note: "吐槽、共鸣" },
  { text: "今天考试挂了，好难过", expectSticker: false, note: "难过，要认真安慰" },
  { text: "在吗，帮我看下这段报错", expectSticker: false, note: "正事，需要真答案" },
];

const prisma = getPrisma();
const wantedId = process.argv[2]?.trim();

const characters = await prisma.character.findMany({ select: { id: true, name: true, basePrompt: true, styleExamples: true, modelConfig: true } });
let character = wantedId ? characters.find((item) => item.id === wantedId) : undefined;
if (!character) {
  for (const candidate of characters) {
    const catalog = await loadStickerCatalog(candidate.id);
    if (catalog.length) {
      character = candidate;
      break;
    }
  }
}
if (!character) {
  console.error("没有找到带表情包的角色。");
  process.exit(1);
}

const catalog = await loadStickerCatalog(character.id);
if (!catalog.length) {
  console.error(`${character.name} 没有启用的表情包（或开关没开），先传几张再探。`);
  process.exit(1);
}

const settings = resolveChatModelSettings(character.modelConfig);
const apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);
// 生产里每次都会重新挑一版（剔除上一张 + 洗牌），这里也照做，避免「总是同一批」的假象。
const offered = pickStickerCatalog(catalog, null);
console.log(`角色：${character.name}`);
console.log(`模型：${settings.model} @ ${settings.apiBaseUrl}`);
console.log(`素材库 ${catalog.length} 张，本次进提示词 ${offered.length} 张\n`);

let hit = 0;
let miss = 0;
for (const sample of SAMPLES) {
  const result = await generateConversationReply({
    characterName: character.name,
    characterPrompt: character.basePrompt.slice(0, 12_000),
    styleExamples: (character.styleExamples ?? "").slice(0, 8000),
    model: settings.model,
    apiKey,
    apiBaseUrl: settings.apiBaseUrl,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    currentMessage: sample.text,
    recentMessages: [],
    memories: [],
    snapshots: [],
    emojiStickers: offered.map((entry) => ({ id: entry.id, name: entry.name, usage: entry.usage })),
  });
  const sticker = result.stickerId ? offered.find((entry) => entry.id === result.stickerId) : null;
  const picked = Boolean(sticker);
  if (picked === sample.expectSticker) hit += 1;
  else miss += 1;
  const mark = picked === sample.expectSticker ? "✓" : "✗";
  console.log(`${mark} [${sample.note}] ${sample.text}`);
  console.log(`   回复：${result.reply.replace(/\s+/g, " ").slice(0, 60)}`);
  console.log(`   表情包：${sticker ? `${sticker.name}（${sticker.usage || "无场景"}）` : "没挑"}${picked === sample.expectSticker ? "" : `　← 预期${sample.expectSticker ? "该挑" : "不该挑"}`}`);
}

console.log(`\n合计：${hit} 句符合预期，${miss} 句不符合（${SAMPLES.length} 句）。`);
await prisma.$disconnect();
