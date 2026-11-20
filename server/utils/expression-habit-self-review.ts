import { createError } from "h3";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { buildChatCompletionsEndpoint, resolveChatModelSettings } from "./chat-model-config";
import { resolveCharacterApiKey } from "./credential-encryption";
import { parseJsonLoose } from "./loose-json";
import { readDailyQuota, readModelUsage, recordModelUsage } from "./model-usage";
import { updateExpressionHabit } from "./expression-habits";

/** She may settle at most this many candidates per day; it is a ceiling, not a target. */
export const SELF_REVIEW_DAILY_LIMIT = 5;
const MAX_CANDIDATES = SELF_REVIEW_DAILY_LIMIT;

export type SelfReviewCandidate = { id: string; revision: number; kind: string; content: string; context: string; reason: string; sourceType: string };

/** Day boundary follows the same +08:00 day used for token quotas. */
export function selfReviewDayStart(now = new Date()) {
  const key = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(now);
  return new Date(`${key}T00:00:00+08:00`);
}

export function selfReviewMessages(name: string, persona: string, candidates: SelfReviewCandidate[]) {
  return [
    { role: "system", content: `你是「${name}」，现在自己整理对话中关于「你怎么说话」的候选习惯。\n${persona.slice(0, 4000)}\n\n判断标准：只保留真正属于你自己语气、用词或句子长短的倾向，并且能由给出的理由支持；一次性口误、附和、模仿别人、或者关于喜好和话题的内容都不要。来源可能出错，宁可不要。\n对每条候选给出 ACCEPT 或 REJECT，并写一句你自己的理由（不超过 60 字）。\n只返回 JSON：{"decisions":[{"id":"候选id","decision":"ACCEPT|REJECT","reason":"理由"}]}。不要返回其他字段，不要漏掉任何一条。` },
    { role: "user", content: JSON.stringify({ candidates: candidates.map(({ id, kind, content, context, reason }) => ({ id, kind, content, context, reason })) }) },
  ];
}

/** Strict on purpose: an unknown id, a missing candidate or an invented decision drops the whole batch. */
export function parseSelfReviewDecisions(text: string, candidates: SelfReviewCandidate[]) {
  const parsed = parseJsonLoose(text, { expect: "object" });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SELF_REVIEW_INVALID");
  const rows = (parsed as Record<string, unknown>).decisions;
  if (!Array.isArray(rows)) throw new Error("SELF_REVIEW_INVALID");
  const byId = new Map(candidates.map(row => [row.id, row]));
  const seen = new Set<string>();
  const decisions: Array<{ candidate: SelfReviewCandidate; accept: boolean; reason: string }> = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") throw new Error("SELF_REVIEW_INVALID");
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const candidate = byId.get(id);
    if (!candidate || seen.has(id)) throw new Error("SELF_REVIEW_INVALID");
    if (row.decision !== "ACCEPT" && row.decision !== "REJECT") throw new Error("SELF_REVIEW_INVALID");
    const reason = typeof row.reason === "string" ? row.reason.trim().slice(0, 120) : "";
    if (!reason) throw new Error("SELF_REVIEW_INVALID");
    seen.add(id);
    decisions.push({ candidate, accept: row.decision === "ACCEPT", reason });
  }
  return decisions;
}

export async function countSelfReviewedToday(prisma: PrismaClient, characterId: string) {
  return prisma.characterExpressionHabit.count({
    where: { characterId, reviewedBy: "SELF", reviewedAt: { gte: selfReviewDayStart() } },
  });
}

/**
 * She reviews her own pending habits: one model call, then each decision goes through the exact same
 * activation path the owner would use, so every existing source check still applies.
 */
export async function runExpressionHabitSelfReview(prisma: PrismaClient, input: { ownerId: string; characterId: string }) {
  const character = await prisma.character.findFirst({ where: { id: input.characterId, ownerId: input.ownerId }, select: { name: true, basePrompt: true, modelConfig: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const used = await countSelfReviewedToday(prisma, input.characterId);
  const remaining = Math.max(0, SELF_REVIEW_DAILY_LIMIT - used);
  if (remaining === 0) return { reviewed: [], remaining: 0, skipped: "daily_limit" as const };

  const candidates = await prisma.characterExpressionHabit.findMany({
    where: { characterId: input.characterId, status: "PENDING", sourceRefs: { not: [] } },
    orderBy: [{ updatedAt: "asc" }], take: Math.min(remaining, MAX_CANDIDATES),
    select: { id: true, revision: true, kind: true, content: true, context: true, reason: true, sourceType: true },
  });
  if (!candidates.length) return { reviewed: [], remaining, skipped: "no_candidates" as const };

  const settings = resolveChatModelSettings(character.modelConfig);
  const apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);
  if (!settings.model || !settings.apiKeyConfigured || !apiKey) throw createError({ statusCode: 503, statusMessage: "请先配置当前角色的聊天模型。" });
  if ((await readDailyQuota(input.characterId, character.modelConfig)).exceeded) throw createError({ statusCode: 429, statusMessage: "当前角色今日模型额度已用完。" });

  let usage: ReturnType<typeof readModelUsage> = null;
  let success = false;
  try {
    const response = await fetch(buildChatCompletionsEndpoint(settings.apiBaseUrl), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: settings.model, temperature: 0.2, max_tokens: 2048, response_format: { type: "json_object" },
        messages: selfReviewMessages(character.name, character.basePrompt ?? "", candidates) }),
    });
    if (!response.ok) throw new Error("Provider failure");
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    usage = readModelUsage(payload);
    const decisions = parseSelfReviewDecisions(payload.choices?.[0]?.message?.content ?? "", candidates);

    const reviewed: Array<{ id: string; status: string }> = [];
    for (const decision of decisions) {
      try {
        const { habit } = await updateExpressionHabit(prisma, {
          ownerId: input.ownerId, characterId: input.characterId, habitId: decision.candidate.id,
          body: { expectedRevision: decision.candidate.revision, operation: decision.accept ? "ACTIVATE" : "REJECT" },
          reviewedBy: "SELF",
        });
        reviewed.push({ id: habit.id, status: habit.status });
      } catch {
        // A single stale or invalid candidate must not abort the others; it simply stays pending.
      }
    }
    success = true;
    return { reviewed, remaining: Math.max(0, remaining - reviewed.length), skipped: null };
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    throw createError({ statusCode: 502, statusMessage: "她自己审核失败，请检查模型配置或稍后重试。" });
  } finally {
    await recordModelUsage({ characterId: input.characterId, kind: "other", model: settings.model, usage,
      metadata: { source: "expression-habit-self-review", status: success ? "success" : "failed" },
    }).catch(() => undefined);
  }
}
