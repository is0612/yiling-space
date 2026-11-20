import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir";
import { getPrisma } from "./prisma";

/**
 * 阶段三第一块：本地只读观察。
 *
 * 边界（2026-11-20 与用户确认）：
 * - 只允许项目根目录，支持 YILING_LOCAL_ROOT 显式改根；
 * - 只读：列目录、读文本、按文件名/内容搜索；
 * - 不做写文件、不跑终端、不碰 Git；
 * - 只对管理员开放，每次操作写审计 JSONL。
 *
 * 这里刻意不提供「任意绝对路径」：所有接口都收相对路径，解析后必须仍在根目录内；
 * 符号链接只显示、不跟随，敏感文件（.env / 私钥 / .data）不可读。
 */

export const LOCAL_OBSERVE_MAX_FILE_BYTES = 256 * 1024;
export const LOCAL_OBSERVE_MAX_LIST_ENTRIES = 300;
export const LOCAL_OBSERVE_MAX_SEARCH_RESULTS = 100;
export const LOCAL_OBSERVE_MAX_SEARCH_FILE_BYTES = 64 * 1024;

const IGNORED_NAMES = new Set([
  ".git",
  ".nuxt",
  ".output",
  ".data",
  ".tmp",
  ".cache",
  "node_modules",
  "dist",
  "backups",
  "updates",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

const SENSITIVE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "credentials-encryption.key",
  "id_rsa",
  "id_ed25519",
]);

const SEARCH_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json", ".md", ".txt",
  ".yml", ".yaml", ".toml", ".ini", ".css", ".scss", ".sql", ".prisma", ".sh",
  ".ps1", ".bat", ".cmd", ".html", ".xml", ".env.example",
]);

export class LocalObserveError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "LocalObserveError";
    this.statusCode = statusCode;
  }
}

export type LocalEntryKind = "directory" | "file" | "symlink" | "other";

export type LocalEntry = {
  name: string;
  path: string;
  kind: LocalEntryKind;
  size: number | null;
  modifiedAt: string | null;
  readable: boolean;
};

export type LocalReadResult = {
  path: string;
  size: number;
  modifiedAt: string;
  content: string;
  lines: number;
};

export type LocalSearchMatch = {
  path: string;
  kind: "name" | "content";
  line: number | null;
  preview: string;
};

export type LocalSearchResult = {
  query: string;
  matches: LocalSearchMatch[];
  truncated: boolean;
  scanned: number;
};

export const PROJECT_ROOT_ID = "project";

export type LocalObserveRoot = {
  id: string;
  label: string;
  path: string;
  mode: "READ_ONLY" | "READ_WRITE";
  enabled: boolean;
  builtin: boolean;
};

export function localObserveRoot(): string {
  const configured = process.env.YILING_LOCAL_ROOT?.trim();
  return path.resolve(configured || process.cwd());
}

export function projectObserveRoot(): LocalObserveRoot {
  return {
    id: PROJECT_ROOT_ID,
    label: "项目目录",
    path: localObserveRoot(),
    mode: "READ_ONLY",
    enabled: true,
    builtin: true,
  };
}

export function localObserveRootInfo() {
  const root = localObserveRoot();
  return {
    root,
    name: path.basename(root) || root,
    readOnly: true,
    maxFileBytes: LOCAL_OBSERVE_MAX_FILE_BYTES,
    maxSearchResults: LOCAL_OBSERVE_MAX_SEARCH_RESULTS,
  };
}

export async function listLocalObserveRoots(includeDisabled = false): Promise<LocalObserveRoot[]> {
  const rows = await getPrisma().localAccessRoot.findMany({
    where: includeDisabled ? {} : { enabled: true },
    orderBy: [{ createdAt: "asc" }],
  });
  return [
    projectObserveRoot(),
    ...rows.map((row) => ({
      id: row.id,
      label: row.label,
      path: row.path,
      mode: row.mode === "READ_WRITE" ? "READ_WRITE" as const : "READ_ONLY" as const,
      enabled: row.enabled,
      builtin: false,
    })),
  ];
}

