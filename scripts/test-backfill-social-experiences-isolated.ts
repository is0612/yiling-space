import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

/**
 * 历史社交经历回填的隔离数据库入口。
 *
 * 和 `test-days-pagination-isolated.ts` 一样：自己建一个一次性本地库、跑完就 DROP，
 * 绝不对 `DATABASE_URL` 指向的业务库执行 —— 回填脚本会带 `--apply` 真写库。
 *
 * 库名必须匹配 `yiling_social_bf_test_<32 位十六进制>`，`test-backfill-social-experiences-db.ts`
 * 会校验这个名字，名字不符就拒绝执行。
 */
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Isolated tests require a local PostgreSQL host.");
const databaseName = `yiling_social_bf_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_social_bf_test_[a-f0-9]{32}$/.test(databaseName));
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
  run("node_modules/tsx/dist/cli.mjs", ["scripts/test-backfill-social-experiences-db.ts"]);
  console.log("Isolated social backfill checks passed; business database was not used for tests.");
} finally {
  try {
    if (created) {
      // Exact generated target verified above; only the disposable database is removed.
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      console.log("Removed disposable social-backfill test database.");
    }
  } finally {
    await admin.end();
  }
}
