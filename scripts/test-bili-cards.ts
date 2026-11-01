import "dotenv/config";
import assert from "node:assert/strict";
import {
  extractBvids,
  formatWatchedForModel,
  isFatalBiliError,
  parseVerdict,
  parseVideoCards,
  parseWatchedVideo,
  parseBiliOwner,
  parseBiliMe,
  parseScore,
  readAuthor,
  readBiliError,
  sanitizePublicText,
} from "../server/utils/channel-adapter/bili/cards";
import { parseJsonLoose } from "../server/utils/loose-json";

/** 一条 feed 卡片的真实结构（author 是对象，不是字符串）。 */
function feedCard(overrides: Record<string, unknown> = {}) {
  return {
    bvid: "BV1xx411c7mD",
    title: "标题",
    author: { mid: 12345, name: "某个UP" },
    duration: 754,
    pubdate: "2026-10-26T12:00:00+08:00",
    stat: { view: 12000, like: 300, danmaku: 45, reply: 20 },
    reason: "你常看这个分区",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    ...overrides,
  };
}

async function main() {
  // ---- 1. readAuthor：这次 bug 的核心 ----
  // 老实现 `typeof author === "string"` 遇上对象就返回 ""，于是「UP：」后面永远是空的
  assert.deepEqual(readAuthor({ mid: 12345, name: "某个UP" }), { mid: "12345", name: "某个UP" });
  assert.deepEqual(readAuthor("纯字符串UP"), { mid: "", name: "纯字符串UP" });
  assert.deepEqual(readAuthor({ uname: "别名UP" }), { mid: "", name: "别名UP" });
  assert.deepEqual(readAuthor({ up_name: "下划线UP" }), { mid: "", name: "下划线UP" });
  assert.deepEqual(readAuthor({ author: { name: "嵌套UP" } }), { mid: "", name: "嵌套UP" });
  assert.deepEqual(readAuthor({ mid: 7, name: "  带空格  " }), { mid: "7", name: "带空格" });
  assert.deepEqual(readAuthor(null), { mid: "", name: "" });
  assert.deepEqual(readAuthor(undefined), { mid: "", name: "" });
  assert.deepEqual(readAuthor(42), { mid: "", name: "" });

  // ---- 2. parseVideoCards：feed / search / 裸数组 ----
  const feed = parseVideoCards({ page: 1, personalized: true, items: [feedCard()] });
  assert.equal(feed.length, 1);
  assert.equal(feed[0]!.author.name, "某个UP", "feed 卡片的 UP 名不能再丢");
  assert.equal(feed[0]!.author.mid, "12345");
  assert.equal(feed[0]!.stat.view, 12000);
  assert.equal(feed[0]!.reason, "你常看这个分区");

  // 搜索结果把 play / favorites 平铺在顶层，没有 stat 对象
  const search = parseVideoCards({
    keyword: "x",
    items: [{ bvid: "BV1yy411c7mD", title: "搜索结果", author: { mid: 9, name: "搜索UP" }, play: 888, favorites: 12, duration: "05:00" }],
  });
  assert.equal(search.length, 1);
  assert.equal(search[0]!.author.name, "搜索UP");
  assert.equal(search[0]!.stat.view, 888);
  assert.equal(search[0]!.stat.favorite, 12);
  assert.equal(search[0]!.duration, 300);

  // 裸数组 / list 字段
  assert.equal(parseVideoCards([feedCard()]).length, 1);
  assert.equal(parseVideoCards({ list: [feedCard()] }).length, 1);
  // 没有 bvid 的项丢掉，不要造出空卡片
  assert.equal(parseVideoCards({ items: [{ title: "无 BV" }, feedCard()] }).length, 1);
  // 空输入不炸
  assert.deepEqual(parseVideoCards(null), []);
  assert.deepEqual(parseVideoCards({}), []);

  // ---- 3. parseWatchedVideo：watch 用 owner 而不是 author ----
  const watched = parseWatchedVideo({
    bvid: "BV1zz411c7mD",
    title: "看懂的视频",
    desc: "简介正文",
    owner: { mid: 555, name: "watch的UP" },
    duration: 600,
    stat: { view: 1, like: 2, danmaku: 3, reply: 4 },
    tags: ["标签A", "标签B"],
    chapters: [{ from: 0, to: 60, title: "开场" }],
    ai_summary: "官方总结",
    transcript: { source: "subtitle:zh-CN", text: "字幕全文" },
    hot_comments: [{ user: "热评用户", content: "热评内容", like: 9 }],
    danmaku: { total: 10, peaks: [{ time: 3, time_str: "00:03", count: 5, top: ["弹幕A"] }] },
    frames_sheet: "/tmp/sheet.jpg",
  });
  assert.ok(watched);
  assert.equal(watched!.author.name, "watch的UP", "watch 的 owner.name 要认");
  assert.equal(watched!.aiSummary, "官方总结");
  assert.equal(watched!.transcriptText, "字幕全文");
  assert.equal(watched!.tags.length, 2);
  assert.equal(watched!.hotComments[0]!.user, "热评用户");
  assert.equal(watched!.danmakuPeaks[0]!.timeStr, "00:03");
  assert.equal(parseWatchedVideo({ title: "没有 bvid" }), null);

  // 给模型看的材料要带上 UP 名
  const material = formatWatchedForModel(watched!);
  assert.match(material, /UP：watch的UP/);
  assert.match(material, /字幕全文/);
  assert.match(material, /热评用户/);

  // ---- 4. parseVerdict：否定必须先判 ----
  // 老实现 reply.includes("值得") 会把「不值得」判成挑中
  assert.equal(parseVerdict("值得").worth, true);
  assert.equal(parseVerdict("不值得").worth, false, "「不值得」不能判成值得");
  assert.equal(parseVerdict("不值得，标题党").worth, false);
  assert.equal(parseVerdict("跳过。理由：标题党，不值得看").worth, false);
  assert.equal(parseVerdict("判断：跳过\n理由：内容很空").worth, false);
  assert.equal(parseVerdict("判断：值得\n理由：有实测数据").worth, true);
  assert.equal(parseVerdict("判断：值得\n理由：这不太值得错过").worth, true, "先出现「值得」就算值得");
  assert.equal(parseVerdict("").worth, false);
  assert.equal(parseVerdict("随便说说").worth, false, "判不出来就保守跳过");

  // ---- 5. parseJsonLoose / extractBvids ----
  assert.deepEqual(parseJsonLoose('```json\n["BV1xx411c7mD"]\n```'), ["BV1xx411c7mD"]);
  assert.deepEqual(parseJsonLoose('我挑了两条：["BV1xx411c7mD","BV1yy411c7mD"] 就这些'), ["BV1xx411c7mD", "BV1yy411c7mD"]);
  assert.deepEqual(parseJsonLoose('{"worth":true}'), { worth: true });
  assert.equal(parseJsonLoose("没有 JSON"), null);
  assert.equal(parseJsonLoose(""), null);
  // 要对象时括号顺序要跟着变：默认「数组优先」会在这种带废话的文本里切出 faces 那个数组，
  // 解出来是 `[3]`，调用方 `asRecord` 一过就变成 null —— 明明能救回来的对象反而判死。
  assert.deepEqual(
    parseJsonLoose('好的，这是结果：{"reply":"嗯","faces":[3]}', { expect: "object" }),
    { reply: "嗯", faces: [3] },
    "expect: object 要切整个对象，不能被正文里的数组带偏",
  );
  assert.deepEqual(
    parseJsonLoose('前言 ["BV1xx411c7mD"] 后话'),
    ["BV1xx411c7mD"],
    "不传 expect 时仍按数组优先，B 站那几处调用点行为不变",
  );
  assert.deepEqual(extractBvids("看 BV1xx411c7mD 和 BV1yy411c7mD，还有 BV1xx411c7mD"), ["BV1xx411c7mD", "BV1yy411c7mD"]);

  // ---- 6. 错误结构 ----
  const authError = readBiliError({ ok: false, error: { code: "auth_expired", message: "登录凭证已失效。" } });
  assert.equal(authError?.code, "auth_expired");
  assert.equal(readBiliError({ ok: true, data: {} }), null);
  assert.equal(isFatalBiliError("risk_control"), true);
  assert.equal(isFatalBiliError("captcha_required"), true);
  assert.equal(isFatalBiliError("auth_expired"), true);
  assert.equal(isFatalBiliError("rate_limited"), false);
  assert.equal(isFatalBiliError("invalid_argument"), false);

  // owner show 的真实返回：mid 是数字，别被当成字符串读丢
  assert.deepEqual(parseBiliOwner({ ok: true, data: { owner: { mid: 10000007, name: "示例UP主" } } }), {
    mid: "10000007",
    name: "示例UP主",
  });
  // 没设过主人：CLI 可能回 owner: null，不能造空壳
  assert.equal(parseBiliOwner({ ok: true, data: { owner: null } }), null);
  assert.equal(parseBiliOwner({ ok: false, error: { code: "not_logged_in" } }), null);
  assert.equal(parseBiliOwner(null), null);

  // me show 的真实返回：头像 / 主页地址 / 等级都要读出来
  assert.deepEqual(
    parseBiliMe({
      ok: true,
      data: {
        mid: 3747573877706483,
        name: "北海大肥鱼",
        sign: "无可奈何花落去",
        level: 2,
        face: "https://i2.hdslb.com/bfs/face/abc.jpg",
        url: "https://space.bilibili.com/3747573877706483",
      },
    }),
    {
      mid: "3747573877706483",
      name: "北海大肥鱼",
      face: "https://i2.hdslb.com/bfs/face/abc.jpg",
      level: 2,
      sign: "无可奈何花落去",
      homeUrl: "https://space.bilibili.com/3747573877706483",
    },
  );
  // 协议相对的头像地址要补 https，否则浏览器当本地路径
  assert.equal(parseBiliMe({ ok: true, data: { mid: 1, face: "//i0.hdslb.com/x.jpg" } })?.face, "https://i0.hdslb.com/x.jpg");
  // CLI 没给 url 就按 mid 拼主页
  assert.equal(parseBiliMe({ ok: true, data: { mid: 7, name: "阿七" } })?.homeUrl, "https://space.bilibili.com/7");
  // 兼容包一层 profile 的形状
  assert.equal(parseBiliMe({ ok: true, data: { profile: { mid: 9, name: "九" } } })?.name, "九");
  // 没登录 / 空数据：返回 null，不能造空壳
  assert.equal(parseBiliMe({ ok: false, error: { code: "not_logged_in" } }), null);
  assert.equal(parseBiliMe({ ok: true, data: {} }), null);
  assert.equal(parseBiliMe(null), null);

  // ---- 7. 打分 ----
  assert.equal(parseScore("判断：值得\n分数：16\n理由：有实测数据"), 16);
  assert.equal(parseScore("判断：跳过\n分数: 8\n理由：标题党"), 8, "半角冒号也要认");
  assert.equal(parseScore("分数： 13 "), 13, "带空格要 trim");
  assert.equal(parseScore("分数：99"), 20, "越界夹到 20");
  assert.equal(parseScore("分数：-3"), null, "负数不是合法分（正则不认减号）");
  assert.equal(parseScore("判断：值得\n理由：好"), null, "没给分就是 null，不能当 0");
  assert.equal(parseScore("分数：很高"), null, "非数字当没给");
  assert.equal(parseScore(""), null);

  // ---- 8. 公开脱敏闸 ----
  assert.equal(sanitizePublicText("把实测数据全列了，省得自己试"), "把实测数据全列了，省得自己试", "正常理由不该被改");
  assert.equal(sanitizePublicText("这个讲得好 @示例UP主 说得对"), "这个讲得好 说得对", "@ 提及要去掉");
  assert.equal(sanitizePublicText("加我 QQ 10000007"), "加我 QQ", "长数字串（QQ 号 / UID）要去掉");
  assert.equal(
    sanitizePublicText("这条留给你看。主人应该会喜欢。"),
    "这条留给你看。",
    "提到主人的整句要丢掉，别的句子保留",
  );
  assert.equal(sanitizePublicText("只跟主人说，私信里聊"), "", "整段都是私密话时什么都不剩");
  assert.equal(sanitizePublicText(""), "");

  console.log("✅ test-bili-cards 全部通过");
  console.log("   author 四种形态（对象/字符串/别名/嵌套）：通过");
  console.log("   列表卡片解析（feed / search / 裸数组）：通过");
  console.log("   watch 解析（owner.name / 字幕 / 热评）：通过");
  console.log("   判词否定优先（「不值得」不再判成值得）：通过");
  console.log("   宽松 JSON / BV 提取 / 错误码：通过");
  console.log("   当前主人解析（mid 数字 / owner 为 null）：通过");
  console.log("   我的资料解析（头像 / 主页地址 / 没登录返回 null）：通过");
  console.log("   打分解析（0-20 / 缺省为 null / 越界夹住）：通过");
  console.log("   公开脱敏闸（@ / 长数字 / 私密句）：通过");
}

main().catch((error) => {
  console.error("❌ test-bili-cards 失败：", error);
  process.exit(1);
});
