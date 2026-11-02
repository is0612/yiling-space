import assert from "node:assert/strict";
import {
  QZONE_CONFIRM_COMMENT,
  QZONE_CONFIRM_POST,
  assertQzoneOk,
  buildQzoneCredential,
  computeQzoneGtk,
  isQzoneApprove,
  isQzoneConfirm,
  isQzoneReject,
  isUnsupportedAction,
  parseQzoneBrowseRequest,
  parseQzoneCommentRequest,
  parseQzoneCookieString,
  parseQzoneJsonp,
  parseQzoneMoodList,
  parseQzonePostRequest,
  formatQzoneTime,
  sanitizeQzoneText,
  stripQzoneHtml,
} from "../server/utils/channel-adapter/onebot/qzone";
import {
  evaluateQzoneAutoGate,
  isQzoneAutoAskTime,
  parseQzoneAutoAsk,
} from "../server/utils/channel-adapter/onebot/qzone-proactive";
import { readClockMinutes } from "../server/utils/proactive-settings";

/**
 * 空间模块的纯函数回归。全部离线，不连协议端、不碰数据库。
 * 这些是「改一行就可能静默发错东西」的地方，所以每一条都单独钉住。
 */

// ── g_tk ────────────────────────────────────────────────────
// 用 BigInt 独立实现一遍做参照：主实现每一步都 & 0x7fffffff，容易被误改成只截最后一次，
// 那样长 cookie 会算出另一个值，接口只回 -3000，人还以为是登录态问题。
function referenceGtk(skey: string): number {
  let hash = 5381n;
  for (const char of skey) hash += (hash << 5n) + BigInt(char.codePointAt(0)!);
  return Number(hash & 0x7fffffffn);
}

for (const sample of [
  "abc",
  "p_skey",
  "@aBcDeFg1234567890abcdefghijklmnop",
  "x".repeat(200),
  "中文也要能算",
]) {
  const actual = computeQzoneGtk(sample);
  assert.equal(actual, referenceGtk(sample), `g_tk 与参照实现不一致：${sample.slice(0, 12)}`);
  assert(actual >= 0 && actual <= 0x7fffffff, "g_tk 必须落在 31 位正整数范围内。");
}
assert.equal(computeQzoneGtk(""), 5381, "空串应该退回初始值 5381，而不是 0。");

// ── cookie ─────────────────────────────────────────────────
const pairs = parseQzoneCookieString("uin=o0123456; p_skey=ABC123; skey=XYZ; path=/");
assert.equal(pairs.uin, "o0123456");
assert.equal(pairs.p_skey, "ABC123");
assert.equal(parseQzoneCookieString("broken=;=nokey; ok=1").ok, "1", "空 key 要丢掉，正常项要留下。");
assert.deepEqual(parseQzoneCookieString(""), {}, "空 cookie 不能抛错。");

const credential = buildQzoneCredential("uin=o0123456; p_skey=ABC123");
assert(credential, "有 uin + p_skey 就应该解析成功。");
assert.equal(credential!.uin, "0123456", "uin 的 o 前缀必须去掉 —— 接口只认纯数字。");
assert.equal(credential!.gtk, computeQzoneGtk("ABC123"), "g_tk 必须来自 p_skey。");

assert.equal(buildQzoneCredential("uin=0123456"), null, "没有 p_skey 就没有 g_tk。");
assert.equal(buildQzoneCredential("p_skey=ABC"), null, "没有 uin 不知道是谁。");
assert.equal(
  buildQzoneCredential("skey=ONLY", "0123456")?.gtk,
  computeQzoneGtk("ONLY"),
  "只有 skey 时退化用它，总比直接放弃强。",
);

// ── JSONP ──────────────────────────────────────────────────
assert.deepEqual(parseQzoneJsonp('_Callback({"code":0,"data":{"tid":"abc"}});'), { code: 0, data: { tid: "abc" } });
assert.deepEqual(parseQzoneJsonp('{"code":0}'), { code: 0 }, "纯 JSON 也要能解析。");
assert.equal(parseQzoneJsonp(""), null);
assert.equal(parseQzoneJsonp("<html>登录页</html>"), null, "302 到登录页时不能当成 JSON。");

