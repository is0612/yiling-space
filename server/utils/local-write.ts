import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  auditLocalObserve,
  LocalObserveError,
  validateLocalWritablePath,
  type LocalObserveRoot,
} from "./local-observe";
import { lockLocalTaskForApproval, recordWriteReadback } from "./local-tasks";
import { getPrisma } from "./prisma";

export const LOCAL_WRITE_MAX_BYTES = 32 * 1024;
const MAX_EXISTING_BYTES = 2 * 1024 * 1024;

export type LocalWriteRequestInput = {
  rootId: string;
  relativePath: string;
  content: string;
  reason: string;
  actorId: string;
  characterId?: string;
  conversationId?: string;
  taskId?: string;
  /** A chat proposal owns a new task; neither is saved without the other. */
  taskPlan?: { title: string; goal: string; acceptance: string };
};

function hashContent(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex");
}

async function writableRoot(rootId: string): Promise<LocalObserveRoot> {
  if (!/^[0-9a-f-]{36}$/i.test(rootId)) throw new LocalObserveError(404, "授权目录不存在。");
  const row = await getPrisma().localAccessRoot.findUnique({ where: { id: rootId } });
  if (!row) throw new LocalObserveError(404, "授权目录不存在。");
  if (!row.enabled) throw new LocalObserveError(403, "这个授权目录已停用。");
  if (row.mode !== "READ_WRITE") throw new LocalObserveError(403, "这个目录没有开启写权限。");
  return { id: row.id, label: row.label, path: row.path, mode: "READ_WRITE", enabled: true, builtin: false };
}

export async function createLocalWriteRequest(input: LocalWriteRequestInput) {
  if (typeof input.content !== "string") throw new LocalObserveError(400, "content 必须是字符串。");
  if (!input.content.trim()) throw new LocalObserveError(400, "不能写入空内容。");
  if (Buffer.byteLength(input.content, "utf8") > LOCAL_WRITE_MAX_BYTES) {
    throw new LocalObserveError(413, `一次最多写入 ${LOCAL_WRITE_MAX_BYTES / 1024} KB。`);
  }
  if (input.content.includes("\0")) throw new LocalObserveError(400, "文本内容不能包含 NUL。");
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new LocalObserveError(400, "写文件必须说明原因。");
  const root = await writableRoot(input.rootId);
  const target = validateLocalWritablePath(root.path, input.relativePath);
  if (target.exists && target.size > MAX_EXISTING_BYTES) {
    throw new LocalObserveError(413, "目标文件超过 2 MB，暂不支持覆盖。");
  }
  const baseHash = target.exists ? hashContent(fs.readFileSync(target.real)) : null;
  const plan = input.taskPlan;
  if (plan && (input.taskId || !plan.title.trim() || !plan.goal.trim() || !plan.acceptance.trim())) {
    throw new LocalObserveError(400, "新任务必须包含标题、目标和验收标准，不能同时指定已有任务。");
  }
  const request = await getPrisma().$transaction(async tx => {
    await lockLocalTaskForApproval(tx, input.taskId, input.actorId);
    const taskId = plan ? (await tx.localTask.create({ data: {
      title: plan.title.trim().slice(0, 200), goal: plan.goal.trim().slice(0, 4000),
      plan: `1. 审批后写入 ${target.relative}\n2. 读回文件，核对是否与批准的内容一致\n\n验收标准：${plan.acceptance.trim().slice(0, 1000)}`,
      actorId: input.actorId, characterId: input.characterId, conversationId: input.conversationId,
      status: "WAITING_APPROVAL",
    } })).id : input.taskId;
    const created = await tx.localWriteRequest.create({ data: {
      rootId: root.id,
      relativePath: target.relative,
      content: input.content,
      reason,
      baseHash,
      actorId: input.actorId,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(taskId ? { taskId } : {}),
    } });
    if (taskId) await tx.localTask.update({ where: { id: taskId }, data: {
      status: "WAITING_APPROVAL",
      ...(plan ? { steps: [
        { title: `写入 ${target.relative}`, state: "TODO", request: { kind: "write", id: created.id } },
        { title: "读回文件，核对保存内容", state: "TODO", verifyWriteId: created.id },
      ] } : {}),
    } });
    return created;
  });
  auditLocalObserve(input.actorId, "write.request", {
    requestId: request.id,
    rootId: root.id,
    root: root.path,
    path: target.relative,
    bytes: Buffer.byteLength(input.content, "utf8"),
  });
  return request;
}

