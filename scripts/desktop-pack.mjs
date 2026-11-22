#!/usr/bin/env node
/** Clean Windows installer payload; never includes development .env, .data or a live database. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageDesktopPgDistribution } from "./desktop-pg-distribution.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("desktop_pack_windows_x64_required");
if (flag("--with-env") || flag("--with-data")) throw new Error("desktop_pack_private_data_refused: use the explicit backup/restore workflow");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version);
const output = path.resolve(value("--out", path.join(ROOT, "dist", `YilingSpace-Payload-${version}`)));
const archive = path.resolve(value("--pg-archive", path.join(ROOT, ".data", "vendor", "postgresql-a0", "postgresql-16.16-2-windows-x64-binaries.zip")));
const adjacentNodeLicense = path.join(path.dirname(process.execPath), "LICENSE");
const nodeLicense = path.resolve(value("--node-license", fs.existsSync(adjacentNodeLicense) ? adjacentNodeLicense : path.join(ROOT, ".data", "vendor", "node-" + process.version, "LICENSE")));
if (!fs.existsSync(nodeLicense) || !fs.readFileSync(nodeLicense, "utf8").includes("Node.js is licensed")) throw new Error("desktop_pack_matching_node_license_required");
if (output === ROOT || ROOT.toLowerCase().startsWith(output.toLowerCase() + path.sep) || path.dirname(output) === output) throw new Error("desktop_pack_unsafe_output");
if (fs.existsSync(output)) {
  if (!flag("--force")) throw new Error("desktop_pack_output_exists");
  const metadata = JSON.parse(fs.readFileSync(path.join(output, "desktop-package.json"), "utf8"));
  if (metadata.format !== "yiling-desktop-package" || fs.existsSync(path.join(output, "desktop-install.json"))
    || ["data", "state", "app/.data", "app/.env"].some(file => fs.existsSync(path.join(output, file)))) throw new Error("desktop_pack_existing_private_or_unknown_output");
}
function run(command, commandArgs, options = {}) {
  let executable = command, actualArgs = commandArgs;
  if (command === "yarn") {
    const candidates = [process.env.npm_execpath, process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "yarn", "bin", "yarn.js")];
    const located = spawnSync("where.exe", ["yarn.cmd"], { encoding: "utf8" });
    for (const item of String(located.stdout || "").split(/\r?\n/u).filter(Boolean)) candidates.push(path.join(path.dirname(item), "node_modules", "yarn", "bin", "yarn.js"));
    const yarn = candidates.find(file => file && /yarn\.(?:js|cjs)$/u.test(file) && fs.existsSync(file));
    if (!yarn) throw new Error("desktop_pack_yarn_classic_entry_missing");
    executable = process.execPath; actualArgs = [yarn, ...commandArgs];
  }
  const result = spawnSync(executable, actualArgs, { cwd: ROOT, stdio: "inherit", shell: false, ...options });
  if (result.error || result.status !== 0) throw new Error(`desktop_pack_command_failed:${command}`);
}
if (!flag("--skip-build")) run("yarn", ["build"]);
if (!fs.existsSync(path.join(ROOT, ".output", "server", "index.mjs"))) throw new Error("desktop_pack_build_missing");
fs.mkdirSync(path.dirname(output), { recursive: true });
const staging = output + ".building-" + randomUUID();
fs.mkdirSync(staging);
const app = path.join(staging, "app"); fs.mkdirSync(app);
fs.mkdirSync(path.join(staging, "runtime"));
console.log("Preparing verified PostgreSQL distribution...");
await stageDesktopPgDistribution({ archive, targetDir: path.join(staging, "runtime", "pgsql") });
const items = [".output", "server", "scripts", "shared", "prisma", "src/generated", "package.json", "yarn.lock", "prisma.config.ts", "LICENSE", "README.md"];
for (const item of items) {
  const source = path.join(ROOT, item);
  if (!fs.existsSync(source)) throw new Error(`desktop_pack_source_missing:${item}`);
  fs.cpSync(source, path.join(app, item), { recursive: true });
}
// Runtime TSX must resolve bundled files, not an absolute development .nuxt/tsconfig path.
fs.writeFileSync(path.join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: {
  target: "ES2022", module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { "#shared/*": ["shared/*"], "~~/*": ["*"], "@@/*": ["*"] },
} }, null, 2));
fs.cpSync(path.join(ROOT, "desktop"), path.join(app, "desktop"), { recursive: true,
  filter: source => !source.split(path.sep).includes("node_modules") });
fs.mkdirSync(path.join(app, "desktop", "node_modules"), { recursive: true });
fs.cpSync(path.join(ROOT, "desktop", "node_modules", "electron"), path.join(app, "desktop", "node_modules", "electron"), { recursive: true });
console.log("Installing locked production dependencies (build machine only)...");
run("yarn", ["install", "--production", "--frozen-lockfile", "--ignore-scripts"], { cwd: app, env: { ...process.env, NODE_ENV: "production" } });
fs.copyFileSync(process.execPath, path.join(staging, "runtime", "node.exe"));
fs.copyFileSync(nodeLicense, path.join(staging, "runtime", "NODE-LICENSE.txt"));
const engine = path.join(ROOT, "node_modules", "@prisma", "engines", "schema-engine-windows.exe");
if (!fs.existsSync(engine)) throw new Error("desktop_pack_schema_engine_missing");
fs.mkdirSync(path.join(app, "node_modules", "@prisma", "engines"), { recursive: true });
fs.copyFileSync(engine, path.join(app, "node_modules", "@prisma", "engines", "schema-engine-windows.exe"));
const required = ["runtime/node.exe", "runtime/NODE-LICENSE.txt", "app/.output/server/index.mjs", "app/desktop/launch.cjs",
  "app/desktop/node_modules/electron/dist/electron.exe", "app/desktop/node_modules/electron/dist/LICENSE", "app/desktop/node_modules/electron/dist/LICENSES.chromium.html",
  "app/scripts/desktop-install.mjs", "app/node_modules/tsx/dist/cli.mjs", "app/node_modules/prisma/build/index.js",
  "app/node_modules/@prisma/engines/schema-engine-windows.exe", "app/src/generated/prisma/client.ts"];
for (const file of required) if (!fs.existsSync(path.join(staging, file))) throw new Error(`desktop_pack_required_file_missing:${file}`);
for (const file of [".env", ".data", ".tmp", ".nuxt"]) if (fs.existsSync(path.join(app, file))) throw new Error("desktop_pack_private_or_development_material_found");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
const metadata = { format: "yiling-desktop-package", version: 1, packageId: randomUUID(), appVersion: version,
  runtime: "embedded", pgRelease: "16.16-2", nodeVersion: process.version, platform: "win32-x64",
  sourceRevision: revision.status === 0 ? revision.stdout.trim() : "unknown", sourceDirty: status.status !== 0 || Boolean(status.stdout.trim()) };
fs.writeFileSync(path.join(staging, "desktop-package.json"), JSON.stringify(metadata, null, 2));
fs.writeFileSync(path.join(staging, "README.txt"), `Yiling Space ${version} Windows installer payload\r\n\r\nThis clean payload includes Node, Electron and PostgreSQL. No Docker, Node or Yarn is required on the target.\r\nUse desktop-installer.mjs to create install.ps1 and the installer wrapper. This payload is not an initialized portable installation.\r\nNo development .env, .data or credentials are included. Licensing notices are preserved in runtime/ and Electron/production dependencies.\r\nDatabase data and install state are created outside program files by the installer.\r\nSource dirty: ${metadata.sourceDirty}; local verification payloads are not a clean-machine release certification.\r\n`, "utf8");
let previous;
if (fs.existsSync(output)) { previous = output + ".previous-" + randomUUID(); fs.renameSync(output, previous); }
try { fs.renameSync(staging, output); }
catch (error) { if (previous && !fs.existsSync(output)) fs.renameSync(previous, output); throw error; }
console.log(`Desktop payload prepared: ${output}`);
if (previous) console.log(`Previous payload retained: ${previous}`);
