import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runTestFile } from "./test-process.mjs";
import { buildTestPlan } from "./test-plan.mjs";
import { isolatedSuites, isolatedTestFiles } from "./test-isolation-map.mjs";

const scripts = {
  "test:unit": "tsx scripts/test-unit.ts",
  "test:alias": "yarn run test:unit && node scripts/test-extra.mjs",
  "test:child-db": "tsx scripts/test-child-db.ts",
  "test:parent-isolated": "tsx scripts/test-parent-isolated.ts",
  "test:all": "node scripts/test-all.mjs",
};
const suites = { "test-parent-isolated.ts": ["test-child-db.ts", "test-unregistered-child.ts"] };
const plan = buildTestPlan(scripts, suites);
assert.deepEqual(plan.tasks.map(task => task.file), ["scripts/test-unit.ts", "scripts/test-extra.mjs", "scripts/test-parent-isolated.ts"]);
assert(plan.coverage.includes("scripts/test-unregistered-child.ts"), "A child without a package entry must remain covered.");
assert.equal(plan.tasks.filter(task => task.file.endsWith("test-unit.ts")).length, 1, "Aliases must not rerun their leaves.");
assert.deepEqual(buildTestPlan(scripts, suites, { only: /^test:child-db$/u }).tasks.map(task => task.file), ["scripts/test-parent-isolated.ts"], "A filtered child request routes to its safe parent.");
assert(buildTestPlan(scripts, suites, { db: true }).tasks.every(task => task.file.endsWith("test-parent-isolated.ts")));
const shared = buildTestPlan({ ...scripts, "test:other-isolated": "tsx scripts/test-other-isolated.ts" }, {
  ...suites, "test-other-isolated.ts": ["test-child-db.ts"],
});
assert(shared.tasks.some(task => task.file.endsWith("test-parent-isolated.ts")));
assert(shared.tasks.some(task => task.file.endsWith("test-other-isolated.ts")), "Different parent fixture contexts must both execute.");
assert(!shared.tasks.some(task => task.file.endsWith("test-child-db.ts")));
const skippedDependency = buildTestPlan(scripts, suites, { only: /^test:alias$/u, skip: /unit/u });
assert.deepEqual(skippedDependency.tasks.map(task => task.file), ["scripts/test-extra.mjs"], "A composite suite must not reintroduce a skipped alias.");
const skippedFile = buildTestPlan(scripts, suites, { only: /^test:alias$/u, skip: /test-extra/u });
assert.deepEqual(skippedFile.tasks.map(task => task.file), ["scripts/test-unit.ts"], "Inline script commands must also honor skip.");
assert.throws(() => buildTestPlan(scripts, suites, { only: /^test:child-db$/u, skip: /parent-isolated/u }), /没有可执行/u,
  "A child request must not resurrect its excluded safe parent.");
assert.throws(() => buildTestPlan({ "test:a": "yarn run test:b", "test:b": "yarn run test:a" }, {}), /循环引用/u);
assert.throws(() => buildTestPlan({ "test:a": "yarn run test:missing" }, {}), /不存在/u);
assert.throws(() => buildTestPlan({ "test:a": "echo pretend" }, {}), /无法明确展开/u);
assert.throws(() => buildTestPlan(scripts, { "test-missing.ts": ["test-child-db.ts"] }), /未接入/u);
assert.throws(() => buildTestPlan(scripts, { "test-parent-isolated.ts": ["test-child-db.ts", "test-child-db.ts"] }), /重复子测试/u);
assert.throws(() => isolatedTestFiles(new URL("test-unknown.ts", import.meta.url).href), /未登记/u);
const children = isolatedTestFiles(new URL("test-chat-isolated.ts", import.meta.url).href);
children.pop();
assert.equal(isolatedTestFiles(new URL("test-chat-isolated.ts", import.meta.url).href).length, isolatedSuites["test-chat-isolated.ts"].length, "Callers must not mutate the shared list.");

const repoScripts = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
const actual = buildTestPlan(repoScripts, isolatedSuites);
// Independent declaration inventory: compare all literal package leaves and explicitly owned children.
const expected = new Set(Object.entries(repoScripts).filter(([name, command]) => name.startsWith("test:") && !command.includes("scripts/test-all.mjs"))
  .flatMap(([, command]) => [...command.matchAll(/(?:tsx|node) (scripts\/[\w.-]+\.(?:ts|mjs))/gu)].map(match => match[1])));
