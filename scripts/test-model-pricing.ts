import assert from "node:assert/strict";
import {
  BUILTIN_MODEL_PRICES,
  estimateUsageCostCny,
  isPeakHour,
  parsePricingOverrides,
  resolveModelPrice,
  resolveUsdCnyRate,
} from "../server/utils/model-pricing";
import { readModelUsage, summarizeUsageRows, toUsageTokens, usageDayWindow } from "../server/utils/model-usage";

// ── 缓存明细解析 ────────────────────────────────────────────
const deepseekUsage = readModelUsage({
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 200,
  },
});
assert.equal(deepseekUsage?.cacheHitTokens, 800, "DeepSeek 的 prompt_cache_hit_tokens 要记住。");
assert.equal(deepseekUsage?.cacheMissTokens, 200, "未命中数要记住。");

const openaiUsage = readModelUsage({
  usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, prompt_tokens_details: { cached_tokens: 320 } },
});
assert.equal(openaiUsage?.cacheHitTokens, 320, "OpenAI 兼容层的 cached_tokens 也要认。");
assert.equal(openaiUsage?.cacheMissTokens, 180, "没给未命中数时用 prompt - 命中补出来。");

const noCacheDetail = readModelUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
assert.equal(noCacheDetail?.cacheHitTokens, undefined, "供应商没回传缓存明细时要留 undefined，不能写成 0。");
assert.equal(toUsageTokens({ promptTokens: 100, cacheHitTokens: 60 })?.cacheMissTokens, 40, "宽松输入也要补未命中数。");
assert.equal(toUsageTokens({ promptTokens: 100 })?.cacheHitTokens, undefined, "没有缓存字段时不臆造命中。");

// ── 价目表匹配 ──────────────────────────────────────────────
const flash = resolveModelPrice("deepseek-flash", {});
assert.equal(flash?.currency, "CNY", "DeepSeek 用人民币计价。");
assert.equal(flash?.input, 1.5, "空闲时段输入价 1.5 元/百万。");
assert.equal(flash?.output, 4.5, "空闲时段输出价 4.5 元/百万。");
assert.equal(flash?.peakInput, 3, "高峰输入价 3 元/百万。");
assert.equal(flash?.peakOutput, 9, "高峰输出价 9 元/百万。");

assert.deepEqual(resolveModelPrice("DeepSeek-V4.1-Flash", {}), flash, "模型名大小写不敏感，别名要落回同一档价。");
assert.deepEqual(resolveModelPrice("deepseek-ai/DeepSeek-V4-Flash", {}), flash, "带厂商前缀的模型名要按包含关系匹配。");

const mini = resolveModelPrice("gpt-4o-mini", {});
assert.equal(mini?.currency, "USD", "OpenAI 按美元计价。");
assert.equal(mini?.input, 0.15, "gpt-4o-mini 不能被 gpt-4o 抢走：取最长匹配。");

assert.equal(resolveModelPrice("totally-unknown-model", {}), null, "认不出的模型返回 null，不猜价。");
assert.equal(resolveModelPrice("", {}), null, "空模型名没有价格。");

// ── 覆盖表 ──────────────────────────────────────────────────
const overrides = parsePricingOverrides('{"my-model":{"input":2,"output":8},"broken":{"input":"x"}}');
assert.equal(overrides["my-model"]?.output, 8, "覆盖表里合法的条目要生效。");
assert.equal(overrides.broken, undefined, "字段类型不对的条目要丢掉，不能带进计价。");
assert.deepEqual(parsePricingOverrides("not-json"), {}, "JSON 写坏时退化成空表，不能抛错。");

const overridden = resolveModelPrice("deepseek-flash", { MODEL_PRICING: '{"deepseek-flash":{"input":10,"output":20}}' });
assert.equal(overridden?.input, 10, "厂商调价时用 MODEL_PRICING 覆盖内置价。");
assert.deepEqual(
  resolveModelPrice("gpt-4o-mini", { MODEL_PRICING: '{"deepseek-flash":{"input":10,"output":20}}' }),
  mini,
  "覆盖表不能影响没被覆盖的模型。",
);
assert.equal(BUILTIN_MODEL_PRICES["gpt-4o"]?.input, 2.5, "内置表保持只读，不被覆盖污染。");

