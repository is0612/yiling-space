import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Preference isolated tests require local PostgreSQL.");
source.pathname = "/postgres";
const databaseName = `yiling_preferences_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_preferences_test_[a-f0-9]{32}$/.test(databaseName));
const target = new URL(source); target.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: source.toString(), connectionTimeoutMillis: 5_000 });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
  const env = { ...process.env, DATABASE_URL: target.toString(), LLM_API_KEY: "", LLM_MODEL: "" };
  for (const [entry, args] of [
    ["node_modules/prisma/build/index.js", ["migrate", "deploy"]],
    ["node_modules/tsx/dist/cli.mjs", ["scripts/test-preferences-db.ts"]],
  ] as const) {
    const result = spawnSync(process.execPath, [entry, ...args], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Preference isolated check failed: ${args.join(" ")}`);
  }
  console.log("Preference isolated checks passed; business database was not used.");
} finally {
  try {
    if (created) { await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); console.log("Removed disposable preference test database."); }
  } finally { await admin.end(); }
}
