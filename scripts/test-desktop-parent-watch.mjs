import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import watchApi from "./desktop-parent-watch.cjs";
const { windowsProcessBirth, watchWindowsProcess } = watchApi;
if (process.platform !== "win32") {
  assert.throws(() => windowsProcessBirth(process.pid), /identity_invalid/u);
  console.log("Desktop Windows process-handle watch correctly rejects unsupported platform; Windows lifecycle not run.");
} else {
  const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const birth = windowsProcessBirth(owner.pid);
  let timer, watcher;
  try {
    let lost = false;
    const observedExit = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Original process exit was not observed")), 10_000);
      watcher = watchWindowsProcess(owner.pid, birth, () => { lost = true; resolve(); });
    });
    assert.equal(await watcher.ready, true, "the watcher must report a pinned original process handle before the fault");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(lost, false, "watch must stay attached while the original owner is genuinely alive");
    owner.kill("SIGKILL");
    await observedExit;
    clearTimeout(timer); await watcher.stop();
    const stopped = watchWindowsProcess(process.pid, windowsProcessBirth(process.pid), () => assert.fail("Stopped watch must not report owner loss"));
    await stopped.stop(); await stopped.stop();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Birth identity mismatch was not rejected")), 10_000);
      const invalid = watchWindowsProcess(process.pid, "123456789012345678", () => { clearTimeout(deadline); void invalid.stop(); resolve(); });
    });
    console.log("Desktop Windows process watch passed: original kernel handle exit, creation identity mismatch, idempotent stop; no database or installation used.");
  } finally { clearTimeout(timer); await watcher?.stop(); if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); }
}
