import assert from "node:assert/strict";
import {
  ONEBOT_FACES,
  onebotFaceName,
  readOnebotFaceIds,
  toOnebotFaceSegments,
} from "../server/utils/channel-adapter/onebot/faces";
import { readOnebotMessageText } from "../server/utils/channel-adapter/onebot/types";

// ── 清单本身 ────────────────────────────────────────────────
assert(ONEBOT_FACES.length >= 20, "表情清单太少，模型没得挑。");
assert.equal(new Set(ONEBOT_FACES.map((face) => face.id)).size, ONEBOT_FACES.length, "id 不能重复。");
assert(ONEBOT_FACES.every((face) => /^\d+$/.test(face.id)), "face id 必须是纯数字。");
assert(ONEBOT_FACES.every((face) => face.name.length > 0), "每个表情都要有中文名。");
// 菜刀 / 骷髅 / 炸弹 在 QQ 的 face 表里确实存在，但模型分不清玩笑与真发火。
for (const risky of ["55", "37", "59", "56"]) {
  assert(!ONEBOT_FACES.some((face) => face.id === risky), `攻击性表情 ${risky} 不该进清单。`);
}

// ── 入站：id → 中文名 ───────────────────────────────────────
assert.equal(onebotFaceName("6"), "害羞", "字符串 id 要能解析。");
assert.equal(onebotFaceName(6), "害羞", "数字 id 也要能解析 —— 各家网关类型不一致。");
assert.equal(onebotFaceName(" 6 "), "害羞", "带空白要 trim。");
assert.equal(onebotFaceName("9999"), "", "清单外的 id 返回空串，由调用方退回通用占位符。");
assert.equal(onebotFaceName(null), "", "缺字段不能抛错。");

// ── 入站：整条消息 ──────────────────────────────────────────
const segmentMessage = (segments: Array<{ type: string; data?: Record<string, unknown> }>) =>
  readOnebotMessageText({ message: segments });

assert.equal(segmentMessage([{ type: "face", data: { id: "6" } }]), "[害羞]", "入站表情要出中文名。");
assert.equal(segmentMessage([{ type: "face", data: { id: 6 } }]), "[害羞]", "数字 id 同样处理。");
assert.equal(segmentMessage([{ type: "face", data: {} }]), "[表情]", "没有 id 时退回通用占位符。");
assert.equal(segmentMessage([{ type: "face", data: { id: "9999" } }]), "[表情]", "清单外退回通用占位符。");
assert.equal(
  segmentMessage([{ type: "text", data: { text: "你干嘛" } }, { type: "face", data: { id: "22" } }]),
  "你干嘛[白眼]",
  "文字与表情要按原顺序拼起来。",
);
assert.equal(
  segmentMessage([{ type: "mface", data: { summary: "[赚到了]" } }]),
  "[赚到了]",
  "商城表情包用 summary。",
);
assert.equal(segmentMessage([{ type: "mface", data: {} }]), "[表情包]", "没有 summary 时给通用占位。");
assert.equal(
  segmentMessage([{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text: " 在吗" } }]),
  "@10001 在吗",
  "at 段不受影响。",
);

// ── 出站：模型返回的 id 要校验 ──────────────────────────────
assert.deepEqual(readOnebotFaceIds(["6"]), ["6"], "清单内 id 放行。");
assert.deepEqual(readOnebotFaceIds([6]), ["6"], "数字 id 归一成字符串。");
assert.deepEqual(readOnebotFaceIds(["9999"]), [], "编造的 id 必须丢掉，否则网关会回 retcode 报错。");
assert.deepEqual(readOnebotFaceIds(["6", "6"]), ["6"], "重复只留一个。");
assert.deepEqual(readOnebotFaceIds(["6", "12"]), ["6"], "默认最多一个 —— 一次贴三张是在刷屏。");
assert.deepEqual(readOnebotFaceIds(["6", "12"], 2), ["6", "12"], "max 可控。");
assert.deepEqual(readOnebotFaceIds(["6", "9999", "12"]), ["6"], "非法值跳过而不是整批丢弃。");
assert.deepEqual(readOnebotFaceIds("6"), [], "不是数组就当没给。");
assert.deepEqual(readOnebotFaceIds(undefined), [], "缺字段当没给。");
assert.deepEqual(readOnebotFaceIds([null, {}, 6]), ["6"], "夹带垃圾值也要挑出合法的。");

// ── 出站：段结构 ────────────────────────────────────────────
const segments = toOnebotFaceSegments(["6", "12"]);
assert.deepEqual(segments, [
  { type: "face", data: { id: "6" } },
  { type: "face", data: { id: "12" } },
], "段结构要符合 OneBot v11：type + data.id。");
assert.deepEqual(toOnebotFaceSegments([]), [], "没表情就别产生空段数组。");

console.log("OneBot 表情测试通过：入站解析、出站校验、段结构。");
