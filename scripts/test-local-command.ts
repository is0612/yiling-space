import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma } from "../server/utils/prisma";
import { createLocalTask, getLocalTask } from "../server/utils/local-tasks";
import {
  approveLocalCommandRequest,
  createGitBranchRequest,
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

  await assert.rejects(
    () => createLocalCommandRequest({ rootId, command: "git", args: ["status"], cwd: "", reason: "test", actorId }),
    /允许列表/,
  );
  const legacy = await prisma.localCommandRequest.create({ data: { rootId, command: "git", args: ["status"], cwd: "", reason: "test", actorId } });
  await assert.rejects(() => approveLocalCommandRequest(legacy.id, actorId), /允许列表/);
  assert.equal((await prisma.localCommandRequest.findUniqueOrThrow({ where: { id: legacy.id } })).status, "FAILED");

  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd: rootPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "--allow-empty", "-qm", "initial");
  const branch = await createGitBranchRequest({ rootId, taskId: task.id, branch: "work/notes", cwd: "", reason: "test", actorId });
  assert.equal(branch.status, "PENDING");
  assert.equal(git("branch", "--list", "work/notes"), "");
  assert.equal((await approveLocalCommandRequest(branch.id, actorId)).status, "SUCCEEDED");
  assert.match(git("branch", "--list", "work/notes"), /work\/notes/);
  assert.equal(git("branch", "--show-current"), "main");
  assert.ok((await getLocalTask(task.id)).evidence.some(item => item.kind === "COMMAND" && item.note.includes("work/notes")));
  const stale = await createGitBranchRequest({ rootId, branch: "work/stale", cwd: "", reason: "test", actorId });
  git("commit", "--allow-empty", "-qm", "next");
  await assert.rejects(() => approveLocalCommandRequest(stale.id, actorId), /当前提交已变化/);
  assert.equal(git("branch", "--list", "work/stale"), "");
  const disabled = await createGitBranchRequest({ rootId, branch: "work/disabled", cwd: "", reason: "test", actorId });
  await prisma.localAccessRoot.update({ where: { id: rootId }, data: { enabled: false } });
  await assert.rejects(() => approveLocalCommandRequest(disabled.id, actorId), /已停用/);
  assert.equal(git("branch", "--list", "work/disabled"), "");

  console.log("Local command tests passed: approval lifecycle, evidence, generic Git rejection and approved branch creation.");
} finally {
  if (rootId) await getPrisma().localAccessRoot.delete({ where: { id: rootId } }).catch(() => {});
  fs.rmSync(rootPath, { recursive: true, force: true });
  await getPrisma().$disconnect().catch(() => {});
}
