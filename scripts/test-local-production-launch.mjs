import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourcePath = fileURLToPath(new URL("./launch.mjs", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const root = path.resolve(path.dirname(sourcePath), "..");

// Evaluate the actual launcher declarations with dependencies injected. Only remove
// ESM imports and the executable entrypoint; no launcher behavior is reimplemented.
function harness({ production = true, rebuild = false, built = true, env = "", fetchOk = true, buildStatus = 0, childError = false, timeout = false } = {}) {
  const calls = { sync: [], spawn: [], reads: [], exists: [], workers: [], databases: [], browser: [], stopped: 0 };
  const processMock = new EventEmitter();
  Object.assign(processMock, {
    argv: ["node", sourcePath, ...(production ? ["--production"] : []), ...(rebuild ? ["--rebuild"] : [])],
    env: {}, versions: { node: "22.20.0" }, execPath: "/mock/node", platform: "linux", stdout: { isTTY: false },
  });
  let clock = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = (signal) => { calls.kill = signal; child.exitCode = 0; child.emit("exit", 0); };
  const spawn = (command, args, options) => {
    calls.spawn.push({ command, args, options });
    if (childError) setImmediate(() => child.emit("error", new Error("mock spawn failure")));
    else if (!timeout) setImmediate(() => { child.exitCode = 0; child.emit("exit", 0); });
    return child;
  };
  const context = vm.createContext({
    process: processMock, console: { log() {}, error() {} }, URL, AbortSignal, path, fileURLToPath,
    spawn, spawnSync(command, args, options) {
      calls.sync.push({ command, args, options: options ?? args });
      return { status: /build/.test(command) ? buildStatus : 0, stdout: "1.22.22" };
    },
    existsSync(file) {
      calls.exists.push(file);
      if (file.endsWith(path.join(".output", "server", "index.mjs"))) return built;
      return true;
    },
    readFileSync(file) {
      calls.reads.push(file);
      if (file.endsWith("package.json")) return JSON.stringify({ name: "yiling-space", dependencies: { nuxt: "4" }, engines: { node: ">=20.19" } });
      if (file.endsWith(".env")) return `DATABASE_URL=postgresql://owner:secret@localhost:5434/yiling_hub\nDEV_OWNER_PASSWORD=keep-original-password\nPORT=3000\n${env}`;
      throw new Error(`Unexpected file read: ${file}`);
    },
    net: {}, setTimeout(callback) { setImmediate(callback); },
    fetch: async (url) => { calls.healthUrl = url; return { ok: fetchOk }; },
    Date: timeout ? { now: () => { clock += 31_000; return clock; } } : Date,
    superviseMemoryWorker: async (options) => { calls.workers.push(options); return { disabled: false, async stop() { calls.stopped++; } }; },
    __database: async (value) => { calls.databases.push(value); },
    __browser: (url) => { calls.browser.push(url); },
  });
  const entry = source.lastIndexOf("\ntry {");
  assert(entry > 0, "Cannot identify launcher's executable entrypoint");
  const body = source.slice(0, entry)
    .replace(/^import .+;\r?$/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(sourcePath).href));
  vm.runInContext(`${body}\nensureDatabase = __database; openBrowser = __browser; pingPort = async () => false;\nglobalThis.api = { loadEnv, buildProduction, runProduction, main, PRODUCTION, REBUILD, DEFAULT_PORT };`, context, { filename: sourcePath });
  return { api: context.api, calls, process: processMock, child };
}

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}

