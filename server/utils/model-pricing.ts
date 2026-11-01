/**
 * 模型单价与花费估算。
 *
 * 这里只做估算，不是对账系统：
 * - 输入 token 分「缓存命中」和「未命中」两档计价。DeepSeek 命中价只有未命中价的 1/30，
 *   群聊场景同一段上下文反复发送，命中率通常很高；不分开算会高估两三倍
 *   （2026-10-30 实测：按全未命中估 0.99 元，供应商账单 0.34 元）。
 *   历史行没有缓存明细时只能按未命中价算，结果偏高，页面上必须说明。
 * - DeepSeek 是分时定价（高峰时段贵一倍），所以计价必须带上调用时间，不能用当天统一单价。
 * - 认不出的模型返回 null。上层要显示「未定价」，既不能当 0 元，也不能拿别的模型的价格硬套。
 */

export type ModelCurrency = "CNY" | "USD";

export type ModelPrice = {
  currency: ModelCurrency;
  /** 每百万 token 的输入价（缓存未命中）。 */
  input: number;
  /** 每百万 token 的输出价。 */
  output: number;
  /** 每百万 token 的缓存命中输入价；缺省表示这家不区分缓存，按 input 算。 */
  cacheHitInput?: number;
  /** 分时定价的高峰价；缺省表示这家不分时段。 */
  peakInput?: number;
  peakOutput?: number;
  peakCacheHitInput?: number;
};

export type ModelUsageTokensLike = {
  promptTokens: number;
  completionTokens: number;
  /** 缓存命中的输入 token；没有这个字段就是「未知」，按未命中价算。 */
  cacheHitTokens?: number;
};

/**
 * 内置参考价，单位「元（或美元）/ 百万 token」。
 * 最后核对：2026-10-30，DeepSeek 官方价（2026-08-17 生效，空闲/高峰两档），
 * gpt / claude 为各家公开价（美元）。厂商调价后请用 MODEL_PRICING 覆盖，不要改这里的历史值来"修正"过去的花费。
 */
export const BUILTIN_MODEL_PRICES: Record<string, ModelPrice> = {
  // DeepSeek V4.1-Flash：空闲 1.5 / 4.5 元、命中 0.05 元；高峰 3 / 9 元、命中 0.1 元。旧模型名仍按 Flash 计费。
  "deepseek-flash": { currency: "CNY", input: 1.5, output: 4.5, cacheHitInput: 0.05, peakInput: 3, peakOutput: 9, peakCacheHitInput: 0.1 },
  "deepseek-v4-flash": { currency: "CNY", input: 1.5, output: 4.5, cacheHitInput: 0.05, peakInput: 3, peakOutput: 9, peakCacheHitInput: 0.1 },
  "deepseek-v4-flash-vision-exp": { currency: "CNY", input: 1.5, output: 4.5, cacheHitInput: 0.05, peakInput: 3, peakOutput: 9, peakCacheHitInput: 0.1 },
  "deepseek-v4.1-flash": { currency: "CNY", input: 1.5, output: 4.5, cacheHitInput: 0.05, peakInput: 3, peakOutput: 9, peakCacheHitInput: 0.1 },
  // DeepSeek V4-Pro：空闲 4.5 / 13.5 元、命中 0.15 元；高峰 9 / 27 元、命中 0.3 元。
  "deepseek-v4-pro": { currency: "CNY", input: 4.5, output: 13.5, cacheHitInput: 0.15, peakInput: 9, peakOutput: 27, peakCacheHitInput: 0.3 },
  "deepseek-pro": { currency: "CNY", input: 4.5, output: 13.5, cacheHitInput: 0.15, peakInput: 9, peakOutput: 27, peakCacheHitInput: 0.3 },
  // OpenAI（缓存命中价 = 输入价的 50%）
  "gpt-4o-mini": { currency: "USD", input: 0.15, output: 0.6, cacheHitInput: 0.075 },
  "gpt-4o": { currency: "USD", input: 2.5, output: 10, cacheHitInput: 1.25 },
  "o4-mini": { currency: "USD", input: 1.1, output: 4.4, cacheHitInput: 0.275 },
  // Anthropic（缓存读取价 = 输入价的 10%）
  "claude-3-5-haiku": { currency: "USD", input: 0.8, output: 4, cacheHitInput: 0.08 },
  "claude-3-5-sonnet": { currency: "USD", input: 3, output: 15, cacheHitInput: 0.3 },
  "claude-sonnet-4": { currency: "USD", input: 3, output: 15, cacheHitInput: 0.3 },
};

const DEFAULT_USD_CNY_RATE = 7.2;

/** 环境变量里的覆盖表解析结果缓存：同一次进程里 MODEL_PRICING 不变就不重复解析。 */
let overrideCache: { raw: string; prices: Record<string, ModelPrice> } | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 模型名统一成小写去空格：`DeepSeek-V4-Flash` 与 `deepseek-v4-flash` 是同一档价。 */
function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