// ── 高峰时段 ────────────────────────────────────────────────
// 2026-10-30 是周五；北京时间 = UTC+8。
assert.equal(isPeakHour(new Date("2026-10-30T02:00:00Z")), true, "北京时间 10:00 属于高峰。");
assert.equal(isPeakHour(new Date("2026-10-30T03:59:00Z")), true, "北京时间 11:59 仍是高峰。");
assert.equal(isPeakHour(new Date("2026-10-30T04:00:00Z")), false, "北京时间 12:00 起是空闲。");
assert.equal(isPeakHour(new Date("2026-10-30T06:00:00Z")), true, "北京时间 14:00 回到高峰。");
assert.equal(isPeakHour(new Date("2026-10-30T10:00:00Z")), false, "北京时间 18:00 之后是空闲。");
assert.equal(isPeakHour(new Date("2026-10-30T00:59:00Z")), false, "北京时间 08:59 还没到高峰。");
assert.equal(isPeakHour(new Date("2026-10-31T02:00:00Z")), false, "周六同一时刻不算高峰。");

// ── 单次花费 ────────────────────────────────────────────────
const peakCost = estimateUsageCostCny(flash!, { promptTokens: 1_000_000, completionTokens: 1_000_000 }, new Date("2026-10-30T02:00:00Z"));
assert.equal(peakCost, 12, "高峰：3 + 9 = 12 元。");
const offPeakCost = estimateUsageCostCny(flash!, { promptTokens: 1_000_000, completionTokens: 1_000_000 }, new Date("2026-10-31T02:00:00Z"));
assert.equal(offPeakCost, 6, "空闲：1.5 + 4.5 = 6 元。");

// 命中缓存：800k × 0.1 + 200k × 3 = 0.68 元（高峰）。这就是 2026-10-30 账单差三倍的根因。
const cachedCost = estimateUsageCostCny(
  flash!,
  { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 800_000 },
  new Date("2026-10-30T02:00:00Z"),
);
assert.equal(cachedCost, 0.68, "命中缓存要按命中价算，不能整段按未命中价。");
assert.equal(
  estimateUsageCostCny(flash!, { promptTokens: 1_000_000, completionTokens: 0 }, new Date("2026-10-30T02:00:00Z")),
  3,
  "没有缓存明细时退化成全未命中，宁可偏高也不编造命中率。",
);
assert.equal(
  estimateUsageCostCny(
    flash!,
    { promptTokens: 100, completionTokens: 0, cacheHitTokens: 9999 },
    new Date("2026-10-30T02:00:00Z"),
  ),
  0.00001,
  "命中数被报得比 prompt 还大时夹到 prompt 总量，不能算出负的未命中。",
);

assert.equal(resolveUsdCnyRate({}), 7.2, "没有配汇率时用默认值。");
assert.equal(resolveUsdCnyRate({ USD_CNY_RATE: "abc" }), 7.2, "汇率不是数字时回退默认值，不能算出 NaN。");
const usdCost = estimateUsageCostCny(mini!, { promptTokens: 1_000_000, completionTokens: 0 }, new Date("2026-10-30T02:00:00Z"), 8);
assert.equal(usdCost, 1.2, "美元价按配置的汇率折成人民币。");
assert.equal(
  estimateUsageCostCny(flash!, { promptTokens: 0, completionTokens: 0 }, new Date("2026-10-30T02:00:00Z")),
  0,
  "没有 token 就没有花费。",
);

// ── 按天汇总 ────────────────────────────────────────────────
const now = new Date("2026-10-30T02:00:00Z"); // 北京时间 10-30 10:00
const days = usageDayWindow(3, now);
assert.deepEqual(days, ["2026-10-28", "2026-10-29", "2026-10-30"], "窗口从旧到新，最后一个是今天。");
assert.equal(usageDayWindow(3, new Date("2026-10-30T17:00:00Z")).at(-1), "2026-10-31", "东八区日界：UTC 17:00 已经是第二天。");