// ── 业务码 ─────────────────────────────────────────────────
assert.doesNotThrow(() => assertQzoneOk({ code: 0 }, "测试"));
assert.doesNotThrow(() => assertQzoneOk({ code: "0" }, "测试"), "字符串 0 也是成功。");
assert.doesNotThrow(() => assertQzoneOk({ ret: 0, tid: "x" }, "测试"), "有些接口用 ret。");
assert.throws(() => assertQzoneOk({ code: -3000 }, "测试"), /QZONE_API_-3000/u, "未登录必须抛，不能静默。");
assert.throws(() => assertQzoneOk(null, "测试"), /QZONE_BAD_RESPONSE/u);

// ── HTML 清洗与动态解析 ─────────────────────────────────────
assert.equal(stripQzoneHtml("<b>你好</b>&nbsp;&amp;再见"), "你好 &再见");
assert.equal(stripQzoneHtml('看图<img src="a.jpg"/>'), "看图[图片]", "图片要留占位，否则「配了图」这件事消失。");

// 说说列表（emotion_cgi_msglist_v6）：干净 JSON，字段就是实测拿到的那些。
const moodPayload = {
  code: 0,
  msglist: [
    { tid: "tid-a", uin: 123456, name: "小鱼", content: "今天下雨了，想起你说喜欢雨。", created_time: 1793252184, secret: 0 },
    { tid: "tid-b", uin: "778899", name: "阿澈", content: "新买的键盘到了 &amp; 手感不错", created_time: 1793250000, secret: 0 },
    { tid: "tid-a", uin: 123456, name: "小鱼", content: "同一条说说的重复项", secret: 0 },
    { uin: 123456, name: "没 tid 的脏数据", content: "不该出现" },
    { tid: "tid-c", uin: 123456, name: "小鱼", content: "私密说说", secret: 1 },
  ],
};
const moods = parseQzoneMoodList(moodPayload, "123456");
assert.equal(moods.length, 2, "重复 tid 去重、没 tid 丢弃、私密说说过滤。");
assert.equal(moods[0]!.tid, "tid-a");
assert.equal(moods[0]!.uin, "123456");
assert.equal(moods[0]!.nickname, "小鱼");
assert.equal(moods[0]!.excerpt, "今天下雨了，想起你说喜欢雨。");
assert(moods[0]!.time.length > 0, "时间要变成人话，不能是时间戳。");
assert.equal(moods[1]!.uin, "778899", "uin 是字符串也要能认。");
assert.equal(moods[1]!.excerpt, "新买的键盘到了 & 手感不错", "实体要解码。");
assert.deepEqual(parseQzoneMoodList(null), [], "空输入返回空数组，不抛。");
assert.deepEqual(parseQzoneMoodList({ code: -3000 }), [], "没有 msglist 就返回空，绝不瞎猜。");
assert.equal(
  parseQzoneMoodList({ data: { msglist: [{ tid: "t", uin: 1, content: "x" }] } }, "10001")[0]?.uin,
  "10001",
  "缺 uin 时用查询时的目标号兜底。",
);

// 时间格式化
const now = 1_793_252_184_000;
assert.equal(formatQzoneTime(0), "", "没有时间就留空，不编。");
assert.equal(formatQzoneTime(1_793_252_184, now), "刚刚");
assert.equal(formatQzoneTime(1_793_252_184 - 300, now), "5 分钟前");
assert.equal(formatQzoneTime(1_793_252_184 - 3_600 * 3, now), "3 小时前");
assert.equal(formatQzoneTime(1_793_252_184 - 86_400 * 2, now), "2 天前");

// ── 指令解析：发说说 ───────────────────────────────────────
assert.deepEqual(parseQzonePostRequest("发条说说：今天下雨了"), { topic: "今天下雨了" });
assert.deepEqual(parseQzonePostRequest("发个空间说说"), { topic: "" });
assert.deepEqual(parseQzonePostRequest("写一条说说：加班到十点"), { topic: "加班到十点" });
assert.deepEqual(parseQzonePostRequest("说说：懒得动"), { topic: "懒得动" });
assert.equal(parseQzonePostRequest("这条说说真好看"), null, "没动作、没冒号的闲聊不能触发。");
assert.equal(parseQzonePostRequest("群里发的说说谁看到了"), null);
assert.equal(parseQzonePostRequest(QZONE_CONFIRM_POST), null, "确认词本身不能被当成新指令。");

