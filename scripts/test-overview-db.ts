import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import type { OverviewPayload } from "../app/utils/overview";
import { createSession, hashPassword } from "../server/utils/auth";
import { buildDueMemoryPeriods } from "../server/utils/memory-scheduler";
import { usageDayKey } from "../server/utils/model-usage";
import { getPrisma } from "../server/utils/prisma";

/**
 * 总览接口的验收：快照口径、用户隔离、用量日界、周期与时间。
 *
 * 全部走真实 HTTP + 真实 Cookie，只读接口本身不写库；夹具写进独立测试库，跑完按 id 清理。
 */

const connectionString = process.env.DATABASE_URL;
assert(connectionString, "缺少 DATABASE_URL，总览验收无法运行。");

const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[h3]")) return;
  rawConsoleError(...args);
};

(globalThis as unknown as { defineEventHandler: typeof eventHandler }).defineEventHandler = eventHandler;
const { default: overviewHandler } = await import("../server/api/overview/index.get");

const app = createApp({ onError: () => undefined });
const router = createRouter();
router.get("/api/overview", overviewHandler);
app.use(router);
const api = http.createServer(toNodeListener(app));
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

const prisma = getPrisma();
const suffix = randomUUID().slice(0, 8);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const createdUserIds: string[] = [];

const now = new Date();
const todayStart = new Date(`${usageDayKey(now)}T00:00:00+08:00`);

type CharacterFixture = { id: string; name: string };

