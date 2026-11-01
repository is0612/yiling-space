import assert from "node:assert/strict";
import { md5FromEmojiId, readQqCustomFaces, type QqCustomFace } from "../server/utils/qq-custom-face";
import {
  MAX_IMPORT_PER_RUN,
  MAX_NAME_SYNC_PER_RUN,
  MAX_PUSH_PER_RUN,
  UNTITLED_STICKER_NAME,
  planStickerSync,
  uniqueStickerName,
  type SyncLocalRow,
} from "../server/utils/qq-sticker-sync";

/**
 * 纯函数回归：对账逻辑和返回体解析。
 *
 * 只测能纯算的部分 —— 这些恰恰是最容易出错、也最不该靠真机去试的：
 * 「一张图被误判成 QQ 删了」会把本地标签扫进回收站，「同一张被导两遍」会撞唯一约束。
 * 真的连 QQ 的那部分（下载、上传、删）在 `yarn probe:custom-face` 里验过接口形状。
 */

const md5 = (n: number) => n.toString(16).padStart(32, "0");
const emojiIdOf = (n: number) => `10001_0_0_0_${md5(n)}_0_0`;

function faceOf(n: number, desc = ""): QqCustomFace {
  const emojiId = emojiIdOf(n);
  return { emojiId, md5: md5FromEmojiId(emojiId), url: `https://p.qpic.cn/x/${emojiId}`, desc };
}

function rowOf(patch: Partial<SyncLocalRow> & { id: string }): SyncLocalRow {
  return {
    name: "委屈",
    qqEmojiId: null,
    qqMd5: null,
    deletedAt: null,
    deletedReason: null,
    enabled: true,
    ...patch,
  };
}

/* ---------- emoji_id 解析 ---------- */

assert.equal(md5FromEmojiId(emojiIdOf(7)), md5(7), "emoji_id 第 5 段就是 md5");
assert.equal(md5FromEmojiId("10001_0_0_0_ABCDEF0123456789ABCDEF0123456789_0_0"), "abcdef0123456789abcdef0123456789", "大写统一转小写");
assert.equal(md5FromEmojiId("随便一串"), "", "认不出来返回空串，调用方退回只按 id 匹配");
assert.equal(md5FromEmojiId(""), "", "空串不抛错");
assert.equal(md5FromEmojiId("10001_0_0_0_notamd5_0_0"), "", "第 5 段不是 32 位 hex 就放弃");

/* ---------- 列表解析 ---------- */

const parsed = readQqCustomFaces({
  data: [
    { emoji_id: "a_0_0_0_" + md5(1) + "_0_0", url: "https://p.qpic.cn/1", md5: md5(1), desc: "委屈" },
    // resId 是 SnowLuma 原样返回的驼峰字段，不能当 url 用；
    { emoji_id: "b_0_0_0_" + md5(2) + "_0_0", resId: "https://p.qpic.cn/2", URL: "https://p.qpic.cn/2b" },
    { emoji_id: "c_0_0_0_" + md5(3) + "_0_0" },                          // 没有 url，导不下来
    { url: "https://p.qpic.cn/4" },                                       // 没有 emoji_id，删不掉
    { emoji_id: "a_0_0_0_" + md5(1) + "_0_0", url: "https://p.qpic.cn/dup" }, // 重复
  ],
});
assert.equal(parsed.length, 2, "缺 url / 缺 id / 重复的条目都要丢掉");
assert.equal(parsed[0]!.desc, "委屈", "desc 认出来了");
assert.equal(parsed[1]!.url, "https://p.qpic.cn/2b", "URL 大写别名也认");
assert.equal(parsed[1]!.md5, md5(2), "返回里没带 md5 时从 emoji_id 拆出来");

assert.deepEqual(readQqCustomFaces({ data: [] }), [], "空收藏夹");
assert.deepEqual(readQqCustomFaces(null), [], "返回体为 null 不该抛错");
// 有些实现把数组包在 data 下面一层对象里。
assert.equal(readQqCustomFaces({ data: { list: [{ emoji_id: "x_1", url: "u" }] } }).length, 1);

/* ---------- 名字去重 ---------- */

