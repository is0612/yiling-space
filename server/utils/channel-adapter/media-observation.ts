import { classifyOnebotImage, sanitizeMediaSummary, type OnebotMediaSignal, type MediaClassification } from "./onebot/media-kind";

export type MediaVision =
  | { status: "ok" }
  | { status: "failed"; reason: "description_unavailable" }
  | { status: "skipped"; reason: "not_processed" | "not_enabled" | "limit" | "no_url" | "unsupported_segment" | "sticker_policy" };

export type ChannelMediaObservation = OnebotMediaSignal & MediaClassification & { vision: MediaVision };

/** Observation only: classification does not change text tokens or select vision targets. */
export function observeOnebotMedia(signals: readonly OnebotMediaSignal[]): ChannelMediaObservation[] {
  return signals.map(signal => ({ ...signal, ...classifyOnebotImage(signal), vision: {
    status: "skipped", reason: signal.source === "image" ? "not_processed" : "unsupported_segment",
  } }));
}

/** Merge only observation keys; private pre-recorded metadata can contain independent diagnostics. */
export function mergeStoredMediaMetadata(metadata: unknown, observations: readonly ChannelMediaObservation[]): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const { media: _media, mediaOmitted: _omitted, ...rest } = base;
  return { ...rest, media: storedMediaObservations(observations),
    ...(observations.length > 100 ? { mediaOmitted: observations.length - 100 } : {}) };
}

/** Persist a bounded allowlist; transient URLs, filenames and raw provider identifiers never enter metadata. */
export function storedMediaObservations(observations: readonly ChannelMediaObservation[]): Record<string, unknown>[] {
  return observations.slice(0, 100).map(item => ({
    segmentIndex: item.segmentIndex,
    source: item.source,
    ...(item.imageIndex !== undefined ? { imageIndex: item.imageIndex } : {}),
    subTypeState: item.subTypeState,
    ...(item.subTypeState === "valid" && item.subType !== undefined ? { subType: item.subType } : {}),
    ...(sanitizeMediaSummary(item.summary) ? { summary: sanitizeMediaSummary(item.summary) } : {}),
    ...(item.emojiIdPresent !== undefined ? { emojiIdPresent: item.emojiIdPresent } : {}),
    ...(item.emojiPackageIdPresent !== undefined ? { emojiPackageIdPresent: item.emojiPackageIdPresent } : {}),
    kind: item.kind,
    basis: item.basis,
    vision: { status: item.vision.status, ...("reason" in item.vision ? { reason: item.vision.reason } : {}) },
  }));
}
