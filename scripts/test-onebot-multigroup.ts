/**
 * 多群号路由的纯逻辑测试。
 *
 * 群号输入从单值升级成 InputTag 多标签后，routingKey 存逗号分隔的多个群号。
 * 这里只测路由选绑定这件事：一个绑定挂多个群号时能不能精确命中；
 * 单群号老数据、留空默认绑定、去重与空值清理这些边界有没有被破坏。
 *
 * 不连数据库、不调模型 —— 跑一次几十毫秒。
 */

import assert from "node:assert/strict";
import {
  parseBindingRoutingKeys,
  routeOnebotEventToBinding,
} from "../server/utils/channel-adapter/onebot/serve";
import type { OnebotBindingRecord } from "../server/utils/channel-adapter/onebot/configure";
import { resolveOnebotEvent, type OnebotResolvedEvent } from "../server/utils/channel-adapter/onebot/client";

function binding(id: string, routingKey: string | null): OnebotBindingRecord {
  return {
    id,
    characterId: "c",
    characterName: "鱼",
    routingKey,
    replyWindowMinutes: 10,
    replyLimitPerWindow: 0,
    groupChat: {
      mode: "all",
      batchWindowSeconds: 5,
      mentionWindowSeconds: 10,
      minGapSeconds: 0,
      dailyMax: 0,
      quietStart: "",
      quietEnd: "",
      ambientChance: 0,
      aliases: [],
    },
    groupChatModes: {},
    replyOnlyWhenMentioned: false,
    groupBiliRunEnabled: false,
  };
}

function groupEvent(groupId: string): OnebotResolvedEvent {
  const event = resolveOnebotEvent({
    post_type: "message",
    message_type: "group",
    self_id: 10001,
    group_id: Number(groupId),
    user_id: 20001,
    message_id: 1,
    message: [{ type: "text", data: { text: "hi" } }],
  });
  assert.ok(event, "构造群聊事件失败。");
  return event;
}

function privateEvent(): OnebotResolvedEvent {
  const event = resolveOnebotEvent({
    post_type: "message",
    message_type: "private",
    self_id: 10001,
    user_id: 20001,
    message_id: 2,
    message: [{ type: "text", data: { text: "hi" } }],
  });
  assert.ok(event, "构造私聊事件失败。");
  return event;
}

// ── 1. 解析：逗号分隔、去重、去空 ─────────────────────
assert.deepEqual(parseBindingRoutingKeys("12345,67890"), ["12345", "67890"], "逗号分隔拆成数组。");
assert.deepEqual(parseBindingRoutingKeys(" 12345 , 67890 "), ["12345", "67890"], "前后空格被清掉。");
assert.deepEqual(parseBindingRoutingKeys("12345,12345,67890"), ["12345", "67890"], "重复群号只保留一个。");
assert.deepEqual(parseBindingRoutingKeys("12345,,67890,"), ["12345", "67890"], "空段被丢弃。");
assert.deepEqual(parseBindingRoutingKeys(null), [], "null 是空列表。");
assert.deepEqual(parseBindingRoutingKeys(""), [], "空串是空列表。");

// ── 2. 多群绑定：任一命中即选中 ─────────────────────
const multi = binding("b1", "111,222,333");
assert.equal(routeOnebotEventToBinding([multi], groupEvent("222"))?.id, "b1", "多群里第二个号命中。");
assert.equal(routeOnebotEventToBinding([multi], groupEvent("333"))?.id, "b1", "多群里第三个号命中。");
assert.equal(routeOnebotEventToBinding([multi], groupEvent("999")), null, "没在列表里的群不回退到多群绑定。");

// ── 3. 老数据单群号仍是单元素列表 ─────────────────────
const single = binding("b2", "111");
assert.deepEqual(parseBindingRoutingKeys("111"), ["111"], "老单群号数据兼容。");
assert.equal(routeOnebotEventToBinding([single], groupEvent("111"))?.id, "b2", "单群号精确命中。");

// ── 4. 多群命中优先于默认绑定 ────────────────────────
const def = binding("bDefault", null);
const mixed = [def, multi];
assert.equal(routeOnebotEventToBinding(mixed, groupEvent("222"))?.id, "b1", "多群精确命中压过默认绑定。");
assert.equal(routeOnebotEventToBinding([def], groupEvent("222"))?.id, "bDefault", "没有精确命中时用默认绑定。");

// ── 5. 私聊路由 ─────────────────────────────────────
assert.equal(routeOnebotEventToBinding(mixed, privateEvent())?.id, "bDefault", "私聊不看群号，走默认绑定。");

// 5b. 没有默认绑定、只有一条启用中的绑定 → 私聊仍然给她。
// 这是「填了群号，私聊就永久静默」那个 bug 的回归：群里能回、私聊不回，
// 从群聊侧完全看不出问题。
assert.equal(
  routeOnebotEventToBinding([multi], privateEvent())?.id,
  "b1",
  "没有默认绑定时，单条绑定要接住私聊。",
);
assert.equal(
  routeOnebotEventToBinding([binding("b3", "111"), binding("b4", "222")], privateEvent()),
  null,
  "多条绑定又没有默认绑定时不猜，宁可 no_binding —— 猜错人比不回更糟。",
);
assert.equal(
  routeOnebotEventToBinding([], privateEvent()),
  null,
  "没有任何绑定时私聊照旧不回。",
);

console.log("多群号路由测试全部通过。");
