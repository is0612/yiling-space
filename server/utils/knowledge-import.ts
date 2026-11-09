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