// ── 指令解析：看动态 ───────────────────────────────────────
assert.equal(parseQzoneBrowseRequest("看看空间")?.targetUin, "", "不带号 = 看名单/好友列表。");
assert.equal(parseQzoneBrowseRequest("去空间逛逛")?.targetUin, "");
assert.equal(parseQzoneBrowseRequest("空间动态呢")?.targetUin, "");
assert.equal(parseQzoneBrowseRequest("看看 123456 的空间")?.targetUin, "123456", "带 QQ 号就只看那个人。");
assert.equal(parseQzoneBrowseRequest("翻翻123456的空间")?.targetUin, "123456");
assert.equal(parseQzoneBrowseRequest("空间站什么时候发射"), null, "别把「空间站」当成空间。");
assert.equal(parseQzoneBrowseRequest(""), null, "空消息不触发。");

// ── 指令解析：评论 ─────────────────────────────────────────
assert.deepEqual(parseQzoneCommentRequest("评论第 2 条：好可爱"), { index: 2, body: "好可爱" });
assert.deepEqual(parseQzoneCommentRequest("评论第2条好可爱"), { index: 2, body: "好可爱" });
assert.deepEqual(parseQzoneCommentRequest("评论 3 这句我不同意"), { index: 3, body: "这句我不同意" });
assert.deepEqual(parseQzoneCommentRequest("评论第 1 条"), { index: 1, body: "" }, "只给序号 = 让她自己写。");
assert.equal(parseQzoneCommentRequest("评论"), null, "没序号没内容，没听懂，不能猜。");
assert.equal(parseQzoneCommentRequest("评论家都是骗子"), null);
assert.equal(parseQzoneCommentRequest(QZONE_CONFIRM_COMMENT), null);

// ── 确认词 ─────────────────────────────────────────────────
assert(isQzoneConfirm("确认发说说", "POST"));
assert(isQzoneConfirm("确认发说说。", "POST"), "句末标点要能容错。");
assert(isQzoneConfirm("@123456 确认发说说", "POST"), "顺手 @ 一下不算内容。");
assert(!isQzoneConfirm("确认", "POST"), "裸「确认」不能触发 —— 太容易误碰。");
assert(!isQzoneConfirm("确认发布", "POST"), "「确认发布」是群公告的词，不能串台。");
assert(!isQzoneConfirm(QZONE_CONFIRM_COMMENT, "POST"), "两种确认词必须互斥。");
assert(isQzoneConfirm("确认评论", "COMMENT"));
assert(!isQzoneConfirm(QZONE_CONFIRM_POST, "COMMENT"));

// ── 降级判定 ───────────────────────────────────────────────
assert(isUnsupportedAction(new Error("ONEBOT_SEND_HTTP_404: 发送 OneBot 消息失败。")), "404 = 动作不存在，可以降级。");
assert(isUnsupportedAction(new Error("ONEBOT_SEND_1404: 发送 OneBot 消息失败（unknown action）。")));
assert(!isUnsupportedAction(new Error("ONEBOT_SEND_-100: 发送 OneBot 消息失败（风控）")), "风控不是「不支持」，不能降级重试。");
assert(!isUnsupportedAction(new Error("QZONE_API_-3000: 未登录")), "登录失效更要停手。");

// ── 正文清洗 ───────────────────────────────────────────────
assert.equal(sanitizeQzoneText("```\n今天好累\n```", 100), "今天好累");
assert.equal(sanitizeQzoneText("说说：今天好累", 100), "今天好累");
assert.equal(sanitizeQzoneText("“今天好累”", 100), "今天好累");
assert.equal(sanitizeQzoneText("a".repeat(50), 10).length, 10, "超长要按上限截断。");

