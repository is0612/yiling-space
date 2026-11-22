/** Safe image evidence for prompts; never contains storage paths, transport URLs or platform ids. */
export type GeneratedImageFacts = {
  origin: "self_generated";
  mode: "text_to_image";
  generatedAt?: string;
  requestedDescription?: string;
  visual: { status: "not_requested" | "disabled" | "ok" | "failed" | "budget_exhausted" | "missing_file"; description?: string };
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function sanitizeGeneratedImageFacts(value: unknown): GeneratedImageFacts | null {
  const source = record(value);
  if (source.origin !== "self_generated" || source.mode !== "text_to_image") return null;
  const visual = record(source.visual);
  const statuses = ["not_requested", "disabled", "ok", "failed", "budget_exhausted", "missing_file"];
  if (!statuses.includes(String(visual.status))) return null;
  const clean = (text: unknown, limit: number) => typeof text === "string" ? text.replace(/[\u0000-\u001f]/gu, " ").replace(/(?:[a-z][a-z0-9+.-]*:\/\/|data:|www\.)[^\s<>]+/giu, "").trim().slice(0, limit) : "";
  const description = clean(visual.description, 400);
  const prompt = clean(source.requestedDescription, 1200);
  const status = visual.status as GeneratedImageFacts["visual"]["status"];
  return { origin: "self_generated", mode: "text_to_image",
    ...(typeof source.generatedAt === "string" && Number.isFinite(Date.parse(source.generatedAt)) ? { generatedAt: source.generatedAt } : {}),
    ...(prompt ? { requestedDescription: prompt } : {}),
    visual: status === "ok" && description ? { status: "ok", description } : { status: status === "ok" ? "failed" : status },
  };
}
