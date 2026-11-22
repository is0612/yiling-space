import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "pg";
import { acquireDesktopPgLock } from "./desktop-pg-lock.mjs";
import { isolatedPgEnv, verifyPgBinaries, pgExecutable, pgCommand, protectPgDirectory,
  availablePgPort, pgControlIdentifier, pgProcessIdentity, decodePgNativeText } from "./desktop-pg-tools.mjs";
import { readPgJson, writePgJsonAtomic, savePgCredentials, loadPgCredentials } from "./desktop-pg-store.mjs";

const PURPOSE = "YILING_DESKTOP_PG_V1";
const BUSINESS = "yiling_hub";
const ADMIN = "yiling_bootstrap";
const samePath = (a, b) => fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase();
function refuseLink(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("desktop_pg_link_refused");
}
async function occupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
function validManifest(value, expectedId) {
  if (value?.purpose !== PURPOSE || value.schemaVersion !== 1 || value.instanceId !== expectedId
    || value.majorVersion !== 16 || value.locale !== "C" || value.encoding !== "UTF8"
    || !["initializing", "ready", "failed"].includes(value.phase)) throw new Error("desktop_pg_binding_mismatch");
  return value;
}

/** Explicit, Windows-only persistent instance. Never reads .env or adopts an unbound root. */
export async function openDesktopPostgres({ binDir, rootDir, expectedInstanceId, initialize = false, preferredPort }) {
  if (process.platform !== "win32") throw new Error("desktop_pg_windows_required");
  if (!path.isAbsolute(rootDir) || path.dirname(rootDir) === rootDir) throw new Error("desktop_pg_invalid_root");
  if (preferredPort !== undefined && (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535)) {
    throw new Error("desktop_pg_invalid_port");
  }
  binDir = fs.realpathSync(binDir);
  // PG16 initdb embeds its absolute share path as raw SQL during single-user bootstrap.
  // On this Windows build a non-ASCII install path can be emitted in the ANSI code page
  // while the UTF8 backend parses it. Reject before creating data, never change DB encoding.
  if (/[^\x00-\x7F]/u.test(binDir)) throw new Error("desktop_pg_non_ascii_binary_path_unsupported: use an ASCII PostgreSQL runtime path");
  const versions = verifyPgBinaries(binDir);
  const parent = fs.realpathSync(path.dirname(rootDir));
  let root = path.join(parent, path.basename(rootDir));
  if (initialize) {
    if (expectedInstanceId !== undefined) throw new Error("desktop_pg_new_instance_has_no_binding");
    fs.mkdirSync(root); // EEXIST is intentional: never initialize over any existing directory.
    protectPgDirectory(root);
  } else {
    if (!/^[a-f0-9-]{36}$/iu.test(expectedInstanceId ?? "")) throw new Error("desktop_pg_binding_required");
    refuseLink(root);
    validManifest(readPgJson(path.join(root, "runtime.json")), expectedInstanceId);
    protectPgDirectory(root);
  }
  root = fs.realpathSync(root);
  const lease = await acquireDesktopPgLock(root);
  const dataDir = path.join(root, "pgdata");
  const stateFile = path.join(root, "runtime.json");
  const secretFile = path.join(root, "credentials.dpapi.json");
  const pidFile = path.join(dataDir, "postmaster.pid");
  const env = isolatedPgEnv();
  let manifest;
  let credentials;
  let port = 0;
  let ownedProcess = null;
  let closed = false;
  let closing = false;

  function assertBound() {
    lease.assertHeld();
    if (closed || fs.realpathSync(root) !== root) throw new Error("desktop_pg_runtime_closed_or_moved");
    refuseLink(root);
    if (fs.existsSync(dataDir)) refuseLink(dataDir);
    const saved = validManifest(readPgJson(stateFile), manifest.instanceId);
    if (saved.systemIdentifier !== manifest.systemIdentifier || saved.phase !== manifest.phase) throw new Error("desktop_pg_state_changed");
  }
  function persist(change) {
    if (manifest) assertBound();
    manifest = { ...manifest, ...change };
    writePgJsonAtomic(stateFile, manifest);
  }
  function inspectPostmaster(record = ownedProcess) {
    assertBound();
    if (!manifest.systemIdentifier || pgControlIdentifier(binDir, dataDir) !== manifest.systemIdentifier) {
      throw new Error("desktop_pg_cluster_identity_mismatch");
    }
    if (!fs.existsSync(pidFile)) return null;
    refuseLink(pidFile);
    const lines = decodePgNativeText(fs.readFileSync(pidFile)).trim().split(/\r?\n/u);
    const pid = Number(lines[0]), actualPort = Number(lines[3]), startedAt = Number(lines[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(actualPort) || actualPort < 1024 || actualPort > 65535
      || !samePath(lines[1], dataDir)) throw new Error("desktop_pg_postmaster_identity_mismatch");
    const processInfo = pgProcessIdentity(pid);
    if (!processInfo) return { live: false, pid };
    if (!samePath(processInfo.exe, pgExecutable(binDir, "postgres"))
      || Math.abs(Date.parse(processInfo.createdAt) / 1000 - startedAt) > 5
      || (record && (record.pid !== pid || record.createdAt !== processInfo.createdAt || record.port !== actualPort))) {
      throw new Error("desktop_pg_process_identity_mismatch");
    }
    return { live: true, pid, port: actualPort, createdAt: processInfo.createdAt };
  }
  function clientConfig(admin = false, database = BUSINESS) {
    return { host: "127.0.0.1", port, database, user: admin ? ADMIN : BUSINESS,
      password: admin ? credentials.adminPassword : credentials.password,
      ssl: false, sslnegotiation: "postgres", connectionTimeoutMillis: 5000, statement_timeout: 10_000,
      options: "-c statement_timeout=10000", client_encoding: "UTF8", application_name: "yiling-desktop-pg" };
  }
  async function adminVerify() {
    const client = new Client(clientConfig(true, "postgres"));
    try {
      await client.connect();
      const identity = await client.query("SELECT system_identifier::text AS id FROM pg_control_system()");
      // Read exact server-side PID bytes: SHOW data_directory may expose ANSI path bytes
      // inside an otherwise UTF8 protocol on Windows. Keep payload encoding itself UTF8.
      const directory = await client.query("SELECT pg_read_binary_file('postmaster.pid') AS pid_file");
      const directoryBytes = directory.rows[0]?.pid_file;
      const serverDirectory = Buffer.isBuffer(directoryBytes) && directoryBytes.length < 16 * 1024
        ? decodePgNativeText(directoryBytes).split(/\r?\n/u)[1] : undefined;
      if (identity.rows[0]?.id !== manifest.systemIdentifier || !serverDirectory || !samePath(serverDirectory, dataDir)) {
        throw new Error("desktop_pg_sql_identity_mismatch");
      }
    } finally { await client.end().catch(() => {}); }
  }
  function processStillMatches(record) {
    if (!record) return false;
    const current = pgProcessIdentity(record.pid);
    return Boolean(current && current.createdAt === record.createdAt && samePath(current.exe, pgExecutable(binDir, "postgres")));
  }
  async function stopOwned() {
    assertBound();
    if (ownedProcess) {
      const actual = inspectPostmaster();
      if (!actual && processStillMatches(ownedProcess)) throw new Error("desktop_pg_live_process_without_pid_file");
      if (actual?.live) {
        pgCommand(pgExecutable(binDir, "pg_ctl"), ["-D", dataDir, "-w", "-t", "30", "stop", "-m", "fast"], env);
      }
      // A dead server can leave a stale PID file; PostgreSQL itself handles it on the next start.
      const after = fs.existsSync(pidFile) ? inspectPostmaster() : null;
      if (after?.live) throw new Error("desktop_pg_stop_unconfirmed");
      ownedProcess = null;
      persist({ postmaster: null });
    }
  }
  async function startOrRecover() {
    assertBound();
    if (fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim() !== "16"
      || pgControlIdentifier(binDir, dataDir) !== manifest.systemIdentifier) {
      throw new Error("desktop_pg_cluster_identity_mismatch");
    }
    if (!fs.existsSync(pidFile) && processStillMatches(manifest.postmaster)) {
      throw new Error("desktop_pg_live_process_without_pid_file");
    }
    const previous = fs.existsSync(pidFile) ? inspectPostmaster(manifest.postmaster ?? null) : null;
    if (previous?.live) {
      port = previous.port;
      await adminVerify(); // Only authenticated, matching clusters are adopted after manager loss.
      ownedProcess = previous;
      persist({ port, postmaster: previous });
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      port = attempt === 0 && preferredPort ? preferredPort : await availablePgPort();
      if (await occupied(port)) continue;
      persist({ port, postmaster: null });
      const attemptedAt = Date.now();
      let startError;
      try {
        // 集群固定跑 UTC：Prisma 走驱动适配器时，原始 SQL 返回的 timestamptz 按会话时区读成
        // 「本地墙上时间当 UTC」，服务器时区非 UTC 时整体偏移，租约 / 回填这类比较会直接判空。
        // 库里所有时间列都是 timestamptz（存的是绝对时刻），改会话默认时区不动数据。
        pgCommand(pgExecutable(binDir, "pg_ctl"), ["-D", dataDir, "-l", path.join(root, "postgres.log"),
          "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c timezone=UTC`, "-w", "-t", "30", "start"], env);
      } catch (error) { startError = error; }
      if (fs.existsSync(pidFile)) {
        const actual = inspectPostmaster(null);
        if (actual?.live) {
          if (actual.port !== port || Date.parse(actual.createdAt) < attemptedAt - 5000) throw new Error("desktop_pg_unexpected_postmaster");
          ownedProcess = actual; // Capture even if pg_ctl reported a wait timeout.
          persist({ postmaster: actual });
        }
      }
      if (startError) {
        if (!ownedProcess && await occupied(port)) continue;
        throw startError;
      }
      if (!ownedProcess) throw new Error("desktop_pg_start_unconfirmed");
      await adminVerify();
      return;
    }
    throw new Error("desktop_pg_port_unavailable");
  }

  try {
    if (initialize) {
      manifest = { purpose: PURPOSE, schemaVersion: 1, instanceId: randomUUID(), majorVersion: 16,
        locale: "C", encoding: "UTF8", phase: "initializing", systemIdentifier: null, postmaster: null };
      writePgJsonAtomic(stateFile, manifest);
      credentials = { adminPassword: randomBytes(32).toString("base64url"), password: randomBytes(32).toString("base64url") };
      savePgCredentials(secretFile, manifest.instanceId, credentials);
      const passwordFile = path.join(root, "init-password");
      try {
        fs.writeFileSync(passwordFile, credentials.adminPassword, { flag: "wx", mode: 0o600 });
        pgCommand(pgExecutable(binDir, "initdb"), ["-D", dataDir, "--username", ADMIN, "--encoding=UTF8", "--locale-provider=libc",
          "--locale=C", "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "--pwfile", passwordFile], env, 60_000, path.join(root, "initdb-diagnostic.json"));
      } finally { fs.rmSync(passwordFile, { force: true }); }
      persist({ systemIdentifier: pgControlIdentifier(binDir, dataDir) });
    } else {
      manifest = validManifest(readPgJson(stateFile), expectedInstanceId);
      if (manifest.phase !== "ready" || !/^\d+$/u.test(manifest.systemIdentifier ?? "")) throw new Error("desktop_pg_incomplete_initialization");
      if (fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim() !== "16") throw new Error("desktop_pg_incompatible_major_version");
      credentials = loadPgCredentials(secretFile, manifest.instanceId);
    }
    await startOrRecover();
    if (initialize) {
      const client = new Client(clientConfig(true, "postgres"));
      try {
        await client.connect();
        await client.query(`CREATE ROLE ${BUSINESS} LOGIN PASSWORD '${credentials.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
        await client.query(`CREATE DATABASE ${BUSINESS} OWNER ${BUSINESS} TEMPLATE template0`);
      } finally { await client.end().catch(() => {}); }
      persist({ phase: "ready" });
    }
    const client = new Client(clientConfig());
    try { await client.connect(); await client.query("SELECT 1"); } finally { await client.end().catch(() => {}); }
  } catch (error) {
    let stopUnconfirmed = false;
    if (manifest && ownedProcess) { try { await stopOwned(); } catch { stopUnconfirmed = true; } }
    if (fs.existsSync(pidFile)) {
      try { if (inspectPostmaster()?.live) stopUnconfirmed = true; } catch { stopUnconfirmed = true; }
    } else if (manifest?.postmaster) {
      try { if (processStillMatches(manifest.postmaster)) stopUnconfirmed = true; } catch { stopUnconfirmed = true; }
    }
    await lease.release();
    const failure = new Error(`${error.message}; diagnosticRoot=${root}${stopUnconfirmed ? "; stop_unconfirmed" : ""}`);
    failure.code = error.code;
    throw failure;
  }

  function descriptor() {
    assertBound();
    return Object.freeze({ runtime: "embedded", rootDir: root, instanceId: manifest.instanceId,
      systemIdentifier: manifest.systemIdentifier, host: "127.0.0.1", port, database: BUSINESS, user: BUSINESS,
      majorVersion: 16, locale: "C", encoding: "UTF8", version: versions.postgres });
  }
  return {
    descriptor,
    async connect() {
      assertBound();
      if (closing) throw new Error("desktop_pg_runtime_closing");
      const client = new Client(clientConfig());
      try { await client.connect(); return client; } catch (error) { await client.end().catch(() => {}); throw error; }
    },
    childEnvironment(base = {}) {
      assertBound();
      const url = new URL("postgresql://127.0.0.1");
      url.username = BUSINESS; url.password = credentials.password; url.port = String(port); url.pathname = "/" + BUSINESS;
      // Sensitive output: only pass to owned child processes, never logs/renderer/ready events.
      return { ...isolatedPgEnv(base), DATABASE_URL: url.toString() };
    },
    async verify() { assertBound(); inspectPostmaster(); await adminVerify(); return descriptor(); },
    async backup() {
      assertBound(); await adminVerify();
      const directory = path.join(root, "backups");
      if (!fs.existsSync(directory)) fs.mkdirSync(directory); else refuseLink(directory);
      const file = path.join(directory, `desktop-${randomUUID()}.dump`);
      const temporary = file + ".partial";
      pgCommand(pgExecutable(binDir, "pg_dump"), ["--host", "127.0.0.1", "--port", String(port), "--username", BUSINESS,
        "--dbname", BUSINESS, "--format=custom", "--no-owner", "--no-privileges", "--file", temporary], { ...env, PGPASSWORD: credentials.password });
      if (!fs.statSync(temporary).size) throw new Error("desktop_pg_empty_backup");
      fs.renameSync(temporary, file);
      return file;
    },
    async restoreEmptyDatabase(file) {
      assertBound(); await adminVerify();
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error("desktop_pg_invalid_restore_file");
      const client = new Client(clientConfig());
      try {
        await client.connect();
        const objects = await client.query(`SELECT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
            AND c.relkind IN ('r','p','v','m','S','f','c')
          UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
          UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND t.typtype IN ('d','e')
          UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public')
            AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
        ) AS populated`);
        const active = await client.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
        if (objects.rows[0].populated || active.rows[0].n) throw new Error("desktop_pg_restore_target_not_empty_or_idle");
      } finally { await client.end().catch(() => {}); }
      pgCommand(pgExecutable(binDir, "pg_restore"), ["--host", "127.0.0.1", "--port", String(port), "--username", BUSINESS,
        "--dbname", BUSINESS, "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error", fs.realpathSync(file)],
      { ...env, PGPASSWORD: credentials.password }, 180_000);
      await adminVerify();
    },
    async close() {
      if (closed) return;
      if (closing) throw new Error("desktop_pg_runtime_closing");
      closing = true;
      try { await stopOwned(); await lease.release(); closed = true; }
      finally { closing = false; }
    },
  };
}