const reports = summarizeUsageRows(
  [
    {
      characterId: "char-a",
      model: "deepseek-flash",
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      createdAt: new Date("2026-10-30T02:00:00Z"), // 高峰时段
    },
    {
      characterId: "char-a",
      model: "unknown-model-x",
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      createdAt: new Date("2026-10-29T02:00:00Z"),
    },
    {
      characterId: "char-b",
      model: "gpt-4o-mini",
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      createdAt: new Date("2026-10-28T02:00:00Z"),
    },
    {
      characterId: "char-a",
      model: "deepseek-flash",
      promptTokens: 999_999,
      completionTokens: 1,
      totalTokens: 1_000_000,
      createdAt: new Date("2026-10-27T02:00:00Z"), // 窗口之外
    },
    {
      characterId: "char-c",
      model: "deepseek-flash",
      promptTokens: 5000,
      completionTokens: 5000,
      totalTokens: 10_000,
      createdAt: new Date("2026-10-30T02:00:00Z"), // 没请求这个角色
    },
  ],
  { characterIds: ["char-a", "char-b"], days, env: {} },
);

assert.equal(reports.size, 2, "只给请求过的角色出报告。");
const a = reports.get("char-a")!;
assert.equal(a.days.length, 3, "没有用量的日子也要补零，柱状图间距才均匀。");
assert.equal(a.today.totalTokens, 1500, "今天的 token 只算窗口内的行。");
assert.equal(a.today.calls, 1, "调用次数按行计。");
assert.equal(a.today.costCny, 0.0075, "高峰时段 1000 输入 × 3 元 + 500 输出 × 9 元。");
assert.equal(a.days[1]?.totalTokens, 1000, "昨天的用量落在中间那根柱子。");
assert.equal(a.days[1]?.costCny, 0, "未定价模型不计金额。");
assert.equal(a.days[1]?.unpricedTokens, 1000, "未定价的 token 要单独留痕。");
assert.deepEqual(a.unpricedModels, ["unknown-model-x"], "未定价模型名要带出来给页面提示。");
assert.equal(a.windowTokens, 2500, "7 天合计只含窗口内数据。");
assert.equal(a.windowCostCny, 0.0075, "窗口金额不含未定价部分。");
assert.equal(a.days[0]?.totalTokens, 0, "最早那天没有调用。");

const b = reports.get("char-b")!;
assert.equal(b.today.totalTokens, 0, "今天没调用就是 0，不是继承昨天的数字。");
assert.equal(b.days[0]?.costCny, 1.08, "美元价按默认汇率 7.2 折算。");

// ── 带缓存明细的汇总 ────────────────────────────────────────
const cacheDay = usageDayWindow(1, new Date("2026-10-30T02:00:00Z"))[0]!;
const cachedReports = summarizeUsageRows(
  [
    {
      characterId: "char-c",
      model: "deepseek-flash",
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      cacheHitTokens: 800_000,
      createdAt: new Date("2026-10-30T02:00:00Z"),
    },
    {
      characterId: "char-c",
      model: "deepseek-flash",
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      createdAt: new Date("2026-10-30T02:00:00Z"),
    },
  ],
  { characterIds: ["char-c"], days: [cacheDay], env: {} },
);
const c = cachedReports.get("char-c")!;
assert.equal(c.today.cacheHitTokens, 800_000, "命中数要累计。");
assert.equal(c.today.uncachedCalls, 1, "没有缓存明细的那次调用要单独计数，供页面提示「金额偏高」。");
assert.ok(c.today.costCny > 0.68 && c.today.costCny < 0.7, "带缓存的金额应接近 0.68 + 旧记录：实际 " + c.today.costCny);
assert.equal(c.uncachedCalls, 1, "角色级也要能报出窗口内没有明细的调用数。");

console.log("模型计价测试通过：缓存明细解析、价目表匹配、覆盖表、高峰时段、汇率折算、按天汇总与未定价留痕。");
