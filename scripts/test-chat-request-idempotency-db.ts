import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// Database-backed tests for chat request idempotency. Uses isolated UUIDs and removes
// only rows created by this test; use a disposable development/test database.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，聊天请求幂等性数据库测试无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const ownerId = randomUUID();
const characterId = randomUUID();
const requestKey = randomUUID();
const requestHash = "a".repeat(64);
const requestIds: string[] = [];

try {
  const request = await prisma.chatRequest.create({
    data: { ownerId, characterId, requestKey, requestHash, claimToken: randomUUID(), status: "PROCESSING" },
    select: { id: true, status: true, claimToken: true, requestHash: true },
  });
  requestIds.push(request.id);
  assert.equal(request.status, "PROCESSING");
  assert.equal(request.requestHash, requestHash, "The request payload fingerprint must be stored with the idempotency key.");

  // The database unique constraint is the final guard against duplicate request rows.
  await assert.rejects(
    prisma.chatRequest.create({ data: { ownerId, characterId, requestKey, claimToken: randomUUID() } }),
    (error: { code?: string }) => error.code === "P2002",
    "The same owner/character/request key must not create two request records.",
  );

  // Simulate a stale lease and two clients trying to reclaim it at the same time.
  const staleAt = new Date(Date.now() - 11 * 60 * 1000);
  await prisma.chatRequest.update({
    where: { id: request.id },
    data: { updatedAt: staleAt, claimToken: randomUUID() },
  });
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const claims = await Promise.all([
    prisma.chatRequest.updateMany({
      where: { id: request.id, status: "PROCESSING", updatedAt: { lt: staleBefore } },
      data: { status: "PROCESSING", claimToken: randomUUID(), lastError: null, response: undefined, conversationId: null },
    }),
    prisma.chatRequest.updateMany({
      where: { id: request.id, status: "PROCESSING", updatedAt: { lt: staleBefore } },
      data: { status: "PROCESSING", claimToken: randomUUID(), lastError: null, response: undefined, conversationId: null },
    }),
  ]);
  assert.equal(claims.reduce((sum, claim) => sum + claim.count, 0), 1,
    "Only one concurrent retry may reclaim a stale PROCESSING request.");

  const winningClaim = await prisma.chatRequest.findUniqueOrThrow({ where: { id: request.id } });
  const staleFinalize = await prisma.chatRequest.updateMany({
    where: { id: request.id, status: "PROCESSING", claimToken: request.claimToken },
    data: { status: "COMPLETED", response: { stale: true } },
  });
  assert.equal(staleFinalize.count, 0,
    "A previous claimant must not finalize after a retry has replaced its claim token.");
  assert.notEqual(winningClaim.claimToken, request.claimToken,
    "Reclaiming a stale request must rotate its claim token.");
  const staleFailure = await prisma.chatRequest.updateMany({
    where: { id: request.id, status: "PROCESSING", claimToken: request.claimToken },
    data: { status: "FAILED", lastError: "stale claimant failure" },
  });
  assert.equal(staleFailure.count, 0,
    "A stale claimant must not mark a request FAILED after a newer claimant has taken over.");

  const conversationId = randomUUID();
  const cachedResponse = {
    conversationId,
    title: "幂等性测试",
    userMessage: { id: randomUUID(), role: "USER", content: "你好" },
    assistantMessage: { id: randomUUID(), role: "ASSISTANT", content: "你好！" },
  };
  await prisma.chatRequest.update({
    where: { id: request.id },
    data: { status: "COMPLETED", conversationId, response: cachedResponse, lastError: null },
  });
  const replay = await prisma.chatRequest.findUnique({
    where: { ownerId_characterId_requestKey: { ownerId, characterId, requestKey } },
  });
  assert.equal(replay?.status, "COMPLETED");
  assert.equal(replay?.conversationId, conversationId);
  assert.deepEqual(replay?.response, cachedResponse,
    "Completed requests must retain the exact response payload needed for a safe replay.");

  const failedKey = randomUUID();
  const failed = await prisma.chatRequest.create({
    data: { ownerId, characterId, requestKey: failedKey, claimToken: randomUUID(), status: "FAILED", lastError: "temporary test failure" },
    select: { id: true, status: true },
  });
  requestIds.push(failed.id);
  const retry = await prisma.chatRequest.updateMany({
    where: { id: failed.id, status: "FAILED" },
    data: { status: "PROCESSING", claimToken: randomUUID(), lastError: null, response: undefined, conversationId: null },
  });
  assert.equal(retry.count, 1, "A failed request must be eligible for a controlled retry.");

  console.log("Chat request idempotency DB tests passed: unique key, payload fingerprint, concurrent stale-lease claim, stale claimant protection, completed response replay, and failed-request retry.");
} finally {
  await prisma.chatRequest.deleteMany({ where: { id: { in: requestIds } } });
  await prisma.chatRequest.deleteMany({ where: { ownerId, characterId } });
  await prisma.$disconnect();
}
