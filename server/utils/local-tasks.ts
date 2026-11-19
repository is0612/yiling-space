import { auditLocalObserve, LocalObserveError } from "./local-observe";
import { getPrisma } from "./prisma";

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
      evidence: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!task) throw new LocalObserveError(404, "任务不存在。");
  return task;
}

export async function recordLocalTaskEvidence(id: string, input: {
  outcome: unknown;
  note: unknown;
  kind?: unknown;
  actorId: string;
}) {
  const outcome = input.outcome;
  if (outcome !== "PASS" && outcome !== "FAIL" && outcome !== "INFO") {
    throw new LocalObserveError(400, "验收结果只能是 PASS / FAIL / INFO。");
  }
  const note = cleanText(input.note, 4000, "验收说明");
  const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim().slice(0, 20) : "MANUAL";
  const task = await getLocalTask(id);
  if (task.status === "CANCELLED") throw new LocalObserveError(409, "已取消的任务不能再记验收。");
  const evidence = await getPrisma().localTaskEvidence.create({
    data: { taskId: id, kind, outcome, note, actorId: input.actorId },
  });
  const status: LocalTaskStatus = outcome === "PASS" ? "SUCCEEDED" : outcome === "FAIL" ? "FAILED" : task.status as LocalTaskStatus;
  await getPrisma().localTask.update({
    where: { id },
    data: {
      status,
      resultNote: note.slice(0, 1000),
      ...(outcome === "PASS" || outcome === "FAIL" ? { completedAt: new Date() } : {}),
    },
  });
  auditLocalObserve(input.actorId, "task.evidence", { taskId: id, outcome, kind });
  return { evidence, task: await getLocalTask(id) };
}

export async function cancelLocalTask(id: string, actorId: string) {
  const task = await getLocalTask(id);
  if (task.status === "SUCCEEDED" || task.status === "FAILED") {
    throw new LocalObserveError(409, "已完成的任务不能取消。");
  }
  await getPrisma().localTask.update({
    where: { id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  auditLocalObserve(actorId, "task.cancel", { taskId: id });
  return await getLocalTask(id);
}

/** 写请求创建/批准时推动任务状态；不覆盖已完成的验收状态。 */
export async function advanceTaskForWrite(taskId: string | null | undefined, status: "WAITING_APPROVAL" | "RUNNING") {
  if (!taskId) return;
  const task = await getPrisma().localTask.findUnique({ where: { id: taskId }, select: { status: true } });
  if (!task || task.status === "SUCCEEDED" || task.status === "FAILED" || task.status === "CANCELLED") return;
  await getPrisma().localTask.update({ where: { id: taskId }, data: { status } }).catch(() => {});
}
