import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectDesktopVcRuntime, readPeImports, VC_DOWNLOAD_URL } from "./desktop-vc-runtime.mjs";
function image(imports = [], machine = 0x8664) {
  const b = Buffer.alloc(4096), pe = 0x80, opt = pe + 24, section = opt + 240;
  b.writeUInt16LE(0x5a4d); b.writeUInt32LE(pe, 0x3c); b.writeUInt32LE(0x4550, pe);
  b.writeUInt16LE(machine, pe + 4); b.writeUInt16LE(1, pe + 6); b.writeUInt16LE(240, pe + 20);
  b.writeUInt16LE(0x20b, opt); b.writeUInt32LE(0x200, opt + 60); b.writeUInt32LE(16, opt + 108);
  b.writeUInt32LE(0x1000, section + 12); b.writeUInt32LE(0xe00, section + 16); b.writeUInt32LE(0x200, section + 20);
  if (imports.length) {
    b.writeUInt32LE(0x1000, opt + 120); b.writeUInt32LE((imports.length + 1) * 20, opt + 124);
    imports.forEach((name, index) => { const at = 0x400 + index * 128; b.writeUInt32LE(at - 0x200 + 0x1000, 0x200 + index * 20 + 12); b.write(name + "\0", at, "ascii"); });
  }
  return b;
}
assert.deepEqual(readPeImports(image(["VCRUNTIME140.dll", "KERNEL32.dll"])), { machine: 0x8664, linkerMajor: 0, linkerMinor: 0, imports: ["kernel32.dll", "vcruntime140.dll"] });
assert.deepEqual(readPeImports(image(["WINSPOOL.DRV"])).imports, ["winspool.drv"]);
const delay = image();
delay.writeUInt32LE(0x1000, 0x80 + 24 + 112 + 13 * 8); delay.writeUInt32LE(64, 0x80 + 24 + 116 + 13 * 8);
delay.writeUInt32LE(1, 0x200); delay.writeUInt32LE(0x1200, 0x204); delay.write("vcruntime140_1.dll\0", 0x400, "ascii");
assert.deepEqual(readPeImports(delay).imports, ["vcruntime140_1.dll"]);
delay.writeUInt32LE(0, 0x200); assert.throws(() => readPeImports(delay), /invalid_pe/u);
for (const bad of [Buffer.alloc(0), Buffer.alloc(64), image().subarray(0, 400)]) assert.throws(() => readPeImports(bad), /invalid_pe/u);
const malformed = image(["vcruntime140.dll"]); malformed.writeUInt32LE(0xffffffff, 0x200 + 12);
assert.throws(() => readPeImports(malformed), /invalid_pe/u);
const traversal = image(["../evil.dll"]); assert.throws(() => readPeImports(traversal), /invalid_pe/u);
const noTerminator = image(["vcruntime140.dll"]); noTerminator.writeUInt32LE(20, 0x80 + 24 + 124);
assert.throws(() => readPeImports(noTerminator), /invalid_pe/u);
for (let size = 0; size < 1024; size += 31) {
  const truncated = image(["vcruntime140.dll"]).subarray(0, size);
  assert.throws(() => readPeImports(truncated), /invalid_pe/u);
}
for (const [checkStatus, status] of [["ready", "ready"], ["missing", "missing"], ["wrong-architecture", "incompatible"], ["load-failed", "incompatible"], ["unverified", "unverified"]]) {
  const report = await inspectDesktopVcRuntime({ inspectSystemDll: async () => ({ status: checkStatus, secret: "must-not-leak" }) });
  assert.equal(report.status, status); assert.equal(report.scope, "known-minimum"); assert.equal(report.downloadUrl, VC_DOWNLOAD_URL);
  assert.deepEqual(report.required, ["vcruntime140.dll"]); assert.equal(report.redistributed, false); assert.equal(report.automaticInstall, false);
  assert(!JSON.stringify(report).includes("must-not-leak"));
}
assert.equal((await inspectDesktopVcRuntime({ inspectSystemDll: () => { throw Error("secret"); } })).status, "unverified");
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yiling-vc-synthetic-"));
try {
  const files = [];
  const put = (name, bytes) => { const file = path.join(root, ...name.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    files.push({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); };
  const deps = ["VCRUNTIME140.dll", "MSVCP140_1.dll", "CONCRT140.dll", "api-ms-win-crt-runtime-l1-1-0.dll"];
  for (const name of ["postgres", "initdb", "pg_ctl", "pg_controldata", "pg_dump", "pg_restore"]) put("bin/" + name + ".exe", image(deps));
  put("bin/helper.dll", image(["vcruntime140_1.dll"]));
  put("server_license.txt", Buffer.from("synthetic license fixture")); put("commandlinetools_3rd_party_licenses.txt", Buffer.from("synthetic notice fixture"));
  put("lib/synthetic.txt", Buffer.from("fixture")); put("share/synthetic.txt", Buffer.from("fixture"));
  fs.writeFileSync(path.join(root, "distribution.json"), JSON.stringify({ format: "yiling-desktop-postgresql-distribution", version: 1, release: "16.16-2",
    archiveSHA: "add1de261b150e6923266abee293f05050795e73f5356158aee4221a2170c073", files }));
  let called = 0;
  const report = await inspectDesktopVcRuntime({ pgRoot: root, inspectSystemDll: ({ name }) => { called++; return { name, status: "ready" }; } });
  assert.equal(report.scope, "pg-distribution"); assert.deepEqual(report.required, ["concrt140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);
  assert.equal(called, 4); assert.equal(report.status, "ready");
  fs.appendFileSync(path.join(root, "bin", "postgres.exe"), "tamper");
  called = 0;
  await assert.rejects(() => inspectDesktopVcRuntime({ pgRoot: root, inspectSystemDll: () => { called++; return { status: "ready" }; } }), /distribution/u);
  assert.equal(called, 0, "verify the distribution before system inspection or import scanning");
  console.log("Desktop VC static checks passed: bounded PE parsing, malformed/truncated inputs, actual import family filtering, verified-distribution gate, injected missing/architecture/load outcomes, private evidence filtering. Synthetic manifests are integrity fixtures, not official release authentication; no DLL executed or redistributed.");
} finally { assert(path.basename(root).startsWith("yiling-vc-synthetic-")); fs.rmSync(root, { recursive: true }); }
