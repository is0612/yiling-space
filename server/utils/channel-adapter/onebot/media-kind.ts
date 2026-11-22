export type MediaKind = "sticker" | "image" | "unknown";
export type SubTypeState = "missing" | "valid" | "invalid";
export type OnebotMediaSignal = {
  segmentIndex: number;
  source: "image" | "mface" | "marketface";
  imageIndex?: number;
  subType?: number;
  subTypeState: SubTypeState;
  summary?: string;
  emojiIdPresent?: boolean;
  emojiPackageIdPresent?: boolean;
};
export type MediaClassification = {
  kind: MediaKind;
  basis: "segment_type" | "summary" | "sub_type_1" | "sub_type_0" | "no_known_signal";
};

/** Safe observation text, never a transport URL or an unbounded gateway payload. */
export function sanitizeMediaSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|data:)[^\s<>]+/giu, "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120).trim();
  return safe || undefined;
}

export function readMediaSignal(source: OnebotMediaSignal["source"], data: Record<string, unknown>, segmentIndex: number, imageIndex?: number): OnebotMediaSignal {
  const present = Object.prototype.hasOwnProperty.call(data, "sub_type");
  const valid = typeof data.sub_type === "number" && Number.isSafeInteger(data.sub_type) && data.sub_type >= 0;
  const summary = sanitizeMediaSummary(data.summary);
  return { source, segmentIndex, ...(imageIndex === undefined ? {} : { imageIndex }),
    subTypeState: !present ? "missing" : valid ? "valid" : "invalid",
    ...(valid ? { subType: data.sub_type as number } : {}),
    ...(summary ? { summary } : {}),
    ...(data.emoji_id !== undefined ? { emojiIdPresent: true } : {}),
    ...(data.emoji_package_id !== undefined ? { emojiPackageIdPresent: true } : {}),
  };
}

export function classifyOnebotImage(ref: Pick<OnebotMediaSignal, "subType" | "summary"> & Partial<Pick<OnebotMediaSignal, "source" | "subTypeState">>): MediaClassification {
  if (ref.source === "mface" || ref.source === "marketface") return { kind: "sticker", basis: "segment_type" };
  if (/^(?:动画表情|表情|表情包|贴图|\[(?:动画表情|表情|表情包|贴图)\])$/u.test(ref.summary?.trim() ?? "")) return { kind: "sticker", basis: "summary" };
  const valid = ref.subTypeState === undefined || ref.subTypeState === "valid";
  if (valid && ref.subType === 1) return { kind: "sticker", basis: "sub_type_1" };
  if (valid && ref.subType === 0) return { kind: "image", basis: "sub_type_0" };
  return { kind: "unknown", basis: "no_known_signal" };
}
