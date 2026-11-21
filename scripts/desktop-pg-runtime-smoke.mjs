import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { openDesktopPostgres } from "./desktop-pg-runtime.mjs";
import { loadPgCredentials } from "./desktop-pg-store.mjs";
import { pgCommand } from "./desktop-pg-tools.mjs";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "owner") {
  let runtime;
  try {
    runtime = await openDesktopPostgres({ binDir: process.env.YILING_TEST_PG_BIN,
      rootDir: process.argv[3], expectedInstanceId: process.argv[4] });
    process.send({ status: "ready", descriptor: runtime.descriptor() });
    process.on("message", async message => {
      if (message === "close") { await runtime.close(); process.send({ status: "closed" }); process.disconnect(); }
    });
  } catch (error) {
    process.send({ status: "error", code: error.code, message: error.message });
    process.disconnect();
  }
} else if (process.argv[2] === "query-env") {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false,
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000" });
  try {
    await client.connect();
    const result = await client.query("SELECT count(*)::integer AS n FROM runtime_fixture");
    process.send({ status: "queried", count: result.rows[0].n });
  } finally { await client.end(); process.disconnect(); }
} else {
  if (process.platform !== "win32" || !process.env.YILING_TEST_PG_BIN) throw new Error("Windows and verified YILING_TEST_PG_BIN are required; no business database is used.");
  const sourceBinDir = process.env.YILING_TEST_PG_BIN;
  const parent = path.resolve(".data", "desktop-pg-runtime-tests");
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, "runtime-"));
  const runtimeFiles = path.join(temporary, "程序运行时");
  const unicodeBin = path.join(runtimeFiles, "bin");
  fs.mkdirSync(unicodeBin, { recursive: true });
  const binDir = sourceBinDir;
  const testEnv = { ...process.env, YILING_TEST_PG_BIN: binDir };
  const rootDir = path.join(temporary, "实例资料", "instance");
  fs.mkdirSync(path.dirname(rootDir));
  const children = new Set();
  const queues = new Map(), waiting = new Map();
  let runtime;
  let binding;
  let succeeded = false;
  function child(mode, args = [], env = testEnv) {
    const execution = fork(self, [mode, ...args], { env, stdio: ["inherit", "inherit", "inherit", "ipc"] });
    children.add(execution); queues.set(execution, []);
    execution.on("message", message => {
      const waiter = waiting.get(execution);
      if (waiter) { waiting.delete(execution); waiter(message); } else queues.get(execution).push(message);
    });
    return execution;
  }
  function receive(execution) {
    const message = queues.get(execution).shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(execution); reject(new Error("Runtime child IPC timeout")); }, 30_000);
      waiting.set(execution, value => { clearTimeout(timer); resolve(value); });
    });
  }
  function exit(execution, kill = false) {
    if (execution.exitCode !== null || execution.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runtime child exit timeout")), 10_000);
      execution.once("exit", () => { clearTimeout(timer); resolve(); });
      if (kill) execution.kill("SIGKILL");
    });
  }
  try {
    const refusedRoot = path.join(temporary, "must-not-create");
    await assert.rejects(() => openDesktopPostgres({ binDir: unicodeBin, rootDir: refusedRoot, initialize: true }), /non_ascii_binary_path_unsupported/u);
    assert(!fs.existsSync(refusedRoot), "unsupported program paths must fail before creating any data directory");
    // No initialization into an unknown existing directory, even when explicitly requested.
    const unknown = path.join(temporary, "unknown"); fs.mkdirSync(unknown);
    fs.writeFileSync(path.join(unknown, "keep.txt"), "do not touch");
    await assert.rejects(() => openDesktopPostgres({ binDir, rootDir: unknown, initialize: true }), { code: "EEXIST" });
    assert.equal(fs.readFileSync(path.join(unknown, "keep.txt"), "utf8"), "do not touch");
    await assert.rejects(() => openDesktopPostgres({ binDir, rootDir: unknown, expectedInstanceId: randomUUID() }));
    assert(!fs.existsSync(path.join(unknown, "pgdata")));
    const listener = net.createServer(socket => socket.destroy());
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
    try {
      runtime = await openDesktopPostgres({ binDir, rootDir, initialize: true, preferredPort: listener.address().port });
      assert.notEqual(runtime.descriptor().port, listener.address().port, "occupied port must not be adopted");
    } finally { await new Promise(resolve => listener.close(resolve)); }
    binding = runtime.descriptor();
    assert(binding.systemIdentifier && binding.instanceId);
    const secretFile = path.join(rootDir, "credentials.dpapi.json");
    const secretText = fs.readFileSync(secretFile, "utf8");
    assert.equal(JSON.parse(secretText).format, "windows-dpapi-current-user-v1");
    assert(!secretText.includes("adminPassword"));
    assert(!fs.existsSync(path.join(rootDir, "init-password")));
    assert.throws(() => loadPgCredentials(secretFile, randomUUID()), /credentials_unavailable/u);
    let client = await runtime.connect();
    try {
      await client.query("CREATE TABLE runtime_fixture (id integer PRIMARY KEY, body text NOT NULL)");
      await client.query("INSERT INTO runtime_fixture VALUES (1, $1)", ["持久化测试：合成记录"]);
    } finally { await client.end(); }
    const environment = runtime.childEnvironment({ ...testEnv, DATABASE_URL: "postgresql://invalid.invalid", PGOPTIONS: "-c invalid_setting=1" });
    assert.equal(new URL(environment.DATABASE_URL).port, String(binding.port));
    assert.equal(environment.PGOPTIONS, undefined);
    const query = child("query-env", [], environment);
    assert.deepEqual(await receive(query), { status: "queried", count: 1 }); await exit(query);
    const contender = child("owner", [rootDir, binding.instanceId]);
    assert.equal((await receive(contender)).code, "DESKTOP_PG_LOCK_BUSY"); await exit(contender);
    const dump = await runtime.backup(); assert(fs.statSync(dump).size > 0);
    const pidMarker = path.join(rootDir, "pgdata", "postmaster.pid");
    const activePidBytes = fs.readFileSync(pidMarker);
    try {
      fs.unlinkSync(pidMarker);
      await assert.rejects(() => runtime.close(), /live_process_without_pid_file/u, "missing marker must not be reported as successful shutdown");
    } finally { fs.writeFileSync(pidMarker, activePidBytes); }
    await runtime.close(); await runtime.close(); runtime = null;
    assert(!fs.existsSync(path.join(rootDir, "pgdata", "postmaster.pid")));
    // New process loads DPAPI credentials; no password is transferred through IPC/argv.
    const owner = child("owner", [rootDir, binding.instanceId]);
    const reopened = await receive(owner); assert.equal(reopened.status, "ready");
    assert.equal(reopened.descriptor.systemIdentifier, binding.systemIdentifier);
    const originalPostmaster = JSON.parse(fs.readFileSync(path.join(rootDir, "runtime.json"), "utf8")).postmaster;
    await exit(owner, true); // Manager dies, postgres remains; OS lock must release automatically.
    const orphanPidBytes = fs.readFileSync(pidMarker);
    try {
      fs.unlinkSync(pidMarker);
      await assert.rejects(() => openDesktopPostgres({ binDir, rootDir, expectedInstanceId: binding.instanceId }), /live_process_without_pid_file/u,
        "a live persisted process without a PID file must not cause a second startup");
    } finally { fs.writeFileSync(pidMarker, orphanPidBytes); }
    runtime = await openDesktopPostgres({ binDir, rootDir, expectedInstanceId: binding.instanceId });
    const recovered = await runtime.verify();
    assert.equal(recovered.systemIdentifier, binding.systemIdentifier);
    assert.equal(recovered.port, reopened.descriptor.port, "recover the same live postmaster, not a second database");
    const recoveredPostmaster = JSON.parse(fs.readFileSync(path.join(rootDir, "runtime.json"), "utf8")).postmaster;
    assert.equal(recoveredPostmaster.pid, originalPostmaster.pid);
    assert.equal(recoveredPostmaster.createdAt, originalPostmaster.createdAt);
    client = await runtime.connect();
    try { assert.equal((await client.query("SELECT body FROM runtime_fixture")).rows[0].body, "持久化测试：合成记录"); }
    finally { await client.end(); }
    await runtime.close(); runtime = null;
    await assert.rejects(() => openDesktopPostgres({ binDir, rootDir, expectedInstanceId: randomUUID() }), /binding_mismatch/u);
    const stateFile = path.join(rootDir, "runtime.json");
    const originalState = fs.readFileSync(stateFile, "utf8");
    try {
      const wrongCluster = JSON.parse(originalState); wrongCluster.systemIdentifier = "1234567890123456789";
      fs.writeFileSync(stateFile, JSON.stringify(wrongCluster));
      await assert.rejects(() => openDesktopPostgres({ binDir, rootDir, expectedInstanceId: binding.instanceId }), /cluster_identity_mismatch/u);
      assert(!fs.existsSync(path.join(rootDir, "pgdata", "postmaster.pid")), "cluster mismatch must be rejected before any start command");
    } finally { fs.writeFileSync(stateFile, originalState); }
    try {
      const incomplete = JSON.parse(originalState); incomplete.phase = "initializing";
      fs.writeFileSync(stateFile, JSON.stringify(incomplete));
      await assert.rejects(() => openDesktopPostgres({ binDir, rootDir, expectedInstanceId: binding.instanceId }), /incomplete_initialization/u);
    } finally { fs.writeFileSync(stateFile, originalState); }
    try {
      fs.writeFileSync(secretFile, JSON.stringify({ format: "windows-dpapi-current-user-v1", ciphertext: "broken=" }));
      await assert.rejects(() => openDesktopPostgres({ binDir, rootDir, expectedInstanceId: binding.instanceId }), /credentials_unavailable/u);
      assert(!fs.existsSync(path.join(rootDir, "pgdata", "postmaster.pid")), "bad credentials must not start or reinitialize pgdata");
    } finally { fs.writeFileSync(secretFile, secretText); }
    try {
      pgCommand("icacls.exe", [rootDir, "/grant", "*S-1-1-0:(OI)(CI)R"]);
      await assert.rejects(() => openDesktopPostgres({ binDir, rootDir, expectedInstanceId: binding.instanceId }), /directory_acl_rejected/u);
      assert(!fs.existsSync(path.join(rootDir, "pgdata", "postmaster.pid")), "unexpected explicit Everyone ACL must fail before startup");
    } finally { pgCommand("icacls.exe", [rootDir, "/remove:g", "*S-1-1-0"]); }
    const caseAlias = path.join(path.dirname(rootDir), "INSTANCE");
    runtime = await openDesktopPostgres({ binDir, rootDir: caseAlias, expectedInstanceId: binding.instanceId });
    assert.equal((await runtime.verify()).systemIdentifier, binding.systemIdentifier);
    await runtime.close(); runtime = null;
    succeeded = true;
    console.log("Persistent PG runtime passed: DPAPI, explicit binding, occupied port, child env, cross-process lock, clean reopen, manager crash recovery, no reinit on corrupt state/credentials, original data preserved.");
  } finally {
    for (const execution of children) { if (execution.exitCode === null && execution.signalCode === null) await exit(execution, true); }
    if (runtime) await runtime.close();
    // If a child failed after starting PG, recover through the bound runtime before deleting anything.
    if (binding && fs.existsSync(path.join(rootDir, "pgdata", "postmaster.pid"))) {
      const cleanup = await openDesktopPostgres({ binDir, rootDir, expectedInstanceId: binding.instanceId });
      await cleanup.close();
    }
    if (fs.existsSync(path.join(rootDir, "pgdata", "postmaster.pid"))) throw new Error(`Cleanup refused; inspect ${temporary}`);
    if (path.dirname(temporary) !== parent || !path.basename(temporary).startsWith("runtime-")) throw new Error("Unexpected test cleanup root");
    if (succeeded) fs.rmSync(temporary, { recursive: true });
    else console.error(`Retained isolated runtime diagnostics: ${temporary}`);
  }
}
