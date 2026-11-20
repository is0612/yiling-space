import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertReadableName, LocalObserveError, resolveLocalPath, validateLocalWritablePath } from "./local-observe";

const windows = process.platform === "win32";
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const branchName = /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,99}$/;

function gitExecutable() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const absolute = dir.replace(/^"|"$/g, "");
    if (!path.isAbsolute(absolute)) continue;
    const candidate = path.join(absolute, windows ? "git.exe" : "git");
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  throw new LocalObserveError(503, "找不到 Git。请安装 Git 并重启桌面端。");
}

function equalPath(left: string, right: string) {
  return path.relative(left, right) === "";
}

function repository(root: string, cwd: string) {
  if (cwd.includes(":") || cwd.split(/[\\/]/).some(part => part === ".." || part.startsWith(".") && part !== ".")) {
    throw new LocalObserveError(400, "请输入授权根内的仓库相对路径。");
  }
  const resolved = resolveLocalPath(root, cwd);
  assertReadableName(resolved.relative.toLowerCase());
  // Require a real, self-contained .git directory at precisely this location. Git must not discover a parent repo.
  if (!equalPath(resolved.absolute, resolved.real)) throw new LocalObserveError(403, "请选择仓库真实目录，不使用链接。");
  const directory = path.join(resolved.real, ".git");
  const meta = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!meta?.isDirectory() || !equalPath(fs.realpathSync(directory), directory)
    || fs.existsSync(path.join(directory, "commondir"))) {
    throw new LocalObserveError(400, "请选择含有实体 .git 目录的仓库根目录；暂不支持链接工作树或子模块。");
  }
  return { cwd: resolved.real, relative: resolved.relative, directory };
}

type Repo = ReturnType<typeof repository>;
function run(repo: Repo, args: string[], maxBuffer = 64 * 1024) {
  const env: NodeJS.ProcessEnv = {
    ...(windows ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: windows ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", LC_ALL: "C",
  };
  const result = spawnSync(gitExecutable(), ["--no-pager", "--literal-pathspecs", `--git-dir=${repo.directory}`,
    `--work-tree=${repo.cwd}`, "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${windows ? "NUL" : "/dev/null"}`,
    "-c", "core.untrackedCache=false", "-c", "core.quotePath=false", ...args], {
    cwd: repo.cwd, env, encoding: "utf8", shell: false, windowsHide: true,
    timeout: 5000, maxBuffer, stdio: ["ignore", "pipe", "pipe"],
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") throw new LocalObserveError(413, "Git 输出太大，请缩小查看范围。");
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new LocalObserveError(503, "Git 操作超时。");
  return result;
}

function requireOutput(result: ReturnType<typeof run>) {
  if (result.error || result.status !== 0) throw new LocalObserveError(409, "Git 操作未能完成，请检查仓库状态。");
  return result.stdout;
}

function requirePlainWorktree(repo: Repo) {
  // Git may apply repository-defined filters while inspecting tracked worktree files.
  const filters = run(repo, ["config", "--includes", "--name-only", "--get-regexp", "^filter\\."]);
  if (!filters.error && filters.status === 1 && !filters.stderr) return;
  requireOutput(filters);
  throw new LocalObserveError(409, "这个仓库配置了 Git 文件过滤器，暂不支持查看工作区。");
}

function worktreeRecords(repo: Repo, file?: string) {
  requirePlainWorktree(repo);
  return requireOutput(run(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "--ignore-submodules=all", "-z",
    ...(file === undefined ? [] : ["--", file])])).split("\0");
}

export function readGitStatus(root: string, cwd: string) {
  const repo = repository(root, cwd);
  const ref = run(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = ref.status === 1 ? null : requireOutput(ref).trim();
  const records = worktreeRecords(repo);
  const visible = [];
  for (const record of records) {
    if (record.length < 4) continue;
    const file = record.slice(3);
    if (!file) continue;
    try { previewTarget(repo, file); } catch { continue; }
    const code = record.slice(0, 2);
    visible.push({ code, path: file, staged: code[0] !== " " && code[0] !== "?", unstaged: code[1] !== " " || code === "??", untracked: code === "??" });
  }
  return { cwd: repo.relative, branch, entries: visible.slice(0, 100), truncated: visible.length > 100 };
}

function untrackedDiff(target: ReturnType<typeof validateLocalWritablePath>) {
  if (target.size > 64 * 1024) throw new LocalObserveError(413, "文件超过 64 KB，暂不预览差异。");
  if (!target.exists) throw new LocalObserveError(404, "新文件已不存在，请刷新状态。");
  const fd = fs.openSync(target.real, "r");
  let buffer: Buffer;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new LocalObserveError(415, "仅预览普通文件。");
    const bounded = Buffer.alloc(64 * 1024 + 1);
    const count = fs.readSync(fd, bounded, 0, bounded.length, 0);
    if (count === bounded.length) throw new LocalObserveError(413, "文件超过 64 KB，暂不预览差异。");
    buffer = bounded.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new LocalObserveError(415, "仅预览 UTF-8 文本文件。"); }
  if (text.includes("\0")) throw new LocalObserveError(415, "二进制文件不预览差异。");
  const endsWithNewline = text.endsWith("\n");
  const lines = text ? text.split(/\r?\n/) : [];
  if (endsWithNewline) lines.pop();
  if (lines.length > 2000) throw new LocalObserveError(413, "文件行数太多，暂不预览差异。");
  return ["--- /dev/null", `+++ b/${target.relative}`, ...(lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)] : []),
    ...(!endsWithNewline && lines.length ? ["\\ No newline at end of file"] : [])].join("\n");
}

