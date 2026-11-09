import assert from "node:assert/strict";
import {
  KNOWLEDGE_IMPORT_MAX_BYTES,
  KNOWLEDGE_IMPORT_MAX_CHARS,
  parseKnowledgeImportFile,
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

console.log("Knowledge document import parser: 11 assertions passed.");
