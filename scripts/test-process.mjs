import { spawn } from "node:child_process";
import path from "node:path";

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ } }
  }
}

/** Execute one trusted plan leaf without a shell, keeping its final output and exit status. */
export function runTestFile(task, { root, timeoutMs }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const argv = task.runner === "tsx" ? ["node_modules/tsx/dist/cli.mjs", task.file] : [task.file];
    const child = spawn(process.execPath, argv, {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, PATH: `${path.join(root, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`, FORCE_COLOR: "0" },
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.once("error", error => {
      clearTimeout(timer);
      resolve({ name: task.file, ok: false, ms: Date.now() - startedAt, output: `${output}\n${error.message}`, timedOut, code: null });
    });
    // close waits for stdout/stderr to drain; exit alone can truncate the failure evidence.
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ name: task.file, ok: code === 0 && !timedOut, ms: Date.now() - startedAt,
        output: timedOut ? `${output}\n[超时] 超过 ${timeoutMs}ms，已终止进程树。` : output, timedOut, code });
    });
  });
}