export async function listLocalWriteRequests(status = "PENDING") {
  return await getPrisma().localWriteRequest.findMany({
    where: status ? { status } : {},
    orderBy: [{ createdAt: "desc" }],
    take: 50,
    include: { root: { select: { id: true, label: true, path: true, mode: true, enabled: true } } },
  });
}

export async function getLocalWriteRequest(id: string) {
  const request = await getPrisma().localWriteRequest.findUnique({
    where: { id },
    include: { root: { select: { id: true, label: true, path: true, mode: true, enabled: true } } },
  });
  if (!request) throw new LocalObserveError(404, "写文件请求不存在。");
  return request;
}

async function markFailed(id: string, message: string) {
  await getPrisma().localWriteRequest.update({
    where: { id },
    data: { status: "FAILED", decidedAt: new Date(), error: message.slice(0, 500) },
  }).catch(() => {});
}

export async function approveLocalWriteRequest(id: string, actorId: string) {
  const request = await getLocalWriteRequest(id);
  if (request.status !== "PENDING") throw new LocalObserveError(409, "这个请求已经处理过了。");
  await getPrisma().$transaction(async tx => {
    await lockLocalTaskForApproval(tx, request.taskId);
    const claimed = await tx.localWriteRequest.updateMany({
      where: { id, taskId: request.taskId, status: "PENDING" },
      data: { status: "APPROVING", decidedAt: new Date() },
    });
    if (claimed.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");
  });

  try {
    const root = await writableRoot(request.rootId);
    const target = validateLocalWritablePath(root.path, request.relativePath);
    const currentHash = target.exists ? hashContent(fs.readFileSync(target.real)) : null;
    if (currentHash !== request.baseHash) {
      throw new LocalObserveError(409, "文件在请求之后被修改过，请重新发起写请求。");
    }
    const temporary = path.join(path.dirname(target.real), `.${path.basename(target.real)}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, request.content, "utf8");
    try {
      fs.copyFileSync(temporary, target.real);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const savedPath = target.real;
    let readback: { path: string; matches: boolean; preview?: string; truncated?: boolean } = { path: savedPath, matches: false };
    if (request.taskId) {
      try {
        const saved = validateLocalWritablePath(root.path, request.relativePath);
        if (saved.real === savedPath && saved.exists && saved.size <= LOCAL_WRITE_MAX_BYTES && fs.statSync(savedPath).isFile()) {
          const actual = fs.readFileSync(savedPath);
          const matches = actual.equals(Buffer.from(request.content, "utf8"));
          if (matches) {
            const text = actual.toString("utf8");
            readback = { path: savedPath, matches, preview: text.slice(0, 6000), truncated: text.length > 6000 };
          }
        }
      } catch { /* The write happened, but readback could not be verified. */ }
    }
    let recordedReadback = false;
    const applied = await getPrisma().$transaction(async tx => {
      await lockLocalTaskForApproval(tx, request.taskId);
      if (request.taskId) {
        recordedReadback = await recordWriteReadback(tx, request.taskId, id, actorId, readback);
        const pending = await tx.localWriteRequest.findFirst({ where: { taskId: request.taskId, status: "PENDING" }, select: { id: true } });
        await tx.localTask.update({ where: { id: request.taskId }, data: { status: pending ? "WAITING_APPROVAL" : "RUNNING" } });
      }
      return tx.localWriteRequest.update({
        where: { id },
        data: { status: "APPLIED", appliedAt: new Date() },
        include: { root: { select: { id: true, label: true, path: true, mode: true, enabled: true } } },
      });
    });
    auditLocalObserve(actorId, "write.apply", {
      requestId: id,
      rootId: root.id,
      root: root.path,
      path: target.relative,
      status: "applied",
    });
    return { ...applied, ...(recordedReadback ? { readback } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(id, message);
    auditLocalObserve(actorId, "write.apply", { requestId: id, status: "failed", error: message.slice(0, 300) });
    if (error instanceof LocalObserveError) throw error;
    throw new LocalObserveError(500, `写入失败：${message}`);
  }
}

export async function rejectLocalWriteRequest(id: string, actorId: string, reason = "") {
  const request = await getLocalWriteRequest(id);
  if (request.status !== "PENDING") throw new LocalObserveError(409, "这个请求已经处理过了。");
  const updated = await getPrisma().localWriteRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "REJECTED", decidedAt: new Date(), error: reason.trim().slice(0, 500) || null },
  });
  if (updated.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");
  auditLocalObserve(actorId, "write.reject", { requestId: id });
  return await getLocalWriteRequest(id);
}
