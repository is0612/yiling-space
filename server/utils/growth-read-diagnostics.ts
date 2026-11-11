export const GROWTH_READ_DOMAINS = ["knowledge", "preferences", "language", "goals"] as const;
export type GrowthReadDomain = typeof GROWTH_READ_DOMAINS[number];
export type GrowthReadDiagnostic = {
  domain: GrowthReadDomain;
  status: "not_needed" | "no_match" | "failed" | "budget_excluded" | "provided";
  candidateCount: number; matchedCount: number; selectedCount: number;
  budgetExcludedCount: number; limitExcludedCount: number; candidateLimitReached: boolean;
  provided: Array<{ id: string; revision?: number; updatedAt?: string }>;
  usedIds: string[];
};
export type GrowthReadObserver = (entry: GrowthReadDiagnostic) => void;
export function createGrowthReadDiagnostic(domain: GrowthReadDomain, patch: Partial<Omit<GrowthReadDiagnostic, "domain">> = {}): GrowthReadDiagnostic {
  return { domain, status: "not_needed", candidateCount: 0, matchedCount: 0, selectedCount: 0, budgetExcludedCount: 0, limitExcludedCount: 0, candidateLimitReached: false, provided: [], usedIds: [], ...patch };
}
export function reportGrowthRead(observer: GrowthReadObserver | undefined, entry: GrowthReadDiagnostic) {
  try { observer?.(entry); } catch { /* Read diagnostics never affect retrieval or replies. */ }
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.min(1000, Math.max(0, Math.floor(v))) : 0;
/** Diagnostics include references only; no query, record text, actor or provider metadata. */
export function sanitizeGrowthReadDiagnostics(value: unknown): GrowthReadDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: GrowthReadDiagnostic[] = []; const seen = new Set<string>();
  for (const raw of value.slice(0, 4)) {
    const row = object(raw);
    if (typeof row.domain !== "string" || !GROWTH_READ_DOMAINS.includes(row.domain as GrowthReadDomain) || seen.has(row.domain)) continue;
    if (typeof row.status !== "string" || !["not_needed", "no_match", "failed", "budget_excluded", "provided"].includes(row.status)) continue;
    seen.add(row.domain);
    const provided: GrowthReadDiagnostic["provided"] = [];
    for (const raw of (Array.isArray(row.provided) ? row.provided : []).slice(0, 8)) {
      const ref = object(raw);
      if (typeof ref.id !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(ref.id) || provided.some(item => item.id === ref.id)) continue;
      provided.push({ id: ref.id,
        ...(typeof ref.revision === "number" && Number.isSafeInteger(ref.revision) && ref.revision > 0 ? { revision: ref.revision } : {}),
        ...(typeof ref.updatedAt === "string" && ref.updatedAt.length <= 40 && Number.isFinite(Date.parse(ref.updatedAt)) ? { updatedAt: new Date(ref.updatedAt).toISOString() } : {}),
      });
    }
    const ids = new Set(provided.map(item => item.id));
    output.push({ domain: row.domain as GrowthReadDomain, status: row.status as GrowthReadDiagnostic["status"],
      candidateCount: count(row.candidateCount), matchedCount: count(row.matchedCount), selectedCount: count(row.selectedCount),
      budgetExcludedCount: count(row.budgetExcludedCount), limitExcludedCount: count(row.limitExcludedCount), candidateLimitReached: row.candidateLimitReached === true,
      provided, usedIds: [...new Set((Array.isArray(row.usedIds) ? row.usedIds : []).filter((id): id is string => typeof id === "string" && ids.has(id)))].slice(0, 8),
    });
  }
  return output;
}
export function reconcileGrowthReadUsage(reads: readonly GrowthReadDiagnostic[], usage: { preferences?: readonly string[]; language?: readonly string[]; goals?: readonly string[] }, silent = false): GrowthReadDiagnostic[] {
  return reads.map(read => {
    const permitted = new Set(read.provided.map(item => item.id));
    const used = read.domain === "knowledge" ? [] : usage[read.domain] ?? [];
    return { ...read, provided: read.provided.map(item => ({ ...item })), usedIds: silent ? [] : [...new Set(used.filter(id => permitted.has(id)))].slice(0, 8) };
  });
}
