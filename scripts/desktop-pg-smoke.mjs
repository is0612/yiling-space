import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { createEmbeddedPgPrototype, isolatedPgEnv, verifyPgBinaries } from "./embedded-postgres-prototype.mjs";

// Deliberately no dotenv import: never reads or connects to the user's business DATABASE_URL.
const binDir = process.env.YILING_TEST_PG_BIN;
if (!binDir || !path.isAbsolute(binDir)) {
  throw new Error("Set YILING_TEST_PG_BIN to the absolute path of verified PostgreSQL 16 binaries; no system service or business database is used.");
}
const parentDir = path.resolve(".data", "desktop-pg-a0");
fs.mkdirSync(parentDir, { recursive: true });
assert.throws(() => verifyPgBinaries("relative-bin"), /must_be_absolute/u);
const env = isolatedPgEnv({ DATABASE_URL: "postgresql://must-not-use.invalid", PGSERVICE: "business", PGOPTIONS: "untrusted", PATH: "test" });
assert.equal(env.DATABASE_URL, undefined);
assert.equal(env.PGSERVICE, undefined);
assert.equal(env.PGOPTIONS, undefined);
assert.equal(env.PATH, "test");
let instance;
const previousPgOptions = process.env.PGOPTIONS;
process.env.PGOPTIONS = "-c nonexistent_a0_setting=1";
try {
  instance = await createEmbeddedPgPrototype({ binDir, parentDir });
  const info = instance.info();
  assert(info.running && info.systemIdentifier && info.port);
  assert(!fs.existsSync(path.join(instance.root, "init-password")), "initdb password file must be removed");
  let client = await instance.connect();
  try {
    const identity = await client.query("SELECT current_database() AS db, current_user AS name, pg_encoding_to_char(encoding) AS encoding, datcollate FROM pg_database WHERE datname = current_database()");
    assert.equal(identity.rows[0].db, "yiling_hub");
    assert.equal(identity.rows[0].name, "yiling_hub");
    assert.equal(identity.rows[0].encoding, "UTF8");
    assert.equal(identity.rows[0].datcollate, "C");
    const permissions = await client.query("SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user");
    assert.deepEqual(permissions.rows[0], { rolsuper: false, rolcreatedb: false });
    await client.query("CREATE TABLE a0_fixture (id integer PRIMARY KEY, body text NOT NULL, metadata jsonb NOT NULL, at timestamptz NOT NULL)");
    await client.query("INSERT INTO a0_fixture VALUES (1, $1, $2::jsonb, $3::timestamptz)",
      ["测试角色：备份与恢复", JSON.stringify({ source: "synthetic", tags: ["中文", "test"] }), "2026-01-01T08:00:00Z"]);
  } finally { await client.end(); }
  const unauthenticated = new Client({ host: "127.0.0.1", port: info.port, user: "yiling_hub", password: "wrong-password", database: "yiling_hub", ssl: false, connectionTimeoutMillis: 5000 });
  try { await assert.rejects(() => unauthenticated.connect(), /password authentication failed/u); }
  finally { await unauthenticated.end().catch(() => {}); }
  const dump = await instance.backup();
  client = await instance.restore(dump);
  try {
    const restored = await client.query("SELECT id, body, metadata, at FROM a0_fixture");
    assert.equal(restored.rowCount, 1);
    assert.equal(restored.rows[0].body, "测试角色：备份与恢复");
    assert.deepEqual(restored.rows[0].metadata, { source: "synthetic", tags: ["中文", "test"] });
    assert.equal(restored.rows[0].at.toISOString(), "2026-01-01T08:00:00.000Z");
  } finally { await client.end(); }
  await assert.rejects(() => instance.restore(dump), /already exists/u, "restore must not overwrite an existing target");
  const manifestFile = path.join(instance.root, "prototype.json");
  const originalManifest = fs.readFileSync(manifestFile, "utf8");
  try {
    const tampered = JSON.parse(originalManifest); tampered.id = "different-installation";
    fs.writeFileSync(manifestFile, JSON.stringify(tampered));
    await assert.rejects(() => instance.stop(), /identity_mismatch/u, "refuse to stop an unrecognised instance");
  } finally { fs.writeFileSync(manifestFile, originalManifest); }
  await instance.stop();
  assert(!instance.info().running);
  assert(!fs.existsSync(path.join(instance.root, "pgdata", "postmaster.pid")), "postmaster must stop before cleanup");
  await assert.rejects(() => instance.connect(), /not_running/u);
  await instance.start();
  assert.equal(instance.info().systemIdentifier, info.systemIdentifier, "restart must reuse the original cluster");
  client = await instance.connect();
  try { assert.equal((await client.query("SELECT count(*)::integer AS n FROM a0_fixture")).rows[0].n, 1); }
  finally { await client.end(); }
  console.log(JSON.stringify({ status: "passed", release: instance.versions.postgres, checks: [
    "fresh isolated initdb", "SCRAM rejects wrong password", "UTF8/C locale", "non-superuser business role",
    "SQL/JSONB/timestamp", "dump and independent restore", "no overwrite restore", "instance binding guard",
    "clean stop", "same cluster restart", "no business database environment",
  ] }));
} finally {
  if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
  else process.env.PGOPTIONS = previousPgOptions;
  if (instance) {
    const root = instance.root;
    await instance.dispose();
    assert(!fs.existsSync(root));
    console.log("A0 temporary cluster stopped and removed; business database was not used.");
  }
}
