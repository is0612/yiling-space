import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { isStickerAutoCollectEnabled } from "../server/utils/sticker-collect";
/**
 * 「偷表情包」回归测试。
 *
 * collectSticker 依赖真实下载（公网 url）与视觉模型，没法在单测里真正跑通，
 * 这里只覆盖能脱离网络验证的部分：开关判定。下载、打标、去重这三段要么走
 * downloadImage（已有 image-understanding 的测试兜底）、要么在 dev 服务里冒烟。
 */
assert.equal(isStickerAutoCollectEnabled(undefined), false, "没配置时默认关。");
assert.equal(isStickerAutoCollectEnabled({}), false, "空配置也是关。");
assert.equal(isStickerAutoCollectEnabled({ stickerAutoCollect: true }), true, "显式 true 才开。");
assert.equal(isStickerAutoCollectEnabled({ stickerAutoCollect: false }), false);
assert.equal(isStickerAutoCollectEnabled({ stickerAutoCollect: "true" }), false, "字符串不算，别让「顺手写个字符串」悄悄打开开关。");
assert.equal(isStickerAutoCollectEnabled(null), false);

// ── 打标结果的解析（纯函数，不碰网络）───────────────────────────────
// 这一段是「收不收」的全部判断依据，最容易出错的也是这里：
// skip 的判定、泛称名字、模型返回非 JSON。
const { readStickerLabel } = await import("../server/utils/sticker-collect");
assert.deepEqual(
  readStickerLabel(JSON.stringify({ name: "委屈", usage: "被冤枉、想撒娇时" })),
  { ok: true, name: "委屈", usage: "被冤枉、想撒娇时" },
  "正常的名字 + 场景。",
);
assert.deepEqual(
  readStickerLabel(JSON.stringify({ skip: true })),
  { ok: false, reason: "not-a-sticker" },
  "模型说「这不是表情包」（截图 / 长图 / 照片）要能被认出来。",
);
assert.deepEqual(
  readStickerLabel(JSON.stringify({ skip: false, name: "拍桌笑" })),
  { ok: true, name: "拍桌笑", usage: "" },
  "skip 只有严格 true 才算跳过，false 不能误判。",
);
assert.deepEqual(
  readStickerLabel(JSON.stringify({ name: "表情包", usage: "" })),
  { ok: false, reason: "unusable-name" },
  "泛称名字等于没起名。",
);
assert.deepEqual(
  readStickerLabel("抱歉，我看不清这张图"),
  { ok: false, reason: "model-failed" },
  "非 JSON 当成模型失败。",
);
assert.deepEqual(
  readStickerLabel(JSON.stringify({ name: "  委屈  ", usage: "  想撒娇时  " })),
  { ok: true, name: "委屈", usage: "想撒娇时" },
  "首尾空白要裁掉。",
);

// ── 弹窗里「AI 生成」那句使用场景的解析（同样是纯函数）───────────────
// 模型不总是听话：有时换键名、有时干脆回一句裸文本，不能整条丢掉 ——
// 用户点这一下要的是「一句话」，不是「一次合规的 JSON」。
const { readStickerUsageSuggestion, suggestStickerUsage } = await import("../server/utils/sticker-usage");
assert.equal(
  readStickerUsageSuggestion(JSON.stringify({ usage: "被冤枉、想撒娇时" })),
  "被冤枉、想撒娇时",
  "标准形状。",
);
assert.equal(
  readStickerUsageSuggestion(JSON.stringify({ 什么时候用: "被冤枉时" })),
  "被冤枉时",
  "模型自创键名也认，取第一个字符串值。",
);
assert.equal(
  readStickerUsageSuggestion("被冤枉、想撒娇时用"),
  "被冤枉、想撒娇时用",
  "裸文本（没包 JSON）直接当结果。",
);
assert.equal(
  readStickerUsageSuggestion('"被冤枉时"'),
  "被冤枉时",
  "包裹的引号要去掉，别把引号填进输入框。",
);
assert.equal(readStickerUsageSuggestion(JSON.stringify({ usage: "" })), "", "空字符串算没生成。");
assert.equal(readStickerUsageSuggestion('{"usage": "被冤'), "", "半截 JSON 不能当场景填进去。");
assert.equal(
  readStickerUsageSuggestion(""),
  "",
  "空返回算没生成。",
);
assert.equal(
  readStickerUsageSuggestion(JSON.stringify({ usage: "冤".repeat(300) })).length,
  200,
  "超长按输入框上限截断（服务端 maxlength 也是 200）。",
);
assert.deepEqual(
  await suggestStickerUsage({ name: "  ", context: { characterId: "x", modelConfig: {}, chatModel: "", chatApiBaseUrl: "", chatApiKey: "" } }),
  { ok: false, reason: "no-name" },
  "名字为空时不该去调模型 —— 没依据。",
);
assert.deepEqual(
  await suggestStickerUsage({ name: "委屈", context: { characterId: "x", modelConfig: {}, chatModel: "", chatApiBaseUrl: "", chatApiKey: "" } }),
  { ok: false, reason: "no-model" },
  "没配模型时回 no-model，交给接口层翻译成人话。",
);

