#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDesktopVcRuntime, VC_DOWNLOAD_URL } from "./desktop-vc-runtime.mjs";

/** Same fail-closed requirement for direct CLI installs and packaged first launches. */
export async function requireDesktopVcRuntime(options = {}, inspect = inspectDesktopVcRuntime) {
  const report = await inspect(options);
  if (report?.format !== "yiling-desktop-vc-check" || report.version !== 1 || report.architecture !== "x64"
    || report.automaticInstall !== false || report.redistributed !== false || !Array.isArray(report.checks)
    || !Array.isArray(report.required) || !report.required.length || report.required.length !== report.checks.length
    || (report.status === "ready" && report.checks.some(check => check.status !== "ready"))) {
    throw new Error("desktop_vc_check_report_invalid");
  }
  if (report.status === "ready") return report;
  const unavailable = report.checks.filter(check => check.status !== "ready").map(check => check.name).join(", ");
  const error = new Error(`desktop_install_msvc_runtime_required: Microsoft VC x64 运行库未就绪（${report.status}${unavailable ? ": " + unavailable : ""}）。请自行从微软下载并交互安装后重试：${VC_DOWNLOAD_URL}。程序不会自动安装系统组件、提权或重启；本次未开始数据库初始化。`);
  error.code = "DESKTOP_VC_PREREQUISITE";
  error.report = report;
  throw error;
}

export async function desktopVcCheckCommand(args) {
  let pgRoot;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--pg-root" || !args[1]) throw new Error("desktop_vc_check_arguments_invalid");
    pgRoot = path.resolve(args[1]);
  }
  return inspectDesktopVcRuntime({ pgRoot });
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const report = await desktopVcCheckCommand(process.argv.slice(2));
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "ready" ? 0 : 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
