import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

/** Creates an empty, disposable LOCAL database; never runs tests against DATABASE_URL itself. */
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Isolated tests require a local PostgreSQL host.");
const databaseName = `yiling_memory_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(databaseName));
const target = new URL(source);
target.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: source.toString() });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const env = {
    ...process.env,
    DATABASE_URL: target.toString(),
    LLM_API_KEY: "", LLM_MODEL: "", LLM_BASE_URL: "http://127.0.0.1:4010/v1",
  };
  const run = (entry: string, args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Isolated check failed: ${args.join(" ")}`);
  };
  run("node_modules/prisma/build/index.js", ["migrate", "deploy"]);
  const fixture = new Client({ connectionString: target.toString() });
  await fixture.connect();
  try {
    await fixture.query('INSERT INTO "users" (id, username, "passwordHash", "updatedAt") VALUES ($1, $2, $3, NOW())',
      [randomUUID(), "isolated-memory-fixture", "not-a-real-password-hash"]);
  } finally { await fixture.end(); }
  for (const script of [
    "test-interaction-experiences-db.ts", "test-interaction-experience-settings-db.ts", "test-interaction-experience-automatic-db.ts",
    "test-memory-scheduler-db.ts", "test-memory-events-db.ts", "test-private-chat-events-db.ts",
    "test-memory-event-move-db.ts", "test-owner-private-scope-db.ts", "test-chat-private-memory-db.ts",
    "test-character-portable-db.ts", "test-memory-event-pagination-db.ts", "test-memory-item-lifecycle-db.ts", "test-memory-cleanup-dependency-db.ts", "test-private-chat-pagination-db.ts", "test-event-extraction-quality-db.ts", "test-memory-events-manual-queue-db.ts", "test-snapshot-review-db.ts", "test-memory-job-fencing-db.ts", "test-memory-scheduler-atomic-db.ts", "test-snapshot-generate-db.ts", "test-memory-settings-db.ts", "test-memory-progress-db.ts",
  ]) run("node_modules/tsx/dist/cli.mjs", [`scripts/${script}`]);
  console.log("Isolated memory database checks passed; business database was not used for tests.");
} finally {
  try {
    if (created) {
      // Exact generated target verified above; only the disposable database is removed.
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log("Removed disposable memory-test database.");
    }
  } finally {
    await admin.end();
  }
}
