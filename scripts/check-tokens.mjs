/**
 * 样式契约门禁。
 *
 * `main.css` 顶上那份注释是「设计契约」：六档字号、两档圆角、一套语义色。
 * 但它只是注释 —— 2026-11-20 全站扫了一遍，22 个 .vue 里还散着 61 处十六进制色，
 * 13px / 15px / 17px 也刚清干净。没有门禁，下一个人（或者下一个 AI）照样会写回去。
 *
 * 所以把最容易回退的两条做成硬检查：
 *   1. 组件里不许出现十六进制颜色 —— 一律用 var(--xxx)；
 *   2. 字号不许出现 13 / 15 / 17px —— 只允许六档 12 / 14 / 16 / 18 / 22 / 26。
 *
 * 为什么不管圆角、间距：那些值域更宽，硬拦会误报（999px 药丸 vs 8/10 控件），
 * 收益不抵噪音。两条最容易回退的先锁住，其余靠 review。
 *
 * 真需要例外（比如某处必须跟第三方组件的内联色对齐），在那一行或上一行写：
 *   /* token-allow: 说明为什么 *\/
 * 用过就欠一句解释，比悄悄加个 var 更显眼。
 *
 * `--fix` 只做「值完全等价」的替换：命中的十六进制恰好就是某个令牌的值，换过去像素不变。
 * 颜色相近但不相等的（#fff8fa 对 --brand-soft #fdf0f4）不自动改 —— 那是设计判断，
 * 得看着页面决定，工具不该替人拍板。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const matched = raw.match(/^--([^=]+)(?:=([\s\S]*))?$/);
    return matched ? [matched[1], matched[2] ?? "true"] : [raw.replace(/^--/, ""), "true"];
  }),
);
const APP_DIR = path.join(ROOT, "app");
/** 令牌本身的定义处，只有这里允许写十六进制 */
const TOKEN_FILE = path.join(APP_DIR, "assets", "css", "main.css");
/** 已经清干净、只允许六档的字号 */
const BANNED_FONT_SIZES = new Set(["13px", "15px", "17px"]);

const problems = [];
const fixes = [];

/**
 * 值完全等价、可以放心机械替换的映射。
 * 只收「十六进制 === 某个令牌当前的值」的情况，换完像素一模一样。
 * 相近但不相等的（#fff8fa 对 --brand-soft #fdf0f4、#f5f7fa 对 --surface-2 #f8f9fb）
 * 一律不收：那属于选哪个令牌的判断，得看页面。
 */
const EXACT_MAP = {
  "#0b7a54": "var(--green)",
  "#8f5c05": "var(--amber)",
  "#c92b41": "var(--red)",
  "#fdecef": "var(--red-soft)",
};

