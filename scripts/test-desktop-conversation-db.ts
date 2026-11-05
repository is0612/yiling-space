import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  desktopConversationWhere, lockActiveDesktopConversationForWrite,
  tombstoneDesktopConversationRequests, validateDesktopConversationReplay,
  DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR,
} from "../server/utils/desktop-conversation";

// Only the disposable parent runner may supply the database. Never load local .env.
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.YILING_CHAT_ISOLATED_DB !== "1") {
  throw new Error("Run through the disposable chat DB runner (YILING_CHAT_ISOLATED_DB=1).");
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const connectionId = randomUUID();
const isConflict = (error: unknown) => typeof error === "object" && error !== null
  && "statusCode" in error && error.statusCode === 409;

try {
  await prisma.user.create({ data: { id: ownerId, username: `desktop-test-${ownerId}`, passwordHash: "test-only" } });
  await prisma.character.create({ data: {
    id: characterId, ownerId, name: "Desktop boundary test", basePrompt: "test",
    memoryScopes: { create: { id: scopeId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` } },
  } });
  const desktop = await prisma.conversation.create({ data: { characterId, memoryScopeId: scopeId, title: "desktop" } });
  await prisma.platformConnection.create({ data: { id: connectionId, platform: "qq-onebot", displayName: "test" } });
  const binding = await prisma.characterChannelBinding.create({ data: { characterId, connectionId } });
  const channelConversations = await Promise.all(["g:123456", "c:123456"].map((externalConversationId) =>
    prisma.conversation.create({ data: {
      characterId, memoryScopeId: scopeId, channelBindingId: binding.id, externalConversationId,
    } })));
  await prisma.characterChannelBinding.delete({ where: { id: binding.id } });
  const detached = await prisma.conversation.findMany({ where: { id: { in: channelConversations.map((row) => row.id) } } });
  assert.equal(detached.length, 2);
  assert.ok(detached.every((row) => row.channelBindingId === null));
  assert.deepEqual(detached.map((row) => row.externalConversationId).sort(), ["c:123456", "g:123456"]);
  const where = desktopConversationWhere({ characterId, memoryScopeId: scopeId });
  assert.deepEqual((await prisma.conversation.findMany({ where })).map((row) => row.id), [desktop.id]);
  for (const row of detached) {
    assert.equal(await prisma.conversation.findFirst({ where: desktopConversationWhere({ ...where, id: row.id }) }), null);
    await assert.rejects(prisma.$transaction((tx) => lockActiveDesktopConversationForWrite(tx, {
      id: row.id, characterId, memoryScopeId: scopeId, lastMessageAt: new Date(),
    })), isConflict);
    await assert.rejects(validateDesktopConversationReplay(prisma, {
      conversationId: row.id, characterId, memoryScopeId: scopeId,
    }), isConflict);
  }

  // Model input was loaded while ACTIVE; archive commits before the model finishes.
  await prisma.conversation.update({ where: { id: desktop.id }, data: { status: "ARCHIVED" } });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await lockActiveDesktopConversationForWrite(tx, {
      id: desktop.id, characterId, memoryScopeId: scopeId, lastMessageAt: new Date(),
    });
    await tx.message.create({ data: { conversationId: desktop.id, role: "USER", content: "must not commit", occurredAt: new Date() } });
  }), isConflict);
  assert.equal(await prisma.message.count({ where: { conversationId: desktop.id } }), 0);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: desktop.id } })).lastMessageAt, null);
  await validateDesktopConversationReplay(prisma, { conversationId: desktop.id, characterId, memoryScopeId: scopeId });

  // Hold an uncommitted archive row lock; the guard must wait then recheck ACTIVE.
  await prisma.conversation.update({ where: { id: desktop.id }, data: { status: "ACTIVE" } });
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
  let archiveLocked!: () => void;
  const locked = new Promise<void>((resolve) => { archiveLocked = resolve; });
  const archive = prisma.$transaction(async (tx) => {
    await tx.conversation.update({ where: { id: desktop.id }, data: { status: "ARCHIVED" } });
    archiveLocked();
    await archiveGate;
  });
  await locked;
  const append = prisma.$transaction(async (tx) => {
    await lockActiveDesktopConversationForWrite(tx, {
      id: desktop.id, characterId, memoryScopeId: scopeId, lastMessageAt: new Date(),
    });
    await tx.message.create({ data: { conversationId: desktop.id, role: "ASSISTANT", content: "must not commit", occurredAt: new Date() } });
  });
  const rejected = assert.rejects(append, isConflict);
  releaseArchive();
  await Promise.all([archive, rejected]);
  assert.equal(await prisma.message.count({ where: { conversationId: desktop.id } }), 0);

  await prisma.conversation.update({ where: { id: desktop.id }, data: { status: "ACTIVE" } });
  await prisma.$transaction(async (tx) => {
    await lockActiveDesktopConversationForWrite(tx, {
      id: desktop.id, characterId, memoryScopeId: scopeId, lastMessageAt: new Date(),
    });
    await tx.message.create({ data: { conversationId: desktop.id, role: "USER", content: "saved", occurredAt: new Date() } });
  });
  assert.equal(await prisma.message.count({ where: { conversationId: desktop.id } }), 1);
  const request = await prisma.chatRequest.create({ data: {
    ownerId, characterId, requestKey: randomUUID(), requestHash: "a".repeat(64), claimToken: randomUUID(),
    status: "COMPLETED", conversationId: desktop.id, response: { conversationId: desktop.id, secret: "deleted content" },
  } });
  await prisma.$transaction(async (tx) => {
    await tombstoneDesktopConversationRequests(tx, desktop.id);
    await tx.conversation.delete({ where: { id: desktop.id } });
  });
  const tombstone = await prisma.chatRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(tombstone.status, "FAILED");
  assert.equal(tombstone.lastError, DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR);
  assert.equal(tombstone.response, null);
  assert.equal(tombstone.requestHash, request.requestHash);
  await assert.rejects(validateDesktopConversationReplay(prisma, {
    conversationId: desktop.id, characterId, memoryScopeId: scopeId,
  }), isConflict);
  console.log("Desktop conversation DB tests passed: detached boundary, archive commit guard, row-lock recheck, valid write, archive replay and deletion tombstones.");
} finally {
  await prisma.chatRequest.deleteMany({ where: { ownerId, characterId } });
  await prisma.conversation.deleteMany({ where: { characterId } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.platformConnection.deleteMany({ where: { id: connectionId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
}
