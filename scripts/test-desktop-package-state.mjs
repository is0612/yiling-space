import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopDefaultLayout, verifyDesktopSystemRuntime } from "./desktop-install.mjs";
import { preparePackagedDesktop } from "./desktop-package-state.mjs";

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yiling-package-state-"));
const applicationRoot = path.join(root, "program", "app"); fs.mkdirSync(applicationRoot, { recursive: true });
try {
  const legacy = await preparePackagedDesktop({ applicationRoot, env: { DATABASE_URL: "synthetic-legacy-value" } });
  assert.equal(legacy.packaged, false); assert.equal(legacy.env.DATABASE_URL, "synthetic-legacy-value"); await legacy.release();
  if (process.platform === "win32") {
    const fakeSystem = path.join(root, "synthetic-system"); fs.mkdirSync(path.join(fakeSystem, "System32"), { recursive: true });
    assert.throws(() => verifyDesktopSystemRuntime(fakeSystem), /msvc_runtime_required/u);
    fs.writeFileSync(path.join(fakeSystem, "System32", "vcruntime140.dll"), "synthetic presence marker; never executed");
    verifyDesktopSystemRuntime(fakeSystem);
    const installedMarker = path.join(root, "program", "desktop-install.json");
    fs.writeFileSync(installedMarker, "{}");
    await assert.rejects(() => preparePackagedDesktop({ applicationRoot, env: {} }), /metadata_missing/u, "an installed marker cannot fall back to a legacy database if package metadata is lost");
    fs.unlinkSync(installedMarker);
    const normal = desktopDefaultLayout({ localAppData: "C:\\Users\\fixture\\AppData\\Local", publicDir: "C:\\Users\\Public", sid: "S-1-5-21-1-2-3-1001" });
    assert.equal(normal.target, "C:\\Users\\fixture\\AppData\\Local\\YilingSpace");
    const unicode = desktopDefaultLayout({ localAppData: "C:\\Users\\合成用户\\AppData\\Local", publicDir: "C:\\Users\\Public", sid: "S-1-5-21-1-2-3-1001" });
    assert(!/[^\x00-\x7F]/u.test(unicode.target)); assert(unicode.dataDir.includes("合成用户"));
    fs.writeFileSync(path.join(root, "program", "desktop-package.json"), JSON.stringify({ format: "yiling-desktop-package", version: 1,
      packageId: randomUUID(), appVersion: "fixture", runtime: "embedded", pgRelease: "16.16-2" }));
    await assert.rejects(() => preparePackagedDesktop({ applicationRoot, env: {} }), /install_required/u);
    assert(!fs.existsSync(path.join(root, "program", "data")), "payload must not silently initialize a portable database");
  }
  console.log("Desktop package state passed: source compatibility, explicit installed marker, ASCII program fallback and independent Unicode data paths; no database used.");
} finally { fs.rmSync(root, { recursive: true }); }
