import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  readDailyQuota,
  readDailyUsage,
  readModelUsage,
  recordModelUsage,
  resolveDailyTokenLimit,
  toUsageTokens,
  usageDayKey,
} from "../server/utils/model-usage";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，用量测试无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// ── 解析 ────────────────────────────────────────────────────
const parsed = readModelUsage({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
assert.deepEqual(parsed, { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, "标准 usage 要能解析。");

const withReasoning = readModelUsage({
  usage: { prompt_tokens: 10, completion_tokens: 90, total_tokens: 100, completion_tokens_details: { reasoning_tokens: 70 } },
});
assert.equal(withReasoning?.reasoningTokens, 70, "思考型模型的 reasoning token 要单独留下。");

assert.equal(readModelUsage({}), null, "没有 usage 字段时返回 null，不编造。");
assert.equal(readModelUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } }), null, "全零视为没有用量。");

const derived = readModelUsage({ usage: { prompt_tokens: 30, completion_tokens: 20 } });
assert.equal(derived?.totalTokens, 50, "缺 total_tokens 时用两项相加。");

assert.equal(toUsageTokens(null), null, "宽松输入为空时返回 null。");
assert.equal(toUsageTokens({ promptTokens: 5 })?.totalTokens, 5, "宽松输入按已有字段补零。");

// ── 额度解析 ────────────────────────────────────────────────
assert.equal(resolveDailyTokenLimit({}), 0, "没配额度 = 不限。");
assert.equal(resolveDailyTokenLimit({ dailyTokenLimit: 5000 }), 5000, "读得到自定义额度。");
assert.equal(resolveDailyTokenLimit({ dailyTokenLimit: -1 }), 0, "负数按不限处理。");
assert.equal(resolveDailyTokenLimit({ dailyTokenLimit: "5000" }), 0, "字符串不认，避免脏配置。");

// ── 落库与聚合 ──────────────────────────────────────────────
const characterId = randomUUID();
const day = usageDayKey();

try {
  await recordModelUsage({
    kind: "chat", model: "test-model", characterId,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  });
  await recordModelUsage({
    kind: "bili-judge", model: "test-model", characterId,
    usage: { promptTokens: 60, completionTokens: 40, totalTokens: 100 },
  });
  // 没有用量的调用不该写入任何行。
  await recordModelUsage({ kind: "chat", model: "test-model", characterId, usage: null });

  const usage = await readDailyUsage(characterId, day);
  assert.equal(usage.totalTokens, 250, "两条记录应累计到 250。");
  assert.equal(usage.calls, 2, "没有用量的调用不计入次数。");
  assert.equal(usage.byKind.chat?.totalTokens, 150, "按类别分开统计。");
  assert.equal(usage.byKind["bili-judge"]?.calls, 1, "值班调用单独一类。");

  const exceeded = await readDailyQuota(characterId, { dailyTokenLimit: 200 }, day);
  assert.equal(exceeded.exceeded, true, "用超 200 要判定为超额。");
  assert.equal(exceeded.remaining, 0, "超额时剩余为 0，不为负。");

  const roomLeft = await readDailyQuota(characterId, { dailyTokenLimit: 10_000 }, day);
  assert.equal(roomLeft.exceeded, false, "额度足够时不拦。");
  assert.equal(roomLeft.remaining, 9_750, "剩余额度要准确。");

  const unlimited = await readDailyQuota(characterId, {}, day);
  assert.equal(unlimited.exceeded, false, "不配额度永不拦。");
  assert.equal(unlimited.remaining, null, "不限额度时剩余为 null（而不是 Infinity，JSON 表达不了）。");

  console.log("模型用量测试通过：usage 解析、reasoning 单独统计、缺字段推导、额度解析、落库聚合、超额判定与剩余量。");
} finally {
  await prisma.modelUsage.deleteMany({ where: { characterId } });
  await prisma.$disconnect();
}