export async function resolveObserveRoot(rootIdInput: unknown): Promise<LocalObserveRoot> {
  const rootId = typeof rootIdInput === "string" && rootIdInput.trim() ? rootIdInput.trim() : PROJECT_ROOT_ID;
  if (rootId === PROJECT_ROOT_ID) return projectObserveRoot();
  if (!/^[0-9a-f-]{36}$/i.test(rootId)) throw new LocalObserveError(404, "授权目录不存在。");
  const row = await getPrisma().localAccessRoot.findUnique({ where: { id: rootId } });
  if (!row) throw new LocalObserveError(404, "授权目录不存在。");
  if (!row.enabled) throw new LocalObserveError(403, "这个授权目录已停用。");
  if (row.mode !== "READ_ONLY" && row.mode !== "READ_WRITE") throw new LocalObserveError(403, "这个目录的权限模式暂不支持。");
  return {
    id: row.id,
    label: row.label,
    path: row.path,
    mode: row.mode === "READ_WRITE" ? "READ_WRITE" : "READ_ONLY",
    enabled: row.enabled,
    builtin: false,
  };
}

const DENIED_ROOT_PATHS = new Set([
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\programdata",
]);

/** 管理页新增目录时用：必须是已存在的绝对目录，不能是盘符根/系统目录。 */
export function validateLocalRootPath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new LocalObserveError(400, "请填写目录路径。");
  const raw = input.trim();
  if (raw.includes("\0")) throw new LocalObserveError(400, "路径包含非法字符。");
  if (!path.isAbsolute(raw)) throw new LocalObserveError(400, "授权目录必须是绝对路径。");
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch {
    throw new LocalObserveError(400, "目录不存在或无法访问。");
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) throw new LocalObserveError(400, "授权路径必须是目录。");
  const parsed = path.parse(real);
  if (parsed.root === real) throw new LocalObserveError(400, "不能把整个盘符根目录加为授权目录。");
  if (DENIED_ROOT_PATHS.has(real.toLowerCase())) {
    throw new LocalObserveError(403, "Windows 系统目录不允许加入本地观察。");
  }
  if (real.split(/[\\/]/).some((part) => part.toLowerCase() === ".data")) {
    throw new LocalObserveError(403, ".data 是运行时数据目录，不允许作为授权目录。");
  }
  const home = process.env.USERPROFILE ? path.resolve(process.env.USERPROFILE) : "";
  if (home && path.resolve(real).toLowerCase() === home.toLowerCase()) {
    throw new LocalObserveError(403, "不能直接授权整个用户目录；请选择下面的具体目录。");
  }
  return real;
}

function isIgnored(name: string) {
  return IGNORED_NAMES.has(name);
}

function isSensitive(name: string) {
  if (SENSITIVE_NAMES.has(name)) return true;
  return /^\.env(?:\.|$)/i.test(name)
    || /\.(?:pem|key|pfx|p12)$/i.test(name)
    || /^onebot-.+\.json$/i.test(name);
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realRoot(root: string): string {
  return fs.realpathSync(root);
}

/**
 * 把接口里的相对路径解析成真实路径；拒绝绝对路径、`..`、授权根外路径和越界符号链接。
 */
export function resolveLocalPath(root: string, input: unknown, allowMissing = false): { relative: string; absolute: string; real: string } {
  if (typeof input !== "string") throw new LocalObserveError(400, "路径参数必须是字符串。");
  const raw = input.trim().replace(/\\/g, "/");
  if (raw.includes("\0")) throw new LocalObserveError(400, "路径包含非法字符。");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new LocalObserveError(400, "只接受授权目录内的相对路径。");
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new LocalObserveError(403, "不能访问授权目录之外。");
  }
  const rootReal = realRoot(root);
  const absolute = path.resolve(root, normalized === "." ? "" : normalized);
  if (!within(root, absolute)) throw new LocalObserveError(403, "不能访问授权目录之外。");
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    if (!allowMissing) throw new LocalObserveError(404, "路径不存在。");
    const parent = path.dirname(absolute);
    let parentReal: string;
    try {
      parentReal = fs.realpathSync(parent);
    } catch {
      throw new LocalObserveError(404, "目标目录不存在。");
    }
    if (!within(rootReal, parentReal)) throw new LocalObserveError(403, "目标目录在授权目录之外。");
    real = path.join(parentReal, path.basename(absolute));
  }
  if (!within(rootReal, real)) throw new LocalObserveError(403, "符号链接指向授权目录之外。");
  return { relative: normalized === "." ? "" : normalized, absolute, real };
}

