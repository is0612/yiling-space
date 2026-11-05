/**
 * Safe diagnostics for QQ red-packet events received through OneBot.
 *
 * Never returns segment values, message text, QQ identifiers, URLs, tokens, or raw payloads.
 * The output is intentionally limited to protocol shape so it can be logged safely.
 */
export type OnebotRedPacketDiagnostic = {
  source: "segment" | "text_marker";
  candidateTypes: string[];
  segmentCount: number;
  dataKeys: string[][];
};

/** Known textual markers used by gateways when rendering QQ red packets. */
const RED_PACKET_TEXT_MARKERS = [/\[QQ红包\]/i, /\[红包\]/i, /\[red.?packet\]/i, /hongbao/i];

/** Match only segment type names; never inspect or return their data values. */
const RED_PACKET_SEGMENT_TYPE = /red.?packet|red.?bag|hongbao|lucky.?money|qq.?red.?packet/i;

function readSegmentArray(message: unknown): Array<{ type?: unknown; data?: unknown }> {
  if (!Array.isArray(message)) return [];
  return message.filter((item): item is { type?: unknown; data?: unknown } =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

/**
 * Summarize a possible red-packet event without exposing its payload.
 * Returns null for ordinary messages, so callers only emit diagnostics when relevant.
 */
export function inspectOnebotRedPacket(data: unknown): OnebotRedPacketDiagnostic | null {
  if (!data || typeof data !== "object") return null;
  const event = data as { message?: unknown; raw_message?: unknown };
  const segments = readSegmentArray(event.message);
  const candidateSegments = segments.filter((segment) =>
    typeof segment.type === "string" && RED_PACKET_SEGMENT_TYPE.test(segment.type));
  const textValues = [
    typeof event.message === "string" ? event.message : "",
    typeof event.raw_message === "string" ? event.raw_message : "",
    ...segments
      .filter((segment) => segment.type === "text" && segment.data && typeof segment.data === "object")
      .map((segment) => {
        const value = (segment.data as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      }),
  ];
  const hasTextMarker = textValues.some((value) => RED_PACKET_TEXT_MARKERS.some((marker) => marker.test(value)));

  if (!candidateSegments.length && !hasTextMarker) return null;

  const candidateTypes = [...new Set(candidateSegments
    .map((segment) => segment.type)
    .filter((type): type is string => typeof type === "string"))];
  const dataKeys = candidateSegments.map((segment) =>
    segment.data && typeof segment.data === "object" && !Array.isArray(segment.data)
      ? Object.keys(segment.data as Record<string, unknown>)
          .filter((key) => /^[a-zA-Z0-9_]{1,40}$/.test(key))
          .sort()
      : []);

  return {
    source: candidateSegments.length ? "segment" : "text_marker",
    candidateTypes,
    segmentCount: segments.length,
    dataKeys,
  };
}