function readPriceEntry(key: string, value: unknown): ModelPrice | null {
  const entry = asRecord(value);
  const input = nonNegativeNumber(entry.input);
  const output = nonNegativeNumber(entry.output);
  if (input === null || output === null) return null;
  const currency = entry.currency === "USD" ? "USD" : "CNY";
  const cacheHitInput = nonNegativeNumber(entry.cacheHitInput);
  const peakInput = nonNegativeNumber(entry.peakInput);
  const peakOutput = nonNegativeNumber(entry.peakOutput);
  const peakCacheHitInput = nonNegativeNumber(entry.peakCacheHitInput);
  // 分时价必须凑齐两个，否则高峰时段只换了一半的价，账单会莫名其妙。
  const hasPeak = peakInput !== null && peakOutput !== null;
  if (!key) return null;
  return {
    currency,
    input,
    output,
    ...(cacheHitInput !== null ? { cacheHitInput } : {}),
    ...(hasPeak ? { peakInput, peakOutput } : {}),
    ...(hasPeak && peakCacheHitInput !== null ? { peakCacheHitInput } : {}),
  };
}

/** `MODEL_PRICING='{"my-model":{"input":2,"output":8}}'`；格式坏的条目直接丢掉，不让一个笔误把整个总览弄挂。 */
export function parsePricingOverrides(raw: string | undefined): Record<string, ModelPrice> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  if (overrideCache && overrideCache.raw === text) return overrideCache.prices;
  const prices: Record<string, ModelPrice> = {};
  try {
    const parsed = asRecord(JSON.parse(text));
    for (const [key, value] of Object.entries(parsed)) {
      const price = readPriceEntry(normalizeModelName(key), value);
      if (price) prices[normalizeModelName(key)] = price;
    }
  } catch {
    // 坏 JSON 也进缓存：否则每一条用量行都会再打印一次同样的警告。
    overrideCache = { raw: text, prices: {} };
    console.warn("[pricing] MODEL_PRICING 不是合法 JSON，已忽略。");
    return {};
  }
  overrideCache = { raw: text, prices };
  return prices;
}

export function resolveUsdCnyRate(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.USD_CNY_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_USD_CNY_RATE;
}

/**
 * 先精确匹配，再退化成「包含关系里的最长键」：
 * `deepseek-ai/DeepSeek-V4-Flash` 能落到 flash，`gpt-4o-mini` 不会被 `gpt-4o` 抢走。
 */
export function resolveModelPrice(
  model: string,
  env: Record<string, string | undefined> = process.env,
): ModelPrice | null {
  const name = normalizeModelName(model);
  if (!name) return null;

  const overrides = parsePricingOverrides(env.MODEL_PRICING);
  if (overrides[name]) return overrides[name];
  const table = { ...BUILTIN_MODEL_PRICES, ...overrides };
  if (table[name]) return table[name];

  let matchedKey = "";
  for (const key of Object.keys(table)) {
    if (name.includes(key) && key.length > matchedKey.length) matchedKey = key;
  }
  return matchedKey ? table[matchedKey] ?? null : null;
}

/**
 * DeepSeek 的高峰时段：北京时间 9:00–12:00、14:00–18:00，周一到周五，其余为空闲价。
 * 用东八区固定偏移算，和 `usageDayKey` 的「今天」是同一个时区。
 */
export function isPeakHour(at: Date): boolean {
  const shifted = new Date(at.getTime() + 8 * 60 * 60 * 1000);
  const weekday = shifted.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/**
 * 单次调用的估算花费，单位元，保留 6 位小数（一次调用常常只有几厘钱）。
 *
 * 命中缓存的输入按 `cacheHitInput` 计价，其余按未命中价；没有缓存明细（`cacheHitTokens` 为 undefined）
 * 时全部按未命中价 —— 这条规则决定了「历史数据偏高、新数据才准」，别在汇总处再做二次修正。
 */
export function estimateUsageCostCny(
  price: ModelPrice,
  tokens: ModelUsageTokensLike,
  at: Date,
  usdCnyRate: number = resolveUsdCnyRate(),
): number {
  const peak = isPeakHour(at) && price.peakInput !== undefined && price.peakOutput !== undefined;
  const inputRate = peak ? price.peakInput! : price.input;
  const outputRate = peak ? price.peakOutput! : price.output;
  const hitRate = peak
    ? price.peakCacheHitInput ?? price.cacheHitInput ?? inputRate
    : price.cacheHitInput ?? inputRate;
  const promptTokens = Math.max(0, tokens.promptTokens);
  const completionTokens = Math.max(0, tokens.completionTokens);
  // 供应商偶尔会把命中数报得比 prompt 总量还大（重试/代理改写），夹到合理范围再算。
  const hitTokens = Math.min(promptTokens, Math.max(0, tokens.cacheHitTokens ?? 0));
  const missTokens = promptTokens - hitTokens;
  const raw = (missTokens / 1_000_000) * inputRate
    + (hitTokens / 1_000_000) * hitRate
    + (completionTokens / 1_000_000) * outputRate;
  const cny = price.currency === "USD" ? raw * usdCnyRate : raw;
  return Math.round(cny * 1_000_000) / 1_000_000;
}
