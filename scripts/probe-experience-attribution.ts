/**
 * 只读复核：自动激活的互动经验里，有多少「关键前提其实只来自助手旧说法」。
 *
 * 为什么不能只靠新加的归因门槛：那道门只管住之后的新候选；按旧协议已经 ACTIVE 的行
 * 还留在库里，当时没记 attribution（2026-11-21 前激活的都没有）。
 *
 * 这里不调模型，只用可复核的确定性判据，产出一份给人看的候选清单：
 *   1. quote_missing   —— feedbackQuote 不是用户那条反馈里的原话（服务端本该挡住）；
 *   2. assistant_only  —— 纠正/下次判断里有一段长片段只出现在助手原话里，用户反馈里没有；
 *   3. absolute_claim  —— 经验写成了永久能力断言，且该断言同样出自助手原话。
 * 命中不代表经验一定错，只表示「这条该人工看一眼」。脚本只读，不写库、不改状态。
 *
 * 用法：
 *   yarn tsx scripts/probe-experience-attribution.ts            # 全部角色，摘要 + 前 20 条
 *   yarn tsx scripts/probe-experience-attribution.ts --limit=100 --json
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL。");
const args = Object.fromEntries(process.argv.slice(2).map(raw => {
  const matched = /^--([^=]+)(?:=([\s\S]*))?$/u.exec(raw);
  return matched ? [matched[1], matched[2] ?? "true"] : [raw.replace(/^--/u, ""), "true"];
}));
const limit = Math.max(1, Math.min(500, Number(args.limit ?? 20) || 20));
const asJson = args.json === "true";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const ABSOLUTE_CLAIM = /(永远|从不|一直|再也|没有权限|读不到|无法访问|不可能|必须始终|绝对不)/u;
const MIN_SHARED_CHARS = 12;

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "");
}
function longestCommonSubstring(left: string, right: string): string {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return "";
  let best = { length: 0, text: "" };
  const previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j]!;
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (previous[j]! > best.length) best = { length: previous[j]!, text: a.slice(i - previous[j]!, i) };
      diagonal = saved;
    }
  }
  return best.text;
}
function clip(text: string, size = 40): string {
  const flat = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return flat.length > size ? `${flat.slice(0, size)}…` : flat;
}

const rows = await prisma.interactionExperience.findMany({
  where: { status: "ACTIVE" },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  select: {
    id: true, characterId: true, conversationId: true, status: true, createdAt: true,
    content: true, context: true, feedbackQuote: true, learning: true,
    assistantMessageId: true, feedbackMessageId: true,
  },
});
const reviews = rows.length
  ? await prisma.auditLog.findMany({
      where: { action: "interaction_experience.ai_reviewed", entityType: "InteractionExperience", entityId: { in: rows.map(row => row.id) } },
      select: { entityId: true, createdAt: true, details: true },
    })
  : [];
const reviewed = new Map(reviews.map(row => [row.entityId, row]));
const messages = rows.length
  ? await prisma.message.findMany({
      where: { id: { in: rows.flatMap(row => [row.assistantMessageId, row.feedbackMessageId]) } },
      select: { id: true, role: true, content: true },
    })
  : [];
const byId = new Map(messages.map(row => [row.id, row]));

const findings: Array<{ id: string; characterId: string; checks: string[]; note: string; createdAt: Date }> = [];
for (const row of rows) {
  // 只有经过自动审核（ai_reviewed 审计）的行才是「模型自己放行的」，人工创建的不在复核范围。
  if (!reviewed.has(row.id)) continue;
  const feedback = byId.get(row.feedbackMessageId);
  const assistant = byId.get(row.assistantMessageId);
  const checks: string[] = [];
  const notes: string[] = [];
  const feedbackText = normalize(feedback?.content ?? "");
  if (row.feedbackQuote.trim()) {
    if (!feedbackText.includes(normalize(row.feedbackQuote))) {
      checks.push("quote_missing");
      notes.push(`引用不在用户反馈里：${clip(row.feedbackQuote, 24)}`);
    }
  }
  const learning = (row.learning ?? {}) as Record<string, unknown>;
  // 只看「结论侧」：misunderstanding 本来就该引用助手说错的那句，拿它比对会把正确条目判成可疑
  // （2026-11-21 实跑就撞到一条这样的误报）。
  const claims = [learning.correction, learning.nextJudgment]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const assistantText = assistant?.content ?? "";
  let shared = "";
  for (const claim of claims) {
    const overlap = longestCommonSubstring(claim, assistantText);
    if (overlap.length >= MIN_SHARED_CHARS && !feedbackText.includes(normalize(overlap))) {
      shared = overlap;
      break;
    }
  }
  if (shared) {
    checks.push("assistant_only");
    notes.push(`只和助手原话重合：${clip(shared)}`);
  }
  const absolute = claims.find(claim => ABSOLUTE_CLAIM.test(claim) && ABSOLUTE_CLAIM.test(assistantText));
  if (absolute && !shared) {
    checks.push("absolute_claim");
    notes.push(`永久能力措辞：${clip(absolute, 30)}`);
  }
  if (checks.length) findings.push({ id: row.id, characterId: row.characterId, checks, note: notes.join("；"), createdAt: row.createdAt });
}

const autoActive = rows.filter(row => reviewed.has(row.id)).length;
const summary = {
  activeExperiences: rows.length,
  autoActivated: autoActive,
  manuallyActivated: rows.length - autoActive,
  suspicious: findings.length,
  byCheck: {
    quoteMissing: findings.filter(item => item.checks.includes("quote_missing")).length,
    assistantOnly: findings.filter(item => item.checks.includes("assistant_only")).length,
    absoluteClaim: findings.filter(item => item.checks.includes("absolute_claim")).length,
  },
  readOnly: true,
  modelCalls: 0,
};

if (asJson) {
  console.log(JSON.stringify({ summary, findings: findings.slice(0, limit).map(item => ({ ...item, createdAt: item.createdAt.toISOString() })) }, null, 2));
} else {
  console.log(`自动激活经验 ${autoActive} 条（人工 ${rows.length - autoActive} 条），可疑 ${findings.length} 条`);
  console.log(`判据命中：引用不在用户反馈 ${summary.byCheck.quoteMissing}、只与助手原话重合 ${summary.byCheck.assistantOnly}、永久能力措辞 ${summary.byCheck.absoluteClaim}`);
  console.log(`（只读，未调用模型，未修改任何状态）`);
  if (!findings.length) console.log("\n没有命中：自动激活的条目里没发现只靠助手旧说法的前提。");
  for (const item of findings.slice(0, limit)) {
    console.log(`\n- ${item.createdAt.toISOString().slice(0, 10)} ${item.id} [${item.checks.join(", ")}]`);
    console.log(`  ${item.note}`);
  }
  if (findings.length > limit) console.log(`\n…还有 ${findings.length - limit} 条，用 --limit 查看。`);
}
await prisma.$disconnect();
