import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { loadBiliConnections, BILI_DUTY_DEFAULTS } from "../server/utils/channel-adapter/bili/configure";
import { acquireBiliDutyLease, BiliDutyLeaseLostError } from "../server/utils/channel-adapter/bili/bili-duty-lease";
import { runDutyRound } from "../server/utils/channel-adapter/bili/duty-pipeline";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，B站 渠道数据库测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
(globalThis as Record<string, unknown>).__yilingPrisma = prisma;
const contenderPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/**
 * 本脚本建过的东西，清理时要一个不落地删掉。
 *
 * **清理必须兜底**：以前它写在 `main()` 末尾的成功路径上，`main().catch()` 里直接
 * `process.exit(1)`，断言一挂清理就整段跳过。`test-journal-db` 就是这样在开发库里
 * 留下过空账号（2026-11-01），这个脚本是同一个写法，还会额外留下平台连接和判重表。
 *
 * 而且它的用户名前缀 `bili-test-` **不在** `clean-test-data.ts` 的清理名单里，
 * 漏了只能手工捞 —— 更不能指望事后补救。
 */
const createdUserIds: string[] = [];
const createdCharacterIds = new Set<string>();
const createdConnectionIds: string[] = [];
const createdBindingIds: string[] = [];

/** 按依赖顺序回滚：判重表挂 binding，范围挂角色，binding 挂角色和连接。 */
async function cleanup(): Promise<void> {
  const characterIds = [...createdCharacterIds];
  if (!characterIds.length && !createdUserIds.length && !createdConnectionIds.length) return;

  // 判重表 → 绑定：CharacterChannelBinding 被角色 Restrict 挂住，必须先走。
  if (createdBindingIds.length) {
    await prisma.biliSeenVideo.deleteMany({ where: { bindingId: { in: createdBindingIds } } });
    await prisma.biliRoundReport.deleteMany({ where: { bindingId: { in: createdBindingIds } } });
    await prisma.characterChannelBinding.deleteMany({ where: { id: { in: createdBindingIds } } });
  }
  if (characterIds.length) {
    const scopeIds = (await prisma.memoryScope.findMany({
      where: { characterId: { in: characterIds } },
      select: { id: true },
    })).map((row) => row.id);
    if (scopeIds.length) {
      await prisma.memoryItem.deleteMany({ where: { memoryScopeId: { in: scopeIds } } });
      await prisma.memoryScope.deleteMany({ where: { id: { in: scopeIds } } });
    }
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
  }
  if (createdConnectionIds.length) {
    await prisma.platformConnection.deleteMany({ where: { id: { in: createdConnectionIds } } });
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
}

async function main() {
  const ownerId = randomUUID();
  const characterId = randomUUID();
  const connectionId = randomUUID();
  const bindingId = randomUUID();

  // 建最小依赖：用户 → 角色 → 连接 → 绑定
  await prisma.user.create({
    data: {
      id: ownerId,
      username: `bili-test-${randomUUID().slice(0, 8)}`,
      passwordHash: "test",
      role: "USER",
    },
  });
  createdUserIds.push(ownerId);
  const character = await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
      name: "bili-test-character",
      basePrompt: "test persona",
    },
  });
  createdCharacterIds.add(characterId);
  const connection = await prisma.platformConnection.create({
    data: {
      id: connectionId,
      platform: "bili",
      displayName: "bili-test-connection",
      metadata: {
        dataHome: "/tmp/bili-test",
        biliBin: "bili",
        duty: { perDay: 3, keywords: ["DeepSeek"], zone: "tech", dmMode: "both" },
      },
    },
  });
  createdConnectionIds.push(connectionId);
  await prisma.characterChannelBinding.create({
    data: {
      id: bindingId,
      characterId,
      connectionId,
    },
  });
  createdBindingIds.push(bindingId);

  // 0. 数据库值班锁：两套 Prisma Client 并发争抢时只有一个能拿到。
  const simultaneous = await Promise.all([
    acquireBiliDutyLease(prisma, bindingId),
    acquireBiliDutyLease(contenderPrisma, bindingId),
  ]);
  const winners = simultaneous.filter((lease) => lease !== null);
  assert.equal(winners.length, 1, "两个独立 Prisma Client 同时认领同一 binding，必须只有一个成功。");
  const firstLease = winners[0]!;
  const blockedLease = await acquireBiliDutyLease(
    simultaneous[0] === null ? prisma : contenderPrisma,
    bindingId,
  );
  assert.equal(blockedLease, null, "租约有效期间，第三次认领必须被拒绝。");

  // 模拟持有进程崩溃：过期后新实例可接管，但旧 token 不能续租或释放新租约。
  await prisma.biliDutyLease.update({
    where: { bindingId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const takeoverLease = await acquireBiliDutyLease(contenderPrisma, bindingId);
  assert(takeoverLease, "过期租约必须允许新实例接管。");
  assert.notEqual(takeoverLease.token, firstLease.token, "接管必须生成新的 fencing token。");
  await assert.rejects(
    firstLease.assertOwned(),
    (error: unknown) => error instanceof BiliDutyLeaseLostError,
    "旧执行者不能在锁已接管后继续认为自己拥有执行权。",
  );
  assert.equal(await firstLease.release(), false, "旧执行者不能删除新执行者的租约。");
  assert.equal(
    (await prisma.biliDutyLease.findUnique({ where: { bindingId } }))?.token,
    takeoverLease.token,
    "旧 token 释放后，新 token 必须仍留在数据库中。",
  );
  assert.equal(await takeoverLease.release(), true, "当前持有者应能正常释放租约。");
  assert.equal(await prisma.biliDutyLease.findUnique({ where: { bindingId } }), null, "释放后租约行应删除。");

  // 1. BiliSeenVideo 写入 + 唯一约束幂等（同 binding 同 bvid 第二次 upsert 不新增）
  const seen = await prisma.biliSeenVideo.create({
    data: { bindingId, bvid: "BV1TEST000000001", title: "测试视频", author: "测试UP", result: "picked", reason: "值得" },
  });
  assert.equal(seen.bvid, "BV1TEST000000001");

  // 重复创建应触发唯一约束错误
  let dupError = false;
  try {
    await prisma.biliSeenVideo.create({
      data: { bindingId, bvid: "BV1TEST000000001", title: "重复", author: "x", result: "skipped" },
    });
  } catch {
    dupError = true;
  }
  assert.ok(dupError, "同 binding 同 bvid 重复写入应失败（唯一约束）");

  // 2. BiliRoundReport 写入 + 唯一约束（bindingId+day+roundIndex）
  const report = await prisma.biliRoundReport.create({
    data: { bindingId, day: "2026-10-25", roundIndex: 1, pickedCount: 1, content: "### BV1TEST000000001\n值得一看" },
  });
  assert.equal(report.pickedCount, 1);

  // 3. loadBiliConnections 能加载配置并解析 duty 默认值/覆盖值
  const records = await loadBiliConnections();
  const record = records.find((r) => r.id === connectionId);
  assert.ok(record, "应能加载 B站 连接");
  assert.equal(record?.duty.perDay, 3);
  assert.deepEqual(record?.duty.keywords, ["DeepSeek"]);
  assert.equal(record?.duty.zone, "tech");
  assert.equal(record?.duty.dmMode, "both");
  assert.equal(record?.duty.autoComment, BILI_DUTY_DEFAULTS.autoComment); // 未配置的用默认值
  assert.equal(record?.bindings.length, 1);

  // 高层入口在抢锁失败时必须直接返回，不能先读取模型配置或启动 bili CLI。
  const heldForRound = await acquireBiliDutyLease(contenderPrisma, bindingId);
  assert(heldForRound, "测试需要先持有该 binding 的租约。");
  const skippedRound = await runDutyRound(record!, { id: bindingId, characterId });
  assert.equal(skippedRound.ok, false);
  assert.equal(skippedRound.error, "已有值班轮次正在执行", "手动/定时共用的入口必须识别数据库锁冲突。");
  assert.equal(skippedRound.picked, 0);
  assert.equal(await heldForRound.release(), true, "测试结束后释放模拟占用的租约。");

  // 4. 默认值正确性
  assert.equal(BILI_DUTY_DEFAULTS.perDay, 5);
  assert.equal(BILI_DUTY_DEFAULTS.zone, "all");
  assert.equal(BILI_DUTY_DEFAULTS.dmMode, "only");

  // 5. 札记：落在角色全局长期记忆，按 binding 前缀能查回；软删除后不再出现在列表
  const scope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
  });
  const journal = await prisma.memoryItem.create({
    data: {
      memoryScopeId: scope.id,
      category: "EVENT",
      content: "我在 B站 看了 3 条视频，挑中了 1 条。",
      confidence: 1,
      dedupeKey: `bili-journal:${bindingId}:test`,
      validFrom: new Date(),
    },
  });
  const journalled = await prisma.memoryItem.findMany({
    where: {
      memoryScopeId: scope.id,
      deletedAt: null,
      OR: [
        { dedupeKey: { startsWith: `bili-duty:${bindingId}:` } },
        { dedupeKey: { startsWith: `bili-journal:${bindingId}:` } },
      ],
    },
  });
  assert.equal(journalled.length, 1, "札记必须能按 binding 前缀查回。");
  await prisma.memoryItem.update({
    where: { id: journal.id },
    data: { status: "TRASHED", statusBeforeTrash: journal.status, deletedAt: new Date() },
  });
  const afterDelete = await prisma.memoryItem.findMany({
    where: { memoryScopeId: scope.id, deletedAt: null, dedupeKey: { startsWith: `bili-journal:${bindingId}:` } },
  });
  assert.equal(afterDelete.length, 0, "软删除后的札记不再出现在列表。");

  console.log("✅ test-bili-db 全部通过");
  console.log(`   判重表唯一约束幂等：通过`);
  console.log(`   值班配置解析（覆盖 + 默认）：通过`);
  console.log(`   札记写入 / 查询 / 软删除：通过`);
  console.log("   B站值班数据库锁（并发唯一认领 / 过期接管 / token fencing / 正确释放）：通过");
}

// 清理一律走同一条路径：成功和失败都跑，不再有两套容易漂移的逻辑。
main()
  .then(async () => {
    await cleanup();
    await contenderPrisma.$disconnect();
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("❌ test-bili-db 失败：", error);
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("⚠️ 测试数据回滚失败，库里可能残留 bili-test-* 数据，需要手动清理：", cleanupError);
    }
    await contenderPrisma.$disconnect();
    await prisma.$disconnect();
    process.exit(1);
  });
