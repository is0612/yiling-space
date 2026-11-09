import { createHash } from "node:crypto";
import { assertFetchableMediaUrl, downloadSafeMedia } from "./safe-media-download";

export const KNOWLEDGE_WEB_MAX_BYTES = 1_500_000;
export const KNOWLEDGE_WEB_MAX_CHARS = 20_000;
export const KNOWLEDGE_WEB_TIMEOUT_MS = 15_000;

export type ParsedKnowledgeWebPage = {
  originalUrl: string;
  finalUrl: string;
  title: string;
  mediaType: string;
  httpStatus: number;
  byteSize: number;
  sha256: string;
  rawContent: string;
};

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
    ldquo: "“", rdquo: "”", copy: "©", reg: "®",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cleanExtractedText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\u00a0/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHtml(html: string): { title: string; rawContent: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch
    ? cleanExtractedText(titleMatch[1]!.replace(/<[^>]*>/g, " ")).slice(0, 240)
    : "";

  // 先移除不可见/非正文区域，再把常见块级元素转换成段落边界。
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|object|template|nav|footer|header|aside|form|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|article|section|main|h[1-6]|li|blockquote|tr|pre)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return { title, rawContent: cleanExtractedText(text) };
}

export function parseKnowledgeWebContent(input: {
  url: string;
  finalUrl?: string;
  mediaType: string;
  status: number;
  data: Uint8Array;
}): ParsedKnowledgeWebPage {
  const originalUrl = assertFetchableMediaUrl(input.url).toString();
  const finalUrl = assertFetchableMediaUrl(input.finalUrl || originalUrl).toString();
  const mediaType = input.mediaType.split(";")[0]!.trim().toLowerCase();
  if (!["text/html", "application/xhtml+xml", "text/plain"].includes(mediaType)) {
    throw new Error("网页返回的不是支持的 HTML 或纯文本内容。");
  }
  if (!input.data.byteLength) throw new Error("网页没有返回正文内容。");
  if (input.data.byteLength > KNOWLEDGE_WEB_MAX_BYTES) throw new Error("网页正文超过 1.5 MB，无法导入。");

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.data);
  } catch {
    throw new Error("网页不是有效的 UTF-8 文本，暂时无法导入。");
  }

  const extracted = mediaType === "text/plain"
    ? { title: "", rawContent: cleanExtractedText(decoded) }
    : extractHtml(decoded);
  const rawContent = extracted.rawContent.slice(0, KNOWLEDGE_WEB_MAX_CHARS).trim();
  if (!rawContent) throw new Error("没有从网页中提取到正文内容。");
  if (rawContent.length < 40) throw new Error("网页正文过短，可能只是导航或错误页面，请改用手动录入。");

  return {
    originalUrl,
    finalUrl,
    title: extracted.title || new URL(finalUrl).hostname,
    mediaType,
    httpStatus: input.status,
    byteSize: input.data.byteLength,
    sha256: createHash("sha256").update(input.data).digest("hex"),
    rawContent,
  };
}

export async function fetchKnowledgeWebPage(rawUrl: string): Promise<ParsedKnowledgeWebPage> {
  let url: URL;
  try {
    url = assertFetchableMediaUrl(rawUrl.trim());
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "IMAGE_BLOCKED_HOST") throw new Error("该网址指向本机、内网或保留地址，已阻止访问。");
    if (reason === "IMAGE_INVALID_PROTOCOL") throw new Error("只允许导入 HTTP 或 HTTPS 网页。");
    throw new Error("请输入有效的 HTTP 或 HTTPS 网页地址。");
  }
  let result;
  try {
    result = await downloadSafeMedia(url.toString(), {
      prefix: "IMAGE",
      maxBytes: KNOWLEDGE_WEB_MAX_BYTES,
      timeoutMs: KNOWLEDGE_WEB_TIMEOUT_MS,
      headers: {
        "user-agent": "YilingSpace-KnowledgeImporter/1.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      },
      allowedMimeTypes: ["text/html", "application/xhtml+xml", "text/plain"],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason.includes("BLOCKED_HOST")) throw new Error("网页或重定向地址指向本机、内网或保留地址，已阻止访问。");
    if (reason.includes("TOO_LARGE")) throw new Error("网页响应超过 1.5 MB，已停止下载。");
    if (reason.includes("UNSUPPORTED_CONTENT_TYPE")) throw new Error("网页只支持 HTML、XHTML 或纯文本内容。");
    if (reason.includes("REDIRECT_LIMIT")) throw new Error("网页重定向次数过多，已停止访问。");
    if (reason.includes("INVALID_PROTOCOL") || reason.includes("INVALID_URL")) throw new Error("只允许有效的 HTTP 或 HTTPS 网页地址。");
    if (reason.includes("_HTTP_")) throw new Error("网页服务器暂时无法访问：" + reason.match(/_HTTP_\\d+/)?.[0]?.replace("_HTTP_", "HTTP ") + "。");
    if (reason.includes("_TIMEOUT")) throw new Error("网页连接超时，请稍后重试。");
    throw new Error("无法安全获取该网页，请检查网址或稍后重试。");
  }
  return parseKnowledgeWebContent({
    url: url.toString(),
    finalUrl: result.finalUrl,
    mediaType: result.mime,
    status: result.status,
    data: result.buffer,
  });
}
