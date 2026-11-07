import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, eventHandler, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { hashSessionToken } from "../server/utils/auth";
import { processNextMemoryJob, reclaimExpiredMemoryJobs } from "../server/utils/memory-worker";
import { isMemoryJobLeaseExpired, MEMORY_JOB_LEASE_MS, MemoryJobLeaseLostError, renewMemoryJobLease } from "../server/utils/memory-job-lease";

// Never allow this regression to write to the user's business database.
const database = new URL(process.env.DATABASE_URL ?? "");
assert(/^\/yiling_memory_test_[a-f0-9]{32}$/.test(database.pathname), "Run through the disposable memory reliability runner.");
assert(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));
const prisma = getPrisma();
(globalThis as unknown as { defineEventHandler: typeof eventHandler }).defineEventHandler = eventHandler;
const retry = (await import("../server/api/tasks/[id]/retry.post")).default;
const cancel = (await import("../server/api/tasks/[id]/cancel.post")).default;
/**
 * 自己建一个管理员账号，不 `findFirst`。
 *
 * 隔离跑法会先插入一条 USER 角色的「无关用户」做跨用户隔离，`findFirst` 随手拿到它时，
 * `/tasks/{id}/retry|cancel` 的 `requireAdminActor` 会直接 403 —— 测试挂在一个和本用例
 * 毫无关系的账号选择上。这里要的是「管理员能操作」，该由用例自己保证。
 */
const owner = await prisma.user.create({ data: {
  username: `__fencing_admin_${randomUUID()}`, passwordHash: "x", role: "ADMIN",
} });
const sessionToken = randomUUID();
const session = await prisma.session.create({ data: {
  userId: owner.id, tokenHash: hashSessionToken(sessionToken), expiresAt: new Date(Date.now() + 3_600_000),
} });
const app = createApp();
app.use(eventHandler(async (event) => {
  const match = event.path.match(/^\/tasks\/([^/]+)\/(retry|cancel)$/);
  assert(match);
  event.context.params = { id: match[1]! };
  return match[2] === "retry" ? retry(event) : cancel(event);
}));
const api = http.createServer(toNodeListener(app));
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
async function action(id: string, operation: "retry" | "cancel") {
  const response = await fetch(`${apiUrl}/tasks/${id}/${operation}`, {
    method: "POST", headers: { cookie: `yiling_session=${sessionToken}` },
  });
  assert.equal(response.status, 200, await response.text());
}
async function reachedModel(reached: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([reached, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Worker did not reach the controlled model barrier")), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function barrier() {
  let release!: () => void;
  let entered!: () => void;
  return {
    wait: new Promise<void>((resolve) => { release = resolve; }),
    reached: new Promise<void>((resolve) => { entered = resolve; }),
    release: () => release(), enter: () => entered(),
  };
}
let gate = barrier();
let fail = false;
let journalSkip = false;
const model = http.createServer(async (request, response) => {
  try {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const prompt = JSON.parse(body.messages.find((m: { role: string }) => m.role === "user").content);
    gate.enter();
    await gate.wait;
    if (fail) { response.writeHead(400).end(JSON.stringify({ error: { message: "controlled old model failure" } })); return; }
    const first = prompt.messages[0];
    const entry = journalSkip ? { action: "SKIP", reason: "今天平静" } : {
      action: "CREATE", title: "今日", content: "今天一起散步，记下这段平静的相处。", sourceMessageIds: [first.id], sourceEventIds: [],
    };
    const result = prompt.dayKey ? entry : {
      summary: "今天一起散步。", importantEvents: [], factAndPreferenceChanges: [], relationshipChanges: [],
      goalsAndCommitments: [], unresolvedTopics: [], differencesFromPrevious: [], memoryChanges: [],
      events: [{ occurredAt: first.occurredAt, title: "一起散步", detail: "今天一起散步。", confidence: 0.95,
        evidenceMessageIds: [first.id], participants: [], keywords: ["散步"] }],
    };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(result) } }],
    }));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
const characters: string[] = [];
const start = new Date("2026-11-01T00:00:00Z");
const end = new Date("2026-11-02T00:00:00Z");
async function fixture(type: "EXTRACT_EVENTS" | "GENERATE_SNAPSHOT" | "GENERATE_JOURNAL") {
  const character = await prisma.character.create({ data: {
    ownerId: owner.id, name: `__fencing_${randomUUID()}`, basePrompt: "测试角色",
    modelConfig: { chatModel: "ci-fencing", chatApiBaseUrl: modelUrl, chatApiKeyEncrypted: await encryptApiKey("test-only-key") },
    memorySetting: { create: { timezone: "UTC", anchorAt: start, nextSnapshotAt: end } },
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `fencing:${randomUUID()}` } },
  }, include: { memoryScopes: true } });
  characters.push(character.id);
  const scopeId = character.memoryScopes[0]!.id;
  await prisma.conversation.create({ data: {
    characterId: character.id, memoryScopeId: scopeId, title: "测试",
    messages: { create: { role: "USER", content: "今天一起散步。", occurredAt: new Date(start.getTime() + 60_000) } },
  } });
  const key = type === "EXTRACT_EVENTS" ? `events-final:${scopeId}:2026-11-01` : type === "GENERATE_JOURNAL" ? `journal:${scopeId}:2026-11-01:DIARY` : `snapshot:${scopeId}`;
  const job = await prisma.memoryJob.create({ data: {
    memoryScopeId: scopeId, type, periodStart: start, periodEnd: end, idempotencyKey: key,
    journalDayKey: type === "GENERATE_JOURNAL" ? "2026-11-01" : null,
    journalTarget: type === "GENERATE_JOURNAL" ? "DIARY" : null, runAt: new Date(0),
  } });
  return { job, scopeId };
}
async function verifyLeaseRenewal() {
  const { job } = await fixture("EXTRACT_EVENTS");
  const startedAt = new Date(Date.now() - MEMORY_JOB_LEASE_MS - 30_000);
  const claimToken = `lease-renewal:${randomUUID()}`;
  await prisma.memoryJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", lockedAt: startedAt, lockedBy: claimToken, startedAt },
  });

  await renewMemoryJobLease(prisma, { jobId: job.id, claimToken });
  const renewed = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
  assert(renewed.lockedAt && renewed.lockedAt.getTime() > startedAt.getTime());
  assert.equal(renewed.startedAt?.getTime(), startedAt.getTime(), "Renewal must preserve the original start time.");
  assert.equal(isMemoryJobLeaseExpired(renewed.lockedAt), false);
  const recovered = await reclaimExpiredMemoryJobs(prisma, { ownerId: owner.id });
  assert.equal(recovered.recovered, 0, "A renewed lease must not be reclaimed.");

  await assert.rejects(
    () => renewMemoryJobLease(prisma, { jobId: job.id, claimToken: "stale-worker-token" }),
    (error: unknown) => error instanceof MemoryJobLeaseLostError,
    "A stale worker must not renew a successor's lease.",
  );
  console.log("Memory job lease renewal regression passed.");
}

