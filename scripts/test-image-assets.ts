import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PrismaClient } from "../src/generated/prisma/client";
import { dataPath } from "../server/utils/data-dir";
import { findGeneratedImageAsset, inspectGeneratedImageAsset, readGeneratedImageBuffer, readGeneratedImageFacts, type GeneratedImageAssetScope } from "../server/utils/image-assets";
import { sanitizeGeneratedImageFacts } from "../server/utils/image-facts";
import { readOnebotSendReceipt, resolveOnebotPrivateQuote, resolveOnebotGroupQuotes, type OnebotResolvedEvent } from "../server/utils/channel-adapter/onebot/client";

const scope: GeneratedImageAssetScope = { characterId: randomUUID(), bindingId: "fixture-binding", externalConversationId: "c:10000001" };
const relative = `images/${scope.characterId}/fixture.png`;
let metadata: Record<string, unknown> = { sentinel: "keep", image: { path: relative, width: 2, height: 2,
  generation: { prompt: "blue whale", model: "mock-image", provider: "mock", generatedAt: "2026-11-22T00:00:00Z", mode: "text_to_image" } },
  replyDelivery: { image: { status: "sent", externalMessageId: "-42" } } };
let query: unknown;
let duplicate = false;
let policyVisible = true;
const prisma = { message: {
  findMany: async (input: unknown) => { query = input; return policyVisible ? duplicate ? [{ id: "asset", metadata }, { id: "duplicate", metadata }] : [{ id: "asset", metadata }] : []; },
  findFirst: async () => policyVisible ? { metadata } : null,
  updateMany: async (input: { data: { metadata: Record<string, unknown> } }) => { metadata = input.data.metadata; return { count: 1 }; },
} } as unknown as PrismaClient;
const originalFetch = globalThis.fetch;
const directory = dataPath("images", scope.characterId);
const outsideDirectory = dataPath("images", `asset-outside-${randomUUID()}`);
try {
  assert.deepEqual(readOnebotSendReceipt({ message_id: -42 }), { messageId: "-42" });
  assert.deepEqual(readOnebotSendReceipt({ message_id: "-9007199254740993123" }), { messageId: "-9007199254740993123" });
  for (const value of [null, {}, { message_id: Number.MAX_SAFE_INTEGER + 1 }, { message_id: 1.5 }, { message_id: "x" }]) assert.equal(readOnebotSendReceipt(value).messageId, null);
  const asset = await findGeneratedImageAsset(prisma, scope, "-42");
  assert(asset);
  const where = (query as { where: Record<string, unknown> }).where;
  assert.deepEqual(where.conversation, { characterId: scope.characterId, channelBindingId: scope.bindingId, externalConversationId: scope.externalConversationId });
  assert.equal(where.role, "ASSISTANT");
  assert.deepEqual(where.AND, [{ metadata: { path: ["replyDelivery", "image", "status"], equals: "sent" } }, { metadata: { path: ["replyDelivery", "image", "externalMessageId"], equals: "-42" } }]);
  assert.equal(asset.facts.requestedDescription, "blue whale");
  assert(!JSON.stringify(asset.facts).includes("fixture.png"));
  duplicate = true;
  assert.equal(await findGeneratedImageAsset(prisma, scope, "-42"), null);
  duplicate = false;
  policyVisible = false;
  assert.equal(await findGeneratedImageAsset(prisma, scope, "-42"), null);
  policyVisible = true;
  assert.equal(await findGeneratedImageAsset(prisma, { ...scope, bindingId: "" }, "-42"), null);
  assert.equal(await findGeneratedImageAsset(prisma, scope, "not-an-id"), null);
  const safe = sanitizeGeneratedImageFacts({ ...asset.facts, path: "secret", externalMessageId: "private-id", visual: { status: "ok", description: "a whale https://bad.invalid/key" } });
  assert(safe && safe.visual.status === "ok");
  assert(!JSON.stringify(safe).includes("secret"));
  assert(!JSON.stringify(safe).includes("bad.invalid"));
  assert.equal(sanitizeGeneratedImageFacts({ origin: "external", mode: "text_to_image", visual: { status: "ok" } }), null);
  await fs.mkdir(directory, { recursive: true });
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
  await fs.writeFile(dataPath(relative), buffer);
  assert.equal((await readGeneratedImageBuffer(asset))?.mime, "image/png");
  for (const invalidPath of ["../credentials", path.resolve(dataPath(relative)), `images/other-role/fixture.png`, `images/${scope.characterId}/../other/file.png`]) {
    assert.equal(await readGeneratedImageBuffer({ ...asset, path: invalidPath }), null);
  }
  assert.equal(await readGeneratedImageBuffer({ ...asset, path: `images/${scope.characterId}/missing.png` }), null);
  await fs.writeFile(path.join(directory, "oversize.png"), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal(await readGeneratedImageBuffer({ ...asset, path: `images/${scope.characterId}/oversize.png` }), null);
  // A directory junction cannot make another character's file readable through this root.
  await fs.mkdir(outsideDirectory, { recursive: true });
  await fs.writeFile(path.join(outsideDirectory, "fixture.png"), buffer);
  await fs.symlink(outsideDirectory, path.join(directory, "escape"), "junction");
  assert.equal(await readGeneratedImageBuffer({ ...asset, path: `images/${scope.characterId}/escape/fixture.png` }), null);
  let visionCalls = 0;
  globalThis.fetch = async () => { visionCalls++; return Response.json({ choices: [{ message: { content: "一条蓝鲸。" } }] }); };
  let consumes = 0;
  const settings = { model: "mock-vision", apiBaseUrl: "https://vision.invalid/v1", apiKey: "mock-secret" };
  assert.equal((await inspectGeneratedImageAsset(prisma, asset, null, () => { consumes++; return true; })).visual.status, "disabled");
  assert.equal(consumes, 0);
  assert.equal((await inspectGeneratedImageAsset(prisma, asset, settings, () => false)).visual.status, "budget_exhausted");
  assert.equal(visionCalls, 0);
  policyVisible = false;
  assert.equal((await inspectGeneratedImageAsset(prisma, asset, settings, () => { throw new Error("missing scoped row must not consume budget"); })).visual.status, "missing_file");
  policyVisible = true;
  const viewed = await inspectGeneratedImageAsset(prisma, asset, settings, () => { consumes++; return true; });
  assert.equal(viewed.visual.status, "ok");
  assert.equal(viewed.visual.description, "一条蓝鲸。");
  assert.equal(visionCalls, 1);
  assert.equal(metadata.sentinel, "keep");
  const cached = readGeneratedImageFacts(metadata)!;
  assert.equal((await inspectGeneratedImageAsset(prisma, { ...asset, facts: cached }, settings, () => { throw new Error("cached image must not consume budget"); })).visual.status, "ok");
  assert.equal(visionCalls, 1);

  // New output is inspected before delivery: no sent receipt or follow-up question
  // exists yet. Its observation must already be available to the next chat turn.
  const deliveredMetadata = metadata;
  metadata = { image: { path: relative, generation: { prompt: "blue whale" }, vision: { status: "not_requested" } } };
  const created = await inspectGeneratedImageAsset(prisma, { ...asset, facts: readGeneratedImageFacts(metadata)! }, settings, () => true);
  assert.equal(created.visual.status, "ok");
  assert.equal(visionCalls, 2, "one additional call observes the new output");
  assert.equal(readGeneratedImageFacts(metadata)?.visual.description, "一条蓝鲸。");
  assert.equal(metadata.replyDelivery, undefined, "observing a generated image must not claim delivery");
  await inspectGeneratedImageAsset(prisma, { ...asset, facts: readGeneratedImageFacts(metadata)! }, settings, () => { throw new Error("automatic observation must be reused"); });
  assert.equal(visionCalls, 2, "subsequent inspection reuses the automatic observation");
  metadata = { image: { path: relative, vision: { status: "not_requested" } } };
  globalThis.fetch = async () => { throw new Error("fixture vision unavailable"); };
  const failedObservation = await inspectGeneratedImageAsset(prisma, { ...asset, facts: readGeneratedImageFacts(metadata)! }, settings, () => true);
  assert.equal(failedObservation.visual.status, "failed", "vision failure returns normally so output delivery can continue");
  assert.equal((metadata.image as { path: string }).path, relative);
  metadata = deliveredMetadata;

  const event = { messageType: "private", messageId: "current", userId: "10000001", selfId: "10000002", groupId: "", data: { message: [{ type: "reply", data: { id: "-42" } }] } } as OnebotResolvedEvent;
  let raw: Record<string, unknown> = { message_id: -42, message_type: "private", user_id: 10000001, target_id: 10000001,
    sender: { user_id: 10000002 }, message: [{ type: "image", data: { url: "https://media.invalid/image" } }] };
  globalThis.fetch = async () => Response.json({ status: "ok", retcode: 0, data: raw });
  let lookups = 0;
  const options = { resolveGeneratedImage: async () => { lookups++; return cached; } };
  const quoted = await resolveOnebotPrivateQuote({ httpUrl: "https://gateway.invalid", wsUrl: "" }, event, options);
  assert.equal(quoted?.image?.visual.status, "ok");
  assert.equal(quoted?.content, "[图片]");
  assert.equal(lookups, 1);
  raw = { ...raw, target_id: 10000003 };
  const denied = await resolveOnebotPrivateQuote({ httpUrl: "https://gateway.invalid", wsUrl: "" }, event, options);
  assert.equal(denied?.image, undefined);
  assert.equal(lookups, 1, "cross-private quote must not even query assets");
  const groupEvent = { ...event, messageType: "group", groupId: "123456789" } as OnebotResolvedEvent;
  raw = { ...raw, message_type: "group", group_id: 123456789, user_id: 10000002 };
  const groupQuoted = await resolveOnebotGroupQuotes({ httpUrl: "https://gateway.invalid", wsUrl: "" }, [groupEvent], {
    cached: () => undefined, canReadAuthor: () => true, memberCode: () => "self", formatText: text => text, resolveGeneratedImage: options.resolveGeneratedImage,
  });
  assert.equal(groupQuoted.get("current")?.image?.visual.status, "ok");
  raw = { ...raw, group_id: 987654321 };
  const wrongGroup = await resolveOnebotGroupQuotes({ httpUrl: "https://gateway.invalid", wsUrl: "" }, [groupEvent], {
    cached: () => undefined, canReadAuthor: () => true, memberCode: () => "self", formatText: text => text, resolveGeneratedImage: options.resolveGeneratedImage,
  });
  assert.equal(wrongGroup.get("current")?.image, undefined);
  assert.equal(lookups, 2);
  console.log("Image assets: scoped receipt lookup, bounded facts, trusted-file inspection/cache and verified private/group quote recovery passed (mock only).");
} finally {
  globalThis.fetch = originalFetch;
  // This exact randomized fixture directory was created above; application files are never removed.
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(outsideDirectory, { recursive: true, force: true });
}