assert.equal(uniqueStickerName("委屈", new Set()), "委屈");
assert.equal(uniqueStickerName("", new Set()), UNTITLED_STICKER_NAME, "空备注用占位名");
assert.equal(uniqueStickerName("  ", new Set()), UNTITLED_STICKER_NAME);
assert.equal(uniqueStickerName("委屈", new Set(["委屈"])), "委屈 2", "撞名补序号，别几十张全叫一个名");
assert.equal(uniqueStickerName("委屈", new Set(["委屈", "委屈 2"])), "委屈 3");
assert.equal(uniqueStickerName("x".repeat(80), new Set()).length, 60, "名字截到 60，超了页面会撑破");

/* ---------- 对账：什么都不用做 ---------- */

{
  const plan = planStickerSync({ local: [], faces: [] });
  assert.deepEqual(plan.importFaces, []);
  assert.deepEqual(plan.push, []);
  assert.deepEqual(plan.trashLocal, []);
}

{
  // 两边都有、id 一致 → 静默。这是最常见的稳态，不该每次同步都报一堆动作。
  const plan = planStickerSync({
    local: [rowOf({ id: "s1", qqEmojiId: emojiIdOf(1), qqMd5: md5(1), name: "委屈" })],
    faces: [faceOf(1, "委屈")],
  });
  assert.deepEqual(plan.importFaces, []);
  assert.deepEqual(plan.push, []);
  assert.deepEqual(plan.trashLocal, []);
  assert.deepEqual(plan.syncName, [], "备注和名字一样就不用写");
}

/* ---------- 对账：只有 QQ 有 → 导下来 ---------- */

{
  const plan = planStickerSync({ local: [], faces: [faceOf(1), faceOf(2)] });
  assert.equal(plan.importFaces.length, 2);
  assert.equal(plan.importOverflow, 0);
}

{
  const plan = planStickerSync({
    local: [],
    faces: [faceOf(1), faceOf(2), faceOf(3)],
    importLimit: 2,
  });
  assert.equal(plan.importFaces.length, 2, "限额挡住多的");
  assert.equal(plan.importOverflow, 1, "挡住的要报出来，否则用户以为导完了");
}

/* ---------- 对账：只有本地有 → 推上去 ---------- */

{
  const plan = planStickerSync({ local: [rowOf({ id: "s1" }), rowOf({ id: "s2", name: "得意" })], faces: [] });
  assert.deepEqual(plan.push.map((item) => item.id), ["s1", "s2"]);
}

{
  // 停用的不推：停用是「暂时别用」，不是「也别收藏」。
  const plan = planStickerSync({ local: [rowOf({ id: "s1", enabled: false })], faces: [] });
  assert.deepEqual(plan.push, []);
}

{
  const plan = planStickerSync({ local: [rowOf({ id: "s1" }), rowOf({ id: "s2" })], faces: [], pushLimit: 1 });
  assert.equal(plan.push.length, 1);
  assert.equal(plan.pushOverflow, 1);
}

/* ---------- 对账：QQ 里 id 变了但图没变 → 只回填，不重导 ---------- */

{
  // 场景：在 QQ 里删掉又加回同一张图。emoji_id 换了，md5 不变。
  // 按 id 对不上，如果就地当成「QQ 新增」+「本地失效」，本地打好的标签会被一张「新图」顶掉。
  const plan = planStickerSync({
    local: [rowOf({ id: "s1", qqEmojiId: emojiIdOf(1), qqMd5: md5(1), name: "委屈" })],
    faces: [faceOf(2)],
  });
  // 这里 md5 也变了（真的是另一张图），所以应当按「QQ 删了」处理。
  assert.deepEqual(plan.trashLocal.map((item) => item.id), ["s1"]);

  const sameContent = planStickerSync({
    local: [rowOf({ id: "s1", qqEmojiId: "10001_0_0_0_" + md5(9) + "_0_0", qqMd5: md5(1), name: "委屈" })],
    faces: [faceOf(1)],
  });
  assert.deepEqual(sameContent.rebind, [{ id: "s1", emojiId: emojiIdOf(1), md5: md5(1) }]);
  assert.deepEqual(sameContent.trashLocal, [], "认出来了就不该进回收站");
  assert.deepEqual(sameContent.importFaces, [], "更不能当新图再导一份");
}

