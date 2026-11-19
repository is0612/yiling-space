import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma } from "../server/utils/prisma";
import { approveLocalWriteRequest, createLocalWriteRequest } from "../server/utils/local-write";
import {
  cancelLocalTask,
  createLocalTask,
  getLocalTask,
  recordLocalTaskEvidence,
} from "../server/utils/local-tasks";

const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "yiling-local-task-"));
const actorId = randomUUID();
let rootId = "";

try {
  const prisma = getPrisma();
  const root = await prisma.localAccessRoot.create({
    data: { path: rootPath, label: "task-test", mode: "READ_WRITE" },
  });
  rootId = root.id;
  const task = await createLocalTask({
    title: "测试任务",
    goal: "写一个文件并验收",
    plan: "1. 写 notes/a.txt\n2. 检查内容",
    actorId,
  });
  assert.equal(task.status, "PLANNED");

  const write = await createLocalWriteRequest({
    rootId, relativePath: "a.txt", content: "task\n", reason: "task test", actorId, taskId: task.id,
  });
  assert.equal((await getLocalTask(task.id)).status, "WAITING_APPROVAL");
  await approveLocalWriteRequest(write.id, actorId);
  assert.equal((await getLocalTask(task.id)).status, "RUNNING");
  assert.equal(fs.readFileSync(path.join(rootPath, "a.txt"), "utf8"), "task\n");

  const result = await recordLocalTaskEvidence(task.id, {
    outcome: "PASS", note: "文件内容正确", actorId,
  });
  assert.equal(result.task.status, "SUCCEEDED");
  assert.equal(result.task.evidence.length, 1);

  const cancelled = await createLocalTask({ title: "取消任务", goal: "g", plan: "p", actorId });
  assert.equal((await cancelLocalTask(cancelled.id, actorId)).status, "CANCELLED");
  await assert.rejects(
    () => recordLocalTaskEvidence(cancelled.id, { outcome: "PASS", note: "x", actorId }),
    /已取消/,
  );

  console.log("Local task tests passed: create, link write, approval status, evidence acceptance, cancel guard.");
} finally {
  if (rootId) await getPrisma().localAccessRoot.delete({ where: { id: rootId } }).catch(() => {});
  fs.rmSync(rootPath, { recursive: true, force: true });
  await getPrisma().$disconnect().catch(() => {});
}
