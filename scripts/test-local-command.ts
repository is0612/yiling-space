import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma } from "../server/utils/prisma";
import { createLocalTask, getLocalTask } from "../server/utils/local-tasks";
import {
  approveLocalCommandRequest,
  createLocalCommandRequest,
  rejectLocalCommandRequest,
} from "../server/utils/local-command";

const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "yiling-local-command-"));
const actorId = randomUUID();
let rootId = "";

try {
  const prisma = getPrisma();
  const root = await prisma.localAccessRoot.create({
    data: { path: rootPath, label: "command-test", mode: "READ_WRITE" },
  });
  rootId = root.id;
  const task = await createLocalTask({ title: "命令验收", goal: "跑一个命令", plan: "node -e", actorId });

  const request = await createLocalCommandRequest({
    rootId, taskId: task.id, command: "node", args: ["-e", "console.log('ok')"], cwd: "", reason: "test", actorId,
  });
  assert.equal(request.status, "PENDING");
  const approved = await approveLocalCommandRequest(request.id, actorId);
  assert.equal(approved.status, "SUCCEEDED");
  assert.match(approved.stdout ?? "", /ok/);
  const withEvidence = await getLocalTask(task.id);
  assert.ok(withEvidence.evidence.some((item) => item.kind === "COMMAND" && item.outcome === "PASS"));
  assert.equal(withEvidence.status, "PLANNED");

  const failed = await createLocalCommandRequest({
    rootId, command: "node", args: ["-e", "process.exit(3)"], cwd: "", reason: "fail", actorId,
  });
  assert.equal((await approveLocalCommandRequest(failed.id, actorId)).status, "FAILED");

  const rejected = await createLocalCommandRequest({
    rootId, command: "node", args: ["-e", "1"], cwd: "", reason: "reject", actorId,
  });
  assert.equal((await rejectLocalCommandRequest(rejected.id, actorId, "no")).status, "REJECTED");

  await assert.rejects(
    () => createLocalCommandRequest({ rootId, command: "cmd", args: [], cwd: "", reason: "x", actorId }),
    /允许列表/,
  );

  console.log("Local command tests passed: pending, approval, stdout, exit code, evidence append, reject and allowlist.");
} finally {
  if (rootId) await getPrisma().localAccessRoot.delete({ where: { id: rootId } }).catch(() => {});
  fs.rmSync(rootPath, { recursive: true, force: true });
  await getPrisma().$disconnect().catch(() => {});
}
