import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma } from "../server/utils/prisma";
import { approveLocalWriteRequest, createLocalWriteRequest } from "../server/utils/local-write";
import { approveLocalCommandRequest, createLocalCommandRequest } from "../server/utils/local-command";
import {
  cancelLocalTask,
  createLocalTask,
  getLocalTask,
  recordLocalTaskEvidence,
  setLocalTaskSteps,
  updateLocalTaskStep,
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
  const pendingWrite = await createLocalWriteRequest({ rootId, taskId: cancelled.id, relativePath: "cancelled.txt", content: "not applied", reason: "cancel test", actorId });
  const pendingCommand = await createLocalCommandRequest({ rootId, taskId: cancelled.id, command: "node", args: ["--version"], cwd: "", reason: "cancel test", actorId });
  await assert.rejects(() => recordLocalTaskEvidence(cancelled.id, { outcome: "PASS", note: "premature", actorId }), /先处理待审批/);
  assert.equal((await getLocalTask(cancelled.id)).evidence.length, 0);
  assert.equal((await cancelLocalTask(cancelled.id, actorId)).status, "CANCELLED");
  assert.equal((await prisma.localWriteRequest.findUniqueOrThrow({ where: { id: pendingWrite.id } })).status, "REJECTED");
  assert.equal((await prisma.localCommandRequest.findUniqueOrThrow({ where: { id: pendingCommand.id } })).status, "REJECTED");
  await assert.rejects(() => approveLocalWriteRequest(pendingWrite.id, actorId), /已经处理过/);
  await assert.rejects(() => approveLocalCommandRequest(pendingCommand.id, actorId), /已经处理过/);
  assert.equal(fs.existsSync(path.join(rootPath, "cancelled.txt")), false);
  await assert.rejects(() => recordLocalTaskEvidence(task.id, { outcome: "FAIL", note: "not replaceable", actorId }), /已结束/);
  await assert.rejects(() => createLocalCommandRequest({ rootId, taskId: cancelled.id, command: "node", args: ["--version"], cwd: "", reason: "closed", actorId }), /已取消/);
  await assert.rejects(
    () => recordLocalTaskEvidence(cancelled.id, { outcome: "PASS", note: "x", actorId }),
    /已取消/,
  );

  const race = await createLocalTask({ title: "验收竞态", goal: "g", plan: "p", actorId });
  const decisions = await Promise.allSettled([
    recordLocalTaskEvidence(race.id, { outcome: "PASS", note: "pass", actorId }),
    recordLocalTaskEvidence(race.id, { outcome: "FAIL", note: "fail", actorId }),
  ]);
  assert.equal(decisions.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await getLocalTask(race.id)).evidence.length, 1);
  const active = await createLocalTask({ title: "执行中", goal: "g", plan: "p", actorId });
  const claimed = await createLocalWriteRequest({ rootId, taskId: active.id, relativePath: "in-flight.txt", content: "test", reason: "test", actorId });
  await prisma.localWriteRequest.update({ where: { id: claimed.id }, data: { status: "APPROVING" } });
  await assert.rejects(() => cancelLocalTask(active.id, actorId), /正在执行/);

  const multi = await createLocalTask({ title: "多步骤", goal: "g", plan: "p", actorId });
  await setLocalTaskSteps(multi.id, ["准备文本", "检查结果"], actorId);
  assert.deepEqual((await getLocalTask(multi.id)).steps.map(step => step.status), ["TODO", "BLOCKED"]);
  await assert.rejects(() => updateLocalTaskStep(multi.id, { index: 1, action: "done", note: "too early" }, actorId), /前面的步骤/);
  await assert.rejects(() => recordLocalTaskEvidence(multi.id, { outcome: "PASS", note: "too early", actorId }), /所有步骤/);
  const multiWrite = await createLocalWriteRequest({ rootId, taskId: multi.id, relativePath: "step.txt", content: "fixture", reason: "test", actorId });
  await updateLocalTaskStep(multi.id, { index: 0, action: "link", kind: "write", requestId: multiWrite.id }, actorId);
  assert.equal((await getLocalTask(multi.id)).steps[0]?.status, "WAITING_APPROVAL");
  await approveLocalWriteRequest(multiWrite.id, actorId);
  assert.deepEqual((await getLocalTask(multi.id)).steps.map(step => step.status), ["DONE", "TODO"]);
  await updateLocalTaskStep(multi.id, { index: 1, action: "done", note: "文件已核对", }, actorId);
  assert.equal((await recordLocalTaskEvidence(multi.id, { outcome: "PASS", note: "通过", actorId })).task.status, "SUCCEEDED");
  const content = "牛奶\n鸡蛋\n面包\n";
  const proposal = await createLocalWriteRequest({ rootId, relativePath: "采购清单.txt", content, reason: "采购清单", actorId,
    taskPlan: { title: "采购清单", goal: "创建三项清单", acceptance: "包含牛奶、鸡蛋和面包，每项一行。" } });
  assert.ok(proposal.taskId);
  const taskId = proposal.taskId;
  const proposedTask = await getLocalTask(taskId);
  assert.match(proposedTask.plan, /包含牛奶、鸡蛋和面包/);
  assert.deepEqual(proposedTask.steps.map(step => step.status), ["WAITING_APPROVAL", "BLOCKED"]);
  assert.equal(fs.existsSync(path.join(rootPath, "采购清单.txt")), false);
  const approved = await approveLocalWriteRequest(proposal.id, actorId);
  assert.equal(approved.readback?.preview, content);
  assert.equal(approved.readback?.matches, true);
  assert.equal(fs.readFileSync(path.join(rootPath, "采购清单.txt"), "utf8"), content);
  const readBackTask = await getLocalTask(taskId);
  assert.deepEqual(readBackTask.steps.map(step => step.status), ["DONE", "DONE"]);
  assert.equal(readBackTask.status, "RUNNING", "readback is not user acceptance");
  assert.ok(readBackTask.evidence.some(item => item.kind === "WRITE_READBACK" && item.outcome === "PASS" && item.note.endsWith(content)));
  assert.equal((await recordLocalTaskEvidence(taskId, { outcome: "PASS", note: "三项齐全", actorId })).task.status, "SUCCEEDED");
  console.log("Local task tests passed: approvals, cancellation, ordered steps and shopping list readback.");
} finally {
  if (rootId) await getPrisma().localAccessRoot.delete({ where: { id: rootId } }).catch(() => {});
  await getPrisma().localTask.deleteMany({ where: { actorId } }).catch(() => {});
  fs.rmSync(rootPath, { recursive: true, force: true });
  await getPrisma().$disconnect().catch(() => {});
}
