/**
 * 只读报表：某个角色的 token 消耗与去向。
 *
 *   yarn tsx scripts/report-character-usage.ts 大肥鱼
 *
 * 计价按每一行自己的调用时间取价，和总览的「用量与花费」同一条规则 ——
 * 先按天求和再统一乘单价会把 DeepSeek 的高峰/空闲算错。
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { estimateUsageCostCny, resolveModelPrice, resolveUsdCnyRate } from "../server/utils/model-pricing";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL。");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const needle = process.argv[2] ?? "大肥鱼";

function n(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}
function wan(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(2)} 万` : `${value}`;
}
function dayKey(at: Date): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

type Bucket = {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  reasoning: number;
  hit: number;
  miss: number;
  uncached: number;
  cost: number;
  unpriced: number;
};

function emptyBucket(): Bucket {
  return { calls: 0, prompt: 0, completion: 0, total: 0, reasoning: 0, hit: 0, miss: 0, uncached: 0, cost: 0, unpriced: 0 };
}

async function main() {
  const characters = await prisma.character.findMany({
    where: { name: { contains: needle } },
    select: { id: true, name: true, createdAt: true, modelConfig: true },
  });
  if (!characters.length) {
    console.log(`没有名字包含「${needle}」的角色。`);
    return;
  }

  for (const character of characters) {
    const rows = await prisma.modelUsage.findMany({
      where: { characterId: character.id },
      select: {
        kind: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        reasoningTokens: true,
        cacheHitTokens: true,
        conversationId: true,
        channelBindingId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const conversationIds = [...new Set(rows.map((r) => r.conversationId).filter((id): id is string => Boolean(id)))];
    const conversations = conversationIds.length
      ? await prisma.conversation.findMany({
          where: { id: { in: conversationIds } },
          select: { id: true, title: true, metadata: true },
        })
      : [];
    const titleById = new Map(conversations.map((c) => [c.id, c.title]));

    console.log(`\n===== ${character.name} (${character.id}) =====`);
    console.log(`角色创建于 ${dayKey(character.createdAt)}，记账行 ${rows.length} 条`);

    const usdCny = resolveUsdCnyRate();
    const total = emptyBucket();
    const byKind = new Map<string, Bucket>();
    const byModel = new Map<string, Bucket>();
    const byDay = new Map<string, Bucket>();
    const byPlace = new Map<string, Bucket>();
    const firstAt = rows[0]?.createdAt;
    const lastAt = rows[rows.length - 1]?.createdAt;

    for (const row of rows) {
      const prompt = n(row.promptTokens);
      const completion = n(row.completionTokens);
      const sum = n(row.totalTokens) || prompt + completion;
      const hasCache = typeof row.cacheHitTokens === "number";
      const hit = hasCache ? Math.min(prompt, n(row.cacheHitTokens)) : 0;
      const miss = hasCache ? prompt - hit : prompt;
      const price = resolveModelPrice(row.model);
      const cost = price
        ? estimateUsageCostCny(
            price,
            { promptTokens: prompt, completionTokens: completion, ...(hasCache ? { cacheHitTokens: hit } : {}) },
            row.createdAt,
            usdCny,
          )
        : 0;

      const place = row.conversationId
        ? `会话：${titleById.get(row.conversationId) ?? row.conversationId}`
        : row.channelBindingId
          ? "渠道（未挂会话）"
          : "无会话（后台任务/系统）";

      const targets: Array<[Map<string, Bucket>, string]> = [
        [byKind, row.kind],
        [byModel, row.model],
        [byDay, dayKey(row.createdAt)],
        [byPlace, place],
      ];
      for (const [map, key] of targets) {
        if (!map.has(key)) map.set(key, emptyBucket());
      }
      for (const bucket of [total, byKind.get(row.kind)!, byModel.get(row.model)!, byDay.get(dayKey(row.createdAt))!, byPlace.get(place)!]) {
        bucket.calls += 1;
        bucket.prompt += prompt;
        bucket.completion += completion;
        bucket.total += sum;
        bucket.reasoning += n(row.reasoningTokens);
        bucket.hit += hit;
        bucket.miss += miss;
        if (!hasCache) bucket.uncached += 1;
        bucket.cost += cost;
        if (!price) bucket.unpriced += sum;
      }
    }

    const line = (label: string, b: Bucket, width = 34) => {
      const name = label.length > width ? `${label.slice(0, width - 1)}…` : label.padEnd(width);
      return `${name} ${String(b.calls).padStart(4)} 次  ${wan(b.total).padStart(9)} tok  (入 ${wan(b.prompt)} / 出 ${wan(b.completion)})  ¥${b.cost.toFixed(4)}`;
    };

    console.log(`\n-- 合计 --`);
    console.log(line("全部", total));
    console.log(
      `   输入 ${wan(total.prompt)} · 输出 ${wan(total.completion)} · reasoning ${wan(total.reasoning)} · 缓存命中 ${wan(total.hit)} (${pct(total.hit, total.prompt)})`,
    );
    if (total.uncached) console.log(`   ${total.uncached} 次调用没有缓存明细，这部分按未命中价计，金额偏高。`);
    if (total.unpriced) console.log(`   未定价模型消耗 ${wan(total.unpriced)} tok，未计入金额。`);
    if (firstAt && lastAt) console.log(`   时间跨度 ${dayKey(firstAt)} → ${dayKey(lastAt)}`);

    const dump = (title: string, map: Map<string, Bucket>) => {
      const entries = [...map.entries()].sort((a, b) => b[1].total - a[1].total);
      console.log(`\n-- ${title} --`);
      for (const [key, bucket] of entries) {
        console.log(line(key, bucket) + `  ${pct(bucket.total, total.total)}`);
      }
    };

    dump("按调用类型 (kind)", byKind);
    dump("按模型", byModel);
    dump("按天（东八区）", byDay);
    dump("按去处", byPlace);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
