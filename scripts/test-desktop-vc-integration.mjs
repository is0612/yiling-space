import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireDesktopVcRuntime, desktopVcCheckCommand } from "./desktop-vc-check.mjs";
import { desktopInstallCommand } from "./desktop-install.mjs";

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yiling-vc-gate-"));
const report = (status, checkStatus) => ({ format: "yiling-desktop-vc-check", version: 1, status, architecture: "x64",
  required: ["vcruntime140.dll"], checks: [{ name: "vcruntime140.dll", status: checkStatus }],
  scope: "pg-distribution", automaticInstall: false, redistributed: false });
try {
  assert.equal((await requireDesktopVcRuntime({}, async () => report("ready", "ready"))).status, "ready");
  for (const [status, checkStatus] of [["missing", "missing"], ["incompatible", "wrong-architecture"], ["incompatible", "load-failed"], ["unverified", "unverified"]]) {
    await assert.rejects(() => requireDesktopVcRuntime({}, async () => report(status, checkStatus)), error => error.code === "DESKTOP_VC_PREREQUISITE" && error.report.status === status);
    if (process.platform === "win32") {
      const destination = path.join(root, status + "-" + checkStatus);
      let observed;
      await assert.rejects(() => desktopInstallCommand(["install", "--source", path.join(root, "synthetic-payload"),
        "--target", destination, "--state-dir", destination + "-state", "--data-dir", destination + "-data"], {
        inspectRuntime: async options => { observed = options; return report(status, checkStatus); },
      }), /msvc_runtime_required/u);
      assert.equal(observed.pgRoot, path.join(root, "synthetic-payload", "runtime", "pgsql"));
      for (const folder of [destination, destination + "-state", destination + "-data"]) assert(!fs.existsSync(folder), "VC failure must precede any installation/data writes");
    }
  }
  await assert.rejects(() => requireDesktopVcRuntime({}, async () => report("ready", "missing")), /report_invalid/u);
  await assert.rejects(() => requireDesktopVcRuntime({}, async () => ({ ...report("ready", "ready"), automaticInstall: true })), /report_invalid/u);
  await assert.rejects(() => desktopVcCheckCommand(["--pg-root"]), /arguments_invalid/u);
  console.log("VC install integration passed: explicit mock ready/missing/wrong-architecture/load-failed/unverified, inconsistent report refusal, and no target/state/data created on failure. No system component was installed or modified.");
} finally { fs.rmSync(root, { recursive: true }); }
