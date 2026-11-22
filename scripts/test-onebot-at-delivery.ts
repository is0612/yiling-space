import { buildWav, type VoiceTtsSettings } from "../server/utils/voice";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createReplySender } from "../server/utils/channel-adapter/onebot/serve";
import { resetGroupAtCooldown } from "../server/utils/channel-adapter/onebot/at-cooldown";
import type { ChannelReplyDelivery } from "../server/utils/channel-adapter/pipeline";
import { callOnebotAction, sendOnebotPrivateMessage, type OnebotOutgoingMessage } from "../server/utils/channel-adapter/onebot/client";

// All identifiers are synthetic. Only this ephemeral loopback gateway receives requests.
const calls: Array<{ group_id: number; message: OnebotOutgoingMessage }> = [];
let failOnCall = -1;
let responseOverride: string | undefined;
let disconnect = false;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  assert.ok(["/send_group_msg", "/send_private_msg", "/get_msg"].includes(req.url || ""));
  assert.equal(req.method, "POST");
  calls.push(JSON.parse(body));
  if (disconnect) { req.socket.destroy(); return; }
  res.setHeader("content-type", "application/json");
  res.end(responseOverride ?? JSON.stringify(calls.length === failOnCall
    ? { status: "failed", retcode: 1400, wording: "offline fixture failure" }
    : { status: "ok", retcode: 0, data: { message_id: calls.length } }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const config = { wsUrl: "", httpUrl: `http://127.0.0.1:${address.port}` };
const target = { messageType: "group" as const, groupId: "123456789", userId: "10000001", tempGroupId: "" };
const recipient = "10000002";
const sender = (selfQq = "10000003") => createReplySender(config, target, {
  selfQq,
  resolveAtQq: () => recipient,
});
const types = (index: number) => {
  const message = calls[index]!.message;
  return typeof message === "string" ? ["text"] : message.map(segment => segment.type);
};
function reset() {
  resetGroupAtCooldown();
  calls.length = 0;
  failOnCall = -1;
  responseOverride = undefined;
  disconnect = false;
}
function assertSent(delivery: void | ChannelReplyDelivery) {
  assert.equal(delivery?.at?.status, "sent");
  assert.equal(delivery?.at?.targetQq, recipient);
  assert.ok(delivery?.at?.sentAt && Number.isFinite(Date.parse(delivery.at.sentAt)));
}
try {
  reset();
  assertSent(await sender()("first", { atMessageId: "101" }));
  const suppressed = await sender()("second", { atMessageId: "102" });
  assert.equal(suppressed?.at?.status, "suppressed");
  assert.equal(suppressed?.at?.reason, "cooldown");
  assert.equal(suppressed?.at?.requestedMessageId, "102");
  assert.equal(suppressed?.at?.sentAt, undefined);
  assert.deepEqual(types(0), ["at", "text"]);
  assert.deepEqual(types(1), ["text"]);
  assert.equal(calls[0]!.group_id, Number(target.groupId));
  const firstMessage = calls[0]!.message;
  assert.ok(Array.isArray(firstMessage));
  assert.deepEqual(firstMessage[0]!.data, { qq: recipient });

  // A different sending account does not consume this sender's allowance.
  assertSent(await sender("10000004")("other sender", { atMessageId: "103" }));
  assert.deepEqual(types(2), ["at", "text"]);

  reset();
  failOnCall = 1;
  const failedReports: ChannelReplyDelivery[] = [];
  await assert.rejects(sender()("failed", {
    atMessageId: "104", onDelivery: async (delivery) => { failedReports.push(delivery); },
  }), /ONEBOT_SEND_1400/);
  assert.equal(failedReports.length, 1);
  assert.equal(failedReports[0]?.at?.status, "suppressed", "failed sends cannot report successful delivery");
  assert.equal(failedReports[0]?.at?.reason, "send_failed");
  failOnCall = -1;
  assertSent(await sender()("retry", { atMessageId: "104" }));
  assert.deepEqual(types(1), ["at", "text"], "failed attempt must release its reservation");

  for (const unknownResponse of ["not JSON", "{}", "null", '{"retcode":"0"}', '{"retcode":"1400"}', '{"retcode":0,"status":"failed"}']) {
    reset();
    responseOverride = unknownResponse;
    const reports: ChannelReplyDelivery[] = [];
    await assert.rejects(sender()("unconfirmed", {
      atMessageId: "109", onDelivery: async delivery => { reports.push(structuredClone(delivery)); },
    }), /ONEBOT_SEND_UNCONFIRMED/);
    assert.equal(calls.length, 1, "unknown group outcome must not trigger a retry");
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.at?.status, "unknown");
    assert.equal(reports[0]?.at?.reason, "unconfirmed");
    assert.ok(reports[0]?.at?.attemptedAt);
    assert.equal(reports[0]?.at?.sentAt, undefined);
    responseOverride = undefined;
    const afterUnknown = await sender()("explicit next attempt", { atMessageId: "109" });
    assert.equal(afterUnknown?.at?.reason, "cooldown");
    assert.deepEqual(types(1), ["text"], "unknown attempt conservatively reserves cooldown");

    responseOverride = unknownResponse;
    const beforePrivate = calls.length;
    await assert.rejects(sendOnebotPrivateMessage(config, "10000001", "private", target.groupId), /ONEBOT_SEND_UNCONFIRMED/);
    assert.equal(calls.length, beforePrivate + 1, "unknown temporary-private outcome must not fall back and duplicate");
  }
  reset();
  disconnect = true;
  const networkReports: ChannelReplyDelivery[] = [];
  await assert.rejects(sender()("network loss", { atMessageId: "network", onDelivery: async d => { networkReports.push(structuredClone(d)); } }));
  assert.equal(calls.length, 1);
  assert.equal(networkReports[0]?.at?.status, "unknown");
  await assert.rejects(sendOnebotPrivateMessage(config, "10000001", "network private", target.groupId));
  assert.equal(calls.length, 2, "network result cannot trigger temporary-private fallback");
  disconnect = false;
  assert.equal((await sender()("next", { atMessageId: "network" }))?.at?.reason, "cooldown");

  reset();
  responseOverride = "{}";
  const quoteFailureReports: ChannelReplyDelivery[] = [];
  await assert.rejects(sender()("quoted unknown", { replyToMessageId: "105", atMessageId: "106",
    onDelivery: async delivery => { quoteFailureReports.push(structuredClone(delivery)); },
  }), /ONEBOT_SEND_UNCONFIRMED/);
  assert.equal(quoteFailureReports[0]?.at?.status, "suppressed", "no at segment was attempted even when text outcome is unknown");
  assert.equal(quoteFailureReports[0]?.at?.reason, "quote");
  responseOverride = undefined;
  assertSent(await sender()("unquoted retry", { atMessageId: "106" }));

  // Fake TTS audio; no real provider, model, or database calls.
  const realFetch = globalThis.fetch;
  const voiceSettings: VoiceTtsSettings = { provider: "openai", model: "mock", voice: "mock", apiBaseUrl: "https://tts.invalid/v1", apiKey: "mock", groupId: "", instructions: "", language: "zh", speed: 1 };
  globalThis.fetch = async (url, init) => String(url).startsWith("https://tts.invalid/")
    ? new Response(buildWav(Buffer.alloc(4800), 24000), { headers: { "content-type": "audio/wav" } }) : realFetch(url, init);
  try {
    reset();
    disconnect = true;
    await assert.rejects(sender()("语音", { voice: true, voiceSettings }));
    assert.equal(calls.length, 1, "unknown voice outcome must not resend base64 or text");
    assert.deepEqual(types(0), ["record"]);
    reset();
    responseOverride = "{}";
    await assert.rejects(sender()("语音", { voice: true, voiceSettings }), /ONEBOT_SEND_UNCONFIRMED/);
    assert.equal(calls.length, 1, "unconfirmed voice receipt must not resend");
    reset();
    await assert.rejects(sender()("语音", { voice: true, voiceSettings, onDelivery: async () => { throw new Error("metadata fixture failure"); } }), /metadata fixture failure/);
    assert.equal(calls.length, 1, "post-send persistence failure must not resend voice or text");
  } finally { globalThis.fetch = realFetch; }
  reset();
  responseOverride = "not JSON";
  assert.equal(await callOnebotAction(config, "get_msg", {}), undefined, "other API actions retain existing response behavior");
  responseOverride = '{"retcode":0}';
  assertSent(await sender()("status optional", { atMessageId: "110" }));

  reset();
  const quoted = await sender()("quoted", { replyToMessageId: "105", atMessageId: "106" });
  assert.equal(quoted?.at?.status, "suppressed");
  assert.equal(quoted?.at?.reason, "quote");
  assert.deepEqual(types(0), ["reply", "text"]);
  assertSent(await sender()("unquoted", { atMessageId: "106" }));
  assert.deepEqual(types(1), ["at", "text"], "suppressed quote must not start cooldown");

  reset();
  failOnCall = 2;
  const delivered: ChannelReplyDelivery[] = [];
  const segmented = await sender()("first\nsecond\nthird", {
    atMessageId: "107", segments: ["first", "second", "third"],
    onDelivery: async delivery => {
      assert.equal(calls.length, 1, "persist sent metadata before attempting later segments");
      delivered.push(structuredClone(delivery));
    },
  });
  assertSent(segmented);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], segmented, "later failure must preserve actual sent metadata");
  assert.equal(calls.length, 2, "stop after the failed later segment");
  assert.deepEqual(types(0), ["at", "text"]);
  assert.equal(calls[1]!.message, "second", "later segments carry no at or reply segments");
  failOnCall = -1;
  const afterPartial = await sender()("next round", { atMessageId: "108" });
  assert.equal(afterPartial?.at?.reason, "cooldown", "successful first segment retains cooldown");
  assert.deepEqual(types(2), ["text"]);
} finally {
  resetGroupAtCooldown();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log("OneBot @ delivery: all passed (local HTTP mock; no QQ, model, or database calls).");
