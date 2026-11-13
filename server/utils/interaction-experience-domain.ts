import { createError } from "h3";

export function interactionExperienceText(value: unknown, name: string, max = 400): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw createError({ statusCode: 400, statusMessage: `${name}不能为空且不能超过${max}字。` });
  return value.trim();
}
export function validateInteractionEvidence(assistant: { role: string; conversationId: string; occurredAt: Date }, feedback: { role: string; conversationId: string; occurredAt: Date }) {
  if (assistant.role !== "ASSISTANT" || feedback.role !== "USER" || assistant.conversationId !== feedback.conversationId || feedback.occurredAt.getTime() <= assistant.occurredAt.getTime()) throw createError({ statusCode: 400, statusMessage: "必须选择同一会话中助手回复及其后的用户明确反馈。" });
}
export function interactionExperienceWeight(createdAt: Date, now = new Date()): number {
  return Math.pow(0.5, Math.max(0, now.getTime() - createdAt.getTime()) / (7 * 86400000));
}
export function interactionExperienceNextStatus(status: string, operation: string): string {
  if (operation === "ACCEPT" && status === "PENDING") return "ACTIVE";
  if (operation === "REJECT" && status === "PENDING") return "REJECTED";
  if (operation === "DISABLE" && status === "ACTIVE") return "DISABLED";
  if (operation === "EDIT" && ["ACTIVE", "PENDING", "DISABLED"].includes(status)) return status;
  throw createError({ statusCode: 409, statusMessage: "当前状态不允许此操作。" });
}

export const EXPERIENCE_KINDS = ["UNDERSTANDING", "REFERENCE", "SITUATION", "STRATEGY", "EXPRESSION"] as const;
export type ExperienceKind = typeof EXPERIENCE_KINDS[number];
export type ExperienceLearning = { kind: ExperienceKind; situation: string; misunderstanding: string; correction: string; nextJudgment: string };
export function readExperienceLearning(value: unknown): ExperienceLearning | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!(EXPERIENCE_KINDS as readonly unknown[]).includes(row.kind)) return null;
  for (const field of ["situation", "correction", "nextJudgment"]) {
    if (typeof row[field] !== "string" || !row[field].trim() || row[field].length > 400) return null;
  }
  if (typeof row.misunderstanding !== "string" || row.misunderstanding.length > 400) return null;
  return { kind: row.kind as ExperienceKind, situation: String(row.situation).trim(), misunderstanding: row.misunderstanding.trim(), correction: String(row.correction).trim(), nextJudgment: String(row.nextJudgment).trim() };
}
/** Small deterministic intent families; not a semantic model or blanket always-on injection. */
export function experienceSituationSignals(query: string): Set<string> {
  const signals = new Set<string>();
  const groups: Array<[string, RegExp]> = [
    ["emotion", /难受|难过|心烦|委屈|烦死|累了|不开心|倾诉|听我说|陪我|安慰|发泄|吐槽/u],
    ["advice", /建议|方案|怎么办|怎么做|帮我想|解决|分析|出主意/u],
    ["reference", /他|她|他们|她们|别人|那个人|另一个|谁|指的|说的是/u],
    ["joke", /玩笑|开玩笑|逗你|调侃|打趣|当真/u],
    ["public", /群里|群聊|公开|大家|场合|插话|接话/u],
    ["expression", /太长|简短|说重点|先说结论|先给结论|啰嗦|语气|客服|措辞/u],
  ];
  for (const [key, pattern] of groups) if (pattern.test(query)) signals.add(key);
  return signals;
}
export function experienceSituationMatch(learning: ExperienceLearning | null, query: string): number {
  if (!learning) return 0;
  const current = experienceSituationSignals(query);
  const source = experienceSituationSignals(`${learning.situation} ${learning.correction} ${learning.nextJudgment}`);
  const shared = [...current].filter(signal => source.has(signal));
  // Generic pronouns alone must not awaken every reference card.
  if (shared.length === 1 && shared[0] === "reference") return 0;
  return shared.length ? Math.min(1, shared.length / 2 + 0.25) : 0;
}
