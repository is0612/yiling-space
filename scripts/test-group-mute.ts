/**
 * 静默档：判据、状态与闸门优先级。
 *
 * 只测纯函数与状态机，不连库 —— 群聊整条流水线的回归在 `test:onebot` 里。
 */

import assert from "node:assert/strict";
import { evaluateGroupChatGate, GROUP_CHAT_DEFAULTS, type GroupChatGateInput } from "../server/utils/channel-adapter/onebot/group-chat";
import {
  GROUP_MUTE_MS,
  createGroupMuteStore,
  isQuietRequest,
  isResumeRequest,
} from "../server/utils/channel-adapter/onebot/group-mute";

// —— 判据：哪些话算「让她闭嘴」 ——

for (const text of ["闭嘴", "@123 闭嘴", "先别说话", "别插嘴", "安静点", "消停点", "别接话了", "你不用出声"]) {
  assert.equal(isQuietRequest(text), true, `应当识别为静默请求：${text}`);
}
for (const text of [
  "别闭嘴", // 反向说法
  "他刚才让我闭嘴，笑死", // 转述 + 太长
  "闭嘴这个话题挺有意思的", // 只是在聊「闭嘴」这件事
  "", // 空
]) {
  assert.equal(isQuietRequest(text), false, `不该识别为静默请求：${text}`);
}

// 长度上限：真下命令的人不会写小作文
assert.equal(isQuietRequest("你能不能稍微先闭嘴一小会儿让我把这段话说完再说"), false);

for (const text of ["可以说了", "能开口了", "不用憋着了", "你可以出声了"]) {
  assert.equal(isResumeRequest(text), true, `应当识别为解除：${text}`);
}
for (const text of ["说吧", "这个可以说了算吗", ""]) {
  assert.equal(isResumeRequest(text), false, `不该识别为解除：${text}`);
}

// —— 状态：到期自动解除，重复触发顺延 ——

let clock = 1_000_000;
const store = createGroupMuteStore({ now: () => clock, muteMs: 60_000 });
const key = "binding-1:g:123";

assert.equal(store.isMuted(key), false, "初始不应静默");
store.mute(key);
assert.equal(store.isMuted(key), true, "触发后应静默");
assert.equal(store.remainingMs(key), 60_000);

clock += 30_000;
store.mute(key); // 重复触发顺延
assert.equal(store.remainingMs(key), 60_000, "重复触发应重置倒计时");

clock += 59_999;
assert.equal(store.isMuted(key), true, "未到期前一直静默");
clock += 1;
assert.equal(store.isMuted(key), false, "到期后自动解除");
assert.equal(store.remainingMs(key), 0);

store.mute(key);
store.unmute(key);
assert.equal(store.isMuted(key), false, "手动解除立即生效");

// 群之间互不影响
store.mute("a:g:1");
assert.equal(store.isMuted("a:g:2"), false, "别的群不该被连坐");

// —— 闸门：静默压过一切 ——

const base: GroupChatGateInput = {
  settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" },
  now: new Date("2026-11-06T12:00:00+08:00"),
  direct: true,
  named: true,
  topicCandidate: true,
  lastSpokeAt: null,
  spokenToday: 0,
  random: 0,
};

const muted = evaluateGroupChatGate({ ...base, muted: true });
assert.equal(muted.allowed, false, "静默时必须拦住");
assert.equal(muted.reason, "muted");
assert.equal(muted.mustReply, false, "静默时不允许「必须回」");

// 没有静默时，同样的输入应该放行 —— 证明拦下来的是静默，不是别的闸
const open = evaluateGroupChatGate({ ...base, muted: false });
assert.equal(open.allowed, true, "没有静默时应放行");
assert.equal(open.reason, "all_messages");

// all 档 + @ 别人：原来就有这条早退，静默顺手也压得住
const quietAll = evaluateGroupChatGate({
  ...base,
  settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" },
  direct: true,
  named: false,
  topicCandidate: false,
  addressedToOthers: true,
  muted: true,
});
assert.equal(quietAll.allowed, false);
assert.equal(quietAll.reason, "muted", "静默优先于 addressed_to_others");

// 默认时长常量别被手滑改小
assert.equal(GROUP_MUTE_MS, 10 * 60 * 1000);

console.log("✔ 静默档：判据、状态与闸门优先级全部通过");
