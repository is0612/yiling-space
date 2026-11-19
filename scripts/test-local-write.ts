import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma } from "../server/utils/prisma";
import {
  approveLocalWriteRequest,
  createLocalWriteRequest,
  rejectLocalWriteRequest,
} from "../server/utils/local-write";
import { LocalObserveError, validateLocalWritablePath } from "../server/utils/local-observe";

const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "yiling-local-write-"));
fs.mkdirSync(path.join(rootPath, "notes"), { recursive: true });
const actorId = randomUUID();
let rootId = "";

try {
  const prisma = getPrisma();
  const root = await prisma.localAccessRoot.create({
    data: { path: rootPath, label: "write-test", mode: "READ_WRITE" },
  });
  rootId = root.id;

  const written = await createLocalWriteRequest({
    rootId, relativePath: "notes/a.txt", content: "hello\n", reason: "test", actorId,
  });
  assert.equal(written.status, "PENDING");
  const approved = await approveLocalWriteRequest(written.id, actorId);
  assert.equal(approved.status, "APPLIED");
  assert.equal(fs.readFileSync(path.join(rootPath, "notes/a.txt"), "utf8"), "hello\n");

  const second = await createLocalWriteRequest({
    rootId, relativePath: "notes/a.txt", content: "second\n", reason: "test", actorId,
  });
  fs.writeFileSync(path.join(rootPath, "notes/a.txt"), "changed outside\n");
  await assert.rejects(
    () => approveLocalWriteRequest(second.id, actorId),
    (error: unknown) => error instanceof LocalObserveError && error.statusCode === 409,
  );
  assert.equal(fs.readFileSync(path.join(rootPath, "notes/a.txt"), "utf8"), "changed outside\n");

  const rejected = await createLocalWriteRequest({
    rootId, relativePath: "notes/b.txt", content: "nope\n", reason: "test", actorId,
  });
  const afterReject = await rejectLocalWriteRequest(rejected.id, actorId, "not needed");
  assert.equal(afterReject.status, "REJECTED");
  assert.equal(fs.existsSync(path.join(rootPath, "notes/b.txt")), false);

  assert.throws(
    () => validateLocalWritablePath(rootPath, ".env"),
    (error: unknown) => error instanceof LocalObserveError && error.statusCode === 403,
  );
  assert.throws(
    () => validateLocalWritablePath(rootPath, "../outside.txt"),
    (error: unknown) => error instanceof LocalObserveError && error.statusCode === 403,
  );

  console.log("Local write tests passed: pending request, approval write, base-hash conflict, reject, sensitive/path guards.");
} finally {
  if (rootId) await getPrisma().localAccessRoot.delete({ where: { id: rootId } }).catch(() => {});
  fs.rmSync(rootPath, { recursive: true, force: true });
  await getPrisma().$disconnect().catch(() => {});
}
