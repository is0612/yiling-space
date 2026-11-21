import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDesktopPgLock } from "./desktop-pg-lock.mjs";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "child") {
  try {
    const lock = await acquireDesktopPgLock(process.argv[3]);
    lock.assertHeld();
    process.send({ status: "held" });
    process.on("message", async message => {
      if (message === "release") {
        await lock.release();
        await lock.release();
        assert.throws(() => lock.assertHeld(), { code: "DESKTOP_PG_LOCK_NOT_HELD" });
        process.send({ status: "released" });
        process.disconnect();
      }
    });
  } catch (error) {
    process.send({ status: "error", code: error.code, message: error.message });
    process.disconnect();
  }
} else if (process.platform !== "win32") {
  await assert.rejects(() => acquireDesktopPgLock(path.resolve(".")), { code: "DESKTOP_PG_LOCK_UNSUPPORTED" });
  console.log("Windows-only lock: unsupported platform correctly rejected; Windows integration tests not run.");
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yiling-pg-lock-test-"));
  const roots = [path.join(root, "instance"), path.join(root, "other-instance")];
  roots.forEach(directory => fs.mkdirSync(directory));
  const children = new Set();
  const messages = new Map();
  const waiters = new Map();
  function start(directory) {
    const child = fork(self, ["child", directory], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
    children.add(child);
    messages.set(child, []);
    child.on("message", message => {
      const waiter = waiters.get(child);
      if (waiter) { waiters.delete(child); waiter(message); }
      else messages.get(child).push(message);
    });
    return child;
  }
  function receive(child) {
    const queued = messages.get(child).shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(child); reject(new Error("Lock child IPC timed out")); }, 10000);
      waiters.set(child, message => { clearTimeout(timer); resolve(message); });
    });
  }
  async function exit(child, kill = false) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Lock owner did not exit")), 10000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (kill) child.kill("SIGKILL");
    });
  }
  let lock;
  let second;
  try {
    // Record that the tested identity is a Windows SID without exposing it in the report.
    const sidFile = path.join(root, "identity.csv");
    const fd = fs.openSync(sidFile, "wx");
    let identity;
    try { identity = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { stdio: ["ignore", fd, "inherit"] }); }
    finally { fs.closeSync(fd); }
    assert.equal(identity.status, 0);
    assert.match(fs.readFileSync(sidFile, "utf8"), /S-1-5-(?:\d+-)+\d+/u);
    fs.unlinkSync(sidFile);
    await assert.rejects(() => acquireDesktopPgLock("relative"), { code: "DESKTOP_PG_LOCK_INVALID_ROOT" });
    const notDirectory = path.join(root, "not-a-directory");
    fs.writeFileSync(notDirectory, "fixture");
    await assert.rejects(() => acquireDesktopPgLock(notDirectory), { code: "DESKTOP_PG_LOCK_INVALID_ROOT" });
    lock = await acquireDesktopPgLock(roots[0]);
    lock.assertHeld();
    const alias = path.join(root, "junction-alias");
    fs.symlinkSync(roots[0], alias, "junction");
    try {
      await assert.rejects(() => acquireDesktopPgLock(alias), { code: "DESKTOP_PG_LOCK_BUSY" });
      const aliasContender = start(alias);
      assert.equal((await receive(aliasContender)).code, "DESKTOP_PG_LOCK_BUSY");
      await exit(aliasContender);
    } finally { fs.unlinkSync(alias); }
    await assert.rejects(() => acquireDesktopPgLock(roots[0]), { code: "DESKTOP_PG_LOCK_BUSY" });
    await assert.rejects(() => acquireDesktopPgLock(path.join(roots[0], ".") + path.sep), { code: "DESKTOP_PG_LOCK_BUSY" });
    await assert.rejects(() => acquireDesktopPgLock(roots[0].toUpperCase()), { code: "DESKTOP_PG_LOCK_BUSY" });
    const contender = start(roots[0]);
    assert.equal((await receive(contender)).code, "DESKTOP_PG_LOCK_BUSY");
    await exit(contender);
    second = await acquireDesktopPgLock(roots[1]);
    second.assertHeld();
    await second.release();
    await Promise.all([lock.release(), lock.release()]);
    assert.throws(() => lock.assertHeld(), { code: "DESKTOP_PG_LOCK_NOT_HELD" });
    const owner = start(roots[0]);
    assert.equal((await receive(owner)).status, "held");
    await assert.rejects(() => acquireDesktopPgLock(roots[0]), { code: "DESKTOP_PG_LOCK_BUSY" });
    owner.send("release");
    assert.equal((await receive(owner)).status, "released");
    await exit(owner);
    const crashOwner = start(roots[0]);
    assert.equal((await receive(crashOwner)).status, "held");
    await exit(crashOwner, true);
    lock = await acquireDesktopPgLock(roots[0]);
    lock.assertHeld();
    await lock.release();
    // Real simultaneous contenders: exactly one receives OS ownership.
    const racers = [start(roots[0]), start(roots[0])];
    const results = await Promise.all(racers.map(receive));
    assert.equal(results.filter(message => message.status === "held").length, 1);
    assert.equal(results.filter(message => message.code === "DESKTOP_PG_LOCK_BUSY").length, 1);
    const winner = racers[results.findIndex(message => message.status === "held")];
    winner.send("release");
    assert.equal((await receive(winner)).status, "released");
    await Promise.all(racers.map(child => exit(child)));
    console.log("Desktop PG lock Windows integration passed: current SID resolved; same-process busy; canonical paths; cross-process busy; independent roots; idempotent release; crash releases OS ownership; simultaneous race has exactly one winner. Different Windows-user ACL behavior was not tested.");
  } finally {
    for (const child of children) await exit(child, true);
    if (second) await second.release();
    if (lock) await lock.release();
    // This is the exact fresh test root, never an application data directory.
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert(path.basename(root).startsWith("yiling-pg-lock-test-"));
    fs.rmSync(root, { recursive: true });
  }
}
