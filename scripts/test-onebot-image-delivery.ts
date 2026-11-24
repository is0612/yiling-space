import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createReplySender } from "../server/utils/channel-adapter/onebot/serve";
import type { OnebotOutgoingMessage } from "../server/utils/channel-adapter/onebot/client";
import { readSentImageFlag, type GeneratedImage } from "../server/utils/image-generation";
import type { ChannelReplyDelivery } from "../server/utils/channel-adapter/pipeline";

// Synthetic image and ephemeral loopback gateway; no model, database or real QQ calls.
const calls: Array<{ action: string; user_id: number; group_id?: number; message: OnebotOutgoingMessage }> = [];
let textResponse: "ok" | "failed" | "unknown" = "ok";
let imageResponse: "ok" | "failed" | "unknown" = "ok";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  assert.equal(request.url, "/send_private_msg");
  calls.push({ ...JSON.parse(body), action: request.url });
  response.setHeader("content-type", "application/json");
  const current = calls.at(-1)!.message;
  const isImage = Array.isArray(current) && current.some(segment => segment.type === "image");
  if (current === "second" && textResponse === "unknown") response.end("{}");
  else if (current === "second" && textResponse === "failed") response.end(JSON.stringify({ status: "failed", retcode: 1400 }));
  else if (isImage && imageResponse === "unknown") response.end("{}");
  else if (isImage && imageResponse === "failed") response.end(JSON.stringify({ status: "failed", retcode: 1400 }));
  else response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: calls.length } }));
});
const directory = await mkdtemp(join(tmpdir(), "onebot-image-delivery-"));
try {
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer();
  const filePath = join(directory, "fixture.png");
  await writeFile(filePath, buffer);
  const image: GeneratedImage = { filePath, relativePath: "images/fixture/fixture.png", mime: "image/png", width: 2, height: 2, bytes: buffer.length };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const config = { wsUrl: "", httpUrl: `http://127.0.0.1:${address.port}` };
  for (const tempGroupId of ["", "123456789"]) {
    calls.length = 0;
    const sender = createReplySender(config, { messageType: "private", userId: "10000001", groupId: "", tempGroupId });
    let reported = 0;
    const results: ChannelReplyDelivery[] = [];
    const delivered = await sender("here is the drawing", { image, replyToMessageId: "101", atMessageId: "102", onDelivery: async result => {
      reported++;
      results.push(structuredClone(result));
      assert.equal(calls.length, reported, "report text first, then confirmed image");
    } });
    assert.equal(calls.length, 2, "a generated picture must produce text plus a separate image message");
    assert.equal(reported, 2, "delivery callback must report text and image separately");
    assert.equal(results[0]?.image, undefined);
    assert.equal(results[1]?.image?.status, "sent");
    assert.equal(delivered?.image?.status, "sent");
    assert.ok(delivered?.image?.sentAt);
    assert.equal(delivered?.image?.externalMessageId, "2", "asset receipt must be the image, never the preceding text");
    assert.equal(readSentImageFlag({ image: { path: image.relativePath }, replyDelivery: delivered }), true);
    for (const call of calls) {
      assert.equal(call.user_id, 10000001);
      assert.equal(call.group_id, tempGroupId ? Number(tempGroupId) : undefined, "temporary-session group survives both sends");
    }
    assert(Array.isArray(calls[0]!.message));
    assert.deepEqual(calls[0]!.message.map(segment => segment.type), ["reply", "text"]);
    const picture = calls[1]!.message;
    assert(Array.isArray(picture));
    assert.deepEqual(picture.map(segment => segment.type), ["image"], "picture must not carry reply, at or duplicate text");
    assert.equal(picture[0]?.data.file, `base64://${buffer.toString("base64")}`);
  }
  calls.length = 0;
  const segmented = createReplySender(config, { messageType: "private", userId: "10000001", groupId: "", tempGroupId: "123456789" });
  const segmentedDelivery = await segmented("first\nsecond", { image, segments: ["first", "second"], replyToMessageId: "103" });
  assert.equal(segmentedDelivery?.image?.externalMessageId, "3", "segmented text ids must not replace the image id");
  assert.equal(calls.length, 3);
  assert(Array.isArray(calls[0]!.message));
  assert.deepEqual(calls[0]!.message.map(segment => segment.type), ["reply", "text"]);
  assert.equal(calls[1]!.message, "second");
  assert(Array.isArray(calls[2]!.message));
  assert.deepEqual(calls[2]!.message.map(segment => segment.type), ["image"]);
  assert(calls.every(call => call.group_id === 123456789));

  const outcomeSender = createReplySender(config, { messageType: "private", userId: "10000001", groupId: "", tempGroupId: "" });
  for (const outcome of ["failed", "unknown"] as const) {
    calls.length = 0;
    textResponse = outcome;
    const reported: ChannelReplyDelivery[] = [];
    const delivered = await outcomeSender("first\nsecond\nthird", {
      image, segments: ["first", "second", "third"],
      onDelivery: async result => { reported.push(structuredClone(result)); },
    });
    assert.equal(calls.length, 3, "stop remaining text after failure, but still send the already generated image once");
    assert.equal(calls[1]!.message, "second");
    const picture = calls[2]!.message;
    assert(Array.isArray(picture));
    assert.deepEqual(picture.map(segment => segment.type), ["image"]);
    assert.equal(delivered?.image?.status, "sent");
    assert.equal(delivered?.image?.externalMessageId, "3");
    assert.equal(reported.at(-1)?.image?.status, "sent", "persist image receipt even when later text failed");
  }
  textResponse = "ok";
  for (const outcome of ["failed", "unknown"] as const) {
    calls.length = 0;
    imageResponse = outcome;
    const reported: ChannelReplyDelivery[] = [];
    const delivered = await outcomeSender("image outcome", { image, onDelivery: async result => { reported.push(structuredClone(result)); } });
    assert.equal(calls.length, 2, "failed or unknown image send must not duplicate text or image");
    assert.equal(delivered?.image?.status, outcome);
    assert.equal(delivered?.image?.sentAt, undefined);
    assert.equal(reported.at(-1)?.image?.status, outcome);
    assert.equal(readSentImageFlag({ image: { path: image.relativePath }, replyDelivery: delivered }), false);
  }
  calls.length = 0;
  imageResponse = "failed";
  const tempRejected = await segmented("temporary rejection", { image });
  assert.equal(calls.length, 3, "explicit temporary rejection permits one existing plain-private fallback");
  assert.equal(tempRejected?.image?.status, "failed", "two confirmed rejections are not an unknown outcome");
  calls.length = 0;
  imageResponse = "unknown";
  const tempUnknown = await segmented("temporary unknown", { image });
  assert.equal(calls.length, 2, "unknown temporary outcome must not fallback");
  assert.equal(tempUnknown?.image?.status, "unknown");
  imageResponse = "ok";
  calls.length = 0;
  const unreadable = await segmented("missing file", { image: { ...image, filePath: join(directory, "missing.png") } });
  assert.equal(calls.length, 1);
  assert.deepEqual(unreadable?.image, { status: "failed", reason: "read_failed" });

  // Factory tests cannot see a handler wrapper that drops its second argument. Guard the
  // actual wiring as well: command callbacks may ignore the return value, not the options.
  const source = await readFile(new URL("../server/utils/channel-adapter/onebot/serve.ts", import.meta.url), "utf8");
  assert.match(source, /const sendReply = createReplySender\(record\.config, event\);/u,
    "private handler must use the full sender directly; a text-only wrapper drops image/voice/segments/callback options");
  console.log("OneBot image delivery: private/temp text plus separate PNG, segment options, callback and handler wiring passed (local mock only).");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // mkdtemp owns this exact resolved directory; never remove application media.
  await rm(directory, { recursive: true, force: true });
}
