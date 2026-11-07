import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

/**
 * 忆泡日历分页的隔离数据库回归入口。
 *
 * 和 `test-memory-reliability-isolated.ts` 一样：自己建一个一次性本地库，
 * 跑完就 DROP，绝不对 `DATABASE_URL` 指向的业务库跑测试。
 */
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Isolated tests require a local PostgreSQL host.");
const databaseName = `yiling_days_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_days_test_[a-f0-9]{32}$/.test(databaseName));
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
    LLM_API_KEY: "",
    LLM_MODEL: "",
    LLM_BASE_URL: "http://127.0.0.1:4010/v1",
  };
  const run = (entry: string, args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Isolated check failed: ${args.join(" ")}`);
  };
  run("node_modules/prisma/build/index.js", ["migrate", "deploy"]);
  run("node_modules/tsx/dist/cli.mjs", ["scripts/test-days-pagination-db.ts"]);
  console.log("Isolated memory calendar checks passed; business database was not used for tests.");
} finally {
  try {
    if (created) {
      // Exact generated target verified above; only the disposable database is removed.
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log("Removed disposable calendar-test database.");
    }
  } finally {
    await admin.end();
  }
}
