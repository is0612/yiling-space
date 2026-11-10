import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const parentGuard = new URL("./memory-worker-parent.mjs", import.meta.url).href;

/** One local owner per checkout. A second launcher waits and can take over when the owner exits. */
export async function superviseMemoryWorker({
  root,
  env = process.env,
  log = (entry) => console.log(`[worker] ${JSON.stringify(entry)}`),
  command = process.execPath,
  args = ["--import", "tsx", "scripts/run-memory-worker.ts", "--watch"],
  retryMs = 5_000,
  maxRetryMs = 60_000,
  stopMs = 5_000,
}) {
  if (env.YILING_WORKER_DISABLED === "1") {
    log({ event: "worker-disabled" });
    return { stop: async () => {}, owned: () => false, disabled: true };
  }
  const checkout = path.resolve(root);
  const identity = createHash("sha256").update(process.platform === "win32" ? checkout.toLowerCase() : checkout).digest("hex");
  const firstPort = 20_000 + Number.parseInt(identity.slice(0, 6), 16) % 30_000;
  // Windows may reserve whole port ranges. Keep the original first choice so existing
  // owners remain discoverable, then spread deterministic fallbacks across the range.
  const ports = Array.from({ length: 12 }, (_, index) => 20_000 + (firstPort - 20_000 + index * 7_919) % 30_000);
  const signature = `yiling-memory-worker:${identity}`;
  let stopped = false;
  let server = null;
  let child = null;
  let timer = null;
  let delay = retryMs;
  let lastState = "";
  const report = (event, detail = {}) => {
    if (event !== lastState || event === "worker-restarting") log({ event, ...detail });
    lastState = event;
  };
  const later = (callback, ms) => {
    if (!stopped) timer = setTimeout(() => { timer = null; void callback(); }, ms);
  };
  const startChild = () => {
    if (stopped) return;
    const startedAt = Date.now();
    const current = spawn(command, ["--import", parentGuard, ...args], {
      cwd: checkout, env, stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
    });
    child = current;
    report("worker-started", { pid: current.pid });
    let settled = false;
    const exited = (code, signal, error) => {
      if (settled) return;
      settled = true;
      if (child === current) child = null;
      if (stopped) return;
      if (Date.now() - startedAt >= 60_000) delay = retryMs;
      report("worker-restarting", { code, signal, ...(error ? { error: error.message } : {}), retryMs: delay });
      later(startChild, delay);
      delay = Math.min(maxRetryMs, delay * 2);
    };
    current.once("error", (error) => exited(null, null, error));
    current.once("exit", (code, signal) => exited(code, signal));
  };
  const identifyOwner = (port) => new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let text = "";
    const finish = (valid) => { socket.destroy(); resolve(valid); };
    socket.setTimeout(1_000);
    socket.on("data", (data) => {
      text += data.toString();
      if (text.includes("\n") || text.length > 200) finish(text.trim() === signature);
    });
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("end", () => finish(text.trim() === signature));
  });
  const acquire = async () => {
    if (stopped) return;
    for (const port of ports) {
      const candidate = net.createServer((socket) => { socket.on("error", () => {}); socket.end(`${signature}\n`); });
      const error = await new Promise((resolve) => {
        candidate.once("error", resolve);
        candidate.listen(port, "127.0.0.1", () => resolve(null));
      });
      if (stopped) { if (candidate.listening) candidate.close(); return; }
      if (!error) {
        server = candidate;
        startChild();
        return;
      }
      if (error.code === "EACCES") continue;
      if (error.code === "EADDRINUSE" && await identifyOwner(port)) {
        report("worker-already-supervised");
        later(safelyAcquire, retryMs);
        return;
      }
      // Never skip an unrelated occupied port: another owner may be behind it.
      throw new Error(`记忆 Worker 守护锁不可用（${error.code ?? "unknown"}，端口 ${port}）。请检查本机端口占用。`);
    }
    throw new Error("记忆 Worker 的所有候选锁端口均被系统拒绝（EACCES），请检查本机网络保留端口配置。");
  };
  // Background takeover errors remain visible and retry; initial errors fail the launcher clearly.
  const initialAcquire = acquire;
  const safelyAcquire = async () => {
    try { await initialAcquire(); } catch (error) {
      report("worker-supervisor-error", { error: error.message });
      later(safelyAcquire, retryMs);
    }
  };
  await acquire();
  return {
    disabled: false,
    owned: () => server !== null,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const current = child;
      if (current) {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => { current.kill("SIGKILL"); }, stopMs);
          current.once("exit", () => { clearTimeout(timeout); resolve(); });
          current.kill("SIGTERM");
        });
      }
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    },
  };
}
