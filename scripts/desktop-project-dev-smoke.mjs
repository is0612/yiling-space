import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import runtime from "./desktop-web-runtime.cjs";
import { waitDesktopWeb, probeDesktopWeb, desktopWebFailure } from "./desktop-web-readiness.mjs";

// Actual checkout/config/plugins/API; no desktop supervisor, migration, consumer or business request.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = path.join(root, ".tmp", "desktop-project-dev");
fs.mkdirSync(parent, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(parent, "probe-"));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const env = { ...process.env, DATABASE_URL: "postgresql://health_probe:unused@127.0.0.1:1/health_probe",
  YILING_LOCAL_API_ENABLED: "false", YILING_ALLOW_DEV_OWNER_BYPASS: "false", YILING_DESKTOP_PACKAGED: "0", YILING_DB_RUNTIME: "external" };
const plan = runtime.desktopWebPlan({ root, port, dataDir, env, mode: "development" });
const logFile = path.join(dataDir, "runtime.log");
const fd = fs.openSync(logFile, "w");
const child = spawn(process.execPath, ["--import", new URL("./memory-worker-parent.mjs", import.meta.url).href, ...plan.args], {
  cwd: root, env: plan.env, stdio: ["ignore", fd, fd, "ipc"], windowsHide: true,
});
fs.closeSync(fd);
const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
const url = `http://127.0.0.1:${port}`;
let ready;
try {
  ready = await waitDesktopWeb(url, { totalMs: 90000, cancelled: () => child.exitCode !== null,
    onProbe: result => console.log(JSON.stringify({ event: "project-health", ...result })) });
  assert(ready.ready, desktopWebFailure(ready, 90000) + ` Log: ${logFile}`);
  assert.equal((await probeDesktopWeb(url)).ready, true, "health remains live with an unreachable synthetic DB");
} finally {
  if (child.connected) child.disconnect();
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10000);
  await exited; clearTimeout(timer);
}
assert.equal((await probeDesktopWeb(url)).ready, false, "managed dev process must release the HTTP port after IPC disconnect");
console.log(JSON.stringify({ status: "passed", checks: ["actual project Nuxt config/plugins/API", "health 200 with unreachable synthetic DB", "no migration/consumers/QQ/model requests", "IPC exit closes port"], artifacts: dataDir }));
