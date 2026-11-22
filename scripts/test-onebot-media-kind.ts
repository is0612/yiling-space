import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { classifyOnebotImage, sanitizeMediaSummary } from "../server/utils/channel-adapter/onebot/media-kind";
import { readOnebotImages, readOnebotMedia, readOnebotMessageText } from "../server/utils/channel-adapter/onebot/types";
import { fillOnebotImageUrls } from "../server/utils/channel-adapter/onebot/client";

for (const subType of [undefined, 0, 1, 4, 5, 6, 7, 8, -1, NaN, Infinity, "1", null]) {
  for (const summary of [undefined, "[动画表情]", "表情", "[表情包]", "贴图", "[贴图", "贴图]", "普通照片"]) {
    for (const url of [undefined, "https://media.invalid/a.gif?rkey=secret"]) {
      const data = { message: [{ type: "image", data: { ...(subType === undefined ? {} : { sub_type: subType }), summary, url, file: "small.gif" } }] };
      const signal = readOnebotMedia(data)[0]!;
      const classified = classifyOnebotImage(signal);
      const stickerSummary = ["[动画表情]", "表情", "[表情包]", "贴图"].includes(summary ?? "");
      assert.equal(classified.kind, stickerSummary || subType === 1 ? "sticker" : subType === 0 ? "image" : "unknown");
      assert.equal(signal.subTypeState, subType === undefined ? "missing" : typeof subType === "number" && Number.isSafeInteger(subType) && subType >= 0 ? "valid" : "invalid");
      assert(!JSON.stringify(signal).includes("secret"));
      assert(!JSON.stringify(signal).includes("small.gif"));
    }
  }
}
const mixed = { message: [
  { type: "text", data: { text: "看" } },
  { type: "image", data: { url: "https://media.invalid/a?rkey=secret", file: "file-secret", sub_type: 0 } },
  { type: "face", data: { id: "14" } },
  { type: "mface", data: { summary: "[商城表情]", emoji_id: "raw-secret-id" } },
  { type: "image", data: { sub_type: "bad", summary: "[动画表情]" } },
  { type: "marketface", data: { emoji_package_id: "raw-secret-package" } },
] };
const media = readOnebotMedia(mixed);
assert.deepEqual(media.map(ref => [ref.segmentIndex, ref.imageIndex]), [[1, 0], [3, undefined], [4, 1], [5, undefined]]);
assert.deepEqual(media.map(ref => classifyOnebotImage(ref).kind), ["image", "sticker", "sticker", "sticker"]);
assert.equal(media[1]?.emojiIdPresent, true);
assert.equal(media[3]?.emojiPackageIdPresent, true);
assert(!JSON.stringify(media).includes("secret"));
assert.equal(readOnebotImages(mixed)[1]?.subType, undefined);
assert.equal(readOnebotImages(mixed)[1]?.subTypeState, "invalid");
assert.equal(readOnebotMessageText({ message: [{ type: "image", data: { sub_type: 1 } }, { type: "mface", data: { summary: "[动画表情]" } }] }), "[表情包][表情包]", "reliable sticker kinds render explicit sticker tokens");
assert.equal(sanitizeMediaSummary("x https://media.invalid/a?rkey=secret y"), "x  y");
assert.equal(sanitizeMediaSummary("x".repeat(500))?.length, 120);
assert.equal(readOnebotMedia({ message: [{ type: "image", data: [] }] })[0]?.subTypeState, "missing");

let returned: unknown = { message: [{ type: "image", data: { url: "https://media.invalid/fetched", sub_type: 1, summary: "[动画表情]" } }] };
let calls = 0;
const gateway = createServer(async (req, res) => {
  for await (const _part of req) { /* Consume request body. */ }
  calls++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: "ok", retcode: 0, data: returned }));
});
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const address = gateway.address();
assert(address && typeof address !== "string");
try {
  const config = { wsUrl: "", httpUrl: `http://127.0.0.1:${address.port}` };
  const original = readOnebotImages({ message: [{ type: "image", data: { sub_type: 0, summary: "original" } }] });
  const filled = await fillOnebotImageUrls(config, "synthetic", original);
  assert.equal(filled[0]?.url, "https://media.invalid/fetched");
  assert.equal(filled[0]?.subType, 0);
  assert.equal(filled[0]?.summary, "original");
  const absent = readOnebotImages({ message: [{ type: "image", data: { sub_type: "bad" } }] });
  assert.equal((await fillOnebotImageUrls(config, "synthetic", absent))[0]?.subTypeState, "invalid");
  assert.equal((await fillOnebotImageUrls(config, "synthetic", absent))[0]?.summary, "");
  returned = { message: [] };
  assert.deepEqual(await fillOnebotImageUrls(config, "synthetic", absent), absent, "mismatched image counts never guess alignment");
  const before = calls;
  await fillOnebotImageUrls(config, "synthetic", filled);
  assert.equal(calls, before, "no additional refetch when all URLs already exist");
} finally {
  gateway.close();
  gateway.closeAllConnections();
}
console.log("OneBot media signal classification passed (local mock only; explicit sticker tokens).");
