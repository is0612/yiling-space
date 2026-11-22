import type { MediaKind } from "./channel-adapter/onebot/media-kind";

/** Structural image slots prevent literal user text from being interpreted as protocol media. */
export type ImageTextPart = { type: "text"; text: string } | { type: "image"; imageIndex: number; mediaKind: MediaKind };

export function sanitizeMediaDescription(raw: string, maxChars = 400): string | null {
  const text = raw.replace(/\[/gu, "（").replace(/\]/gu, "）")
    .replace(/\s+/gu, " ").trim().slice(0, maxChars).trim();
  return text || null;
}

export function renderImageTextParts(parts: readonly ImageTextPart[], descriptions: readonly (string | null | undefined)[] = []): string {
  return parts.map(part => {
    if (part.type === "text") return part.text;
    const label = part.mediaKind === "sticker" ? "表情包" : "图片";
    const description = descriptions[part.imageIndex] ? sanitizeMediaDescription(descriptions[part.imageIndex]!) : null;
    return description ? `[${label}：${description}]` : `[${label}]`;
  }).join("").trim();
}