async function makeUser(label: string, role: "USER" | "ADMIN") {
  const username = `overview-${label}-${suffix}`;
  const user = await prisma.user.create({
    data: { username, passwordHash: await hashPassword("overview-test-1"), displayName: username, role },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  const session = await createSession({ userId: user.id, ip: "127.0.0.1", userAgent: "overview-test" });
  return { id: user.id, token: session.token };
}

async function makeCharacter(input: {
  ownerId: string;
  name: string;
  setting?: {
    intervalDays?: number;
    timezone?: string;
    nextSnapshotAt?: Date | null;
    autoSnapshotEnabled?: boolean;
  };
}): Promise<CharacterFixture> {
  const character = await prisma.character.create({
    data: {
      ownerId: input.ownerId,
      name: input.name,
      basePrompt: "总览验收角色",
      ...(input.setting
        ? {
            memorySetting: {
              create: {
                snapshotIntervalDays: input.setting.intervalDays ?? 3,
                timezone: input.setting.timezone ?? "Asia/Shanghai",
                nextSnapshotAt: input.setting.nextSnapshotAt ?? null,
                autoSnapshotEnabled: input.setting.autoSnapshotEnabled ?? true,
              },
            },
          }
        : {}),
    },
    select: { id: true, name: true },
  });
  await prisma.memoryScope.create({
    data: {
      characterId: character.id,
      scopeType: "CHARACTER_GLOBAL",
      scopeKey: `overview-test:${character.id}`,
    },
  });
  return character;
}

async function scopeOf(characterId: string): Promise<string> {
  const scope = await prisma.memoryScope.findFirst({ where: { characterId }, select: { id: true } });
  assert(scope, "前置条件：角色应当有记忆范围。");
  return scope.id;
}

async function makeSnapshot(input: {
  characterId: string;
  kind: "AUTOMATIC" | "MANUAL";
  version: number;
  createdAt: Date;
}): Promise<void> {
  const memoryScopeId = await scopeOf(input.characterId);
  await prisma.memorySnapshot.create({
    data: {
      snapshotKey: `overview-test:${randomUUID()}`,
      memoryScopeId,
      kind: input.kind,
      version: input.version,
      periodStart: new Date(input.createdAt.getTime() - 3 * DAY_MS),
      periodEnd: input.createdAt,
      summary: input.kind + " 快照",
      structuredContent: {},
      createdAt: input.createdAt,
    },
  });
}

async function makeJob(input: {
  characterId: string;
  status: "QUEUED" | "RUNNING" | "FAILED";
  createdAt: Date;
}): Promise<void> {
  const memoryScopeId = await scopeOf(input.characterId);
  await prisma.memoryJob.create({
    data: {
      memoryScopeId,
      type: "GENERATE_SNAPSHOT",
      idempotencyKey: `overview-test:${randomUUID()}`,
      status: input.status,
      createdAt: input.createdAt,
      runAt: input.createdAt,
    },
  });
}

async function makeUsage(input: {
  characterId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number | null;
  createdAt: Date;
}): Promise<void> {
  await prisma.modelUsage.create({
    data: {
      kind: "chat",
      model: input.model,
      characterId: input.characterId,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.promptTokens + input.completionTokens,
      ...(input.cacheHitTokens === undefined ? {} : { cacheHitTokens: input.cacheHitTokens }),
      createdAt: input.createdAt,
    },
  });
}

async function fetchOverview(token: string): Promise<OverviewPayload> {
  const response = await fetch(baseUrl + "/api/overview", { headers: { cookie: "yiling_session=" + token } });
  assert.equal(response.status, 200, "总览接口应当返回 200。");
  return await response.json() as OverviewPayload;
}

try {
  const userA = await makeUser("a", "USER");
  const userB = await makeUser("b", "USER");
  const admin = await makeUser("admin", "ADMIN");

  // ── 用户 A：正常角色 / 只有手动存档 / 归档逾期 / 两个不同时区 ──────────────
  const a1 = await makeCharacter({
    ownerId: userA.id,
    name: "A-正常",
    setting: { intervalDays: 3, nextSnapshotAt: new Date(now.getTime() + HOUR_MS), timezone: "Asia/Shanghai" },
  });
  const a2 = await makeCharacter({
    ownerId: userA.id,
    name: "A-只有手动",
    setting: { intervalDays: 3, nextSnapshotAt: null, autoSnapshotEnabled: false },
  });
  const a3 = await makeCharacter({
    ownerId: userA.id,
    name: "A-逾期",
    setting: { intervalDays: 2, nextSnapshotAt: new Date(now.getTime() - HOUR_MS), timezone: "Asia/Shanghai" },
  });
  // 同一个未来时刻，两个时区应当给出不同日期标签（用来钉住「按角色时区格式化」）。
  const zoneInstant = new Date("2027-01-15T23:00:00.000Z");
  const aNewYork = await makeCharacter({
    ownerId: userA.id,
    name: "A-纽约",
    setting: { intervalDays: 3, nextSnapshotAt: zoneInstant, timezone: "America/New_York" },
  });
  const aTokyo = await makeCharacter({
    ownerId: userA.id,
    name: "A-东京",
    setting: { intervalDays: 3, nextSnapshotAt: zoneInstant, timezone: "Asia/Tokyo" },
  });

  // 用户 B：完全独立的角色、任务与用量。
  const b1 = await makeCharacter({
    ownerId: userB.id,
    name: "B-唯一角色",
    setting: { intervalDays: 5, nextSnapshotAt: new Date(now.getTime() + 2 * DAY_MS) },
  });

  // 快照：A1 自动 + 手动（手动更新）；A2 只有手动；B1 自动。
  await makeSnapshot({ characterId: a1.id, kind: "AUTOMATIC", version: 4, createdAt: new Date(now.getTime() - HOUR_MS) });
  await makeSnapshot({ characterId: a1.id, kind: "MANUAL", version: 9, createdAt: now });
  await makeSnapshot({ characterId: a2.id, kind: "MANUAL", version: 2, createdAt: now });
  await makeSnapshot({ characterId: b1.id, kind: "AUTOMATIC", version: 1, createdAt: new Date(now.getTime() - 30 * 60 * 1000) });

  // 任务：A1 排队 + 失败；A3 不排任务（用于制造「归档逾期但队列里没有任务」）；B1 失败 + 运行中。
  await makeJob({ characterId: a1.id, status: "QUEUED", createdAt: new Date(now.getTime() - HOUR_MS) });
  await makeJob({ characterId: a1.id, status: "FAILED", createdAt: new Date(now.getTime() - 2 * HOUR_MS) });
  await makeJob({ characterId: b1.id, status: "FAILED", createdAt: new Date(now.getTime() - HOUR_MS) });
  await makeJob({ characterId: b1.id, status: "RUNNING", createdAt: new Date(now.getTime() - 10 * 60 * 1000) });

  // 用量：A1 一条有缓存明细的已知模型、一条未知模型；A3 铺日界与窗口边界；B1 一条 B 专属模型。
  await makeUsage({ characterId: a1.id, model: "deepseek-v4-flash", promptTokens: 100, completionTokens: 20, cacheHitTokens: 40, createdAt: now });
  await makeUsage({ characterId: a1.id, model: "totally-unknown-9", promptTokens: 200, completionTokens: 0, cacheHitTokens: null, createdAt: now });
  await makeUsage({ characterId: a3.id, model: "deepseek-v4-flash", promptTokens: 111, completionTokens: 0, cacheHitTokens: 10, createdAt: new Date(todayStart.getTime() + HOUR_MS) });
  await makeUsage({ characterId: a3.id, model: "deepseek-v4-flash", promptTokens: 222, completionTokens: 0, cacheHitTokens: 10, createdAt: new Date(todayStart.getTime() - HOUR_MS) });
  await makeUsage({ characterId: a3.id, model: "deepseek-v4-flash", promptTokens: 444, completionTokens: 0, cacheHitTokens: 10, createdAt: new Date(todayStart.getTime() - 8 * DAY_MS) });
  await makeUsage({ characterId: b1.id, model: "b-only-model", promptTokens: 50, completionTokens: 0, cacheHitTokens: null, createdAt: now });

  // 记忆条目：只给 A1 两条，落在它当前周期内。
  const a1Scope = await scopeOf(a1.id);
  for (const index of [1, 2]) {
    await prisma.memoryItem.create({
      data: {
        memoryScopeId: a1Scope,
        category: "FACT",
        content: `总览验收记忆 ${index}`,
        createdAt: new Date(now.getTime() - HOUR_MS),
      },
    });
  }

  const overviewA = await fetchOverview(userA.token);
  const overviewB = await fetchOverview(userB.token);
  const overviewAdmin = await fetchOverview(admin.token);

  // ── 1. 快照类型 ─────────────────────────────────────────────────────────
  const aCharacterIds = overviewA.characters.map((character) => character.id).sort();
  assert.deepEqual(
    aCharacterIds,
    [a1.id, a2.id, a3.id, aNewYork.id, aTokyo.id].sort(),
    "A 的总览只应包含自己的角色。",
  );
  const cardA1 = overviewA.characters.find((character) => character.id === a1.id)!;
  const cardA2 = overviewA.characters.find((character) => character.id === a2.id)!;
  assert.equal(cardA1.latestSnapshotVersion, 4, "角色卡的最近总结必须取 AUTOMATIC，忽略更新的 MANUAL。");
  assert.equal(cardA1.latestSnapshotAt, new Date(now.getTime() - HOUR_MS).toISOString(), "最近总结时间必须来自 AUTOMATIC。");
  assert.equal(cardA2.latestSnapshotVersion, null, "只有 MANUAL 快照的角色不应被算作「已归档」。");
  assert.equal(cardA2.latestSnapshotLabel, "暂无总结", "只有 MANUAL 时必须显示暂无总结。");

  const snapshotEvents = overviewA.events.filter((event) => event.kind === "snapshot");
  assert.equal(snapshotEvents.length, 1, "活动流里只应有一条自动总结事件。");
  assert.equal(snapshotEvents[0]?.title, "阶段总结已生成 · v4", "活动流不得把 MANUAL 的版本号当成阶段总结。");
  assert(
    overviewA.events.every((event) => !event.title.includes("v9")),
    "手动存档绝不能出现在「阶段总结已生成」里。",
  );
  assert(
    overviewA.events.every((event) => !event.meta.startsWith("A-只有手动")),
    "只有手动存档的角色不应产生总结事件。",
  );
  assert.equal(overviewA.latestSnapshot?.characterId, a1.id, "全局最近总结必须来自 A 的自动总结。");
  assert.equal(overviewA.latestSnapshot?.version, 4, "全局最近总结不得取 MANUAL 的版本。");

  // ── 2. 用户隔离 ─────────────────────────────────────────────────────────
  assert(
    overviewB.characters.every((character) => character.id === b1.id),
    "B 的总览不得出现 A 的角色。",
  );
  assert(
    overviewB.events.every((event) => !event.meta.includes("A-")),
    "B 的活动流不得出现 A 的角色事件。",
  );
  assert.equal(overviewB.tasks.failed, 1, "B 只应看到自己的失败任务。");
  assert.equal(overviewB.tasks.pending, 1, "B 只应看到自己的待处理任务。");
  assert.equal(overviewB.usage.characters.length, 1, "B 的用量只应包含自己的角色。");
  assert.deepEqual(overviewB.usage.unpricedModels, ["b-only-model"], "B 的未定价模型不得混入 A 的模型。");
  assert(
    overviewB.watchdog.findings.every((finding) => finding.characterId === b1.id),
    "B 的停滞告警只能指向自己的角色。",
  );
  assert.equal(overviewB.admin, null, "普通用户不得拿到管理员全站统计。");
  assert.equal(overviewA.admin, null, "普通用户不得拿到管理员全站统计。");

  // A 侧反过来核对：B 的角色、模型、任务都不能漏进来。
  assert(
    overviewA.characters.every((character) => character.id !== b1.id),
    "A 的总览不得出现 B 的角色。",
  );
  assert(
    overviewA.events.every((event) => !event.meta.includes("B-唯一角色")),
    "A 的活动流不得出现 B 的角色事件。",
  );
  assert.deepEqual(overviewA.usage.unpricedModels, ["totally-unknown-9"], "A 的未定价模型不应包含 B 的模型。");
  assert.equal(overviewA.tasks.failed, 1, "A 只应看到自己的失败任务。");
  assert.equal(overviewA.tasks.pending, 1, "A 只应看到自己的待处理任务。");

  // 管理员：全站统计正常，且不混入任何人的角色卡。
  assert(overviewAdmin.admin, "管理员必须拿到全站统计。");
  assert.equal(overviewAdmin.admin?.database, "up", "管理员面板应报告数据库可用。");
  assert.equal(overviewAdmin.admin?.jobs.queued, 1, "全站排队任务数应为 1。");
  assert.equal(overviewAdmin.admin?.jobs.running, 1, "全站运行中任务数应为 1。");
  assert.equal(overviewAdmin.admin?.jobs.failed, 2, "全站失败任务数应为 2。");
  assert.equal(overviewAdmin.characters.length, 0, "管理员自己的角色列表应当为空，不混入他人角色。");

  // ── 3. 用量统计 ─────────────────────────────────────────────────────────
  assert.equal(overviewA.usage.days.length, 7, "用量窗口固定为最近 7 天。");
  assert.equal(overviewA.usage.day, usageDayKey(now), "用量「今天」按东八区日界计算。");
  assert.equal(overviewA.usage.days[6], usageDayKey(now), "窗口最后一天必须是东八区今天。");
  assert.equal(overviewA.usage.days[5], usageDayKey(new Date(todayStart.getTime() - HOUR_MS)), "窗口第 6 天必须是东八区昨天。");

  const usageA1 = overviewA.usage.characters.find((item) => item.characterId === a1.id)!;
  assert.equal(usageA1.today.totalTokens, 320, "A1 今日 token 应为两条调用之和。");
  assert.equal(usageA1.today.calls, 2, "A1 今日调用数应为 2。");
  assert.equal(usageA1.today.unpricedTokens, 200, "未知模型的 token 必须单独计入未定价。");
  assert.deepEqual(usageA1.unpricedModels, ["totally-unknown-9"], "未定价模型名单必须准确。");
  assert(usageA1.today.costCny > 0, "已知模型必须产生金额。");
  assert.equal(usageA1.today.uncachedCalls, 1, "没有缓存明细的调用必须单独计数，供页面提示金额偏高。");
  assert.equal(usageA1.today.cacheHitTokens, 40, "有明细的调用按明细统计缓存命中。");
  assert.equal(overviewA.usage.unpricedTokens, 200, "顶栏未定价 token 应汇总各角色。");

  const usageA3 = overviewA.usage.characters.find((item) => item.characterId === a3.id)!;
  assert.equal(usageA3.today.totalTokens, 111, "东八区今天只包含 00:00 之后的那条。");
  assert.equal(usageA3.days[5]?.totalTokens, 222, "昨天 23:00 的调用必须落在昨天，不能跨日累加。");
  assert.equal(usageA3.windowTokens, 333, "窗口外的 8 天前调用必须排除。");

  const usageA2 = overviewA.usage.characters.find((item) => item.characterId === a2.id)!;
  assert.equal(usageA2.today.totalTokens, 0, "没有调用的角色应补零，而不是缺行。");
  assert.equal(usageA2.today.calls, 0, "没有调用的角色调用数应为 0。");
  assert.equal(usageA2.today.costCny, 0, "没有调用的角色金额应为 0。");
  assert.equal(overviewA.usage.characters.length, 5, "多角色汇总必须每个角色都有一份报告。");

  // ── 4. 周期与时间 ───────────────────────────────────────────────────────
  const cardA3 = overviewA.characters.find((character) => character.id === a3.id)!;
  assert.equal(cardA1.cycle?.dayIndex, 3, "3 天周期、还剩 1 小时，应处于第 3 天。");
  assert.equal(cardA1.cycle?.totalDays, 3, "周期总天数取角色设置。");
  assert.equal(cardA1.cycle?.missed, false, "未到归档时间不应标记逾期。");
  assert.equal(cardA3.cycle?.missed, true, "已过归档时间必须标记逾期。");
  assert.equal(cardA3.cycle?.dayIndex, 2, "逾期时进度封顶在周期最后一天。");
  assert.equal(cardA2.cycle, null, "没有计划 / 关闭自动归档时不画周期。");
  assert.equal(cardA2.nextSnapshotLabel, "已暂停", "关闭自动归档时标签应为已暂停。");

  // 周期起点必须与调度器实际切分的周期一致（固定 24 小时，不随时区/夏令时漂移）。
  const scheduledA1 = buildDueMemoryPeriods({
    memoryScopeId: "test",
    nextSnapshotAt: new Date(now.getTime() + HOUR_MS),
    intervalDays: 3,
    now: new Date(now.getTime() + HOUR_MS + 1),
  });
  assert.equal(cardA1.cycle?.startISO, scheduledA1.periods[0]?.periodStart.toISOString(), "总览周期起点必须与调度器一致（3 天）。");
  const scheduledA3 = buildDueMemoryPeriods({
    memoryScopeId: "test",
    nextSnapshotAt: new Date(now.getTime() - HOUR_MS),
    intervalDays: 2,
    now,
  });
  assert.equal(cardA3.cycle?.startISO, scheduledA3.periods[0]?.periodStart.toISOString(), "总览周期起点必须与调度器一致（2 天）。");

  const cardNewYork = overviewA.characters.find((character) => character.id === aNewYork.id)!;
  const cardTokyo = overviewA.characters.find((character) => character.id === aTokyo.id)!;
  assert.equal(cardNewYork.nextSnapshotLabel, "01-15 18:00", "归档时间必须按角色自己的时区格式化（纽约）。");
  assert.equal(cardTokyo.nextSnapshotLabel, "01-16 08:00", "同一时刻在东京应显示为次日（跨日边界）。");

  assert.equal(overviewA.nextSnapshot?.characterId, a3.id, "「距下次归档」应取最早到期的角色（这里已逾期）。");
  assert(overviewA.nextSnapshot!.remainingMs < 0, "逾期角色的剩余时间必须为负。");
  assert.equal(overviewA.cycle?.dayIndex, 2, "顶部周期摘要应与该角色一致。");
  assert.equal(overviewA.cycle?.totalDays, 2, "顶部周期摘要总天数应与该角色一致。");
  assert.equal(cardA1.cycleMemoryCount, 2, "本周期新增记忆只统计周期开始之后的条目。");

  // ── 5. 停滞告警的口径 ───────────────────────────────────────────────────
  assert.equal(overviewA.watchdog.findings.length, 1, "A 只应有一条停滞告警（A3 逾期且队列为空）。");
  assert.equal(overviewA.watchdog.findings[0]?.code, "scheduler_stalled", "A3 应判定为「没有排期」。");
  assert.equal(overviewA.watchdog.findings[0]?.characterId, a3.id, "告警必须指向逾期角色。");

  console.log(
    "总览验收通过：MANUAL/AUTOMATIC 口径一致、跨用户隔离、管理员全站统计、东八区 7 天用量窗口、未定价与缓存明细计数、周期与调度器一致、角色时区标签、逾期与空状态。",
  );

  // 留档模式：把会话交给外部的 SSR / 浏览器验收用，夹具不清理（库是隔离库，验完直接删库）。
  if (process.env.OVERVIEW_TEST_KEEP === "1") {
    console.log("OVERVIEW_FIXTURE " + JSON.stringify({ userId: userA.id, token: userA.token }));
  }
} finally {
  if (process.env.OVERVIEW_TEST_KEEP !== "1") {
    await cleanup();
  }
  await prisma.$disconnect();
  api.close();
}

async function cleanup(): Promise<void> {
  const ids = createdUserIds.filter(Boolean);
  if (ids.length > 0) {
    // 清理失败不能盖掉真正的断言错误，所以整段 best-effort。
    try {
      const characters = await prisma.character.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
      const characterIds = characters.map((character) => character.id);
      if (characterIds.length > 0) {
        await prisma.modelUsage.deleteMany({ where: { characterId: { in: characterIds } } });
        // 记忆范围与角色的外键是 Restrict，必须先删范围；快照 / 任务 / 记忆条目随范围级联。
        await prisma.memoryScope.deleteMany({ where: { characterId: { in: characterIds } } });
        await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
      }
      await prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    } catch (error) {
      console.warn("[overview-test] 夹具清理失败：", error instanceof Error ? error.message : String(error));
    }
  }
}