/** #fff 看属性：当文字色时是「品牌块上的字」，其余当表面色 */
function whiteToken(line) {
  const isText = /(^|[;\s])color\s*:/.test(line) && !/background|border/.test(line);
  return isText ? "var(--on-brand)" : "var(--surface)";
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(vue|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 只看 <style> 里面的行。
 * 模板里也有颜色（比如给 el-progress 传 color），但那是运行时值、走 props，
 * 不是在这里能统一的东西；混进来只会让报告难读，真正的问题被淹掉。
 */
function styleRanges(text) {
  const ranges = [];
  const regex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let matched;
  while ((matched = regex.exec(text))) {
    const start = text.slice(0, matched.index).split("\n").length;
    ranges.push({ start, end: start + matched[1].split("\n").length - 1 });
  }
  return ranges;
}

function inRanges(line, ranges) {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function allowed(lines, index) {
  const current = lines[index] ?? "";
  const previous = lines[index - 1] ?? "";
  return current.includes("token-allow") || previous.includes("token-allow");
}

/**
 * 注释里也会出现颜色（「L1 白砖 #fff」「原来是 #293e3b」这种解释性记录），
 * 而且常是多行块注释。按行状态机标一遍，注释行整行跳过，
 * 否则报告里会混进一堆根本不是代码的行。
 */
function commentMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inBlock = false;
  lines.forEach((line, index) => {
    const opens = (line.match(/\/\*/g) ?? []).length;
    const closes = (line.match(/\*\//g) ?? []).length;
    const startsInComment = inBlock;
    if (opens > closes) inBlock = true;
    else if (closes > opens) inBlock = false;
    mask[index] = startsInComment || opens > 0;
  });
  return mask;
}

for (const file of walk(APP_DIR)) {
  const relative = path.relative(ROOT, file).replace(/\\/g, "/");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const isVue = file.endsWith(".vue");
  const ranges = isVue ? styleRanges(text) : [{ start: 1, end: lines.length }];
  const skipHex = file === TOKEN_FILE;
  const comments = commentMask(lines);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!inRanges(lineNumber, ranges)) return;
    if (comments[index]) return;
    if (allowed(lines, index)) return;
    const code = line.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "");
    // 选择器那一段：用来判断「这条规则是不是在给图标定尺寸」
    const selector = code.split("{")[0] ?? "";

    if (!skipHex) {
      // 两类不是「写死颜色」的十六进制：
      //   url(#filter) 是 SVG 引用；var(--red, #c92b41) 是给了令牌一个兜底值
      const withoutUrlRefs = code.replace(/url\(\s*#[^)]*\)/g, "");
      const withoutFallbacks = withoutUrlRefs.replace(/var\([^()]*#[^()]*\)/g, "var(--x)");
      const hex = withoutFallbacks.match(/#[0-9a-fA-F]{3,8}\b/);
      if (hex) {
        const value = hex[0].toLowerCase();
        const token = value === "#fff" || value === "#ffffff" ? whiteToken(code) : EXACT_MAP[value];
        if (token && args.fix === "true") {
          fixes.push({ file, relative, line: lineNumber, hex: hex[0], token });
          return;
        }
        problems.push({
          file: relative, line: lineNumber, rule: "hex",
          detail: `${hex[0]} —— 换成 var(--text/--dim/--line/--brand/…)，颜色只从 main.css 出`,
          snippet: line.trim(),
        });
        return;
      }
    }

    // 图标尺寸在 Element 里就是用 font-size 表达的，不属于「正文字号」那一套
    if (/icon/i.test(selector)) return;
    const fontMatch = code.match(/font-size\s*:\s*([0-9.]+px)/i);
    if (fontMatch && BANNED_FONT_SIZES.has(fontMatch[1].toLowerCase())) {
      problems.push({
        file: relative, line: lineNumber, rule: "font-size",
        detail: `${fontMatch[1]} 不在六档里 —— 正文 14，次级 12，标题 16/18，页头 22，总览 26`,
        snippet: line.trim(),
      });
    }
  });
}

if (fixes.length) {
  const byFileForFix = new Map();
  for (const fix of fixes) {
    if (!byFileForFix.has(fix.file)) byFileForFix.set(fix.file, []);
    byFileForFix.get(fix.file).push(fix);
  }
  for (const [file, items] of byFileForFix) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const item of items) {
      // 按行号精确替换，不用全文 replace：同一个文件里同样的色值可能一会儿该当文字色、
      // 一会儿该当背景色，全局替换会把语义抹平。
      const current = lines[item.line - 1] ?? "";
      lines[item.line - 1] = current.replace(item.hex, item.token);
    }
    fs.writeFileSync(file, lines.join("\n"));
  }
  console.log(`已替换 ${fixes.length} 处（值完全等价，像素不变），涉及 ${byFileForFix.size} 个文件。\n`);
}

if (!problems.length) {
  console.log(`check:tokens —— ${walk(APP_DIR).length} 个文件通过。`);
  process.exit(0);
}

/**
 * 存量预算：只许减，不许加。
 *
 * 全站还有几十处历史遗留没清（有些色值在令牌里没有对应项，改哪个得看页面），
 * 但「还没清完」不该等于「门禁失效」—— 那样新代码照样能加回来。
 * 给一个当前数量当上限：老的不算新账，新的一律拦下，数字只会往下走。
 */
const budget = args.budget === undefined ? null : Number(args.budget);
if (budget !== null && problems.length <= budget) {
  console.log(`check:tokens —— 还剩 ${problems.length} 处历史遗留（预算 ${budget}），通过。预算只许减不许加。`);
  process.exit(0);
}
if (budget !== null && problems.length > budget) {
  console.error(`check:tokens —— ${problems.length} 处，比预算 ${budget} 多了 ${problems.length - budget} 处：新代码把颜色写死了。\n`);
}

const byFile = new Map();
for (const problem of problems) {
  if (!byFile.has(problem.file)) byFile.set(problem.file, []);
  byFile.get(problem.file).push(problem);
}

console.error(`check:tokens —— 发现 ${problems.length} 处偏离样式契约：\n`);
for (const [file, items] of byFile) {
  console.error(`${file}`);
  for (const item of items) {
    console.error(`  ${String(item.line).padStart(4, " ")}  [${item.rule}] ${item.detail}`);
    console.error(`        ${item.snippet}`);
  }
  console.error("");
}
console.error(`共 ${byFile.size} 个文件。要么改，要么在该行加 /* token-allow: 原因 */。`);
process.exit(1);
