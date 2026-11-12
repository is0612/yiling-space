import assert from "node:assert/strict";
import { MAX_REPLY_SEGMENTS, splitReplySegments } from "../server/utils/reply-segments";

/**
 * 分条发送的分段规则。
 *
 * 这些断言全是「线上会真的发生」的形态：模型换行排版、顺手多换两行、
 * 把三段写成三长段、只回一个字。任一条失守，QQ 里就是一堆没头没尾的碎片。
 */

// 没换行：一条消息，行为与以前完全一致。
assert.deepEqual(splitReplySegments("行啊，你说了算。"), ["行啊，你说了算。"]);
assert.deepEqual(splitReplySegments("  行啊。  "), ["行啊。"]);

// 空内容 / 只有空白：没有可发的段（调用方会走原来的发送路径）。
assert.deepEqual(splitReplySegments(""), []);
assert.deepEqual(splitReplySegments("   \n \n  "), []);

// 正常分条：两句话，各发一条。
assert.deepEqual(splitReplySegments("嗯。\n你也没睡。"), ["嗯。", "你也没睡。"]);
// CRLF 与多余空格都要吃掉：有的中转站会回 \r\n。
assert.deepEqual(splitReplySegments("嗯。\r\n  你也没睡。  "), ["嗯。", "你也没睡。"]);
// 连续空行不算一条空消息。
assert.deepEqual(splitReplySegments("嗯。\n\n\n你也没睡。"), ["嗯。", "你也没睡。"]);

// 上限 3 条，多出来的并回最后一条 —— 宁可最后一条长，不能少半句。
const four = splitReplySegments("一。\n二。\n三。\n四。");
assert.equal(four.length, MAX_REPLY_SEGMENTS);
assert.deepEqual(four, ["一。", "二。", "三。\n四。"]);
// 六条也一样，只并进尾段。
assert.deepEqual(splitReplySegments("1句\n2句\n3句\n4句\n5句\n6句"), ["1句", "2句", "3句\n4句\n5句\n6句"]);

/**
 * 排版式换行不许拆。
 *
 * 模型很爱用换行排版，拆开就是「一、」「二、」各自一条消息。这条判断必须在代码里，
 * 靠提示词求它别这么写是没用的（提示词只能降低概率，不能当护栏）。
 */
for (const layout of ["先说三件事：\n- 别熬夜\n- 别空腹\n- 别嘴硬", "步骤：\n1. 打开\n2. 关掉", "# 今天\n挺好"]) {
  assert.deepEqual(splitReplySegments(layout), [layout.replace(/\r\n?/gu, "\n").trim()], `排版换行不许拆：${layout}`);
}

/**
 * 有一条明显是长段落：说明她在写一整段、只是顺手换了行。
 * 拆出来会是「长的长、短的短」，比一整段更难读。
 */
const longPart = "这个事我其实想了挺久的，你上次说那句话的时候我就记住了，只是一直没找到合适的时候提，"
  + "而且我也怕说早了显得我太当真，所以一直压着没说。";
assert.ok(longPart.length > 60, "这条断言本身要够长，否则测不到长段落护栏。");
assert.deepEqual(splitReplySegments(`${longPart}\n嗯。`), [`${longPart}\n嗯。`]);

console.log("回复分条：全部通过");
