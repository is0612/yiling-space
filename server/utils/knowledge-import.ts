import { createHash } from "node:crypto";

export const KNOWLEDGE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const KNOWLEDGE_IMPORT_MAX_CHARS = 20_000;

export type ParsedKnowledgeImport = {
  filename: string;
  extension: "txt" | "md";
  mediaType: string;
  byteSize: number;
  sha256: string;
  rawContent: string;
};

export function parseKnowledgeImportFile(input: {
  filename: string;
  mediaType?: string | null;
  data: Uint8Array;
}): ParsedKnowledgeImport {
  const filename = input.filename.split(/[\\/]/).pop()?.trim().slice(0, 180) ?? "";
  const extension = filename.toLowerCase().split(".").pop();
  if (!filename || (extension !== "txt" && extension !== "md")) {
    throw new Error("目前只支持 UTF-8 编码的 .txt 和 .md 文件。");
  }
  if (!input.data.byteLength) throw new Error("文件内容为空。");
  if (input.data.byteLength > KNOWLEDGE_IMPORT_MAX_BYTES) {
    throw new Error("单个文件不能超过 2 MB。");
  }

  let decoded = "";
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.data);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本，请另存为 UTF-8 后重试。");
  }
  // 去 BOM、统一换行（CRLF / CR → LF），再掐掉首尾空白。
  const rawContent = decoded.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!rawContent) throw new Error("文件中没有可导入的文本内容。");
  if (rawContent.length > KNOWLEDGE_IMPORT_MAX_CHARS) {
    throw new Error("单个文件提取后的内容不能超过 20000 个字符，请拆分后导入。");
  }
  // C0 控制字符里只放行 \t 和 \n（\r 上一步已归一），其余一律算脏数据。
  // 注意这里是真实的字符类，别写成 \\u0000 那种字面量 —— 那样会把大写字母和数字误判成控制字符。
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(rawContent)) {
    throw new Error("文件包含不支持的控制字符，请先清理内容。");
  }

  const mediaType = extension === "md" ? "text/markdown" : "text/plain";
  return {
    filename,
    extension,
    mediaType,
    byteSize: input.data.byteLength,
    sha256: createHash("sha256").update(input.data).digest("hex"),
    rawContent,
  };
}

/** 一份文档最多拆成这么多条候选：再多就该拆文件，而不是让候选列表失控。 */
export const KNOWLEDGE_IMPORT_MAX_CHUNKS = 50;
/** 单块正文上限。超过就继续切，避免候选长到知识助手读不完。 */
export const KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS = 6_000;
/** 二级标题前的内容（文件标题、用途说明）短于这个长度时丢掉，不单独成条。 */
const PREAMBLE_MAX_CHARS = 200;

export type KnowledgeImportChunk = {
  /** 候选标题：有 `##` 就用它，否则取首行。只用于展示与溯源，最终标题由知识助手决定。 */
  title: string;
  content: string;
};

/**
 * 把一份导入文件拆成「一条知识一段」的候选。
 *
 * 为什么必须拆：知识处理助手一次只输出**一个** JSON 对象，也就是一条知识；整份文档塞进去，
 * 要么被截断成坏 JSON，要么被压成一条跨十几个主题的巨型条目，检索命中率和注入预算都会崩。
 *
 * 切分顺序：`##` 标题 → 空行分段 → 按行累积。没有 `##` 的纯文本按分段切，
 * 这样一段讲一件事的笔记也能得到多条候选。
 */
export function splitKnowledgeImportContent(rawContent: string): KnowledgeImportChunk[] {
  const text = rawContent.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  const blocks: string[] = [];
  if (/^## /m.test(text)) {
    const lines = text.split("\n");
    const firstHeading = lines.findIndex(line => /^## /.test(line));
    const preamble = lines.slice(0, firstHeading).join("\n").trim();
    // 序言很短时只是文件标题与说明，丢掉；长到能独立成段时才保留。
    if (preamble.length >= PREAMBLE_MAX_CHARS) blocks.push(preamble);
    let current: string[] = [];
    for (const line of lines.slice(firstHeading)) {
      if (/^## /.test(line) && current.length) {
        blocks.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    if (current.length) blocks.push(current.join("\n"));
  } else {
    blocks.push(...text.split(/\n{2,}/));
  }

  const chunks: KnowledgeImportChunk[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    for (const piece of splitOversizedBlock(trimmed)) {
      const heading = /^## (.+)$/m.exec(piece);
      const body = heading
        ? piece.replace(/^## .+\n?/, "").trim()
        : piece;
      if (!body) continue;
      const title = (heading?.[1]?.trim() || body.split("\n")[0] || "导入内容").slice(0, 80);
      chunks.push({ title, content: body.slice(0, KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS) });
      if (chunks.length > KNOWLEDGE_IMPORT_MAX_CHUNKS) {
        throw new Error(
          `这份文件能拆出超过 ${KNOWLEDGE_IMPORT_MAX_CHUNKS} 条知识，请拆成多个文件后分别导入。`,
        );
      }
    }
  }
  return chunks;
}

/** 单块超长时先按段落切，段落仍超长再按行累积，保证每块都在上限内。 */
function splitOversizedBlock(block: string): string[] {
  if (block.length <= KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS) return [block];
  const out: string[] = [];
  let current = "";
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) out.push(trimmed);
    current = "";
  };
  for (const paragraph of block.split(/\n{2,}/)) {
    if (paragraph.length > KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS) {
      push();
      for (const line of paragraph.split("\n")) {
        // 单行也可能超长（粘进来的长文、没有换行的笔记）：按字符硬切，
        // 否则这一行会整块塞进候选，助手仍然读不完。
        if (line.length > KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS) {
          push();
          for (let offset = 0; offset < line.length; offset += KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS) {
            out.push(line.slice(offset, offset + KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS).trim());
          }
          continue;
        }
        if (current.length + line.length + 1 > KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS) push();
        current += (current ? "\n" : "") + line;
      }
      push();
      continue;
    }
    if (current.length + paragraph.length + 2 > KNOWLEDGE_IMPORT_CHUNK_MAX_CHARS) push();
    current += (current ? "\n\n" : "") + paragraph;
  }
  push();
  return out;
}
