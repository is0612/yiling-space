const { spawn, spawnSync } = require("node:child_process");
const prefix = "$ErrorActionPreference='Stop';$u=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;";
const encoded = script => Buffer.from(prefix + script, "utf16le").toString("base64");
const flags = script => ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)];
function windowsProcessBirth(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) throw new Error("desktop_parent_identity_invalid");
  const result = spawnSync("powershell.exe", flags("$v=([Console]::In.ReadToEnd()|ConvertFrom-Json);$p=[Diagnostics.Process]::GetProcessById($v.pid);$h=$p.Handle;$p.StartTime.ToUniversalTime().Ticks.ToString()"), {
    input: JSON.stringify({ pid }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 10_000,
  });
  if (result.error || result.status !== 0 || !/^\d{12,20}$/u.test(result.stdout.trim())) throw new Error("desktop_parent_identity_unavailable");
  return result.stdout.trim();
}
/** A Windows kernel process handle pins the original owner, independent of inherited pipe handles. */
function watchWindowsProcess(pid, birthTicks, onLost) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0 || !/^\d{12,20}$/u.test(birthTicks ?? "") || typeof onLost !== "function") {
    throw new Error("desktop_parent_watch_arguments_invalid");
  }
  let stopped = false, notified = false, attached = false;
  let reportReady;
  const ready = new Promise(resolve => { reportReady = resolve; });
  // PID and creation ticks are strictly numeric, non-secret lifecycle metadata. Do not
  // send them via ReadToEnd(stdin): sibling processes can inherit that writer on Windows
  // and prevent EOF forever, leaving a supposed watcher blocked before it attaches.
  const script = `try{$p=[Diagnostics.Process]::GetProcessById(${pid});$h=$p.Handle;if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne '${birthTicks}'){exit 0};[Console]::Out.WriteLine('ATTACHED');[Console]::Out.Flush();$p.WaitForExit();exit 0}catch{exit 0}`;
  const child = spawn("powershell.exe", flags(script), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const timer = setTimeout(() => {
    if (!attached && !stopped) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }, 10_000);
  const lost = () => { clearTimeout(timer); reportReady(false); if (!stopped && !notified) { notified = true; onLost(); } };
  let buffer = "";
  child.stdout.on("data", chunk => {
    buffer = (buffer + chunk.toString("utf8")).slice(-256);
    if (!attached && buffer.includes("ATTACHED")) { attached = true; clearTimeout(timer); reportReady(true); }
  });
  child.once("error", lost); child.once("exit", lost);
  return {
    ready,
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true; clearTimeout(timer); reportReady(false);
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        try { child.kill("SIGKILL"); } catch { clearTimeout(timer); resolve(); }
      });
    },
  };
}
module.exports = { windowsProcessBirth, watchWindowsProcess };