function previewTarget(repo: Repo, file: string) {
  if (file.includes(":") || file.split(/[\\/]/).some(part => part === "..")) throw new LocalObserveError(400, "请输入仓库内的文件相对路径。");
  assertReadableName(file.replace(/\\/g, "/").toLowerCase());
  const target = validateLocalWritablePath(repo.cwd, file);
  assertReadableName(target.relative.toLowerCase());
  if (!equalPath(target.absolute, target.real)) throw new LocalObserveError(403, "不查看链接路径的差异。");
  if (target.exists && !fs.lstatSync(target.absolute).isFile()) throw new LocalObserveError(415, "仅预览普通文件。");
  return target;
}

export function readGitDiff(root: string, cwd: string, file: string, staged = true) {
  const repo = repository(root, cwd);
  const target = previewTarget(repo, file);

  if (!staged) {
    const code = worktreeRecords(repo, target.relative).find(row => row.slice(3) === target.relative)?.slice(0, 2);
    if (code === "??") return { path: target.relative, staged: false, untracked: true, diff: untrackedDiff(target) };
    if (!code || code[1] === " ") throw new LocalObserveError(404, "该文件没有可查看的工作区改动，请刷新状态。");
    return {
      path: target.relative,
      staged: false,
      untracked: false,
      diff: requireOutput(run(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--no-color", "--", target.relative])),
    };
  }

  const stagedNames = requireOutput(run(repo, ["diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "-z"])).split("\0");
  if (!stagedNames.includes(target.relative) || stagedNames.some(name => name.startsWith(`${target.relative}/`))) {
    throw new LocalObserveError(404, "请选择暂存区中可查看的单个文件。");
  }
  return { path: target.relative, staged: true, untracked: false, diff: requireOutput(run(repo, ["diff", "--cached",
    "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--no-color", "--", target.relative])) };
}

export function validateGitBranchArgs(args: string[]) {
  const [, , name, base] = args;
  if (args.length !== 4 || args[0] !== "branch" || args[1] !== "--" || !name || !base
    || !branchName.test(name) || name.includes("//") || name.endsWith("/") || !sha.test(base)) {
    throw new LocalObserveError(403, "Git 写操作只允许通过专用入口提议新建分支。");
  }
  return { name, base };
}

export function planGitBranch(root: string, cwd: string, name: string) {
  const repo = repository(root, cwd);
  const base = requireOutput(run(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const args = ["branch", "--", name, base];
  validateGitBranchArgs(args);
  if (run(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).status === 0) {
    throw new LocalObserveError(409, "这个分支已经存在。");
  }
  return { args, cwd: repo.relative };
}

export function applyGitBranch(root: string, cwd: string, args: string[]) {
  const { name, base } = validateGitBranchArgs(args);
  const repo = repository(root, cwd);
  if (requireOutput(run(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== base) {
    throw new LocalObserveError(409, "当前提交已变化，请重新提议新分支。");
  }
  const started = Date.now();
  const result = run(repo, args);
  const ok = result.status === 0 && !result.error;
  return { code: result.status, timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT", durationMs: Date.now() - started,
    stdout: ok ? `已创建分支 ${name}，起点 ${base}。` : "", stderr: "", error: ok ? undefined : "未能创建分支，可能已存在或仓库不可写。" };
}
