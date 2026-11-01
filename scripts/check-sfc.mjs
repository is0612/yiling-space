#!/usr/bin/env node
/**
 * SFC 编译门禁：把 app/ 下每个 .vue 真的编译一遍（script + template）。
 *
 * 为什么需要它：`await` 写在非 async 函数里这类**语法错误**，eslint（vue-eslint-parser +
 * @typescript-eslint/parser）不会报，`nuxi typecheck` 也会被一堆无关报错淹掉，
 * 结果就是「lint 绿、typecheck 绿（或红得看不清），页面白屏」。
 * 第 5 次踩这种坑的时候，加一条 10 秒就能跑完的检查比记性靠谱。
 *
 * 用法：
 *   node scripts/check-sfc.mjs            # 扫 app/
 *   node scripts/check-sfc.mjs app/pages  # 扫指定目录/文件
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";

const ROOT = resolve(process.cwd());
const targets = process.argv.slice(2);
const inputs = targets.length > 0 ? targets : ["app"];

/** 递归收集 .vue 文件 */
async function collect(path) {
  const absolute = resolve(ROOT, path);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return /\.vue$/u.test(absolute) ? [absolute] : [];
  }
  const files = [];
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...await collect(child));
    } else if (entry.name.endsWith(".vue")) {
      files.push(child);
    }
  }
  return files;
}

function messageOf(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = /** @type {{ message?: string, loc?: { start?: { line?: number, column?: number } } }} */ (error);
    const line = e.loc?.start?.line;
    const column = e.loc?.start?.column;
    const where = line ? ` (${line}:${column})` : "";
    return `${e.message ?? String(error)}${where}`;
  }
  return String(error);
}

async function checkFile(file) {
  const source = await readFile(file, "utf8");
  const problems = [];

  const { descriptor, errors } = parse(source, { filename: file });
  for (const error of errors) problems.push(`parse: ${messageOf(error)}`);

  const hasScript = Boolean(descriptor.script || descriptor.scriptSetup);
  if (hasScript) {
    try {
      compileScript(descriptor, { id: file });
    } catch (error) {
      problems.push(`script: ${messageOf(error)}`);
    }
  }

  if (descriptor.template) {
    try {
      const result = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id: file,
      });
      for (const error of result.errors) problems.push(`template: ${messageOf(error)}`);
    } catch (error) {
      problems.push(`template: ${messageOf(error)}`);
    }
  }

  return problems;
}

const files = (await Promise.all(inputs.map((input) => collect(input)))).flat().sort();
if (files.length === 0) {
  console.error("check:sfc —— 没有找到任何 .vue 文件。");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const problems = await checkFile(file);
  if (problems.length === 0) continue;
  failed += 1;
  console.error(`\n✗ ${relative(ROOT, file)}`);
  for (const problem of problems) console.error(`  ${problem}`);
}

if (failed > 0) {
  console.error(`\ncheck:sfc —— ${failed}/${files.length} 个组件编译失败。`);
  process.exit(1);
}

console.log(`check:sfc —— ${files.length} 个组件全部编译通过。`);