// 两个入口（上传框 / 编辑弹窗）共用同一套失败文案：同一件事说法不一样，用户会以为坏了。
const { stickerUsageError } = await import("../server/utils/sticker-usage");
assert.equal(stickerUsageError("no-name").statusCode, 422, "没名字是用户没填，不是服务器错。");
assert.equal(stickerUsageError("no-model").statusCode, 503, "没配模型是「服务还没就绪」。");
assert.equal(stickerUsageError("unusable-usage").statusCode, 422, "模型回了空话，让用户重试或自己写。");
assert.equal(stickerUsageError("model-failed").statusCode, 502, "上游模型失败是网关错误。");
assert.ok(
  new Set([
    stickerUsageError("no-name").statusMessage,
    stickerUsageError("no-model").statusMessage,
    stickerUsageError("unusable-usage").statusMessage,
    stickerUsageError("model-failed").statusMessage,
  ]).size === 4,
  "四种失败必须给出四句不同的话，否则用户分不清该改什么。",
);

// collectStickersFromTurn 在开关关着时必须一帧不跑（不下载、不调模型）。
// 这里用一个带 url 的候选验证它直接早退 —— 开关关着，url 再合法也不该被碰。
const { collectStickersFromTurn } = await import("../server/utils/sticker-collect");
let touched = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  touched = true;
  throw new Error("不该发起的请求");
};
await collectStickersFromTurn(
  [{ url: "https://example.com/a.png" }],
  {
    characterId: "00000000-0000-4000-8000-00000000dead",
    modelConfig: {},
    chatModel: "test",
    chatApiBaseUrl: "https://example.com/v1",
    chatApiKey: "sk-test",
  },
);
assert.equal(touched, false, "开关关着时不能下载、不能调模型。");
globalThis.fetch = originalFetch;

// ── collectSticker 端到端（mock 网络，不碰真实公网）────────────────────────
// mock fetch：第一次是 downloadImage 的图（返回 PNG 字节），第二次是视觉模型打标（返回 JSON）。
// downloadImage 会在重定向后对 response.url 再做公网校验；undici 的 Response.url 只读，
// 这里用 defineProperty 把它钉成公网地址，避免空 url 被当成内网拦掉。
const { collectSticker } = await import("../server/utils/sticker-collect");
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let callCount = 0;
globalThis.fetch = async (input: RequestInfo | URL) => {
  callCount += 1;
  const url = String(input);
  if (url.includes("example.com/sticker")) {
    // 下载图
    const response = new Response(pngBytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response as Response;
  }
  // 视觉模型打标
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ name: "偷来的图", usage: "群友斗图时" }) } }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  }), { status: 200, headers: { "content-type": "application/json" } }) as Response;
};