/* ---------- 对账：QQ 那边删了 → 本地进回收站 ---------- */

{
  const plan = planStickerSync({
    local: [rowOf({ id: "s1", qqEmojiId: emojiIdOf(1), qqMd5: md5(1) })],
    faces: [],
  });
  assert.deepEqual(plan.trashLocal.map((item) => item.id), ["s1"]);
}

/* ---------- 对账：删除的方向 ---------- */

{
  // 本地删过（deletedReason=local），QQ 还留着 → 补删，且绝不重新导回来。
  const plan = planStickerSync({
    local: [
      rowOf({
        id: "s1",
        qqEmojiId: emojiIdOf(1),
        qqMd5: md5(1),
        deletedAt: new Date(),
        deletedReason: "local",
        enabled: false,
      }),
    ],
    faces: [faceOf(1)],
  });
  assert.deepEqual(plan.retryDelete, [emojiIdOf(1)]);
  assert.deepEqual(plan.restoreFromTrash, []);
  assert.deepEqual(plan.importFaces, [], "这张还在回收站里，不能再导一份（会撞唯一约束）");
}

{
  // QQ 那边先删的（deletedReason=qq），现在又出现了 → 恢复，标签还在。
  const plan = planStickerSync({
    local: [
      rowOf({
        id: "s1",
        qqEmojiId: emojiIdOf(1),
        qqMd5: md5(1),
        deletedAt: new Date(),
        deletedReason: "qq",
        enabled: false,
      }),
    ],
    faces: [faceOf(1)],
  });
  assert.deepEqual(plan.restoreFromTrash, [{ id: "s1" }]);
  assert.deepEqual(plan.retryDelete, [], "用户自己加回来的，不该反过来删掉");
  assert.deepEqual(plan.importFaces, []);
}

{
  // 回收站里的那张 QQ 里也没有了 → 什么都不做（等着过期清掉）。
  const plan = planStickerSync({
    local: [rowOf({ id: "s1", qqEmojiId: emojiIdOf(1), deletedAt: new Date(), deletedReason: "qq" })],
    faces: [],
  });
  assert.deepEqual(plan.retryDelete, []);
  assert.deepEqual(plan.restoreFromTrash, []);
  assert.deepEqual(plan.trashLocal, [], "已经删过了，不该重复计数");
}

/* ---------- 对账：名字回写 ---------- */

{
  const plan = planStickerSync({
    local: [rowOf({ id: "s1", qqEmojiId: emojiIdOf(1), qqMd5: md5(1), name: "委屈" })],
    faces: [faceOf(1, "旧名字")],
  });
  assert.deepEqual(plan.syncName, [{ emojiId: emojiIdOf(1), name: "委屈", previous: "旧名字" }]);
}

{
  // QQ 没备注、本地是占位名 → 不比写，否则会把「未命名表情」写进 QQ。
  const plan = planStickerSync({
    local: [rowOf({ id: "s1", qqEmojiId: emojiIdOf(1), qqMd5: md5(1), name: UNTITLED_STICKER_NAME })],
    faces: [faceOf(1)],
  });
  assert.deepEqual(plan.syncName, []);
}

{
  const plan = planStickerSync({
    local: Array.from({ length: MAX_NAME_SYNC_PER_RUN + 3 }, (_, index) =>
      rowOf({ id: `s${index}`, qqEmojiId: emojiIdOf(index + 1), qqMd5: md5(index + 1), name: "改名了" })),
    faces: Array.from({ length: MAX_NAME_SYNC_PER_RUN + 3 }, (_, index) => faceOf(index + 1, "旧名")),
  });
  assert.equal(plan.syncName.length, MAX_NAME_SYNC_PER_RUN, "回写备注要限量，不然一次同步卡半分钟");
}

/* ---------- 上限常量 ---------- */

assert.equal(MAX_IMPORT_PER_RUN, 60);
assert.equal(MAX_PUSH_PER_RUN, 30);
assert.equal(MAX_NAME_SYNC_PER_RUN, 20);

console.log("qq-sticker-sync: 全部通过");