/** 写文件的路径校验：目标可以不存在，但父目录必须已存在且仍在授权根内。 */
export function validateLocalWritablePath(root: string, input: unknown) {
  const resolved = resolveLocalPath(root, input, true);
  if (!resolved.relative) throw new LocalObserveError(400, "必须指定要写入的文件。");
  assertReadableName(resolved.relative);
  let exists = false;
  let size = 0;
  try {
    const stat = fs.lstatSync(resolved.absolute);
    if (stat.isSymbolicLink()) throw new LocalObserveError(403, "不能写符号链接。");
    if (stat.isDirectory()) throw new LocalObserveError(400, "目标是目录，不能写。");
    exists = true;
    size = stat.size;
  } catch (error) {
    if (error instanceof LocalObserveError) throw error;
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }
  return { ...resolved, exists, size };
}

export function assertReadableName(relative: string) {
  const base = path.basename(relative);
  if (isSensitive(base)) throw new LocalObserveError(403, "这个文件被本地观察的敏感名单挡住。");
  for (const part of relative.split("/")) {
    if (isIgnored(part)) throw new LocalObserveError(403, "这个目录不在本地观察范围内。");
    if (isSensitive(part)) throw new LocalObserveError(403, "这个文件被本地观察的敏感名单挡住。");
  }
}

function kindOf(dirent: fs.Dirent, absolute: string): LocalEntryKind {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "symlink";
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    if (stat.isSymbolicLink()) return "symlink";
  } catch {
    // 读不到就按 other
  }
  return "other";
}

export function listLocalDirectory(root: string, input: unknown): {
  path: string;
  entries: LocalEntry[];
  truncated: boolean;
} {
  const resolved = resolveLocalPath(root, input);
  assertReadableName(resolved.relative);
  const stat = fs.statSync(resolved.real);
  if (!stat.isDirectory()) throw new LocalObserveError(400, "这个路径不是目录。");
  const dirents = fs.readdirSync(resolved.absolute, { withFileTypes: true })
    .filter((entry) => !isIgnored(entry.name) && !isSensitive(entry.name))
    .sort((left, right) => {
      const leftDir = left.isDirectory() ? 0 : 1;
      const rightDir = right.isDirectory() ? 0 : 1;
      return leftDir - rightDir || left.name.localeCompare(right.name, "zh-CN");
    });
  const truncated = dirents.length > LOCAL_OBSERVE_MAX_LIST_ENTRIES;
  const entries = dirents.slice(0, LOCAL_OBSERVE_MAX_LIST_ENTRIES).map((entry) => {
    const absolute = path.join(resolved.absolute, entry.name);
    const kind = kindOf(entry, absolute);
    let size: number | null = null;
    let modifiedAt: string | null = null;
    try {
      const info = fs.lstatSync(absolute);
      size = kind === "file" ? info.size : null;
      modifiedAt = info.mtime.toISOString();
    } catch {
      // 单个条目读不到不影响目录
    }
    return {
      name: entry.name,
      path: resolved.relative ? `${resolved.relative}/${entry.name}` : entry.name,
      kind,
      size,
      modifiedAt,
      readable: kind === "file",
    };
  });
  return { path: resolved.relative, entries, truncated };
}

