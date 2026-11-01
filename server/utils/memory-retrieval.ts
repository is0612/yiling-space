export type RankedCandidate<T> = T & {
  relevanceScore: number;
  matchedTerms: string[];
};

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

const ENGLISH_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "about", "be", "been", "before", "but", "by", "can", "did",
  "discuss", "discussed", "do", "earlier", "for", "from", "how", "i", "in", "is", "it", "like",
  "liked", "likes", "love", "loved", "loves", "me", "my", "of", "on", "or", "our", "please",
  "previously", "remember", "remembered", "talk", "talked", "tell", "the", "their", "them", "they",
  "this", "that", "to", "told", "was", "we", "what", "when", "where", "which", "who", "why", "with",
  "you", "your",
]);

// These are query-intent words, not usually the topic the user wants to retrieve.
const CJK_INTENT_STOPWORDS = [
  "我想知道", "我想问", "告诉我", "帮我", "请问", "有没有", "是不是", "为什么",
  "怎么样", "怎么样了", "如何", "怎么", "怎样", "哪个", "哪些", "什么", "用户",
  "角色", "我们", "你们", "他们", "她们", "它们", "之前", "以后", "后来", "目前",
  "现在", "那个", "这个", "这些", "那些", "一下", "已经", "喜欢", "讨论", "聊过",
  "说过", "提到", "谈过", "有关", "关于", "可以", "是否", "就是", "不是", "然后",
  "因为", "所以", "但是", "如果", "以及", "还有", "记忆",
].sort((left, right) => right.length - left.length);

const CJK_CONNECTORS = new Set(["和", "与", "及", "跟"]);

function splitCjkIntent(run: string): string[] {
  let segments = [run];
  for (const stopword of CJK_INTENT_STOPWORDS) {
    segments = segments.flatMap((segment) => segment.split(stopword));
  }

  // Split short conjunctions only when they join two multi-character topic phrases.
  // This avoids treating words such as “和平” as a conjunction.
  return segments.flatMap((segment) => {
    const pieces: string[] = [];
    let start = 0;
    for (let index = 0; index < segment.length; index += 1) {
      if (
        CJK_CONNECTORS.has(segment[index] ?? "") &&
        index - start >= 2 &&
        segment.length - index - 1 >= 2
      ) {
        pieces.push(segment.slice(start, index));
        start = index + 1;
      }
    }
    pieces.push(segment.slice(start));
    return pieces.filter(Boolean);
  });
}

export function extractRetrievalTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set<string>();

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    if (!ENGLISH_STOPWORDS.has(match[0])) terms.add(match[0]);
  }

  const cjkRuns = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    for (const segment of splitCjkIntent(run)) {
      if (!segment) continue;
      // Keep a complete short phrase as a high-value signal, in addition to n-grams.
      if (segment.length >= 2 && segment.length <= 8) terms.add(segment);
      for (const size of [3, 2]) {
        for (let index = 0; index <= segment.length - size; index += 1) {
          terms.add(segment.slice(index, index + size));
        }
      }
    }
  }

  // Bound term extraction so unusually long messages cannot trigger unbounded scoring work.
  return [...terms].slice(0, 160);
}

function dateValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return 0;
}

function termLengthWeight(term: string): number {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)) {
    if (term.length >= 5) return 1.7;
    if (term.length === 4) return 1.55;
    if (term.length === 3) return 1.3;
    if (term.length === 2) return 1;
    return 0.6;
  }
  return Math.min(1.8, 1.1 + term.length * 0.08);
}

