import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  auditLocalObserve,
  LocalObserveError,
  validateLocalWritablePath,
  type LocalObserveRoot,
} from "./local-observe";
import { advanceTaskForWrite } from "./local-tasks";
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
  if (input.taskId) {
    const task = await getPrisma().localTask.findUnique({ where: { id: input.taskId }, select: { id: true } });
    if (!task) throw new LocalObserveError(404, "任务不存在。");
  }
  const target = validateLocalWritablePath(root.path, input.relativePath);
  if (target.exists && target.size > MAX_EXISTING_BYTES) {
    throw new LocalObserveError(413, "目标文件超过 2 MB，暂不支持覆盖。");
  }
  const baseHash = target.exists ? hashContent(fs.readFileSync(target.real)) : null;
  const request = await getPrisma().localWriteRequest.create({
    data: {
      rootId: root.id,
      relativePath: target.relative,
      content: input.content,
      reason,
      baseHash,
      actorId: input.actorId,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    },
  });
  await advanceTaskForWrite(input.taskId, "WAITING_APPROVAL");
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
  const claimed = await getPrisma().localWriteRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "APPROVING", decidedAt: new Date() },
  });
  if (claimed.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");

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
    const applied = await getPrisma().localWriteRequest.update({
      where: { id },
      data: { status: "APPLIED", appliedAt: new Date() },
      include: { root: { select: { id: true, label: true, path: true, mode: true, enabled: true } } },
    });
    auditLocalObserve(actorId, "write.apply", {
      requestId: id,
      rootId: root.id,
      root: root.path,
      path: target.relative,
      status: "applied",
    });
    await advanceTaskForWrite(request.taskId, "RUNNING");
    return applied;
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
