import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname));
const name = `yiling_scoped_growth_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_scoped_growth_test_[a-f0-9]{32}$/.test(name));
const target = new URL(source); target.pathname = `/${name}`;
const admin = new Client({ connectionString: source.toString() }); await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  const env = { ...process.env, DATABASE_URL: target.toString(), LLM_API_KEY: "", LLM_MODEL: "" };
  for (const args of [["node_modules/prisma/build/index.js", "migrate", "deploy"], ["node_modules/tsx/dist/cli.mjs", "scripts/test-scoped-growth-boundaries-db.ts"]]) {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Scoped growth isolated check failed: ${args[args.length - 1]}`);
  }
} finally { try { if (created) { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); console.log("Removed disposable scoped growth database."); } } finally { await admin.end(); } }
