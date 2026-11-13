import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolveOnebotPrivateQuote, type OnebotResolvedEvent } from "../server/utils/channel-adapter/onebot/client";
import { readOnebotReplyToId } from "../server/utils/channel-adapter/onebot/types";

let calls = 0;
let payload: unknown;
let failure = false;
const server = createServer(async (req, res) => {
  calls++;
  assert.equal(req.url, "/get_msg");
  let body = "";
  for await (const part of req) body += part;
  assert.equal(JSON.parse(body).message_id, "-123");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(failure ? { retcode: 1404 } : { retcode: 0, data: payload }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const config = { wsUrl: "", httpUrl: `http://127.0.0.1:${address.port}` };
const event: OnebotResolvedEvent = {
  messageType: "private", data: { message: [{ type: "reply", data: { id: -123 } }, { type: "text", data: { text: "这一句不对" } }] },
  messageId: "1", userId: "111", selfId: "222", groupId: "", tempGroupId: "", conversationKey: "c:111", displayName: "", content: "这一句不对", images: [], voices: [], senderRole: "member",
};
const unresolved = { messageId: "-123" };
const own = { message_id: -123, message_type: "private", sender: { user_id: 222 }, user_id: 222, target_id: 111, message: [{ type: "text", data: { text: "第一条原文" } }] };
try {
  assert.equal(readOnebotReplyToId({ message: "[CQ:reply,id=-123]正文" }), "-123");
  assert.equal(readOnebotReplyToId(event.data), "-123");
  assert.equal(await resolveOnebotPrivateQuote(config, { ...event, messageType: "group" }), undefined);
  assert.equal(await resolveOnebotPrivateQuote(config, { ...event, data: { message: "无引用" } }), undefined);
  assert.equal(calls, 0, "无引用或群聊不能回查");
  payload = own;
  assert.deepEqual(await resolveOnebotPrivateQuote(config, event), { messageId: "-123", content: "第一条原文", isSelf: true });
  payload = { ...own, message: "第二条原文" };
  assert.equal((await resolveOnebotPrivateQuote(config, event))?.content, "第二条原文", "按 get_msg 单条原文，不拼整轮回复");
  payload = { ...own, target_id: undefined, user_id: 111 };
  assert.equal((await resolveOnebotPrivateQuote(config, event))?.isSelf, true);
  payload = { ...own, sender: { user_id: 111 }, user_id: 111, target_id: 222 };
  assert.equal((await resolveOnebotPrivateQuote(config, event))?.isSelf, false);
  for (const bad of [
    { ...own, target_id: 333 },
    { ...own, target_id: undefined },
    { ...own, user_id: 333 },
    { ...own, sender: { user_id: 333 } },
    { ...own, message_type: "group" },
    { ...own, message_id: -456 },
    { ...own, sender: { user_id: 111 }, user_id: 111, target_id: 333 },
    { message_type: "private", message: "缺身份" },
    null,
  ]) {
    payload = bad;
    assert.deepEqual(await resolveOnebotPrivateQuote(config, event), unresolved, "无法证明同私聊不能带原文");
  }
  payload = { ...own, message: "长".repeat(2200) };
  const long = (await resolveOnebotPrivateQuote(config, event))?.content;
  assert.ok(long && long.length <= 2000 && long.endsWith("[引用原文已截断]"));
  failure = true;
  assert.deepEqual(await resolveOnebotPrivateQuote(config, event), unresolved);
  failure = false;
  payload = own;
  assert.deepEqual(await resolveOnebotPrivateQuote(config, { ...event, selfId: "" }), unresolved);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
assert.deepEqual(await resolveOnebotPrivateQuote(config, event), unresolved, "网络失败保留引用 id");
console.log("OneBot 私聊入站引用：全部通过（本地 mock HTTP，无真实 QQ 请求）");