async function noArtifacts(scopeId: string) {
  assert.equal(await prisma.memoryEvent.count({ where: { memoryScopeId: scopeId } }), 0);
  assert.equal(await prisma.memoryEventDay.count({ where: { memoryScopeId: scopeId } }), 0);
  assert.equal(await prisma.memorySnapshot.count({ where: { memoryScopeId: scopeId } }), 0);
  assert.equal(await prisma.characterJournal.count({ where: { memoryScopeId: scopeId } }), 0);
}
try {
  await verifyLeaseRenewal();
  for (const type of ["EXTRACT_EVENTS", "GENERATE_SNAPSHOT", "GENERATE_JOURNAL"] as const) {
    for (const destination of ["cancel", "new-token", "model-error"] as const) {
      gate = barrier(); fail = false; journalSkip = false;
      const { job, scopeId } = await fixture(type);
      const old = processNextMemoryJob(prisma, { jobId: job.id, ownerId: owner.id, workerId: "same-display-worker" });
      await reachedModel(gate.reached);
      const claimed = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
      assert(claimed.lockedBy?.startsWith("same-display-worker:"));
      await prisma.memoryJob.update({ where: { id: job.id }, data: { lockedAt: new Date(Date.now() - MEMORY_JOB_LEASE_MS - 10_000) } });
      await action(job.id, "retry");
      let successor: ReturnType<typeof processNextMemoryJob> | undefined;
      const oldGate = gate;
      if (destination === "cancel") await action(job.id, "cancel");
      else {
        gate = barrier();
        successor = processNextMemoryJob(prisma, { jobId: job.id, ownerId: owner.id, workerId: "same-display-worker" });
        await reachedModel(gate.reached);
      }
      const before = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
      fail = destination === "model-error";
      oldGate.release(); await old;
      const after = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(after.status, before.status);
      assert.equal(after.lockedBy, before.lockedBy);
      assert.equal(after.attemptCount, before.attemptCount);
      assert.equal(after.lastError, before.lastError);
      await noArtifacts(scopeId);
      if (successor) {
        assert.notEqual(before.lockedBy, claimed.lockedBy, "Same display worker must receive a fresh claim token");
        // Let the successor exit through its ordinary error path after the stale result was rejected.
        fail = true; gate.release(); await successor;
      }
      console.log(`Fenced ${type}: ${destination}`);
    }
    gate = barrier(); fail = false; journalSkip = false;
    const { job, scopeId } = await fixture(type);
    gate.release();
    const active = await processNextMemoryJob(prisma, { jobId: job.id, ownerId: owner.id, workerId: "same-display-worker" });
    assert(active.processed && active.status === "SUCCEEDED", JSON.stringify(active));
    const count = type === "EXTRACT_EVENTS" ? await prisma.memoryEvent.count({ where: { memoryScopeId: scopeId } })
      : type === "GENERATE_SNAPSHOT" ? await prisma.memorySnapshot.count({ where: { memoryScopeId: scopeId } })
        : await prisma.characterJournal.count({ where: { memoryScopeId: scopeId } });
    assert.equal(count, 1);
  }
  // Model SKIP must also pass the journal transaction's lease check.
  gate = barrier(); journalSkip = true; fail = false;
  const { job, scopeId } = await fixture("GENERATE_JOURNAL");
  const old = processNextMemoryJob(prisma, { jobId: job.id, ownerId: owner.id });
  await reachedModel(gate.reached);
  await prisma.memoryJob.update({ where: { id: job.id }, data: { lockedAt: new Date(0) } });
  await action(job.id, "retry"); await action(job.id, "cancel"); gate.release(); await old;
  await noArtifacts(scopeId);
  console.log("Memory job fencing DB regression passed: real retry/cancel, new claims, model errors, active claims and journal SKIP.");
} finally {
  gate.release();
  await Promise.all([new Promise<void>((resolve) => api.close(() => resolve())), new Promise<void>((resolve) => model.close(() => resolve()))]);
  // Only fixture-owned records in the disposable database.
  for (const id of characters) {
    await prisma.memoryJob.deleteMany({ where: { memoryScope: { characterId: id } } });
    await prisma.conversation.deleteMany({ where: { characterId: id } });
    await prisma.memoryScope.deleteMany({ where: { characterId: id } });
    await prisma.character.delete({ where: { id } });
  }
  await prisma.session.delete({ where: { id: session.id } });
  await prisma.$disconnect();
}