function rankCandidates<T extends { id: string }>(
  query: string,
  candidates: T[],
  textOf: (candidate: T) => string,
  recencyOf: (candidate: T) => unknown,
  limit: number,
): RankedCandidate<T>[] {
  const terms = extractRetrievalTerms(query);
  if (!terms.length || limit <= 0) return [];

  const normalizedQuery = normalizeComparable(query);
  const prepared = candidates.map((candidate) => ({
    candidate,
    normalizedText: normalizeComparable(textOf(candidate)),
    recency: dateValue(recencyOf(candidate)),
  }));

  // IDF within the current candidate set dampens generic terms shared by many records.
  const termWeights = new Map(terms.map((term) => {
    const normalizedTerm = normalizeComparable(term);
    const documentFrequency = prepared.reduce(
      (count, entry) => count + (entry.normalizedText.includes(normalizedTerm) ? 1 : 0),
      0,
    );
    const inverseDocumentFrequency = Math.log(1 + (prepared.length + 1) / (documentFrequency + 1));
    return [term, termLengthWeight(term) * inverseDocumentFrequency] as const;
  }));
  const totalWeight = [...termWeights.values()].reduce((sum, weight) => sum + weight, 0);

  const ranked = prepared
    .map((entry) => {
      const matchedTerms = terms.filter((term) =>
        entry.normalizedText.includes(normalizeComparable(term)),
      );
      const matchedWeight = matchedTerms.reduce((sum, term) => sum + (termWeights.get(term) ?? 0), 0);
      const weightedCoverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      const exactPhraseBonus = normalizedQuery.length >= 2 && entry.normalizedText.includes(normalizedQuery) ? 5 : 0;
      const score = weightedCoverage * 10 + exactPhraseBonus + Math.min(matchedTerms.length, 4) * 0.05;
      return {
        candidate: entry.candidate,
        score,
        matchedTerms,
        recency: entry.recency,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.recency - left.recency ||
      left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, limit);

  return ranked.map((entry) => ({
    ...entry.candidate,
    relevanceScore: Math.round(entry.score * 100) / 100,
    matchedTerms: entry.matchedTerms,
  }));
}

export function rankMemoryCandidates<T extends { id: string; content: string; updatedAt?: unknown; createdAt?: unknown }>(
  query: string,
  memories: T[],
  limit = 8,
): RankedCandidate<T>[] {
  return rankCandidates(query, memories, (memory) => memory.content, (memory) => memory.updatedAt ?? memory.createdAt, limit);
}

export function rankSnapshotCandidates<T extends { id: string; summary: string; createdAt?: unknown; periodEnd?: unknown }>(
  query: string,
  snapshots: T[],
  limit = 4,
): RankedCandidate<T>[] {
  return rankCandidates(query, snapshots, (snapshot) => snapshot.summary, (snapshot) => snapshot.createdAt ?? snapshot.periodEnd, limit);
}

// ── token 预算与衰减 ─────────────────────────────────────────
//
// 为什么需要：此前是「按相关度取 top-8 条记忆 + top-4 个快照」的硬截断。
// 两个问题：① 每条长度不受控，8 条长记忆 + 4 篇 3000 字快照能把提示词直接撑爆；
// ② 截断是无声的，没有任何地方能看出「有一条更该进来的记忆被挤掉了」。
// 现在改成按 token 预算装配，并给排序加时间衰减 —— 旧记忆不是被硬删，是慢慢变淡。

export const MEMORY_TOKEN_BUDGET_DEFAULT = 1800;
export const SNAPSHOT_TOKEN_BUDGET_DEFAULT = 2500;
export const MEMORY_HALF_LIFE_DAYS_DEFAULT = 30;
/**
 * 一次回复回看多少条已落库消息。
 *
 * 40 条在桌面端约等于 20 轮问答；群里一轮就有三五条，同样的 40 条只覆盖几轮，
 * 所以群聊侧可以单独调大。上限压住是必要的：再多除了烧 token，模型还会「中间失忆」。
 */
export const RECENT_MESSAGE_LIMIT_DEFAULT = 40;
export const RECENT_MESSAGE_LIMIT_MIN = 20;
export const RECENT_MESSAGE_LIMIT_MAX = 200;

export type MemoryBudgetOptions = {
  /** 最多注入几条。0 或不传 = 不按条数限制，只受 token 预算约束。 */
  limit?: number;
  /** token 预算。0 = 不限制。 */
  tokenBudget?: number;
  /** 新鲜度半衰期（天）：越久没被用到，权重越低。 */
  halfLifeDays?: number;
  now?: number;
};

export type RankedMemory<T> = RankedCandidate<T> & {
  /** 相关度 × 重要度 × 衰减 × 召回加成之后的最终排序分。 */
  finalScore: number;
  /** 0..1，1 = 刚用过。 */
  decay: number;
  /** 估算 token 数。 */
  tokens: number;
};

export type BudgetedRank<T> = {
  items: RankedMemory<T>[];
  /** 有相关度、但被预算或条数挤掉的数量。 */
  dropped: number;
  usedTokens: number;
};

/**
 * 粗估 token：中文 1 字 ≈ 1 token，其他 4 字符 ≈ 1 token。
 * 宁可高估 —— 低估会让提示词在真实模型那里被截断，而截断是静默的。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  const cjkCount = cjk ? cjk.length : 0;
  const otherCount = text.length - cjkCount;
  return Math.max(1, cjkCount + Math.ceil(otherCount / 4));
}

function clamp01(value: unknown, fallback = 0.5): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** 半衰期式衰减：30 天半衰期下，一条 30 天没被碰过的记忆权重降到 0.5。 */
function decayFactor(recencyMs: number, nowMs: number, halfLifeDays: number): number {
  if (!recencyMs) return 0.5;
  const ageDays = Math.max(0, (nowMs - recencyMs) / 86_400_000);
  return Math.exp(-ageDays * Math.LN2 / Math.max(1, halfLifeDays));
}

function selectWithBudget<T extends { id: string }>(
  ranked: Array<RankedCandidate<T> & { finalScore: number; decay: number }>,
  textOf: (candidate: T) => string,
  options: MemoryBudgetOptions,
): BudgetedRank<T> {
  const limit = options.limit && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;
  const budget = options.tokenBudget && options.tokenBudget > 0 ? options.tokenBudget : 0;

  const items: RankedMemory<T>[] = [];
  let usedTokens = 0;
  let dropped = 0;

  for (const entry of ranked) {
    if (items.length >= limit) {
      dropped += 1;
      continue;
    }
    const tokens = estimateTokens(textOf(entry));
    // 预算不够时跳过，但第一条永远放行：否则一个有相关命中的问题会变成「她什么都不记得」。
    const overBudget = budget > 0 && usedTokens + tokens > budget;
    if (overBudget && items.length > 0) {
      dropped += 1;
      continue;
    }
    usedTokens += tokens;
    items.push({ ...entry, tokens });
  }

  return { items, dropped, usedTokens };
}

export function rankMemoriesWithBudget<
  T extends {
    id: string; content: string; importance?: unknown; recallCount?: unknown;
    lastRecalledAt?: unknown; updatedAt?: unknown; createdAt?: unknown;
  },
>(query: string, memories: T[], options: MemoryBudgetOptions = {}): BudgetedRank<T> {
  const now = options.now ?? Date.now();
  const halfLife = options.halfLifeDays && options.halfLifeDays > 0
    ? options.halfLifeDays
    : MEMORY_HALF_LIFE_DAYS_DEFAULT;

  // 先拿到全量相关度排序（不截断），再按衰减重排 —— 相关但不是"最近"的记忆仍有基础分。
  const scored = rankCandidates(
    query,
    memories,
    (memory) => memory.content,
    (memory) => memory.lastRecalledAt ?? memory.updatedAt ?? memory.createdAt,
    memories.length,
  );

  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const rescored = scored.map((entry) => {
    const source = byId.get(entry.id);
    const decay = decayFactor(
      dateValue(source?.lastRecalledAt ?? source?.updatedAt ?? source?.createdAt),
      now,
      halfLife,
    );
    const importance = clamp01(source?.importance);
    const recallCount = typeof source?.recallCount === "number" ? source.recallCount : 0;
    // 衰减下限 0.55：重要的旧事不该因为"很久没提"就彻底消失，只是排得靠后。
    const finalScore = entry.relevanceScore
      * (0.55 + 0.45 * importance)
      * (0.55 + 0.45 * decay)
      * (1 + Math.min(recallCount, 10) * 0.03);
    return { ...entry, finalScore: Math.round(finalScore * 1000) / 1000, decay: Math.round(decay * 1000) / 1000 };
  });

  rescored.sort((left, right) => right.finalScore - left.finalScore || right.relevanceScore - left.relevanceScore);
  return selectWithBudget(rescored, (memory) => memory.content, options);
}

export function rankSnapshotsWithBudget<
  T extends { id: string; summary: string; createdAt?: unknown; periodEnd?: unknown },
>(query: string, snapshots: T[], options: MemoryBudgetOptions = {}): BudgetedRank<T> {
  const now = options.now ?? Date.now();
  const halfLife = options.halfLifeDays && options.halfLifeDays > 0
    ? options.halfLifeDays
    : MEMORY_HALF_LIFE_DAYS_DEFAULT;

  const scored = rankCandidates(
    query,
    snapshots,
    (snapshot) => snapshot.summary,
    (snapshot) => snapshot.createdAt ?? snapshot.periodEnd,
    snapshots.length,
  );

  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const rescored = scored.map((entry) => {
    const source = byId.get(entry.id);
    const decay = decayFactor(dateValue(source?.createdAt ?? source?.periodEnd), now, halfLife);
    // 快照表没有 importance 字段：周期总结本身就是"被提炼过的重要事"，固定按 0.6 算。
    const finalScore = entry.relevanceScore * (0.55 + 0.45 * 0.6) * (0.55 + 0.45 * decay);
    return { ...entry, finalScore: Math.round(finalScore * 1000) / 1000, decay: Math.round(decay * 1000) / 1000 };
  });

  rescored.sort((left, right) => right.finalScore - left.finalScore || right.relevanceScore - left.relevanceScore);
  return selectWithBudget(rescored, (snapshot) => snapshot.summary, options);
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** 记忆预算从角色 modelConfig 读，缺省 1200 token。 */
export function resolveMemoryTokenBudget(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positiveNumber(record.memoryTokenBudget) || MEMORY_TOKEN_BUDGET_DEFAULT;
}

/** 快照预算单独一份：一篇周期总结动辄两三千字，和记忆条目抢同一个池子会互相饿死。 */
export function resolveSnapshotTokenBudget(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positiveNumber(record.snapshotTokenBudget) || SNAPSHOT_TOKEN_BUDGET_DEFAULT;
}

/** 记忆注入条数上限（防止一堆短句把提示词塞满）。 */
export function resolveMemoryItemLimit(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positiveNumber(record.memoryItemLimit) || 12;
}

/**
 * 最近对话回看条数。
 *
 * 页面只让人填「条」，token 不暴露 —— 但值和范围都要夹住：太小接不上话，
 * 太大既烧钱又会让真正相关的几句被稀释。写入侧已校验，这里再兜一层，
 * 因为渠道和 Worker 可能不走同一个入口。
 */
export function resolveRecentMessageLimit(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  const raw = record.recentMessageLimit;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return RECENT_MESSAGE_LIMIT_DEFAULT;
  return Math.min(RECENT_MESSAGE_LIMIT_MAX, Math.max(RECENT_MESSAGE_LIMIT_MIN, Math.round(value)));
}
