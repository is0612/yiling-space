/**
 * 失效体检的纯逻辑：候选整形 + 模型输出解析。
 *
 * 单独放一个文件是为了能直接单测：`stale-memory-audit.ts` 连着 Prisma、凭证解密
 * 和模型调用，import 它就得起一整套环境，而这里只需要字符串进、数组出。
 */
import { parseJsonLoose } from "./loose-json";

export const MEMORY_TEXT_MAX = 220;
export const EVENT_TEXT_MAX = 140;
export const REASON_MAX = 120;

export type StaleKind = "MEMORY" | "EVENT";
export type StaleVerdict = "CONTRADICTED" | "OBSOLETE";

export type StaleAuditItem = {
  kind: StaleKind;
  id: string;
  title: string;
  content: string;
  meta: string;
  fingerprint: string;
  verdict: StaleVerdict;
  reason: string;
  confidence: number;
};

export type StaleCandidate = {
  shortId: string;
  kind: StaleKind;
  id: string;
  title: string;
  content: string;
  meta: string;
  /** 只有长期记忆有分类；忆泡只用 kind。 */
  category?: string;
};

export function clipText(text: string, max: number) {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function memoryCandidate(
  row: { id: string; category: string; content: string; importance: number; updatedAt: Date },
  index: number,
): StaleCandidate {
  return {
    shortId: `M${index + 1}`,
    kind: "MEMORY",
    id: row.id,
    title: row.category,
    content: clipText(row.content, MEMORY_TEXT_MAX),
    meta: `重要度 ${row.importance.toFixed(2)} · 更新于 ${row.updatedAt.toISOString().slice(0, 10)}`,
    category: row.category,
  };
}

export function eventCandidate(
  row: { id: string; dayKey: string; title: string; detail: string; participants: string[] },
  index: number,
): StaleCandidate {
  return {
    shortId: `E${index + 1}`,
    kind: "EVENT",
    id: row.id,
    title: row.title,
    content: clipText(row.detail, EVENT_TEXT_MAX),
    meta: `${row.dayKey}${row.participants.length ? ` · ${row.participants.slice(0, 4).join("、")}` : ""}`,
  };
}

/**
 * 解析模型返回。
 *
 * 白名单之外的一切都丢掉：短 id 必须出现在这一轮的清单里（防模型编 id 或抄错），
 * verdict 只认三种，confidence 落在 0~1，reason 为空或超长一律截断。
 */
export function parseStaleAudit(
  text: string,
  candidates: StaleCandidate[],
): Array<Omit<StaleAuditItem, "title" | "content" | "meta" | "fingerprint">> {
  const parsed = parseJsonLoose(text, { expect: "object" }) as Record<string, unknown> | null;
  const rows = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  const byShortId = new Map(candidates.map(candidate => [candidate.shortId, candidate]));
  const seen = new Set<string>();
  const out: Array<Omit<StaleAuditItem, "title" | "content" | "meta" | "fingerprint">> = [];
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const shortId = typeof row.id === "string" ? row.id.trim().toUpperCase() : "";
    const candidate = byShortId.get(shortId);
    if (!candidate || seen.has(candidate.id)) continue;
    const verdict = typeof row.verdict === "string" ? row.verdict.trim().toUpperCase() : "";
    if (verdict !== "CONTRADICTED" && verdict !== "OBSOLETE") continue;
    const reason = typeof row.reason === "string" ? clipText(row.reason, REASON_MAX) : "";
    if (!reason) continue;
    const rawConfidence = typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : 0.6;
    const confidence = Math.min(1, Math.max(0, rawConfidence));
    // 低分项不进列表：模型自己也说拿不准的东西，摆出来只会让人逐条划掉。
    if (confidence < 0.65) continue;
    // 忆泡是历史记录；长期记忆的 EVENT 是分类，不是候选 kind。
    if (verdict === "OBSOLETE" && (candidate.kind === "EVENT"
      || (candidate.kind === "MEMORY" && (candidate.category === "RELATIONSHIP"
        || candidate.category === "PREFERENCE" || candidate.category === "EVENT")))) continue;
    seen.add(candidate.id);
    out.push({
      kind: candidate.kind,
      id: candidate.id,
      verdict,
      reason,
      confidence,
    });
  }
  return out;
}
