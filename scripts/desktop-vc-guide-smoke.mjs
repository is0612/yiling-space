import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

if (process.platform !== "win32" || !process.env.YILING_TEST_PG_DISTRIBUTION) throw new Error("Windows and verified YILING_TEST_PG_DISTRIBUTION required");
const parent = path.resolve(".data", "desktop-vc-tests"); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "guide-"));
const payload = path.join(root, "payload"), output = path.join(root, "installer");
const scriptDir = path.join(payload, "app", "scripts"); fs.mkdirSync(scriptDir, { recursive: true });
fs.mkdirSync(path.join(payload, "runtime"));
fs.copyFileSync(process.execPath, path.join(payload, "runtime", "node.exe"));
fs.cpSync(fs.realpathSync(process.env.YILING_TEST_PG_DISTRIBUTION), path.join(payload, "runtime", "pgsql"), { recursive: true });
for (const file of ["desktop-vc-check.mjs", "desktop-vc-runtime.mjs", "desktop-pg-distribution.mjs", "desktop-pg-tools.mjs"]) fs.copyFileSync(path.resolve("scripts", file), path.join(scriptDir, file));
fs.writeFileSync(path.join(payload, "desktop-package.json"), JSON.stringify({ format: "yiling-desktop-package", version: 1,
  packageId: randomUUID(), appVersion: "vc-guide-synthetic-fixture", runtime: "embedded", pgRelease: "16.16-2" }));
const sentinel = path.join(root, "unexpected-install-call");
fs.writeFileSync(path.join(scriptDir, "desktop-install.mjs"), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'unexpected fixture install');process.exit(99);`);
function run(executable, args) { return spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }); }
const generated = run(process.execPath, [path.resolve("scripts", "desktop-installer.mjs"), "--source", payload, "--out", output]);
fs.writeFileSync(path.join(root, "generation.log"), generated.stdout + "\n" + generated.stderr);
assert.equal(generated.status, 0, "generate prerequisite guide around a deliberately minimal, non-installable fixture");
const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const checked = run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(output, "check-runtime.ps1")]);
fs.writeFileSync(path.join(root, "current-system-check.log"), checked.stdout + "\n" + checked.stderr);
assert.equal(checked.status, 0, "current system must genuinely pass verified PG dependency and native-load inspection");
assert(!fs.existsSync(sentinel), "standalone check must not call the installer");
const installedLayoutCheck = run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(output, "payload", "check-runtime.ps1")]);
fs.writeFileSync(path.join(root, "installed-layout-check.log"), installedLayoutCheck.stdout + "\n" + installedLayoutCheck.stderr);
assert.equal(installedLayoutCheck.status, 0, "the check copied into the future program directory must resolve its own runtime without a payload subfolder");
assert(fs.existsSync(path.join(output, "payload", "VC-runtime-guide.html")));
const guide = fs.readFileSync(path.join(output, "VC-runtime-guide.html"), "utf8");
assert(guide.includes("learn.microsoft.com/zh-cn/cpp/windows/latest-supported-vc-redist"));
assert(guide.includes("管理员授权")); assert(!/<script/iu.test(guide));
assert(!fs.existsSync(path.join(output, "vc_redist.x64.exe")));
// Replace only the check entry in this explicitly synthetic fixture, never a system DLL.
const checker = path.join(output, "payload", "app", "scripts", "desktop-vc-check.mjs");
for (const [status, checkStatus] of [["missing", "missing"], ["incompatible", "wrong-architecture"], ["unverified", "unverified"]]) {
  fs.writeFileSync(checker, `console.log(JSON.stringify(${JSON.stringify({ format: "yiling-desktop-vc-check", version: 1, scope: "pg-distribution", status,
    checks: [{ name: "vcruntime140.dll", status: checkStatus }], automaticInstall: false, redistributed: false })}));process.exitCode=2;`);
  const target = path.join(root, "never-install-" + status);
  const result = run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(output, "install.ps1"),
    "-Target", target, "-StateDir", target + "-state", "-DataDir", target + "-data", "-NoRegistry", "-NoShortcuts"]);
  fs.writeFileSync(path.join(root, status + ".log"), result.stdout + "\n" + result.stderr);
  assert.equal(result.status, 2, "expected prerequisite condition must stop cleanly, not crash or invoke an installer");
  for (const file of [target, target + "-state", target + "-data", sentinel]) assert(!fs.existsSync(file));
}
console.log(JSON.stringify({ status: "passed", checks: ["real current-system PG DLL loading", "bundled Node standalone check", "offline Microsoft guide", "explicit mocked missing/incompatible/unverified stop before installation", "no redistributed VC executable"], artifacts: root, databaseOrSystemInstallation: false }));
