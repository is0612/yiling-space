import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

/** Event Center tests must only ever touch a disposable local database. */
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname),
  "Growth Event Center isolated tests require a local PostgreSQL host.");
const databaseName = `yiling_growth_event_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_growth_event_test_[a-f0-9]{32}$/.test(databaseName));
const target = new URL(source);
target.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: source.toString() });
await admin.connect();
let created = false;

try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const env = { ...process.env, DATABASE_URL: target.toString() };
  const run = (entry: string, args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Isolated check failed: ${args.join(" ")}`);
  };
  run("node_modules/prisma/build/index.js", ["migrate", "deploy"]);
  run("node_modules/tsx/dist/cli.mjs", ["scripts/test-growth-event-center-db.ts"]);
  console.log("Isolated Growth Event Center checks passed; business database was not used.");
} finally {
  try {
    if (created) {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log("Removed disposable Growth Event Center test database.");
    }
  } finally {
    await admin.end();
  }
}
