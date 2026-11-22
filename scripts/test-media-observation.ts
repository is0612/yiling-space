import assert from "node:assert/strict";
import { attachImageDescriptions, buildStoredMessageMetadata, type ChannelTurnMessage } from "../server/utils/channel-adapter/pipeline";
import { mergeStoredMediaMetadata, observeOnebotMedia, storedMediaObservations } from "../server/utils/channel-adapter/media-observation";
import { readOnebotImages, readOnebotMedia, readOnebotMessageText, readOnebotMessageParts } from "../server/utils/channel-adapter/onebot/types";

const context = { modelConfig: {}, chatModel: "mock", apiBaseUrl: "https://model.invalid/v1", apiKey: "mock", characterId: "test-character", bindingId: "test-binding" };
const settings = { model: "mock", apiBaseUrl: context.apiBaseUrl, apiKey: "mock" };
function message(id: string, segments: Array<{ type: string; data: Record<string, unknown> }>): ChannelTurnMessage {
  const event = { message: segments };
  return { externalMessageId: id, authorOpenId: "synthetic-member", content: readOnebotMessageText(event),
    promptContent: readOnebotMessageText(event), images: readOnebotImages(event), observedMedia: observeOnebotMedia(readOnebotMedia(event)),
    imageTextParts: readOnebotMessageParts(event), promptImageTextParts: readOnebotMessageParts(event) };
}
const mixed = message("mixed", [
  { type: "text", data: { text: "看看" } },
  { type: "image", data: { sub_type: 1, summary: "[动画表情]" } },
  { type: "mface", data: { summary: "[表情包]" } },
  { type: "image", data: { url: "https://media.invalid/a?rkey=secret", sub_type: 0 } },
  { type: "image", data: { url: "https://media.invalid/b", sub_type: "0" } },
  { type: "image", data: { url: "https://media.invalid/c", sub_type: 4 } },
  { type: "image", data: { url: "https://media.invalid/d" } },
]);
const later = message("later", [{ type: "image", data: { url: "https://media.invalid/e" } }]);
let calls = 0;
const processed = await attachImageDescriptions([mixed, later], context, {
  resolveSettings: async () => settings,
  describe: async refs => { calls++; assert.equal(refs.length, 3); assert.equal(refs[0]?.url, mixed.images?.[1]?.url); return ["照片描述", null, "另一张描述"]; },
});
assert.equal(calls, 1, "classification must not skip sticker/image/unknown or expand existing three-image budget");
assert.deepEqual(processed[0]?.observedMedia?.map(m => [m.segmentIndex, m.kind, m.vision]), [
  [1, "sticker", { status: "skipped", reason: "no_url" }],
  [2, "sticker", { status: "skipped", reason: "unsupported_segment" }],
  [3, "image", { status: "ok" }],
  [4, "unknown", { status: "failed", reason: "description_unavailable" }],
  [5, "unknown", { status: "ok" }],
  [6, "unknown", { status: "skipped", reason: "limit" }],
]);
assert.equal(processed[0]?.content, "看看[表情包][表情包][图片：照片描述][图片][图片：另一张描述][图片]");
assert.equal(processed[0]?.promptContent, processed[0]?.content);
assert.deepEqual(processed[1]?.observedMedia?.[0]?.vision, { status: "skipped", reason: "limit" });
assert.equal(mixed.observedMedia?.[0]?.vision.status, "skipped", "observation update must not mutate original rows");
assert.deepEqual(mixed.observedMedia?.[0]?.vision, { status: "skipped", reason: "not_processed" });
for (const storedReason of ["replied", "silent", "mentioned", "context", "recorded"] as const) {
  const metadata = buildStoredMessageMetadata({ platform: "qq-onebot", storedReason, message: processed[0]! });
  assert.equal((metadata.media as unknown[]).length, 6);
  assert(!JSON.stringify(metadata).includes("media.invalid"));
  assert(!JSON.stringify(metadata).includes("rkey"));
}
const disabled = await attachImageDescriptions([mixed], context, { resolveSettings: async () => null,
  describe: async () => { throw new Error("disabled vision must not run"); } });