for (const [parent, files] of Object.entries(isolatedSuites)) {
  expected.add(`scripts/${parent}`);
  for (const file of files) expected.add(`scripts/${file}`);
  const source = fs.readFileSync(new URL(parent, import.meta.url), "utf8");
  assert(source.includes("isolatedTestFiles(import.meta.url)"), `Actual parent must consume the shared list: ${parent}`);
}
assert.deepEqual(actual.coverage, [...expected].sort(), "Deduplication must retain every declared executable and isolated child.");
assert.equal(new Set(actual.tasks.map(task => task.file)).size, actual.tasks.length);
assert(!buildTestPlan(repoScripts, isolatedSuites, { skip: /onebot/iu }).tasks.some(task => /onebot/iu.test(task.file)),
  "Real large suites must not reintroduce OneBot scripts after --skip=onebot.");
for (const file of actual.coverage) assert(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
for (const files of Object.values(isolatedSuites)) for (const child of files) {
  assert(!actual.tasks.some(task => task.file === `scripts/${child}`), `Isolated child must not run on the ordinary test database: ${child}`);
}
function cli(args) {
  const result = spawnSync(process.execPath, ["scripts/test-all.mjs", ...args], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}
const listed = cli(["--only=^test:memory-retrieval$", "--list", "--json"]);
assert.equal(listed.status, 0, listed.stderr);
assert.equal(JSON.parse(listed.stdout).tasks.length, 1);
assert.notEqual(cli(["--timeout=Infinity", "--check"]).status, 0);
assert.notEqual(cli(["--children"]).status, 0, "The old unsafe child execution mode must be refused.");
assert.notEqual(cli(["--only=nonexistent-test", "--check"]).status, 0);
const workflow = fs.readFileSync(new URL("../.github/workflows/phase-0-validation.yml", import.meta.url), "utf8");
assert.equal([...workflow.matchAll(/run: yarn(?: run)? test:/gu)].length, 1, "CI must have one shared test invocation, not duplicate individual suites.");
assert(workflow.includes("run: yarn run test:all"));
assert(workflow.includes("./scripts/test-restore-db.ps1"), "Independent restore regression must be retained.");
assert(workflow.includes("  fresh-clone:"), "Independent fresh-clone installation check must be retained.");
assert.equal([...repoScripts["verify:local"].matchAll(/yarn run test:/gu)].length, 1);
assert(repoScripts["verify:local"].includes("yarn run test:all"), "Local verification and CI use the same runner.");

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yiling-test-runner-"));
try {
  fs.writeFileSync(path.join(fixtureRoot, "pass.cjs"), "process.stdout.write('final stdout'); process.stderr.write('final stderr');");
  fs.writeFileSync(path.join(fixtureRoot, "fail.cjs"), "process.stderr.write('intentional failure'); process.exitCode = 7;");
  fs.writeFileSync(path.join(fixtureRoot, "timeout.cjs"), "setInterval(() => {}, 1000);");
  const run = (file, timeoutMs = 5000) => runTestFile({ runner: "node", file }, { root: fixtureRoot, timeoutMs });
  const passed = await run("pass.cjs");
  assert(passed.ok);
  assert(passed.output.includes("final stdout") && passed.output.includes("final stderr"), "Final output must drain before reporting success.");
  const failed = await run("fail.cjs");
  assert.equal(failed.code, 7);
  assert.equal(failed.ok, false);
  assert(failed.output.includes("intentional failure"));
  const timedOut = await run("timeout.cjs", 250);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert(timedOut.output.includes("[超时]"));
} finally {
  assert.equal(path.resolve(fixtureRoot), fixtureRoot);
  assert(path.basename(fixtureRoot).startsWith("yiling-test-runner-"));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log(`Test plan checks passed: ${actual.roots.length} entries, ${actual.expandedCount} references -> ${actual.tasks.length} unique top-level scripts; ${actual.coverage.length} covered scripts, no lost declarations or direct isolated children.`);
