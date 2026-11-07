import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

/** Only the freshly created, explicitly named local database may receive migrations or fixture writes. */
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Character isolation requires local PostgreSQL.");
const databaseName = `yiling_character_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_character_test_[a-f0-9]{32}$/.test(databaseName));
const target = new URL(source);
target.pathname = `/${databaseName}`;
assert.notEqual(target.pathname, source.pathname);
const admin = new Client({ connectionString: source.toString() });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const env = { ...process.env, DATABASE_URL: target.toString(), LLM_API_KEY: "", LLM_MODEL: "",
    LLM_BASE_URL: "http://127.0.0.1:4010/v1" };
  const run = (entry: string, args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Isolated character check failed: ${args.join(" ")}`);
  };
  run("node_modules/prisma/build/index.js", ["migrate", "deploy"]);
  for (const script of [
    "test-character-portable-db.ts",
    "test-character-sync-root-db.ts",
    "test-character-delete-db.ts",
  ]) {
    run("node_modules/tsx/dist/cli.mjs", [`scripts/${script}`]);
  }
  console.log("Isolated character database checks passed; business data was not used for fixtures.");
} finally {
  try {
    if (created) {
      // Exact disposable target was validated above; never drop the source database.
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log("Removed disposable character-test database.");
    }
  } finally { await admin.end(); }
}