assert.equal(disabled[0]?.content, mixed.content);
assert.deepEqual(disabled[0]?.observedMedia?.[0]?.vision, { status: "skipped", reason: "not_enabled" });
assert.deepEqual(disabled[0]?.observedMedia?.[1]?.vision, { status: "skipped", reason: "unsupported_segment" });
const stickerWithUrl = message("sticker-url", [{ type: "image", data: { sub_type: 1, url: "https://media.invalid/sticker" } }]);
let stickerCalls = 0;
await attachImageDescriptions([stickerWithUrl], context, { resolveSettings: async () => settings,
  describe: async () => { stickerCalls++; return ["原有描述行为"]; } });
assert.equal(stickerCalls, 1, "observational sticker classification must not switch to strategy A");
const failed = await attachImageDescriptions([stickerWithUrl], context, { resolveSettings: async () => settings,
  describe: async () => { throw new Error("mock vision failure"); } });
assert.equal(failed[0]?.content, "[表情包]");
assert.deepEqual(failed[0]?.observedMedia?.[0]?.vision, { status: "failed", reason: "description_unavailable" });
const noUrl = message("no-url", [{ type: "image", data: {} }]);
let noUrlCalls = 0;
const noUrlAfterQuota = await attachImageDescriptions([mixed, noUrl], context, { resolveSettings: async () => settings, describe: async () => ["a", "b", "c"] });
assert.deepEqual(noUrlAfterQuota[1]?.observedMedia?.[0]?.vision, { status: "skipped", reason: "no_url" });
assert.equal(noUrlAfterQuota[1]?.content, noUrl.content, "observation must not change legacy token behavior after quota");
const noUrlResult = await attachImageDescriptions([noUrl], context, { resolveSettings: async () => settings,
  describe: async () => { noUrlCalls++; return []; } });
assert.equal(noUrlCalls, 0);
assert.equal(noUrlResult[0]?.content, "[图片]");
const raw = observeOnebotMedia(readOnebotMedia({ message: [{ type: "image", data: { summary: "x https://cdn.invalid/a?rkey=secret", emoji_id: "private-id" } }] }));
const sanitized = storedMediaObservations(raw.map(m => ({ ...m, url: "https://secret.invalid", file: "private-file", emoji_id: "private-id" })));
assert(!JSON.stringify(sanitized).includes("secret"));
assert(!JSON.stringify(sanitized).includes("private"));
const merged = mergeStoredMediaMetadata({ poke: true, storedReason: "recorded", custom: { sentinel: true }, mediaOmitted: 5 }, raw);
assert.equal(merged.poke, true);
assert.equal(merged.storedReason, "recorded");
assert.deepEqual(merged.custom, { sentinel: true });
assert.equal(merged.mediaOmitted, undefined, "stale truncation count must be removed");
assert.equal((merged.media as unknown[]).length, 1);
for (const summary of ["file:///private/sticker.png", "data:image/png;base64,private", "base64://private"]) {
  assert(!JSON.stringify(storedMediaObservations(raw.map(m => ({ ...m, summary })))).includes("private"));
}
const capped = buildStoredMessageMetadata({ platform: "qq-onebot", storedReason: "recorded", message: { authorOpenId: "synthetic-member", content: "", observedMedia: Array.from({ length: 101 }, () => raw[0]!) } });
assert.equal((capped.media as unknown[]).length, 100);
assert.equal(capped.mediaOmitted, 1);
assert.equal(buildStoredMessageMetadata({ platform: "qq-onebot", storedReason: "recorded", message: { authorOpenId: "x", content: "plain" } }).media, undefined);
console.log("Media observation: per-segment classification, budget/alignment, disabled/failed states, metadata privacy and typed fallback tokens passed (mocked; no model/QQ/database).");
