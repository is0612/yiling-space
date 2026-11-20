/** Shared CI/local test runner. Package aliases expand to unique executable files. */
import { runTestFile } from "./test-process.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildTestPlan } from "./test-plan.mjs";
import { isolatedSuites } from "./test-isolation-map.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map(raw => {
  const matched = /^--([^=]+)(?:=([\s\S]*))?$/u.exec(raw);
  if (!matched) throw new Error(`非法参数：${raw}`);
  return [matched[1], matched[2] ?? "true"];
}));
const supported = new Set(["timeout", "bail", "verbose", "only", "skip", "db", "list", "json", "check", "children"]);
for (const key of Object.keys(args)) if (!supported.has(key)) throw new Error(`未知参数：--${key}`);
const timeoutMs = Number(args.timeout ?? 300_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("timeout 必须是有限的正毫秒数。");
if (args.children === "true" && args.list !== "true" && args.check !== "true") {
  throw new Error("隔离子测试不能在普通数据库上直接跑。请筛选对应 test:*-isolated；--children 只用于 --list/--check 查看。");
}
const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
const plan = buildTestPlan(scripts, isolatedSuites, {
  only: args.only ? new RegExp(args.only, "i") : undefined,
  skip: args.skip ? new RegExp(args.skip, "i") : undefined,
  db: args.db === "true",
});
for (const file of plan.coverage) if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`测试文件不存在：${file}`);
if (args.json === "true") {
  if (args.list !== "true" && args.check !== "true") throw new Error("--json 仅用于 --list/--check，不执行测试。");
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (args.list === "true") {
  for (const task of plan.tasks) {
    console.log(`${task.name} -> ${task.runner} ${task.file}`);
    if (args.children === "true") for (const child of task.children) console.log(`  隔离库内: ${child}`);
  }
}
if (args.list === "true" || args.check === "true") {
  console.log(`清单有效：${plan.roots.length} 个入口展开为 ${plan.expandedCount} 次引用，实际执行 ${plan.tasks.length} 个唯一顶层脚本，覆盖 ${plan.coverage.length} 个脚本（含隔离库子测试）。`);
  process.exit(0);
}

function duration(ms) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}
function indent(text) { return text.split("\n").map(line => `    ${line}`).join("\n"); }
const failures = [];
const startedAll = Date.now();
let ran = 0;
console.log(`${plan.roots.length} 个入口，去重后跑 ${plan.tasks.length} 个顶层脚本（单条超时 ${duration(timeoutMs)}）\n`);
for (const [index, task] of plan.tasks.entries()) {
  ran++;
  process.stdout.write(`[${String(index + 1).padStart(3, " ")}/${plan.tasks.length}] ${task.file} … `);
  const result = await runTestFile(task, { root: ROOT, timeoutMs });
  if (result.ok) {
    console.log(`ok  ${duration(result.ms)}`);
    if (args.verbose === "true" && result.output.trim()) console.log(indent(result.output.trim()));
  } else {
    console.log(`失败  ${duration(result.ms)}`);
    console.log(indent(result.output.trim() || "（没有任何输出）"));
    failures.push(result);
    if (args.bail === "true") break;
  }
}
console.log(`\n通过 ${ran - failures.length} / ${ran}，用时 ${duration(Date.now() - startedAll)}`);
if (failures.length) {
  console.log(`失败清单：\n${failures.map(failure => `  - ${failure.name}`).join("\n")}`);
  process.exitCode = 1;
} else console.log("全部通过。");
