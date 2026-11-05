import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";
import type { Prisma } from "../src/generated/prisma/client";

const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();
const patch = (await import("../server/api/memories/[id].patch")).default;
const trash = (await import("../server/api/memories/[id]/trash.post")).default;
const restore = (await import("../server/api/memories/[id]/restore.post")).default;
const remove = (await import("../server/api/memories/[id].delete")).default;
const router = createRouter();
router.patch("/memories/:id", patch);
router.delete("/memories/:id", remove);
router.post("/memories/:id/trash", trash);
router.post("/memories/:id/restore", restore);
const app = createApp();
app.use(router);
const server = createServer(toNodeListener(app));
const ownerId = randomUUID();
const strangerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const globalPrisma = globalThis as typeof globalThis & { __yilingPrisma?: typeof prisma };
let token = "";
let strangerToken = "";
let base = "";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function request(id: string, action: "patch" | "trash" | "restore" | "delete", body?: object, cookie = token) {
  const response = await fetch(`${base}/memories/${id}${action === "trash" || action === "restore" ? `/${action}` : ""}`, {
    method: action === "patch" ? "PATCH" : action === "delete" ? "DELETE" : "POST",
    headers: { cookie: `yiling_session=${cookie}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function item(status: "ACTIVE" | "ARCHIVED" | "TRASHED" = "ACTIVE") {
  return prisma.memoryItem.create({ data: {
    memoryScopeId: scopeId, category: "FACT", content: `fixture-${randomUUID()}`, status,
    ...(status === "TRASHED" ? { statusBeforeTrash: "ARCHIVED", deletedAt: new Date() } : {}),
  } });
}

/** A real transaction holds the row while the actual API reaches its locking statement.
 * The Promise barrier makes the competing request start before the holder commits.
 * Only the client's transaction entry is wrapped; all SQL and API logic run unchanged.
 */
async function whileLocked<T>(id: string, compete: () => Promise<T>, change: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  const locked = barrier();
  const reachedLock = barrier();
  const release = barrier();
  let observed = false;
  let holderPid = 0;
  const holder = prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM memory_items WHERE id = ${id}::uuid FOR UPDATE`;
    holderPid = rows[0]!.pid;
    locked.resolve();
    await release.promise;
    await change(tx);
  }, { timeout: 15_000 });
  await locked.promise;
  globalPrisma.__yilingPrisma = new Proxy(prisma, {
    get(target, key) {
      if (key === "$transaction") {
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction((tx) => callback(new Proxy(tx, {
          get(transaction, operation) {
            if (operation === "$queryRaw") {
              return (...args: Parameters<typeof tx.$queryRaw>) => {
                observed = true;
                const pending = tx.$queryRaw(...args);
                reachedLock.resolve();
                return pending;
              };
            }
            const value = Reflect.get(transaction, operation);
            return typeof value === "function" ? value.bind(transaction) : value;
          },
        })), { timeout: 15_000 });
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pending = compete();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reachedLock.promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("API did not reach its row lock")), 5000); }),
    ]);
    assert(observed);
    // Confirm PostgreSQL actually blocked the competing statement before committing.
    // This catches a missing FOR UPDATE even if the request still calls $queryRaw.
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
        ) AS blocked
      `;
      if (rows[0]?.blocked) { blocked = true; break; }
    }
    assert(blocked, "Competing API must wait for the holder's PostgreSQL row lock");
    release.resolve();
    await holder;
    return await pending;
  } finally {
    if (timer) clearTimeout(timer);
    release.resolve();
    await Promise.allSettled([holder, pending]);
    globalPrisma.__yilingPrisma = prisma;
  }
}

try {
  await prisma.user.createMany({ data: [ownerId, strangerId].map((id) => ({ id, username: `lifecycle-${id}`, passwordHash: "test-only" })) });
  await prisma.character.create({ data: { id: characterId, ownerId, name: `lifecycle-${characterId}`, basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `lifecycle:${scopeId}` } });
  token = (await createSession({ userId: ownerId })).token;
  strangerToken = (await createSession({ userId: strangerId })).token;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;

  const editable = await item();
  for (const action of ["patch", "trash", "restore", "delete"] as const) {
    assert.equal((await request(editable.id, action, action === "patch" ? { content: "forbidden" } : undefined, strangerToken)).status, 404);
    assert.equal((await request(randomUUID(), action, action === "patch" ? { content: "missing" } : undefined)).status, 404);
  }
  assert.equal((await request(editable.id, "delete")).status, 409);
  assert.equal((await request(editable.id, "restore")).status, 409);
  assert.equal((await request(editable.id, "patch", { status: "trashed" })).status, 400);

  // PATCH queued behind trash must reject, preserving both text and the trash metadata.
  const patchConflict = await whileLocked(editable.id,
    () => request(editable.id, "patch", { content: "must not write", status: "ACTIVE" }),
    (tx) => tx.memoryItem.update({ where: { id: editable.id }, data: { status: "TRASHED", statusBeforeTrash: "ARCHIVED", deletedAt: new Date() } }));
  assert.equal(patchConflict.status, 409);
  const untouched = await prisma.memoryItem.findUniqueOrThrow({ where: { id: editable.id } });
  assert.equal(untouched.content, editable.content);
  assert.equal(untouched.status, "TRASHED");
  assert.equal(untouched.statusBeforeTrash, "ARCHIVED");
  assert(untouched.deletedAt);

  // Trash queued behind PATCH must save the latest status, not the pre-lock status.
  const latest = await item();
  const trashed = await whileLocked(latest.id, () => request(latest.id, "trash"),
    (tx) => tx.memoryItem.update({ where: { id: latest.id }, data: { status: "INVALIDATED", content: "latest committed text" } }));
  assert.equal(trashed.status, 200);
  assert.equal(trashed.body.statusBeforeTrash, "INVALIDATED");
  assert.equal((await request(latest.id, "trash")).status, 409);
  assert.equal((await request(latest.id, "restore")).body.status, "INVALIDATED");
  assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: latest.id } })).content, "latest committed text");

  // DELETE queued behind restore must not delete the newly restored item.
  const restored = await item("TRASHED");
  const deletion = await whileLocked(restored.id, () => request(restored.id, "delete"),
    (tx) => tx.memoryItem.update({ where: { id: restored.id }, data: { status: "ARCHIVED", statusBeforeTrash: null, deletedAt: null } }));
  assert.equal(deletion.status, 409);
  assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: restored.id } })).status, "ARCHIVED");

  // A second restore observes the first committed restore and returns conflict.
  const twice = await item("TRASHED");
  const second = await whileLocked(twice.id, () => request(twice.id, "restore"),
    (tx) => tx.memoryItem.update({ where: { id: twice.id }, data: { status: "ARCHIVED", statusBeforeTrash: null, deletedAt: null } }));
  assert.equal(second.status, 409);
  const onceRestored = await prisma.memoryItem.findUniqueOrThrow({ where: { id: twice.id } });
  assert.equal(onceRestored.status, "ARCHIVED");
  assert.equal(onceRestored.statusBeforeTrash, null);
  assert.equal(onceRestored.deletedAt, null);

  // Restore waiting behind permanent deletion returns 404 rather than a Prisma error.
  const gone = await item("TRASHED");
  assert.equal((await whileLocked(gone.id, () => request(gone.id, "restore"),
    (tx) => tx.memoryItem.delete({ where: { id: gone.id } }))).status, 404);

  const permanent = await item("TRASHED");
  const snapshot = await prisma.memorySnapshot.create({ data: {
    memoryScopeId: scopeId, snapshotKey: `lifecycle:${randomUUID()}`, periodStart: new Date("2026-01-01"),
    periodEnd: new Date("2026-01-02"), summary: "immutable copy", structuredContent: { content: permanent.content },
    sources: { create: { sourceType: "MEMORY_ITEM", sourceRef: permanent.id, memoryItemId: permanent.id } },
  } });
  const deleted = await request(permanent.id, "delete");
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.preservedSnapshotReferences, 1);
  assert.equal(deleted.body.snapshotsPreserved, true);
  assert.equal(await prisma.memoryItem.findUnique({ where: { id: permanent.id } }), null);
  const source = await prisma.memorySnapshotSource.findFirstOrThrow({ where: { snapshotId: snapshot.id } });
  assert.equal(source.memoryItemId, null);
  assert.equal(source.sourceRef, permanent.id);
  assert.deepEqual((await prisma.memorySnapshot.findUniqueOrThrow({ where: { id: snapshot.id } })).structuredContent, { content: permanent.content });
  console.log("Memory item lifecycle PostgreSQL checks passed: owner isolation, lock barriers, PATCH/trash, DELETE/restore, repeated restore and preserved snapshot references.");
} finally {
  globalPrisma.__yilingPrisma = prisma;
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    await prisma.memoryScope.deleteMany({ where: { id: scopeId, characterId } });
    await prisma.character.deleteMany({ where: { id: characterId, ownerId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  } finally {
    await prisma.$disconnect();
  }
}
