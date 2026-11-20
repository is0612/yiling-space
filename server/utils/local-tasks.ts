import { auditLocalObserve, LocalObserveError } from "./local-observe";
import { getPrisma } from "./prisma";
import type { Prisma } from "../../src/generated/prisma/client";

const closedTaskStatuses = new Set(["CANCELLED", "SUCCEEDED", "FAILED"]);

/** Serialize task decisions with the creation and claiming of its approval requests. */
async function lockTask(tx: Prisma.TransactionClient, id: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new LocalObserveError(404, "任务不存在。");
  const [task] = await tx.$queryRaw<Array<{ status: string; actorId: string; steps: Prisma.JsonValue }>>`
    SELECT "status", "actorId", "steps" FROM "local_tasks" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (!task) throw new LocalObserveError(404, "任务不存在。");
  if (closedTaskStatuses.has(task.status)) throw new LocalObserveError(409, "任务已结束或已取消，不能再操作。");
  return task;
}

export async function lockLocalTaskForApproval(tx: Prisma.TransactionClient, id: string | null | undefined, proposalActor?: string) {
  if (!id) return;
  const task = await lockTask(tx, id);
  if (proposalActor && task.actorId !== proposalActor) throw new LocalObserveError(404, "任务不存在。");
}

async function hasTaskRequests(tx: Prisma.TransactionClient, taskId: string, statuses: string[]) {
  const where = { taskId, status: { in: statuses } };
  return Boolean(await tx.localWriteRequest.findFirst({ where, select: { id: true } })
    || await tx.localCommandRequest.findFirst({ where, select: { id: true } }));
}

export type LocalTaskStatus = "PLANNED" | "WAITING_APPROVAL" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

const TASK_STATUSES = new Set<LocalTaskStatus>(["PLANNED", "WAITING_APPROVAL", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);

export type LocalTaskInput = {
  title: string;
  goal: string;
  plan: string;
  actorId: string;
  characterId?: string;
  conversationId?: string;
};

function cleanText(value: unknown, max: number, field: string) {
  if (typeof value !== "string") throw new LocalObserveError(400, `${field}必须是字符串。`);
  const text = value.trim();
  if (!text) throw new LocalObserveError(400, `${field}不能为空。`);
  return text.slice(0, max);
}

type LocalTaskStep = {
  title: string;
  state: "TODO" | "DONE" | "FAILED";
  request?: { kind: "write" | "command"; id: string };
  note?: string;
  verifyWriteId?: string;
};

function taskSteps(value: Prisma.JsonValue): LocalTaskStep[] {
  // This JSON field is written only by the validated step operations below.
  return Array.isArray(value) ? value as unknown as LocalTaskStep[] : [];
}

function stepStatus(step: LocalTaskStep, requests: { write: Map<string, string>; command: Map<string, string> }, cancelled = false) {
  if (!step.request) return step.state === "TODO" && cancelled ? "CANCELLED" : step.state;
  const status = requests[step.request.kind].get(step.request.id);
  if (status === "APPLIED" || status === "SUCCEEDED") return "DONE";
  if (status === "APPROVING") return "RUNNING";
  if (cancelled && (status === "PENDING" || status === "REJECTED")) return "CANCELLED";
  return status === "PENDING" ? "WAITING_APPROVAL" : "FAILED";
}

async function stepRequests(tx: Prisma.TransactionClient, taskId: string) {
  const where = { taskId };
  const select = { id: true, status: true } as const;
  const writes = await tx.localWriteRequest.findMany({ where, select });
  const commands = await tx.localCommandRequest.findMany({ where, select });
  return { write: new Map(writes.map(row => [row.id, row.status])), command: new Map(commands.map(row => [row.id, row.status])) };
}

export async function setLocalTaskSteps(id: string, titles: unknown, actorId: string) {
  if (!Array.isArray(titles) || titles.length < 1 || titles.length > 20
    || titles.some(title => typeof title !== "string" || !title.trim() || title.trim().length > 160)) {
    throw new LocalObserveError(400, "请提供 1 至 20 个步骤，每个标题最多 160 字。");
  }
  const steps: LocalTaskStep[] = titles.map(title => ({ title: title.trim(), state: "TODO" }));
  await getPrisma().$transaction(async tx => {
    const task = await lockTask(tx, id);
    if (taskSteps(task.steps).length) throw new LocalObserveError(409, "已建立步骤，不能覆盖现有记录。");
    await tx.localTask.update({ where: { id }, data: { steps } });
  });
  auditLocalObserve(actorId, "task.steps", { taskId: id, count: steps.length });
  return getLocalTask(id);
}

export async function updateLocalTaskStep(id: string, input: { index: unknown; action: unknown; note?: unknown; kind?: unknown; requestId?: unknown }, actorId: string) {
  const { index, action, kind, requestId } = input;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new LocalObserveError(400, "步骤编号无效。");
  await getPrisma().$transaction(async tx => {
    const task = await lockTask(tx, id);
    const steps = taskSteps(task.steps);
    const step = steps[index];
    if (!step) throw new LocalObserveError(404, "步骤不存在。");
    if (step.verifyWriteId) throw new LocalObserveError(409, "此步骤由系统读回写入结果后更新。");
    const requests = await stepRequests(tx, id);
    if (steps.findIndex(item => stepStatus(item, requests) !== "DONE") !== index) throw new LocalObserveError(409, "请先完成前面的步骤。");
    if (action === "link") {
      if (step.request || step.state !== "TODO") throw new LocalObserveError(409, "该步骤已经关联审批或已有结论。");
      if ((kind !== "write" && kind !== "command") || typeof requestId !== "string"
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) throw new LocalObserveError(400, "审批请求无效。");
      if (steps.some(item => item.request?.kind === kind && item.request.id === requestId)) throw new LocalObserveError(409, "该请求已关联其他步骤。");
      const where = { id: requestId, taskId: id };
      const row = kind === "write" ? await tx.localWriteRequest.findFirst({ where }) : await tx.localCommandRequest.findFirst({ where });
      if (!row) throw new LocalObserveError(404, "只能关联当前任务里的审批请求。");
      step.request = { kind, id: requestId };
    } else if (action === "done" || action === "fail") {
      if (step.state !== "TODO" || step.request) throw new LocalObserveError(409, "已关联审批的步骤由审批结果更新。");
      step.note = cleanText(input.note, 1000, "步骤说明");
      step.state = action === "done" ? "DONE" : "FAILED";
    } else {
      throw new LocalObserveError(400, "步骤操作无效。");
    }
    await tx.localTask.update({ where: { id }, data: { steps } });
  });
  auditLocalObserve(actorId, "task.steps", { taskId: id, index, action });
  return getLocalTask(id);
}

export async function attachContinuationWrite(tx: Prisma.TransactionClient, taskId: string, writeId: string, file: string) {
  const task = await lockTask(tx, taskId);
  const steps = taskSteps(task.steps);
  const requests = await stepRequests(tx, taskId);
  const index = steps.findIndex(step => stepStatus(step, requests) !== "DONE");
  const write = { title: `写入 ${file}`, state: "TODO" as const, request: { kind: "write" as const, id: writeId } };
  const verify = { title: "读回文件，核对保存内容", state: "TODO" as const, verifyWriteId: writeId };
  if (index === -1) steps.push(write, verify);
  else {
    const current = steps[index]!;
    if (current.state !== "TODO" || current.request || current.verifyWriteId) throw new LocalObserveError(409, "当前步骤需要先处理，不能跳过。");
    steps[index] = { ...current, request: write.request };
    steps.splice(index + 1, 0, verify);
  }
  if (steps.length > 20) throw new LocalObserveError(409, "步骤已达上限，请建立新任务。");
  await tx.localTask.update({ where: { id: taskId }, data: { steps } });
}

export async function recordWriteReadback(tx: Prisma.TransactionClient, taskId: string, writeId: string, actorId: string, result: {
  path: string; matches: boolean; preview?: string; truncated?: boolean;
}) {
  const task = await lockTask(tx, taskId);
  const steps = taskSteps(task.steps);
  const step = steps.find(item => item.verifyWriteId === writeId);
  if (!step) return false;
  step.state = result.matches ? "DONE" : "FAILED";
  step.note = result.matches ? "已从磁盘读回，与批准的内容一致。" : "未能确认磁盘内容与批准的内容一致。";
  await tx.localTask.update({ where: { id: taskId }, data: { steps } });
  await tx.localTaskEvidence.create({ data: { taskId, actorId, kind: "WRITE_READBACK", outcome: result.matches ? "PASS" : "FAIL",
    note: [result.path, step.note, ...(result.preview === undefined ? [] : [result.preview + (result.truncated ? "\n（预览已截断）" : "")])].join("\n") } });
  return true;
}

export async function createLocalTask(input: LocalTaskInput) {
  const title = cleanText(input.title, 200, "标题");
  const goal = cleanText(input.goal, 4000, "目标");
  const plan = cleanText(input.plan, 8000, "计划");
  const task = await getPrisma().localTask.create({
    data: {
      title,
      goal,
      plan,
      actorId: input.actorId,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
  });
  auditLocalObserve(input.actorId, "task.create", { taskId: task.id, title });
  return task;
}

export async function listLocalTasks(status = "") {
  const normalized = status && TASK_STATUSES.has(status as LocalTaskStatus) ? status : "";
  return await getPrisma().localTask.findMany({
    where: normalized ? { status: normalized } : {},
    orderBy: [{ createdAt: "desc" }],
    take: 50,
    include: { _count: { select: { writeRequests: true, evidence: true } } },
  });
}

export async function getLocalTask(id: string) {
  const task = await getPrisma().localTask.findUnique({
    where: { id },
    include: {
      writeRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true, relativePath: true, status: true, reason: true, createdAt: true,
          root: { select: { id: true, label: true, path: true, mode: true } },
        },
      },
      commandRequests: { orderBy: { createdAt: "desc" }, select: { id: true, status: true, command: true, cwd: true, root: { select: { label: true } } } },
      evidence: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!task) throw new LocalObserveError(404, "任务不存在。");
  const requests = {
    write: new Map(task.writeRequests.map(row => [row.id, row.status])),
    command: new Map(task.commandRequests.map(row => [row.id, row.status])),
  };
  let blocked = false;
  const steps = taskSteps(task.steps).map(step => {
    const actual = stepStatus(step, requests, task.status === "CANCELLED");
    const status = blocked && actual === "TODO" ? "BLOCKED" : actual;
    blocked ||= actual !== "DONE";
    return { ...step, status };
  });
  return { ...task, steps };
}

export async function recordLocalTaskEvidence(id: string, input: {
  outcome: unknown;
  note: unknown;
  actorId: string;
}) {
  const outcome = input.outcome;
  if (outcome !== "PASS" && outcome !== "FAIL" && outcome !== "INFO") {
    throw new LocalObserveError(400, "验收结果只能是 PASS / FAIL / INFO。");
  }
  const note = cleanText(input.note, 4000, "验收说明");
  const kind = "MANUAL";
  const evidence = await getPrisma().$transaction(async tx => {
    const task = await lockTask(tx, id);
    const steps = taskSteps(task.steps);
    if (outcome === "PASS" && steps.length) {
      const requests = await stepRequests(tx, id);
      if (steps.some(step => stepStatus(step, requests) !== "DONE")) throw new LocalObserveError(409, "所有步骤完成后才能验收通过。");
    }
    if (outcome !== "INFO") {
      if (await hasTaskRequests(tx, id, ["PENDING", "APPROVING"])) {
        throw new LocalObserveError(409, "先处理待审批或正在执行的请求，再验收任务。");
      }
      await tx.localTask.update({
        where: { id },
        data: { status: outcome === "PASS" ? "SUCCEEDED" : "FAILED", resultNote: note.slice(0, 1000), completedAt: new Date() },
      });
    }
    return tx.localTaskEvidence.create({ data: { taskId: id, kind, outcome, note, actorId: input.actorId } });
  });
  auditLocalObserve(input.actorId, "task.evidence", { taskId: id, outcome, kind });
  return { evidence, task: await getLocalTask(id) };
}

/** 命令执行的自动证据：只追加，不替管理员做最终验收。 */
export async function appendCommandEvidence(input: {
  taskId: string;
  outcome: "PASS" | "FAIL";
  note: string;
  actorId: string;
}) {
  const task = await getPrisma().localTask.findUnique({ where: { id: input.taskId }, select: { id: true, status: true } });
  if (!task || task.status === "CANCELLED") return;
  await getPrisma().localTaskEvidence.create({
    data: {
      taskId: input.taskId,
      kind: "COMMAND",
      outcome: input.outcome,
      note: input.note.slice(0, 8000),
      actorId: input.actorId,
    },
  });
  auditLocalObserve(input.actorId, "task.evidence", {
    taskId: input.taskId, outcome: input.outcome, kind: "COMMAND",
  });
}

/** 网页操作的自动证据：同样只追加，最终验收仍由管理员决定。 */
export async function appendBrowserEvidence(input: {
  taskId: string;
  outcome: "PASS" | "FAIL";
  note: string;
  actorId: string;
}) {
  const task = await getPrisma().localTask.findUnique({ where: { id: input.taskId }, select: { id: true, status: true } });
  if (!task || task.status === "CANCELLED") return;
  await getPrisma().localTaskEvidence.create({
    data: {
      taskId: input.taskId,
      kind: "BROWSER",
      outcome: input.outcome,
      note: input.note.slice(0, 8000),
      actorId: input.actorId,
    },
  });
  auditLocalObserve(input.actorId, "task.evidence", { taskId: input.taskId, outcome: input.outcome, kind: "BROWSER" });
}

export async function cancelLocalTask(id: string, actorId: string) {
  const revoked = await getPrisma().$transaction(async tx => {
    await lockTask(tx, id);
    if (await hasTaskRequests(tx, id, ["APPROVING"])) throw new LocalObserveError(409, "任务正在执行，请等待执行结束再取消。");
    const decidedAt = new Date();
    const data = { status: "REJECTED", decidedAt, error: "任务已取消，待审批请求已撤销。" };
    const writes = await tx.localWriteRequest.updateMany({ where: { taskId: id, status: "PENDING" }, data });
    const commands = await tx.localCommandRequest.updateMany({ where: { taskId: id, status: "PENDING" }, data });
    await tx.localTask.update({ where: { id }, data: { status: "CANCELLED", completedAt: decidedAt } });
    return { writes: writes.count, commands: commands.count };
  });
  auditLocalObserve(actorId, "task.cancel", { taskId: id, revoked });
  return await getLocalTask(id);
}
