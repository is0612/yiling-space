import { randomUUID } from "node:crypto";
import { createSession, hashSessionToken } from "./auth";
import { auditLocalObserve } from "./local-observe";
import { getPrisma } from "./prisma";

/** Hard ceiling regardless of configuration: an unattended loop must always end. */
export const AUTO_CONTINUE_MAX_ROUNDS = 5;
const MAX_ATTEMPTS = Number(process.env.YILING_AUTO_CONTINUE_MAX_ROUNDS ?? 3);

export function autoContinueEnabled() {
  return process.env.YILING_AUTO_CONTINUE === "1";
}

export function autoContinueLimit() {
  return Number.isFinite(MAX_ATTEMPTS) && MAX_ATTEMPTS > 0 ? Math.min(Math.trunc(MAX_ATTEMPTS), AUTO_CONTINUE_MAX_ROUNDS) : 3;
}

export const AUTO_CONTINUE_PROMPT = "继续这个任务。先读取当前任务的执行结果，不要重复已经完成的动作；如果还有下一步，提出需要我审批的申请；如果已经完成，只说明结果，等我验收。";

type Verdict = { run: true; conversationId: string; characterId: string; url: string } | { run: false; reason: string };

/**
 * Decides whether one unattended round may start. Everything here is a refusal by default:
 * the switch is off, the task is closed, work is still pending, or the round budget is spent.
 */
export async function planAutoContinue(taskId: string): Promise<Verdict> {
  if (!autoContinueEnabled()) return { run: false, reason: "disabled" };
  const task = await getPrisma().localTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, autoContinue: true, autoRounds: true, conversationId: true, characterId: true },
  });
  if (!task) return { run: false, reason: "missing" };
  if (!task.autoContinue) return { run: false, reason: "task_off" };
  if (["SUCCEEDED", "FAILED", "CANCELLED", "WAITING_APPROVAL"].includes(task.status)) return { run: false, reason: `task_${task.status.toLowerCase()}` };
  if (!task.conversationId || !task.characterId) return { run: false, reason: "no_conversation" };
  if (task.autoRounds >= autoContinueLimit()) return { run: false, reason: "round_limit" };
  const db = getPrisma();
  const [writes, commands, browsers] = await Promise.all([
    db.localWriteRequest.count({ where: { taskId, status: { in: ["PENDING", "APPROVING"] } } }),
    db.localCommandRequest.count({ where: { taskId, status: { in: ["PENDING", "APPROVING"] } } }),
    db.localBrowserRequest.count({ where: { taskId, status: { in: ["PENDING", "APPROVING", "FILLED"] } } }),
  ]);
  if (writes || commands || browsers) return { run: false, reason: "pending_approval" };
  const port = process.env.PORT || "3000";
  return { run: true, conversationId: task.conversationId, characterId: task.characterId, url: `http://127.0.0.1:${port}` };
}

/**
 * Runs at most one unattended round. The counter is claimed first, so two approvals finishing at the same
 * time cannot both start a round. The request goes through the same authenticated chat endpoint as the UI.
 */
export async function runAutoContinue(taskId: string, actorId: string) {
  const plan = await planAutoContinue(taskId);
  if (!plan.run) {
    if (plan.reason !== "disabled") auditLocalObserve(actorId, "task.auto", { taskId, status: "skipped", reason: plan.reason });
    return { started: false, reason: plan.reason };
  }
  const claimed = await getPrisma().localTask.updateMany({
    where: { id: taskId, autoRounds: { lt: autoContinueLimit() } },
    data: { autoRounds: { increment: 1 } },
  });
  if (claimed.count !== 1) return { started: false, reason: "round_limit" };

  let sessionToken = "";
  try {
    const session = await createSession({ userId: actorId, userAgent: "yiling-auto-continue" });
    sessionToken = session.token;
    const response = await fetch(`${plan.url}/api/characters/${plan.characterId}/chat`, {
      method: "POST",
      // The cookie name follows the same environment switch the rest of the app uses (desktop sets its own).
      headers: { "content-type": "application/json", cookie: `${process.env.YILING_SESSION_COOKIE || "yiling_session"}=${sessionToken}` },
      body: JSON.stringify({ requestKey: randomUUID(), conversationId: plan.conversationId, localTaskId: taskId, message: AUTO_CONTINUE_PROMPT }),
    });
    const ok = response.ok;
    auditLocalObserve(actorId, "task.auto", { taskId, status: ok ? "ran" : "failed", code: response.status });
    return { started: true, ok, status: response.status };
  } catch (error) {
    auditLocalObserve(actorId, "task.auto", { taskId, status: "failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return { started: true, ok: false };
  } finally {
    // The self-call session lives for seconds; removing it keeps no standing credential behind.
    if (sessionToken) await getPrisma().session.deleteMany({ where: { tokenHash: hashSessionToken(sessionToken) } }).catch(() => {});
  }
}

/** Fire-and-forget from approval paths: never delay or fail the approval itself. */
export function scheduleAutoContinue(taskId: string | null | undefined, actorId: string) {
  if (!taskId || !autoContinueEnabled()) return;
  void runAutoContinue(taskId, actorId).catch(() => {});
}
