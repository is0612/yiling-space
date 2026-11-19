import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { auditLocalObserve, LocalObserveError, resolveLocalPath, type LocalObserveRoot } from "./local-observe";
import { appendCommandEvidence } from "./local-tasks";
import { getPrisma } from "./prisma";

export const LOCAL_COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const ALLOWED_COMMANDS = new Set(["git", "node", "python", "python3", "cargo", "go", "dotnet"]);

export type LocalCommandInput = {
  rootId: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  reason: string;
  actorId: string;
  characterId?: string;
  conversationId?: string;
};

async function writableRoot(rootId: string): Promise<LocalObserveRoot> {
  if (!/^[0-9a-f-]{36}$/i.test(rootId)) throw new LocalObserveError(404, "授权目录不存在。");
  const row = await getPrisma().localAccessRoot.findUnique({ where: { id: rootId } });
  if (!row) throw new LocalObserveError(404, "授权目录不存在。");
  if (!row.enabled) throw new LocalObserveError(403, "这个授权目录已停用。");
  if (row.mode !== "READ_WRITE") throw new LocalObserveError(403, "这个目录没有开启写权限，不能执行命令。");
  return { id: row.id, label: row.label, path: row.path, mode: "READ_WRITE", enabled: true, builtin: false };
}

function normalizeCommand(input: unknown) {
  if (typeof input !== "string") throw new LocalObserveError(400, "command 必须是字符串。");
  const name = path.basename(input.trim()).replace(/\.exe$/i, "").toLowerCase();
  if (!ALLOWED_COMMANDS.has(name)) {
    throw new LocalObserveError(
      403,
      `命令 ${name || "(空)"} 不在允许列表里；当前只允许 ${[...ALLOWED_COMMANDS].join(" / ")}。`,
    );
  }
  return name;
}

function normalizeArgs(input: unknown) {
  if (!Array.isArray(input)) throw new LocalObserveError(400, "args 必须是字符串数组。");
  if (input.length > 50) throw new LocalObserveError(400, "参数最多 50 个。");
  return input.map((value) => {
    if (typeof value !== "string" || value.includes("\0")) throw new LocalObserveError(400, "参数必须是字符串。");
    if (value.length > 500) throw new LocalObserveError(400, "单个参数最多 500 字符。");
    return value;
  });
}

async function resolveCommandCwd(root: LocalObserveRoot, cwdInput: unknown) {
  const cwd = typeof cwdInput === "string" && cwdInput.trim() ? cwdInput.trim() : "";
  const resolved = resolveLocalPath(root.path, cwd);
  const target = resolved.real;
  const { statSync } = await import("node:fs");
  const stat = statSync(target);
  if (!stat.isDirectory()) throw new LocalObserveError(400, "cwd 必须是授权目录内的目录。");
  return { relative: resolved.relative, absolute: target };
}

export async function createLocalCommandRequest(input: LocalCommandInput) {
  const command = normalizeCommand(input.command);
  const args = normalizeArgs(input.args);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (!reason) throw new LocalObserveError(400, "执行命令必须说明原因。");
  const root = await writableRoot(input.rootId);
  const cwd = await resolveCommandCwd(root, input.cwd);
  if (input.taskId) {
    const task = await getPrisma().localTask.findUnique({ where: { id: input.taskId }, select: { id: true } });
    if (!task) throw new LocalObserveError(404, "任务不存在。");
  }
  const request = await getPrisma().localCommandRequest.create({
    data: {
      rootId: root.id,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      command,
      args,
      cwd: cwd.relative,
      reason,
      actorId: input.actorId,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
  });
  auditLocalObserve(input.actorId, "command.request", {
    requestId: request.id, rootId: root.id, command, args, cwd: cwd.relative,
  });
  return request;
}

export async function listLocalCommandRequests(status = "PENDING") {
  return await getPrisma().localCommandRequest.findMany({
    where: status ? { status } : {},
    orderBy: [{ createdAt: "desc" }],
    take: 50,
    include: { root: { select: { id: true, label: true, path: true, mode: true } } },
  });
}

export async function getLocalCommandRequest(id: string) {
  const request = await getPrisma().localCommandRequest.findUnique({
    where: { id },
    include: { root: { select: { id: true, label: true, path: true, mode: true } } },
  });
  if (!request) throw new LocalObserveError(404, "命令请求不存在。");
  return request;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

async function executeCommand(command: string, args: string[], cwd: string) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number; error?: string }>((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started, ...(error ? { error } : {}) });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES);
    });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, LOCAL_COMMAND_TIMEOUT_MS);
  });
}

export async function approveLocalCommandRequest(id: string, actorId: string) {
  const request = await getLocalCommandRequest(id);
  if (request.status !== "PENDING") throw new LocalObserveError(409, "这个请求已经处理过了。");
  const claimed = await getPrisma().localCommandRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "APPROVING", decidedAt: new Date() },
  });
  if (claimed.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");
  try {
    const root = await writableRoot(request.rootId);
    const cwd = await resolveCommandCwd(root, request.cwd);
    const args = Array.isArray(request.args) ? request.args.filter((value): value is string => typeof value === "string") : [];
    const result = await executeCommand(request.command, args, cwd.absolute);
    const status = result.code === 0 && !result.timedOut ? "SUCCEEDED" : "FAILED";
    const error = result.timedOut ? `命令超时（${LOCAL_COMMAND_TIMEOUT_MS / 1000} 秒）` : result.error ?? (result.code === 0 ? null : `退出码 ${result.code}`);
    const updated = await getPrisma().localCommandRequest.update({
      where: { id },
      data: {
        status,
        exitCode: result.code,
        stdout: result.stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: result.stderr.slice(0, MAX_OUTPUT_BYTES),
        durationMs: result.durationMs,
        startedAt: new Date(Date.now() - result.durationMs),
        finishedAt: new Date(),
        error: error?.slice(0, 500) ?? null,
      },
      include: { root: { select: { id: true, label: true, path: true, mode: true } } },
    });
    if (request.taskId) {
      await appendCommandEvidence({
        taskId: request.taskId,
        outcome: status === "SUCCEEDED" ? "PASS" : "FAIL",
        note: [
          `$ ${request.command} ${args.join(" ")}`.trim(),
          `cwd: ${request.cwd || "."}`,
          `exit: ${result.code ?? "unknown"}${result.timedOut ? " (timeout)" : ""}`,
          result.stdout ? `stdout:\n${result.stdout.slice(-3000)}` : "",
          result.stderr ? `stderr:\n${result.stderr.slice(-2000)}` : "",
        ].filter(Boolean).join("\n"),
        actorId,
      });
    }
    auditLocalObserve(actorId, "command.apply", { requestId: id, status, exitCode: result.code, durationMs: result.durationMs });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getPrisma().localCommandRequest.update({
      where: { id },
      data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
    }).catch(() => {});
    auditLocalObserve(actorId, "command.apply", { requestId: id, status: "failed", error: message.slice(0, 300) });
    if (error instanceof LocalObserveError) throw error;
    throw new LocalObserveError(500, `命令执行失败：${message}`);
  }
}

export async function rejectLocalCommandRequest(id: string, actorId: string, reason = "") {
  const request = await getLocalCommandRequest(id);
  if (request.status !== "PENDING") throw new LocalObserveError(409, "这个请求已经处理过了。");
  const updated = await getPrisma().localCommandRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "REJECTED", decidedAt: new Date(), error: reason.trim().slice(0, 500) || null },
  });
  if (updated.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");
  auditLocalObserve(actorId, "command.reject", { requestId: id });
  return await getLocalCommandRequest(id);
}
