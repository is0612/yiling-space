/**
 * 重新生成某一天的忆泡。
 *
 * 用途：忆泡的 `participants` 是泛称（「群友」）、或者 `sourceMessageIds` 为空导致
 * 无法回填时，只要原始消息还在保留期里，就可以让按天任务重跑一遍，用修好后的
 * 抽取逻辑（带 `speaker`）重新写一份。
 *
 * 前置条件：那天的消息还在。`CLEAN_EXPIRED_MESSAGES` 跑过之后原文就没了，
 * 再重跑只会得到「这天没有对话」，旧忆泡也已经不可回溯 —— 这一点脚本会在预演时
 * 直接告警并拒绝执行。
 *
 * 用法：
 *   yarn regen:events --day=2026-11-02            预演（不删、不调模型）
 *   yarn regen:events --day=2026-11-02 --apply    真跑（删掉该天旧忆泡 + 调模型重抽）
 *
 * 只处理 `CHARACTER_GLOBAL` 范围。私聊范围的口语对象固定是「主人」，泛称没有
 * 检索价值，重跑的收益抵不上它重新编排一遍事实的风险。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { processNextMemoryJob } from "../server/utils/memory-worker";
import { resolveDayWindow } from "../server/utils/memory-event-time";

const apply = process.argv.includes("--apply");
const dayKey = (process.argv.find((arg) => arg.startsWith("--day="))?.split("=")[1] ?? "").trim();
if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) {
  console.error("必须指定 --day=YYYY-MM-DD");
  process.exit(1);
}

const prisma = getPrisma();

const character = await prisma.character.findFirst({
  select: { id: true, name: true, ownerId: true, memorySetting: { select: { timezone: true } } },
});
if (!character) {
  console.error("没有角色。");
  process.exit(1);
}
const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
const scope = await prisma.memoryScope.findFirstOrThrow({
  where: { characterId: character.id, scopeType: "CHARACTER_GLOBAL" },
  select: { id: true },
});

const window = resolveDayWindow(dayKey, timeZone);
const messageCount = await prisma.message.count({
  where: { conversation: { memoryScopeId: scope.id }, occurredAt: { gte: window.start, lt: window.end } },
});
const existing = await prisma.memoryEvent.findMany({
  where: { memoryScopeId: scope.id, dayKey },
  orderBy: { occurredAt: "asc" },
  select: { id: true, title: true, participants: true, sourceMessageIds: true },
});

console.log(`角色：${character.name}　时区：${timeZone}`);
console.log(`范围：${scope.id}（CHARACTER_GLOBAL）`);
console.log(`日期：${dayKey}　窗口：${window.start.toISOString()} ~ ${window.end.toISOString()}`);
console.log(`当天原始消息：${messageCount} 条`);
console.log(`现有忆泡：${existing.length} 条`);
for (const event of existing) {
  const src = event.sourceMessageIds.length;
  console.log(`  · ${event.title}`);
  console.log(`    参与者 ${event.participants.join("、") || "（空）"}　来源 ${src ? `${src} 条` : "无（不可回填）"}`);
}

/**
 * 没有原始消息就不能重跑：按天任务只读 `messages`，空输入等于把这一天写成「没聊过」，
 * 而旧忆泡已经被删掉的话就真的找不回来了。
 */
if (!messageCount) {
  console.error("\n当天没有原始消息（很可能已被保留策略清理）：重跑只会得到空结果，已中止。");
  process.exit(1);
}

// 按天任务一次最多看 120 × 8 = 960 条，超出部分会被均匀放大块大小。
const aiMessageCap = 960;
const calls = Math.min(Math.ceil(messageCount / 120), 8);
console.log(`\n本次会调模型约 ${calls} 次（最多 ${aiMessageCap} 条消息进模型，超出部分不参与）。`);

if (!apply) {
  console.log("\n（预演，未改动任何数据；加 --apply 才会删旧忆泡并重跑）");
  process.exit(0);
}

const jobKey = `events-final:${scope.id}:${dayKey}`;
const todayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
if (dayKey >= todayKey) {
  console.error(`\n${dayKey} 不是过去的日期：按天任务只收口已完成的一天，今天请用「立即整理」。`);
  process.exit(1);
}

console.log("\n删除旧忆泡（已备份到 backups/ 的话可恢复）…");
const deleted = await prisma.memoryEvent.deleteMany({ where: { memoryScopeId: scope.id, dayKey } });
console.log(`  删除 ${deleted.count} 条`);

/**
 * **进度行必须一起删**，这是重跑最容易踩的坑。
 *
 * `runDailyEventJob` 的增量起点是 `max(periodStart, day.extractedAt)`：只要这一天的
 * `extractedAt` 已经被推到周期末尾（每次跑完都会更新），增量窗口就是空的，
 * 任务会直接以「这一段没有新的对话」SKIPPED —— 旧忆泡已经删了，新的却一条不写，
 * 等于把这一天抹平。（2026-11-03 实测踩过一次。）
 */
const progress = await prisma.memoryEventDay.deleteMany({ where: { memoryScopeId: scope.id, dayKey } });
console.log(`  重置当天进度行 ${progress.count} 条`);

// 幂等键还在的话，新任务会被 skipDuplicates 挡掉，也必须先清。
await prisma.memoryJob.deleteMany({ where: { idempotencyKey: jobKey } });
const job = await prisma.memoryJob.create({
  data: {
    memoryScopeId: scope.id,
    type: "EXTRACT_EVENTS",
    idempotencyKey: jobKey,
    periodStart: window.start,
    periodEnd: window.end,
    status: "QUEUED",
    runAt: new Date(),
  },
  select: { id: true },
});
console.log(`已排队：${job.id}`);

const workerId = `regen-${Date.now()}`;
for (let attempt = 0; attempt < 8; attempt += 1) {
  const result = await processNextMemoryJob(prisma, { workerId });
  if (!result.processed) {
    console.log("队列里没有可执行的任务了。");
    break;
  }
  if (result.jobId === job.id) {
    console.log(`任务结束：${result.status}　${result.message}`);
    break;
  }
  console.log(`（先处理了别的任务 ${result.jobId}：${result.status}）`);
}

const after = await prisma.memoryEvent.findMany({
  where: { memoryScopeId: scope.id, dayKey },
  orderBy: { occurredAt: "asc" },
  select: { title: true, participants: true, sourceMessageIds: true },
});
console.log(`\n重跑后：${after.length} 条`);
for (const event of after) {
  const names = event.participants.join("、") || "（空）";
  const generic = event.participants.some((person) => ["群友", "群成员", "对方", "有人"].includes(person));
  console.log(`  ${generic ? "⚠️" : "  "} ${event.title}`);
  console.log(`     参与者 ${names}　来源 ${event.sourceMessageIds.length} 条`);
}
process.exit(0);
