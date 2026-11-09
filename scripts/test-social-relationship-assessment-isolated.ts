import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

/**
 * 社交关系评估数据库基础的隔离验收入口。
 * 只允许在本地 PostgreSQL 上创建一次性数据库，执行全部迁移和 DB 断言后 DROP。
 */
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Isolated tests require a local PostgreSQL host.");
const databaseName = `yiling_social_assessment_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_social_assessment_test_[a-f0-9]{32}$/.test(databaseName));
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
  run("node_modules/tsx/dist/cli.mjs", ["scripts/test-social-relationship-assessment-db.ts"]);
  run("node_modules/tsx/dist/cli.mjs", ["scripts/test-social-relationship-assessment-ai-db.ts"]);
  console.log("Isolated social relationship assessment database checks passed.");
} finally {
  try {
    if (created) {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log("Removed disposable social-assessment test database.");
    }
  } finally {
    await admin.end();
  }
}