// 需要一个开了视觉模型配置 + 开了自动收图的 context。
// characterId 必须是库里真实存在的角色（外键约束），从库里取第一个。
const { getPrisma } = await import("../server/utils/prisma");
const prisma = getPrisma();
const anyCharacter = await prisma.character.findFirst({ select: { id: true } });
if (!anyCharacter) {
  // 没有角色也能跑开关那一半的断言，但端到端这段跳过。
  console.log("（无角色，跳过落库端到端）偷表情包（sticker-collect）：开关部分通过");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

const context = {
  characterId: anyCharacter.id,
  modelConfig: { stickerAutoCollect: true, imageUnderstanding: true },
  chatModel: "test-model",
  chatApiBaseUrl: "https://api.openai.com/v1",
  chatApiKey: "sk-test",
};

const created = await collectSticker(
  { url: "https://example.com/sticker.png", summary: "一只猫" },
  context,
);
assert.ok(created, "图能下载、打标、落库。");
assert.equal(created.name, "偷来的图");
assert.equal(created.usage, "群友斗图时");
assert.equal(created.source, "collected");
assert.equal(callCount, 2, "先下载一次，再打标一次。");

// 同一张图再收一次：contentHash 相同，去重返回 null（不再多花一次下载/打标）。
const before = callCount;
const dup = await collectSticker(
  { url: "https://example.com/sticker.png", summary: "一只猫" },
  context,
);
assert.equal(dup, null, "同一张图不重复偷。");
assert.equal(callCount, before + 1, "去重只多一次下载，不调打标。");

// ── 起不出名字的图不收 ────────────────────────────────────────────────
// 名字是模型挑图的唯一依据。以前打标失败会用「收藏的表情」兜底存下来，
// 结果库里全是既没场景、也没名字线索的废图，占着名额又永远挑不中。
const rowsBefore = await prisma.characterSticker.count({ where: { characterId: context.characterId } });
// 每张图用不同字节：内容相同会比 contentHash 去重掉，测出来的「没收」就不是因为打标失败。
const pngA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const pngB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const pngC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5]);
let labelReply = "";
globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("sticker-a.png") || url.includes("sticker-b.png") || url.includes("sticker-c.png")) {
    const bytes = url.includes("sticker-a") ? pngA : url.includes("sticker-b") ? pngB : pngC;
    const response = new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response as Response;
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: labelReply } }],
  }), { status: 200, headers: { "content-type": "application/json" } }) as Response;
};

// a) 模型偷懒，名字直接回「表情包」这种没信息量的词。
labelReply = JSON.stringify({ name: "表情包", usage: "" });
assert.equal(
  await collectSticker({ url: "https://example.com/sticker-a.png" }, context),
  null,
  "名字是「表情包」这种废话时不该收。",
);

// b) 模型回的不是 JSON（或干脆失败）：同样不收。
labelReply = "抱歉，我看不清这张图";
assert.equal(
  await collectSticker({ url: "https://example.com/sticker-b.png" }, context),
  null,
  "打标失败不该落库。",
);
assert.equal(
  await prisma.characterSticker.count({ where: { characterId: context.characterId } }),
  rowsBefore,
  "两张都没收：库里不该多出「收藏的表情」这种废图。",
);

// c) 模型判定「这不是表情包」：别人的聊天截图、长截图、随手拍的照片都属于这一类。
// 这类图收进来只会占名额（提示词里模型根本判断不出什么时候该用它）。
labelReply = JSON.stringify({ skip: true });
assert.equal(
  await collectSticker({ url: "https://example.com/sticker-c.png" }, context),
  null,
  "模型说「这不是表情包」时不该收。",
);
assert.equal(
  await prisma.characterSticker.count({ where: { characterId: context.characterId } }),
  rowsBefore,
  "截图类的图不该落库。",
);

// 清理落盘的文件（避免污染仓库 .data）。
const { stickerFilePath } = await import("../server/utils/stickers");
try {
  const row = await prisma.characterSticker.findFirst({ where: { id: created.id } });
  if (row) {
    await prisma.characterSticker.delete({ where: { id: created.id } });
    const fp = stickerFilePath(context.characterId, row.fileName);
    if (fp) await fs.rm(fp, { force: true });
  }
} catch {
  // 清理失败不影响测试结论
}
try { await prisma.$disconnect(); } catch { /* ignore */ }

globalThis.fetch = originalFetch;

console.log("偷表情包（sticker-collect）：全部通过");
