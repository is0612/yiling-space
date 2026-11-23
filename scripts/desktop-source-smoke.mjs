import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { protectPgDirectory } from "./desktop-pg-tools.mjs";
const require = createRequire(import.meta.url);
if (process.platform !== "win32") throw new Error("Windows source desktop smoke required");
const electron = require("../desktop/node_modules/electron");
const parent = path.resolve(".tmp", "electron", "source-tests"); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "source-"));
protectPgDirectory(root); // Only this new synthetic fixture, never the user's source/data directories.
const desktop = path.join(root, "desktop"), scripts = path.join(root, "scripts");
fs.mkdirSync(desktop); fs.mkdirSync(scripts);
for (const file of ["main.cjs", "launch.cjs", "preload.cjs", "identity.cjs"]) fs.copyFileSync(path.resolve("desktop", file), path.join(desktop, file));
fs.cpSync(path.resolve("desktop", "assets"), path.join(desktop, "assets"), { recursive: true });
fs.writeFileSync(path.join(desktop, "package.json"), JSON.stringify({ name: "source-regression-fixture", productName: "Source startup fixture", main: "main.cjs", version: "0.0.0" }));
fs.mkdirSync(path.join(desktop, "node_modules", "electron"), { recursive: true });
fs.writeFileSync(path.join(desktop, "node_modules", "electron", "index.js"), "module.exports=" + JSON.stringify(electron));
for (const file of ["desktop-parent-watch.cjs", "desktop-auth-ipc.cjs", "desktop-web-runtime.cjs"]) fs.copyFileSync(path.resolve("scripts", file), path.join(scripts, file));
// Explicit source-mode fixture. Backend HTTP and bootstrap are mocks; Node launcher,
// Electron executable/main/profile/window and shutdown are real. No DB or QQ is used.
fs.writeFileSync(path.join(scripts, "desktop-package-state.mjs"), "export async function preparePackagedDesktop({env}){return {packaged:false,env:{...env},release:async()=>{}}};export function peekPackagedDesktop(){throw Error('not an installed package')}");
const backendEvidence = path.join(root, "backend.json");
fs.writeFileSync(path.join(scripts, "desktop-supervisor.mjs"), `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
fs.mkdirSync(path.join(process.env.YILING_DATA_DIR,'logs'),{recursive:true});
const evidence=${JSON.stringify(backendEvidence)};fs.writeFileSync(evidence,JSON.stringify({hasInstalledWatch:!!process.env.YILING_DESKTOP_PARENT_PID,hasDev:process.argv.includes('--dev'),stopped:false}));
const server=http.createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html;charset=utf-8'});r.end('<title>source startup fixture</title>synthetic source desktop');});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({event:'ready',url:'http://127.0.0.1:'+server.address().port})));
let stopped=false;function stop(){if(stopped)return;stopped=true;fs.writeFileSync(evidence,JSON.stringify({hasInstalledWatch:!!process.env.YILING_DESKTOP_PARENT_PID,hasDev:process.argv.includes('--dev'),stopped:true}));server.closeAllConnections();server.close(()=>process.exit(0));}
process.stdin.on('data',stop);process.stdin.on('end',stop);
`);
const logFile = path.join(root, "launcher.log"), fd = fs.openSync(logFile, "w");
const env = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "YILING_DATA_DIR", "YILING_ELECTRON_PROFILE", "YILING_DESKTOP_PACKAGED"]) delete env[key];
// A stale inherited installation field must not enable source-mode monitoring.
env.YILING_DESKTOP_BACKEND_PID = "123456"; env.YILING_DESKTOP_PARENT_PID = "123456";
const child = spawn(process.execPath, [path.join(desktop, "launch.cjs"), "--remote-debugging-port=0"], { cwd: root, env, stdio: ["ignore", fd, fd], windowsHide: true }); fs.closeSync(fd);
let socket;
async function until(test, ms, message) { const limit=Date.now()+ms; while(true){const value=await test();if(value)return value;if(Date.now()>limit)throw new Error(message);await new Promise(r=>setTimeout(r,100));} }
try {
  const profile = path.join(root, ".tmp", "electron");
  const page = await until(async () => {
    if (child.exitCode !== null) throw new Error("Source launcher exited: " + child.exitCode);
    const origin=/runtime ready: (http:\/\/127\.0\.0\.1:\d+)/u.exec(fs.readFileSync(logFile,"utf8"))?.[1];
    const portFile=path.join(profile,"DevToolsActivePort");if(!origin||!fs.existsSync(portFile))return false;
    try {const port=Number(fs.readFileSync(portFile,"utf8").split(/\r?\n/u)[0]);const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();return pages.find(page=>{try{return page.type==='page'&&new URL(page.url).origin===origin}catch{return false}});}catch{return false;}
  },30_000,"Source Electron failed to load its own mock backend");
  assert(fs.existsSync(path.join(profile,"instance.json")), "Electron must use the launcher's prepared profile, not global Roaming");
  assert.equal(JSON.parse(fs.readFileSync(backendEvidence,"utf8")).hasInstalledWatch,false);
  assert.equal(JSON.parse(fs.readFileSync(backendEvidence,"utf8")).hasDev,true, "source launcher must explicitly request dev from the supervisor");
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j)});
  socket.send(JSON.stringify({id:1,method:'Browser.close'}));
  await until(()=>child.exitCode!==null,15_000,"Source launcher shutdown timeout");
  assert.equal(child.exitCode,0);assert.equal(JSON.parse(fs.readFileSync(backendEvidence,"utf8")).stopped,true);
  console.log(JSON.stringify({status:"passed",checks:["real source launcher and Electron", "mock HTTP backend only", "no installed watcher in source mode", "prepared profile instead of Roaming", "window and backend shutdown"],artifacts:root}));
} finally {socket?.close();if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>setTimeout(r,1000));if(child.exitCode===null)child.kill('SIGKILL');}}
