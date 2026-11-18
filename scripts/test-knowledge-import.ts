import assert from "node:assert/strict";
import {
  KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS,
  KNOWLEDGE_IMPORT_MAX_BYTES,
  KNOWLEDGE_IMPORT_MAX_CHARS,
  parseKnowledgeImportFile,
  splitKnowledgeImportContent,
} from "../server/utils/knowledge-import";

function parse(filename: string, content: string, mediaType = "text/plain") {
  return parseKnowledgeImportFile({ filename, mediaType, data: Buffer.from(content, "utf8") });
}

function rejects(filename: string, data: Uint8Array, expected: RegExp) {
  assert.throws(
    () => parseKnowledgeImportFile({ filename, data }),
    expected,
  );
}

const markdown = parse("../资料/鲸类知识.MD", "\uFEFF# 蓝鲸\r\n\r\n蓝鲸是现存体型最大的动物。", "application/octet-stream");
assert.equal(markdown.filename, "鲸类知识.MD", "文件名必须剥离路径，保留可读名称");
assert.equal(markdown.extension, "md");
assert.equal(markdown.mediaType, "text/markdown");
assert.equal(markdown.rawContent, "# 蓝鲸\n\n蓝鲸是现存体型最大的动物。", "去 BOM 并统一换行");
assert.equal(markdown.byteSize, Buffer.byteLength("\uFEFF# 蓝鲸\r\n\r\n蓝鲸是现存体型最大的动物。"));
assert.match(markdown.sha256, /^[a-f0-9]{64}$/);

const plain = parse("notes.txt", "  可复用的知识  ");
assert.equal(plain.rawContent, "可复用的知识");
assert.equal(plain.mediaType, "text/plain");
assert.equal(plain.extension, "txt");

// 回归：数字与大写字母是正常正文，不能被「控制字符」那道校验误伤。
const ascii = parse("mixed.txt", "ABC 123 hello, 第 2 章。");
assert.equal(ascii.rawContent, "ABC 123 hello, 第 2 章。", "含数字与大写字母的正文必须正常导入");

rejects("payload.pdf", Buffer.from("not really a pdf"), /只支持/);
rejects("payload.exe", Buffer.from("bad"), /只支持/);
rejects("empty.md", Buffer.from("  "), /为空|没有可导入/);
rejects("invalid.txt", Uint8Array.from([0xc3, 0x28]), /UTF-8/);
rejects("control.txt", Buffer.from("hello\u0000world"), /控制字符/);
rejects("large.txt", Buffer.alloc(KNOWLEDGE_IMPORT_MAX_BYTES + 1, 65), /2 MB/);
rejects("long.md", Buffer.from("a".repeat(KNOWLEDGE_IMPORT_MAX_CHARS + 1)), /20000/);

// 一份文档要按 `##` 拆成多条候选：每段一条知识，标题取二级标题。
const multi = splitKnowledgeImportContent([
  "# 养鱼知识",
  "",
  "> 用途说明只有一行，不该单独成条。",
  "",
  "## 记忆按预算装配",
  "",
  "适用：注入记忆时。",
  "做法：按 token 预算装配。",
  "",
  "## 群聊开口判据",
  "",
  "适用：群里要不要接话。",
  "做法：人回机器不回。",
].join("\n"));
assert.equal(multi.length, 2, "两个二级标题应拆成两条候选，序言丢掉");
assert.equal(multi[0]!.title, "记忆按预算装配");
assert.ok(multi[0]!.content.startsWith("适用：注入记忆时。"), "正文不应带标题行");
assert.equal(multi[1]!.title, "群聊开口判据");

// 没有 `##` 的纯文本按空行分段，每段一条。
const paragraphs = splitKnowledgeImportContent("第一段讲记忆。\n\n第二段讲语音。\n\n\n第三段讲成本。");
assert.equal(paragraphs.length, 3, "无标题时按空行分段");
assert.equal(paragraphs[0]!.content, "第一段讲记忆。");

// 序言够长时保留为一条，不能因为「在第一个 ## 前面」就整段丢掉。
const longPreamble = splitKnowledgeImportContent(
  "A".repeat(240) + "\n\n## 正文一\n\n内容一。",
);
assert.equal(longPreamble.length, 2, "长序言应保留，否则会静默丢内容");
assert.ok(longPreamble[0]!.title.startsWith("AAAA"), "无标题块用首行做展示标题");
assert.equal(longPreamble[0]!.title.length, 80, "展示标题截到 80 字，避免整份序言压进标题");

// 超长块必须继续切，且每块都不超过上限。
const huge = splitKnowledgeImportContent("## 长条目\n\n" + "这是一句很长的话。".repeat(1_200));
assert.ok(huge.length >= 2, "超长条目必须切成多块");
assert.ok(huge.every(chunk => chunk.content.length <= KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS), "每块都不能超过上限");

// 空内容不产生候选。
assert.equal(splitKnowledgeImportContent("   \n\n  ").length, 0);

console.log("Knowledge document import parser: 11 + 9 assertions passed.");
