import { assertFetchableMediaUrl, downloadSafeMedia } from "./safe-media-download";

export type PublicWebpage = { url: string; title: string; text: string; truncated: boolean; links: string[] };
const MAX_TEXT = 6000;
const MIME_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "application/json", "text/json", "text/markdown", "text/x-markdown"];

/** Syntactic/public-IP validation; DNS is checked and pinned by the downloader. */
export function validatePublicWebpageUrl(raw: string): URL {
  try {
    const url = assertFetchableMediaUrl(raw);
    if (url.port) throw new Error();
    url.hash = "";
    return url;
  } catch { throw new Error("WEB_INVALID_URL"); }
}
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (whole, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
    const value = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : " ";
  });
}
const clean = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").replace(/[ \t]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
const withoutTags = (html: string): string => clean(decodeEntities(html.replace(/<[^>]*>/gu, " ")));

/** Bounded extraction only; returned text is untrusted reference material, never instructions. */
export function extractPublicWebpage(source: string, mime: string, finalUrl: string): PublicWebpage {
  const url = validatePublicWebpageUrl(finalUrl).toString();
  const links: string[] = [];
  let title = "", text = source;
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    const visible = source.replace(/<!--[\s\S]*?(?:-->|$)/gu, " ")
      .replace(/<(script|style|noscript|template|svg|iframe|object|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, " ");
    title = withoutTags(source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu)?.[1] ?? "").slice(0, 300);
    for (const match of visible.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
      try {
        const link = validatePublicWebpageUrl(new URL(decodeEntities(match[1] ?? match[2] ?? match[3] ?? ""), url).toString()).toString();
        if (!links.includes(link)) links.push(link);
      } catch { /* Non-public and non-HTTP references are omitted. */ }
      if (links.length === 8) break;
    }
    text = withoutTags(visible.replace(/<\/?(?:p|div|article|section|h[1-6]|li|ul|ol|br|tr|blockquote|pre)\b[^>]*>/giu, "\n"));
  } else {
    text = clean(text);
    if (mime.includes("markdown")) title = text.match(/^#\s+(.+)$/mu)?.[1]?.slice(0, 300) ?? "";
  }
  return { url, title, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, links };
}

export async function readPublicWebpage(url: string): Promise<PublicWebpage> {
  try {
    const checked = validatePublicWebpageUrl(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const download = downloadSafeMedia(checked.toString(), {
      prefix: "WEB", maxBytes: 512 * 1024, timeoutMs: 10_000,
      allowedMimeTypes: MIME_TYPES,
      headers: { Accept: MIME_TYPES.join(", "), "User-Agent": "YilingSpace-PublicReader/1.0" },
    });
    const response = await Promise.race([download, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("WEB_READ_FAILED")), 10_000);
    })]).finally(() => { if (timer) clearTimeout(timer); });
    return extractPublicWebpage(response.buffer.toString("utf8"), response.mime, response.finalUrl);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const allowed = ["WEB_INVALID_URL", "WEB_BLOCKED_HOST", "WEB_TOO_LARGE", "WEB_UNSUPPORTED_CONTENT_TYPE", "WEB_REDIRECT_LIMIT", "WEB_EMPTY"];
    throw new Error(allowed.includes(code) ? code : "WEB_READ_FAILED");
  }
}
