#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDesktopDatabase, desktopPgBin } from "./desktop-database-config.mjs";
import { restoreDesktopPgBackup } from "./desktop-pg-backup.mjs";

// Explicit maintenance entry. Never loads .env and never accepts an overwrite flag.
const args = process.argv.slice(2);
const command = args.shift();
const options = new Map();
while (args.length) {
  const key = args.shift(), value = args.shift();
  if (!["--data-dir", "--bin", "--backup"].includes(key) || !value || value.startsWith("--") || options.has(key)) {
    throw new Error("desktop_database_invalid_arguments");
  }
  options.set(key, value);
}
if (!["init", "restore"].includes(command) || !options.has("--data-dir")) {
  throw new Error("Use desktop-database.mjs init|restore --data-dir <NEW directory> [--bin <absolute PG bin>] [--backup <bundle>]");
}
const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(options.get("--data-dir"));
const binDir = options.get("--bin") || desktopPgBin(applicationRoot);
if (command === "restore") {
  if (!options.has("--backup")) throw new Error("desktop_database_backup_required");
  const result = await restoreDesktopPgBackup({ directory: path.resolve(options.get("--backup")), dataDir, binDir });
  console.log(JSON.stringify({ status: "restored", ...result }));
} else {
  if (options.has("--backup")) throw new Error("desktop_database_unexpected_backup_argument");
  const runtime = await initializeDesktopDatabase({ dataDir, binDir });
  try { console.log(JSON.stringify({ status: "initialized", ...runtime.descriptor() })); }
  finally { await runtime.close(); }
}