await test("Windows compatibility entry sets import-meta before dynamically loading compiled output", async () => {
  const entrySource = readFileSync(new URL("./local-production-entry.mjs", import.meta.url), "utf8");
  const events = [];
  const environment = { NODE_ENV: "production" };
  const context = vm.createContext({
    path: path.win32, pathToFileURL: (entry) => ({ href: `file:///${entry.replaceAll("\\", "/")}` }),
    process: { env: environment },
    __import: async (entry) => {
      assert(context._importMeta_, "Dynamic import ran before import-meta initialization");
      assert.equal(context._importMeta_.url, entry);
      assert.equal(context._importMeta_.env, environment);
      events.push(entry);
    },
  });
  // Keep the real entry's resolve, shim assignment and import argument intact.
  // Substitute only ESM imports and dynamic import to avoid starting Nitro.
  const body = entrySource.replace(/^import .+;\r?$/gm, "").replace(/await import\(/g, "await __import(");
  await vm.runInContext(`(async () => { ${body} })()`, context);
  assert.equal(events.length, 1);
  assert(events[0].endsWith("/.output/server/index.mjs"));
  assert(!events[0].includes("_entry.js"));
});
await test("production flag selects 8801 while development retains 3000", () => {
  assert.equal(harness().api.DEFAULT_PORT, 8801);
  assert.equal(harness({ production: false }).api.DEFAULT_PORT, 3000);
});
await test("existing build is reused without invoking a build command", () => {
  const { api, calls } = harness();
  api.buildProduction("yarn", api.loadEnv());
  assert.equal(calls.sync.length, 0);
});
await test("first production start builds with production environment and original database", () => {
  const { api, calls } = harness({ built: false });
  api.buildProduction("yarn", api.loadEnv());
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0].command, "yarn build");
  assert.equal(calls.sync[0].options.cwd, root);
  assert.equal(calls.sync[0].options.env.NODE_ENV, "production");
  assert.equal(calls.sync[0].options.env.DATABASE_URL, "postgresql://owner:secret@localhost:5434/yiling_hub");
});
await test("rebuild flag compiles even when production output already exists", () => {
  const { api, calls } = harness({ rebuild: true });
  api.buildProduction("yarn", api.loadEnv());
  assert.equal(calls.sync.filter(({ command }) => /build/.test(command)).length, 1);
});
await test("missing Yarn uses local Nuxt command and failed builds stop startup", () => {
  const { api, calls } = harness({ built: false, buildStatus: 1 });
  assert.throws(() => api.buildProduction(null, api.loadEnv()), /生产构建失败/);
  assert.equal(calls.sync[0].command, "npx nuxt build");
  assert.equal(calls.spawn.length, 0);
});
await test("production executes actual output with Node and original project cwd", async () => {
  const { api, calls, process } = harness();
  assert.equal(await api.runProduction("http://127.0.0.1:8801", api.loadEnv()), 0);
  assert.equal(calls.spawn.length, 1);
  const call = calls.spawn[0];
  assert.equal(call.command, process.execPath);
  assert.equal(call.args.join("|"), "scripts/local-production-entry.mjs");
  assert.equal(call.options.cwd, root); // Relative .data is the original project's .data.
  assert.equal(call.options.env.NODE_ENV, "production");
  assert.equal(call.options.env.PORT, "8801");
  assert.equal(call.options.env.NITRO_HOST, "127.0.0.1");
  assert.equal(call.options.env.DEV_OWNER_PASSWORD, "keep-original-password");
  assert.equal(calls.healthUrl, "http://127.0.0.1:8801/api/health");
  assert.equal(calls.browser.join("|"), "http://127.0.0.1:8801");
  assert.equal(process.listenerCount("SIGINT"), 0);
  assert.equal(process.listenerCount("SIGTERM"), 0);
});
await test("original .env is loaded without reading a separate production config", () => {
  const { api, calls } = harness();
  api.loadEnv();
  assert(calls.reads.includes(path.join(root, ".env")));
  assert(!calls.reads.some((file) => /\.env\.prod$/.test(file)));
});
await test("full production flow preserves original database and data root without setup or seed", async () => {
  const { api, calls } = harness();
  assert.equal(await api.main(), 0);
  assert.equal(calls.databases.length, 1);
  assert.equal(calls.databases[0].DATABASE_URL, "postgresql://owner:secret@localhost:5434/yiling_hub");
  assert.equal(calls.workers.length, 1);
  assert.equal(calls.workers[0].root, root);
  assert.equal(calls.workers[0].env.DATABASE_URL, calls.databases[0].DATABASE_URL);
  assert(!calls.sync.some((call) => /seed|setup|docker-pack|compose\.prod/.test(JSON.stringify(call))));
  assert(!calls.spawn.some((call) => /nuxt.*dev|launch-prod/.test(JSON.stringify(call))));
  assert.equal(calls.stopped, 1);
  assert.equal(calls.spawn[0].options.env.PORT, "8801");
});
await test("explicit production port overrides development PORT", async () => {
  const { api, calls } = harness({ env: "YILING_PRODUCTION_PORT=18801\n" });
  await api.main();
  assert.equal(calls.spawn[0].options.env.PORT, "18801");
  assert.equal(calls.healthUrl, "http://127.0.0.1:18801/api/health");
});
await test("Worker receives production environment in production mode", async () => {
  const { api, calls } = harness();
  await api.main();
  assert.equal(calls.workers[0].env.NODE_ENV, "production");
});
await test("spawn failure returns nonzero and does not open browser", async () => {
  const { api, calls } = harness({ childError: true, fetchOk: false });
  assert.equal(await api.runProduction("http://127.0.0.1:8801", api.loadEnv()), 1);
  assert.equal(calls.browser.length, 0);
});
await test("readiness timeout stops child and removes signal handlers", async () => {
  const { api, calls, process } = harness({ timeout: true, fetchOk: false });
  await assert.rejects(api.runProduction("http://127.0.0.1:8801", api.loadEnv()), /60秒/);
  assert.equal(calls.kill, "SIGTERM");
  assert.equal(calls.browser.length, 0);
  assert.equal(process.listenerCount("SIGINT"), 0);
  assert.equal(process.listenerCount("SIGTERM"), 0);
});
console.log(`Results: ${passed} passed; no database, network, filesystem writes, or subprocesses used.`);
