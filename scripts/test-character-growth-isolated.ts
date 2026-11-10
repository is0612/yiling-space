import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
const source = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname));
const name = `yiling_growth_card_test_${randomUUID().replaceAll("-", "")}`;
assert(/^yiling_growth_card_test_[a-f0-9]{32}$/.test(name));
const target = new URL(source); target.pathname = `/${name}`; assert.notEqual(target.pathname, source.pathname);
const admin = new Client({ connectionString: source.toString() }); await admin.connect(); let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  const env = { ...process.env, DATABASE_URL: target.toString(), LLM_API_KEY: "", LLM_MODEL: "" };
  const steps = [["node_modules/prisma/build/index.js", "migrate", "deploy"], ...["test-character-growth-transfer-db.ts", "test-character-growth-db.ts", "test-character-portable-db.ts"].map(file => ["node_modules/tsx/dist/cli.mjs", `scripts/${file}`])];
  for (const [entry, ...args] of steps) {
    const result = spawnSync(process.execPath, [entry!, ...args], { env, stdio: "inherit" });
    if (result.error) throw result.error; assert.equal(result.status, 0, `Growth card isolated test failed: ${args.join(" ")}`);
  }
  console.log("Growth card isolated checks passed without business database fixture writes.");
} finally { try { if (created) { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); console.log("Removed disposable growth card database."); } } finally { await admin.end(); } }
