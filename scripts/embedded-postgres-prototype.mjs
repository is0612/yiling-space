import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { isolatedPgEnv, verifyPgBinaries, pgExecutable as executable, pgCommand as execute,
  protectPgDirectory as protectDirectory, availablePgPort as availablePort } from "./desktop-pg-tools.mjs";
export { isolatedPgEnv, verifyPgBinaries };

/** Newly created prototype roots only; production startup does not import this module. */
export async function createEmbeddedPgPrototype({ binDir, parentDir }) {
  const versions = verifyPgBinaries(binDir);
  const parent = fs.realpathSync(parentDir);
  const root = fs.mkdtempSync(path.join(parent, "yiling-pg-a0-"));
  protectDirectory(root);
  const id = randomUUID();
  const dataDir = path.join(root, "pgdata");
  const env = isolatedPgEnv();
  const admin = "yiling_bootstrap";
  const database = "yiling_hub";
  const user = "yiling_hub";
  const adminPassword = randomBytes(32).toString("base64url");
  const password = randomBytes(32).toString("base64url");
  const passwordFile = path.join(root, "init-password");
  const manifestFile = path.join(root, "prototype.json");
  let port = 0;
  let systemIdentifier = null;
  let running = false;
  let closed = false;
  let postmasterPid = null;

  const readClusterIdentifier = () => {
    const control = execute(executable(binDir, "pg_controldata"), ["-D", dataDir], env);
    const identifier = control.match(/Database system identifier:\s+(\d+)/)?.[1];
    if (!identifier) throw new Error("embedded_pg_control_identity_unavailable");
    return identifier;
  };
  const verifyLocalPostmaster = () => {
    assertRoot();
    if (!systemIdentifier || readClusterIdentifier() !== systemIdentifier) throw new Error("embedded_pg_control_identity_mismatch");
    const file = path.join(dataDir, "postmaster.pid");
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("embedded_pg_postmaster_link_refused");
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/u);
    const pid = Number(lines[0]);
    if (!Number.isInteger(pid) || pid <= 0 || fs.realpathSync(lines[1]) !== fs.realpathSync(dataDir)
      || Number(lines[3]) !== port || (postmasterPid && pid !== postmasterPid)) {
      throw new Error("embedded_pg_postmaster_identity_mismatch");
    }
    return { pid, startedAt: Number(lines[2]) };
  };

  const assertRoot = () => {
    if (closed || fs.realpathSync(root) !== root || (fs.existsSync(dataDir) && fs.lstatSync(dataDir).isSymbolicLink())) {
      throw new Error("embedded_pg_root_changed");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.id !== id || manifest.purpose !== "A0_ISOLATED_PROTOTYPE" || manifest.systemIdentifier !== systemIdentifier) {
      throw new Error("embedded_pg_identity_mismatch");
    }
  };
  const writeManifest = () => fs.writeFileSync(manifestFile, JSON.stringify({
    purpose: "A0_ISOLATED_PROTOTYPE", id, systemIdentifier,
    majorVersion: 16, locale: "C", encoding: "UTF8",
  }, null, 2), { mode: 0o600 });
  writeManifest();

  async function connect(asAdmin = false, db = database) {
    assertRoot();
    if (!running) throw new Error("embedded_pg_not_running");
    const client = new Client({
      host: "127.0.0.1", port, user: asAdmin ? admin : user,
      password: asAdmin ? adminPassword : password, database: db,
      ssl: false, sslnegotiation: "postgres", connectionTimeoutMillis: 5000, statement_timeout: 10_000,
      options: "-c statement_timeout=10000", application_name: "yiling-pg-a0", client_encoding: "UTF8",
    });
    try {
      await client.connect();
      // pg_control_system is privileged; all verification uses the bootstrap connection.
      if (asAdmin) {
        const result = await client.query("SELECT system_identifier::text AS id FROM pg_control_system()");
        const actual = result.rows[0]?.id;
        if (!actual || (systemIdentifier && actual !== systemIdentifier)) throw new Error("embedded_pg_server_identity_mismatch");
        const directory = await client.query("SHOW data_directory");
        if (fs.realpathSync(directory.rows[0].data_directory) !== fs.realpathSync(dataDir)) {
          throw new Error("embedded_pg_server_directory_mismatch");
        }
        if (!systemIdentifier) { systemIdentifier = actual; writeManifest(); }
      }
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  async function start() {
    assertRoot();
    if (running) throw new Error("embedded_pg_already_running");
    // Never claim another manager's postmaster, even if it points at this prototype root.
    if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) throw new Error("embedded_pg_existing_postmaster");
    port = await availablePort();
    const attemptedAt = Math.floor(Date.now() / 1000);
    try {
      execute(executable(binDir, "pg_ctl"), ["-D", dataDir, "-l", path.join(root, "postgres.log"),
        "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c timezone=UTC`, "-w", "-t", "30", "start"], env);
    } finally {
      // A failed/wait-timed-out pg_ctl can still have started postgres. Never lose that owner.
      if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) {
        const actual = verifyLocalPostmaster();
        if (actual.startedAt < attemptedAt - 2 || actual.startedAt > Math.floor(Date.now() / 1000) + 2) {
          throw new Error("embedded_pg_postmaster_start_time_mismatch");
        }
        postmasterPid = actual.pid;
        running = true;
      }
    }
    const client = await connect(true, "postgres");
    await client.end();
  }

  async function stop() {
    assertRoot();
    if (!running) return;
    // Control-file/PID identity is independent of SQL responsiveness; never stop by process name.
    verifyLocalPostmaster();
    execute(executable(binDir, "pg_ctl"), ["-D", dataDir, "-w", "-t", "30", "stop", "-m", "fast"], env);
    if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) throw new Error("embedded_pg_stop_unconfirmed");
    running = false;
    postmasterPid = null;
  }

  async function backup() {
    const client = await connect(true, "postgres");
    await client.end();
    const file = path.join(root, `backup-${randomUUID()}.dump`);
    execute(executable(binDir, "pg_dump"), ["--host", "127.0.0.1", "--port", String(port),
      "--username", user, "--dbname", database, "--format=custom", "--no-owner", "--no-privileges", "--file", file],
    { ...env, PGPASSWORD: password });
    if (!fs.statSync(file).size) throw new Error("embedded_pg_empty_backup");
    return file;
  }

  async function restore(file) {
    const realFile = fs.realpathSync(file);
    if (path.dirname(realFile) !== root || !/^backup-[a-f0-9-]+\.dump$/u.test(path.basename(realFile))) {
      throw new Error("embedded_pg_unknown_backup");
    }
    const client = await connect(true, "postgres");
    const restored = "yiling_restore_check";
    try {
      // No DROP/--clean: restore is into a separate fresh database, never the source.
      await client.query(`CREATE DATABASE ${restored} OWNER ${user} TEMPLATE template0`);
    } finally { await client.end(); }
    execute(executable(binDir, "pg_restore"), ["--host", "127.0.0.1", "--port", String(port),
      "--username", user, "--dbname", restored, "--exit-on-error", "--no-owner", "--no-privileges", realFile],
    { ...env, PGPASSWORD: password });
    return connect(false, restored);
  }

  try {
    fs.writeFileSync(passwordFile, adminPassword, { flag: "wx", mode: 0o600 });
    try {
      execute(executable(binDir, "initdb"), ["-D", dataDir, "--username", admin,
        "--encoding=UTF8", "--locale-provider=libc", "--locale=C", "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "--pwfile", passwordFile], env);
    } finally { fs.rmSync(passwordFile, { force: true }); }
    systemIdentifier = readClusterIdentifier();
    writeManifest();
    await start();
    const client = await connect(true, "postgres");
    try {
      // Password is hex/base64url generated locally; do not accept an arbitrary SQL identifier/password.
      await client.query(`CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await client.query(`CREATE DATABASE ${database} OWNER ${user} TEMPLATE template0`);
    } finally { await client.end(); }
  } catch (error) {
    let stopFailed = false;
    if (running) { try { await stop(); } catch { stopFailed = true; } }
    // Identity failure must not imply the server is stopped: preserve it, do not guess/kill.
    if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) stopFailed = true;
    // Preserve failed initialization for inspection; never silently delete an unconfirmed instance.
    const failure = new Error(`${error.message}; diagnosticRoot=${root}${stopFailed ? "; stop_unconfirmed" : ""}`);
    failure.code = error.code;
    failure.prototypeRoot = root;
    throw failure;
  }

  return {
    root, versions, connect, start, stop, backup, restore,
    info: () => ({ id, systemIdentifier, port, running, locale: "C", encoding: "UTF8" }),
    // Only explicit cleanup of a stopped, verified A0 root is allowed.
    async dispose() {
      assertRoot();
      await stop();
      if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) throw new Error("embedded_pg_stop_unconfirmed");
      if (path.dirname(root) !== parent || !path.basename(root).startsWith("yiling-pg-a0-")) {
        throw new Error("embedded_pg_cleanup_refused");
      }
      fs.rmSync(root, { recursive: true });
      closed = true;
    },
  };
}
