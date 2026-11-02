/**
 * 群聊「这一轮记成跟谁互动过」的判定（`pickFriendTargets`）。
 *
 * 起因（2026-11-02 复核「她的朋友」页面）：那段逻辑原来是「按引用 / @ 的 id 在本批里
 * 硬匹配，匹配不到就一条都不记」。她引用历史消息、或者引用了上一轮的尾巴时，id 在本批
 * 里根本不存在 —— 于是她明明回了人，关系行却停在几小时前，页面上看着像统计坏了。
 *
 * 现在：先按 id 找；找不到就退回本轮最新一条（她接的就是那句话）。
 */
import assert from "node:assert/strict";
import { pickFriendTargets } from "../server/utils/channel-adapter/pipeline";

const message = (externalMessageId: string, author: string) => ({
  externalMessageId,
  authorOpenId: author,
});

const batch = [message("m1", "A"), message("m2", "B"), message("m3", "C")];

// 引用本批中间那条：记谁被她引用。
assert.deepEqual(
  pickFriendTargets(batch, { replyToMessageId: "m2" }).map((item) => item.authorOpenId),
  ["B"],
  "引用了本批里的消息：记那条的作者。",
);

// 引用 + @ 命中两个不同的人：两个都算。
assert.deepEqual(
  pickFriendTargets(batch, { replyToMessageId: "m2", atMessageId: "m3" }).map((item) => item.authorOpenId),
  ["B", "C"],
  "引用和 @ 各指一个人时，两个人都记。",
);

// 什么都没给：退回本轮最新一条。
assert.deepEqual(
  pickFriendTargets(batch, {}).map((item) => item.authorOpenId),
  ["C"],
  "没有引用也没有 @：记本轮最新一条。",
);

/**
 * 这条是这次修的核心：引用的是本批之外的消息（历史消息 / 上一轮的尾巴）。
 * 以前这里返回空数组 → 整轮白记。
 */
assert.deepEqual(
  pickFriendTargets(batch, { replyToMessageId: "old-999" }).map((item) => item.authorOpenId),
  ["C"],
  "引用的消息不在本批：退回最新一条，不许整轮不记。",
);

// @ 的目标是别人、引用的是历史消息：同样退回最新一条，而不是一条不记。
assert.deepEqual(
  pickFriendTargets(batch, { replyToMessageId: "old-999", atMessageId: "old-888" }).map((item) => item.authorOpenId),
  ["C"],
  "引用和 @ 都指向本批之外：退回最新一条。",
);

// 空批次：什么都不记（没有作者可记，也不许造一个出来）。
assert.deepEqual(pickFriendTargets([], {}), [], "本轮没有消息：不记任何人。");

// 最新一条连 id 都没有：不猜。
assert.deepEqual(
  pickFriendTargets([{ externalMessageId: undefined, authorOpenId: "A" }], {}),
  [],
  "最新一条没有 externalMessageId：宁可不记，也不拿它当对象。",
);

console.log("通过：群聊互动的对象判定 —— 引用优先、找不到退回最新一条。");
