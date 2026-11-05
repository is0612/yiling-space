import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

/** Fixture writes run only in the newly created local database, never DATABASE_URL itself. */
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Chat isolation requires local PostgreSQL.");
const databaseName = `yiling_chat_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_chat_test_[a-f0-9]{32}$/.test(databaseName));
const target = new URL(source);
target.pathname = `/${databaseName}`;
assert.notEqual(target.pathname, source.pathname);
const admin = new Client({ connectionString: source.toString() });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const env = { ...process.env, DATABASE_URL: target.toString(), YILING_CHAT_ISOLATED_DB: "1", LLM_API_KEY: "", LLM_MODEL: "",
    LLM_BASE_URL: "http://127.0.0.1:4010/v1" };
  const run = (entry: string, args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Isolated chat check failed: ${args.join(" ")}`);
  };
  run("node_modules/prisma/build/index.js", ["migrate", "deploy"]);
  for (const script of ["test-desktop-conversation-db.ts", "test-chat-conversation-delete-db.ts",
    "test-chat-request-idempotency-db.ts", "test-chat-private-memory-db.ts"]) {
    run("node_modules/tsx/dist/cli.mjs", [`scripts/${script}`]);
  }
  console.log("Isolated chat checks passed; no business fixtures or paid models were used.");
} finally {
  try {
    if (created) {
      // Only the exact validated disposable target above is removed.
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log("Removed disposable chat-test database.");
    }
  } finally { await admin.end(); }
}