// ── 口语审批 ───────────────────────────────────────────────
for (const yes of ["行", "可以", "好", "嗯", "ok", "OK", "发吧", "发", "评吧", "同意", "准了", "没问题", "行！"]) {
  assert(isQzoneApprove(yes), `「${yes}」应该算同意。`);
}
for (const no of ["不行", "不好", "不要", "别", "算了", "不", "否", "拒绝", "别发", "不用", "不了"]) {
  assert(isQzoneReject(no), `「${no}」应该算拒绝。`);
}
assert(!isQzoneApprove("行不行"), "带疑问的不算同意。");
assert(!isQzoneApprove("好的，但是改一下"), "长句不算同意，防止误判。");
assert(!isQzoneApprove("看看空间"), "普通指令不算同意。");
assert(!isQzoneReject("不好说"), "模糊词不算拒绝。");
// 精确确认词不能和口语审批互相误吃
assert(!isQzoneApprove("确认发说说"), "精确确认词不该被「行」这类短词误判。");
assert(!isQzoneReject("确认发说说"));

// ── 空间主动闸门 ───────────────────────────────────────────
const autoBase = { qzoneEnabled: true, qzoneAutoAskEnabled: true, ownerQq: "12345", hasBinding: true };
assert(evaluateQzoneAutoGate(autoBase).allowed);
assert.equal(evaluateQzoneAutoGate({ ...autoBase, qzoneEnabled: false }).reason, "qzone_disabled");
assert.equal(evaluateQzoneAutoGate({ ...autoBase, qzoneAutoAskEnabled: false }).reason, "auto_ask_disabled");
assert.equal(evaluateQzoneAutoGate({ ...autoBase, ownerQq: "" }).reason, "no_owner");
assert.equal(evaluateQzoneAutoGate({ ...autoBase, hasBinding: false }).reason, "no_binding");

// ── 空间主动意图解析 ───────────────────────────────────────
assert.deepEqual(parseQzoneAutoAsk({ action: "post", content: "今天下雨了" }), { action: "post", content: "今天下雨了" });
assert.deepEqual(parseQzoneAutoAsk({ action: "comment", index: 2, content: "好可爱" }), { action: "comment", index: 2, content: "好可爱" });
assert.deepEqual(parseQzoneAutoAsk({ action: "none" }), { action: "none" });
assert.deepEqual(parseQzoneAutoAsk({ action: "post", content: "" }), { action: "none" }, "空正文退回 none。");
assert.deepEqual(parseQzoneAutoAsk({ action: "comment", index: 0, content: "x" }), { action: "none" }, "序号非法退回 none。");
assert.deepEqual(parseQzoneAutoAsk({ action: "comment", index: 1, content: "" }), { action: "none" });
assert.deepEqual(parseQzoneAutoAsk(null), { action: "none" });
assert.deepEqual(parseQzoneAutoAsk({ action: "garbage" }), { action: "none" }, "未知 action 退回 none。");

// ── 主动问时间点 ───────────────────────────────────────────
assert.equal(readClockMinutes("12:00"), 720);
assert.equal(readClockMinutes("0:30"), 30);
assert.equal(readClockMinutes("7:5"), 425, "宽容接受 7:5（与 proactive-settings 一致）。");
assert.equal(readClockMinutes("25:00"), null);

// 到点判定：容差 5 分钟窗口内算到点。
const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 2, h - 8, m)); // 构造东八区 h:m
assert(isQzoneAutoAskTime(at(12, 0), ["12:00"]), "整点到点。");
assert(isQzoneAutoAskTime(at(12, 4), ["12:00"]), "到点后 4 分钟还在容差内。");
assert(!isQzoneAutoAskTime(at(12, 6), ["12:00"]), "超过容差就错过这次。");
assert(!isQzoneAutoAskTime(at(11, 59), ["12:00"]), "到点前不算。");
assert(isQzoneAutoAskTime(at(18, 2), ["12:00", "18:00"]), "多个时间点命中第二个。");
assert(!isQzoneAutoAskTime(at(9, 0), []), "没设时间点永远不到点。");

console.log("qzone 纯函数回归通过：g_tk / cookie / JSONP / 说说列表解析 / 时间格式化 / 指令 / 确认词 / 口语审批 / 主动意图 / 时间点 / 清洗");