function looksBinary(buffer: Buffer) {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

export function readLocalTextFile(root: string, input: unknown): LocalReadResult {
  const resolved = resolveLocalPath(root, input);
  assertReadableName(resolved.relative);
  const stat = fs.statSync(resolved.real);
  if (!stat.isFile()) throw new LocalObserveError(400, "这个路径不是文件。");
  if (stat.size > LOCAL_OBSERVE_MAX_FILE_BYTES) {
    throw new LocalObserveError(413, `文件超过 ${Math.round(LOCAL_OBSERVE_MAX_FILE_BYTES / 1024)} KB，暂不预览。`);
  }
  const buffer = fs.readFileSync(resolved.real);
  if (looksBinary(buffer)) throw new LocalObserveError(415, "这看起来是二进制文件，只读观察不预览。");
  const content = buffer.toString("utf8");
  return {
    path: resolved.relative,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    content,
    lines: content.length ? content.split(/\r?\n/).length : 0,
  };
}

function searchableFile(name: string) {
  const lower = name.toLowerCase();
  return SEARCH_EXTENSIONS.has(path.extname(lower)) || lower.endsWith(".env.example");
}

export function searchLocalProject(root: string, queryInput: unknown, pathInput: unknown = ""): LocalSearchResult {
  const query = typeof queryInput === "string" ? queryInput.trim() : "";
  if (query.length < 2) throw new LocalObserveError(400, "搜索词至少 2 个字符。");
  if (query.length > 100) throw new LocalObserveError(400, "搜索词最多 100 个字符。");
  const resolved = resolveLocalPath(root, pathInput);
  assertReadableName(resolved.relative);
  const stat = fs.statSync(resolved.real);
  if (!stat.isDirectory()) throw new LocalObserveError(400, "搜索起点必须是目录。");

  const needle = query.toLowerCase();
  const matches: LocalSearchMatch[] = [];
  let scanned = 0;
  let truncated = false;
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: resolved.absolute, relative: resolved.relative, depth: 0 },
  ];

  while (queue.length && !truncated) {
    const current = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      if (isIgnored(entry.name) || isSensitive(entry.name)) continue;
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (current.depth < 6) queue.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (scanned > 2000) {
        truncated = true;
        break;
      }
      if (entry.name.toLowerCase().includes(needle)) {
        matches.push({ path: relative, kind: "name", line: null, preview: entry.name });
      }
      if (!searchableFile(entry.name) || matches.length >= LOCAL_OBSERVE_MAX_SEARCH_RESULTS) continue;
      try {
        const info = fs.lstatSync(absolute);
        if (info.size > LOCAL_OBSERVE_MAX_SEARCH_FILE_BYTES) continue;
        const buffer = fs.readFileSync(absolute);
        if (looksBinary(buffer)) continue;
        const lines = buffer.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!line || !line.toLowerCase().includes(needle)) continue;
          matches.push({
            path: relative,
            kind: "content",
            line: index + 1,
            preview: line.trim().slice(0, 160),
          });
          break;
        }
      } catch {
        // 单个文件读不到就跳过
      }
      if (matches.length >= LOCAL_OBSERVE_MAX_SEARCH_RESULTS) {
        truncated = true;
        break;
      }
    }
  }

  return {
    query,
    matches: matches.slice(0, LOCAL_OBSERVE_MAX_SEARCH_RESULTS),
    truncated,
    scanned,
  };
}

/** 只追加审计，不记录文件正文；写失败不影响只读请求。 */
export function auditLocalObserve(
  actorId: string,
  action: "list" | "read" | "search" | "root.add" | "root.update" | "root.delete" | "write.request" | "write.apply" | "write.reject" | "task.create" | "task.evidence" | "task.cancel" | "task.steps" | "task.auto" | "command.request" | "command.apply" | "command.reject" | "git.inspect" | "browser.observe" | "browser.request" | "browser.apply" | "browser.reject",
  detail: Record<string, unknown>,
) {
  try {
    const file = dataPath("local-exec-audit.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      actorId,
      action,
      ...detail,
    }) + "\n", "utf8");
  } catch {
    // 审计失败不阻断观察；后续接入统一审计表时再收紧
  }
}
