import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { superviseMemoryWorker } from "./memory-worker-supervisor.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "yiling-worker-test-"));
const instances = [];
const logs = [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (condition) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for fake Worker");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const options = {
  root, env: { ...process.env, YILING_WORKER_DISABLED: "0" },
  args: ["-e", "setInterval(()=>{},1000)"], retryMs: 30, maxRetryMs: 100, stopMs: 500,
  log: (entry) => logs.push(entry),
};
try {
  const first = await superviseMemoryWorker(options); instances.push(first);
  assert.equal(first.owned(), true);
  const firstPid = logs.find((row) => row.event === "worker-started").pid;
  await waitFor(() => alive(firstPid));
  const second = await superviseMemoryWorker(options); instances.push(second);
  assert.equal(second.owned(), false);
  assert.equal(logs.filter((row) => row.event === "worker-started").length, 1, "second launcher must reuse owner");
  await first.stop();
  await waitFor(() => second.owned());
  await waitFor(() => !alive(firstPid));
  const secondPid = logs.filter((row) => row.event === "worker-started").at(-1).pid;
  process.kill(secondPid, "SIGKILL");
  await waitFor(() => logs.filter((row) => row.event === "worker-started").length >= 3);
  const restartedPid = logs.filter((row) => row.event === "worker-started").at(-1).pid;
  assert.ok(alive(restartedPid), "crashed fake Worker should restart");
  await second.stop();
  await waitFor(() => !alive(restartedPid));
  const disabled = await superviseMemoryWorker({ ...options, env: { YILING_WORKER_DISABLED: "1" } });
  assert.equal(disabled.disabled, true); assert.equal(disabled.owned(), false);
  await disabled.stop();
  // Verify failed spawns also recover without an unhandled error or losing the ownership lock.
  const failures = [];
  const failed = await superviseMemoryWorker({ ...options, command: path.join(root, "missing-node"), log: (row) => failures.push(row) });
  instances.push(failed);
  await waitFor(() => failures.filter((row) => row.event === "worker-restarting").length >= 2);
  await failed.stop();
  const ownerFile = path.join(root, "fake-owner.mjs");
  const pidFile = path.join(root, "worker-pid.txt");
  await writeFile(ownerFile, `import {superviseMemoryWorker} from ${JSON.stringify(new URL("./memory-worker-supervisor.mjs", import.meta.url).href)};
await superviseMemoryWorker({root:${JSON.stringify(root)},args:["-e", "setInterval(()=>{},1000)"],log:(row)=>{if(row.pid) import('node:fs').then(fs=>fs.writeFileSync(${JSON.stringify(pidFile)},String(row.pid)))}});`);
  const owner = spawn(process.execPath, [ownerFile], { stdio: "ignore" });
  let orphanPid;
  try {
    await waitFor(() => existsSync(pidFile));
    orphanPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(orphanPid));
    owner.kill("SIGKILL");
    await waitFor(() => !alive(orphanPid));
  } finally {
    owner.kill("SIGKILL");
    if (orphanPid && alive(orphanPid)) process.kill(orphanPid, "SIGKILL");
  }
  console.log("PASS: Worker supervisor deduplication, standby takeover, crash recovery, shutdown, opt-out, spawn errors and killed-parent cleanup (fake Workers only).");
} finally {
  for (const instance of instances) await instance.stop();
  await rm(root, { recursive: true, force: true });
}
