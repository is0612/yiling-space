import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { resolveDailyEventWindow, resolveDayWindow } from "../server/utils/memory-event-time";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";
import {
  collectJournalSources,
  generateJournalForDay,
  persistRevision,
  readPreviousJournalLine,
  restoreJournalRevision,
  saveJournalEdit,
} from "../server/utils/journal-service";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，日记/手账数据库测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TIME_ZONE = "Asia/Shanghai";
const diaryV1 = "今天下午其实有点不开心。一开始我觉得自己的想法没有问题，所以主人提出不同意见的时候，我还有点不服气。后来重新看了一遍，才发现他的担心确实有道理。";
const diaryV2 = "今天下午跟主人聊了很久，后来一起把问题解决了。我也松了口气，原来他担心的是另一件事，说开之后就没那么别扭了。明天想再看看改完的效果。";
const quoteV1 = "我还有点不服气";
const quoteV2 = "我也松了口气";

/**
 * 本脚本建出来的东西，清理时要一个不落地删掉。
 *
 * **清理必须放在 finally 里跑**：以前它写在 `main()` 末尾的成功路径上，任何一条 assert
 * 挂掉就直接 `process.exit(1)`，清理整段被跳过 —— 2026-11-01 12:47 就是这样在开发库里
 * 留下了两个 `journal-test-*` 空账号（角色和范围后来被别的清理带走，只剩 user 壳子）。
 * 断言失败是最常见的路径（新加断言还没调通时每次都会挂），所以这不是边角情况。
 */
const createdUserIds: string[] = [];
const createdCharacterIds = new Set<string>();

/** 按依赖顺序回滚：任务/手账/会话挂在范围上，范围被角色挂住。 */
async function cleanup(): Promise<void> {
  const characterIds = [...createdCharacterIds];
  if (!characterIds.length && !createdUserIds.length) return;

  const scopeIds = characterIds.length
    ? (await prisma.memoryScope.findMany({
        where: { characterId: { in: characterIds } },
        select: { id: true },
      })).map((row) => row.id)
    : [];

  if (scopeIds.length) {
    await prisma.memoryJob.deleteMany({ where: { memoryScopeId: { in: scopeIds } } });
    await prisma.characterJournal.deleteMany({ where: { memoryScopeId: { in: scopeIds } } });
    await prisma.conversation.deleteMany({ where: { memoryScopeId: { in: scopeIds } } });
    await prisma.memoryScope.deleteMany({ where: { id: { in: scopeIds } } });
  }
  if (characterIds.length) {
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
}

/**
 * P3-2：把 migration 里的回填 SQL 原样跑在隔离 schema 里，覆盖
 * 两份都有、只有一份、同一天多版本、SKIPPED 无版本、ACTIVE 无版本。
 *
 * 不改动真实表、不删除用户数据；schema 用完即删。
 */
async function verifyJournalStateMigration(): Promise<void> {
  const schema = `journal_migration_${randomUUID().replace(/-/g, "")}`;
  const migration = await readFile(
    join(process.cwd(), "prisma/migrations/20261101130000_journal_job_state/migration.sql"),
    "utf8",
  );
  const journalPart = migration.split("-- 手账任务显式参数")[0]!;
  const statements = journalPart
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement && statement.split("\n").some((line) => line.trim() && !line.trim().startsWith("--")));
  const bothId = randomUUID();
  const onlyDiaryId = randomUUID();
  const onlyHandbookId = randomUUID();
  const skippedId = randomUUID();
  const activeNoRevisionsId = randomUUID();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE "character_journals" (
          "id" uuid PRIMARY KEY,
          "status" text NOT NULL,
          "updatedAt" timestamptz NOT NULL
        )
      `);
      await tx.$executeRawUnsafe(`
        CREATE TABLE "journal_revisions" (
          "id" uuid PRIMARY KEY,
          "journalId" uuid NOT NULL,
          "kind" text NOT NULL,
          "createdAt" timestamptz NOT NULL
        )
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "${schema}"."character_journals" ("id", "status", "updatedAt") VALUES
          ('${bothId}', 'ACTIVE', '2026-10-31T12:00:00Z'),
          ('${onlyDiaryId}', 'ACTIVE', '2026-10-31T12:00:00Z'),
          ('${onlyHandbookId}', 'ACTIVE', '2026-10-31T12:00:00Z'),
          ('${skippedId}', 'SKIPPED', '2026-10-31T12:00:00Z'),
          ('${activeNoRevisionsId}', 'ACTIVE', '2026-10-31T12:00:00Z')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "${schema}"."journal_revisions" ("id", "journalId", "kind", "createdAt") VALUES
          ('${randomUUID()}', '${bothId}', 'DIARY', '2026-10-31T10:00:00Z'),
          ('${randomUUID()}', '${bothId}', 'DIARY', '2026-10-31T11:00:00Z'),
          ('${randomUUID()}', '${bothId}', 'HANDBOOK', '2026-10-31T09:00:00Z'),
          ('${randomUUID()}', '${onlyDiaryId}', 'DIARY', '2026-10-31T08:00:00Z'),
          ('${randomUUID()}', '${onlyHandbookId}', 'HANDBOOK', '2026-10-31T08:00:00Z')
      `);
      for (const statement of statements) {
        await tx.$executeRawUnsafe(statement);
      }
      const rows = await tx.$queryRawUnsafe<Array<{
        id: string;
        diaryState: string;
        handbookState: string;
        diaryDecidedAt: Date | null;
        handbookDecidedAt: Date | null;
      }>>(`
        SELECT "id", "diaryState", "handbookState", "diaryDecidedAt", "handbookDecidedAt"
        FROM "${schema}"."character_journals"
        ORDER BY "id"
      `);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const both = byId.get(bothId)!;
      assert.equal(both.diaryState, "GENERATED");
      assert.equal(both.handbookState, "GENERATED");
      assert.equal(both.diaryDecidedAt?.toISOString(), "2026-10-31T11:00:00.000Z", "同一天多版本取最新一版时间");
      assert.equal(both.handbookDecidedAt?.toISOString(), "2026-10-31T09:00:00.000Z");

      const onlyDiary = byId.get(onlyDiaryId)!;
      assert.equal(onlyDiary.diaryState, "GENERATED");
      assert.equal(onlyDiary.handbookState, "PENDING", "没有手账版本时手账保持 PENDING");

      const onlyHandbook = byId.get(onlyHandbookId)!;
      assert.equal(onlyHandbook.diaryState, "PENDING", "没有日记版本时日记保持 PENDING");
      assert.equal(onlyHandbook.handbookState, "GENERATED");

      const skipped = byId.get(skippedId)!;
      assert.equal(skipped.diaryState, "SKIPPED");
      assert.equal(skipped.handbookState, "SKIPPED");
      assert.equal(skipped.diaryDecidedAt?.toISOString(), "2026-10-31T12:00:00.000Z");

      const activeNoRevisions = byId.get(activeNoRevisionsId)!;
      assert.equal(activeNoRevisions.diaryState, "PENDING");
      assert.equal(activeNoRevisions.handbookState, "PENDING");
    });
  } finally {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

async function main() {
  const ownerId = randomUUID();
  const characterId = randomUUID();
  const dayKey = resolveDailyEventWindow(new Date(), TIME_ZONE).dayKey;

  await prisma.user.create({
    data: { id: ownerId, username: `journal-test-${randomUUID().slice(0, 8)}`, passwordHash: "test", role: "USER" },
  });
  createdUserIds.push(ownerId);
  await prisma.character.create({
    data: { id: characterId, ownerId, name: "journal-test-character", basePrompt: "test persona" },
  });
  createdCharacterIds.add(characterId);
  const scope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
  });

  // 1. 那天没有对话：不生成正文，落一条 SKIPPED 标记并写清原因
  const empty = await generateJournalForDay({ characterId, dayKey, mode: "manual" }, prisma);
  assert.equal(empty.status, "skipped");
  const skipped = await prisma.characterJournal.findUnique({
    where: { memoryScopeId_dayKey: { memoryScopeId: scope.id, dayKey } },
  });
  assert.equal(skipped?.status, "SKIPPED");
  assert.equal(skipped?.skipReason, "这一天没有对话或忆泡");

  // 2. 人工写日记：第 1 版 DIARY
  const diary = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "DIARY",
    title: "有点小别扭的一天",
    content: diaryV1,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(diary.ok, true);
  if (!diary.ok) throw new Error("diary edit failed");
  assert.equal(diary.revision.kind, "DIARY");
  assert.equal(diary.revision.version, 1);
  assert.equal(diary.revision.revisionType, "USER_EDITED");

  // 3. 人工写手账：第 1 版 HANDBOOK，一句引用第 1 版日记
  const handbook = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 下午跟主人讨论项目，意见不太一样。\n- 晚上一起把问题改好了。\n\n## 灵感与发现\n- 分歧不等于否定。\n\n## 待续事项\n- 明天再看看改完的效果。",
    thought: "坚持自己的想法没错，但也应该认真听听别人的意见。",
    quote: quoteV1,
    tags: ["项目", "自我反思"],
    actorUserId: ownerId,
  }, prisma);
  assert.equal(handbook.ok, true);
  if (!handbook.ok) throw new Error("handbook edit failed");
  assert.equal(handbook.revision.kind, "HANDBOOK");
  assert.equal(handbook.revision.version, 1, "两种文本各自排版本号，手账也是第 1 版");
  assert.equal(handbook.revision.sourceDiaryRevisionId, diary.revision.id, "一句要指向它引用的那版日记");
  assert.deepEqual(handbook.revision.tags, ["项目", "自我反思"]);

  // 4. 只改日记：日记出第 2 版，手账仍是第 1 版、仍指向第 1 版日记
  const diarySecond = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "DIARY",
    content: diaryV2,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(diarySecond.ok, true);
  if (!diarySecond.ok) throw new Error("diary second edit failed");
  assert.equal(diarySecond.revision.version, 2);
  const handbookAfter = await prisma.journalRevision.findFirst({
    where: { journalId: diary.revision.journalId, kind: "HANDBOOK" },
    orderBy: { version: "desc" },
  });
  assert.equal(handbookAfter?.version, 1, "改日记不能动到手账版本");
  assert.equal(handbookAfter?.sourceDiaryRevisionId, diary.revision.id, "手账仍指向当时引用的日记版本");

  // 5. 手账的一句不在任何一版日记里：拒绝
  const invalid = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 随便写一条。",
    quote: "今天真是充实的一天",
    actorUserId: ownerId,
  }, prisma);
  assert.equal(invalid.ok, false);
  if (invalid.ok) throw new Error("invalid quote should be rejected");
  assert.match(invalid.message, /日记正文/);

  // 6. 换成第 2 版日记里的原话：手账出第 2 版，并改为指向第 2 版日记
  const handbookSecond = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 下午聊了很久，最后一起把问题解决了。",
    thought: "问题解决了，人也松下来。",
    quote: quoteV2,
    tags: ["项目"],
    actorUserId: ownerId,
  }, prisma);
  assert.equal(handbookSecond.ok, true);
  if (!handbookSecond.ok) throw new Error("handbook second edit failed");
  assert.equal(handbookSecond.revision.version, 2);
  assert.equal(handbookSecond.revision.sourceDiaryRevisionId, diarySecond.revision.id);

  // 7. 恢复第 1 版日记：新建第 3 版 RESTORED，手账保持第 2 版不动
  const restored = await restoreJournalRevision({
    characterId,
    dayKey,
    kind: "DIARY",
    version: 1,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(restored.ok, true);
  if (!restored.ok) throw new Error("restore failed");
  assert.equal(restored.revision.kind, "DIARY");
  assert.equal(restored.revision.version, 3);
  assert.equal(restored.revision.revisionType, "RESTORED");
  const handbookStill = await prisma.journalRevision.findFirst({
    where: { journalId: diary.revision.journalId, kind: "HANDBOOK" },
    orderBy: { version: "desc" },
  });
  assert.equal(handbookStill?.version, 2, "恢复日记不能改手账");

  // 8. 次日对话读到的是手账的「一句」
  const line = await readPreviousJournalLine(prisma, characterId, new Date(), TIME_ZONE);
  assert.ok(line, "应能读到昨天的日记/手账");
  assert.equal(line?.dayKey, dayKey);
  assert.equal(line?.quote, quoteV2);

  // 8.1 用户把手账的「一句」清掉后，次日不能拿旧版本的句子顶上
  const cleared = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 今天就这样。",
    thought: "没有特别想留的一句话。",
    quote: null,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(cleared.ok, true);
  assert.equal(await readPreviousJournalLine(prisma, characterId, new Date(), TIME_ZONE), null);

  // 8.2 恢复带那句话的手账版本，句子回来
  const restoredHandbook = await restoreJournalRevision({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    version: 2,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(restoredHandbook.ok, true);
  const lineBack = await readPreviousJournalLine(prisma, characterId, new Date(), TIME_ZONE);
  assert.equal(lineBack?.quote, quoteV2);

  // 9. 版本唯一约束按 (journal, kind, version)：同 kind 重复版本失败
  let dupVersion = false;
  try {
    await prisma.journalRevision.create({
      data: {
        journalId: diary.revision.journalId,
        kind: "DIARY",
        version: 1,
        content: diaryV1,
        revisionType: "AI_GENERATED",
      },
    });
  } catch {
    dupVersion = true;
  }
  assert.ok(dupVersion, "同一份文本的版本号重复应失败");

  // 10. 删日期主体时两份文本的版本一起级联删除
  await prisma.characterJournal.delete({ where: { id: diary.revision.journalId } });
  const left = await prisma.journalRevision.count({ where: { journalId: diary.revision.journalId } });
  assert.equal(left, 0, "删日记/手账应级联删版本");

  // 11. 调度器：昨天有对话、还没有日记/手账时，应该排一个 GENERATE_JOURNAL 任务
  const scheduledCharacterId = randomUUID();
  await prisma.character.create({
    data: { id: scheduledCharacterId, ownerId, name: "journal-scheduled-character", basePrompt: "test persona" },
  });
  createdCharacterIds.add(scheduledCharacterId);
  const scheduledScope = await prisma.memoryScope.create({
    data: { characterId: scheduledCharacterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${scheduledCharacterId}:global` },
  });
  const scheduledConversation = await prisma.conversation.create({
    data: { characterId: scheduledCharacterId, memoryScopeId: scheduledScope.id, title: "手账调度测试" },
    select: { id: true },
  });
  await prisma.message.create({
    data: {
      conversationId: scheduledConversation.id,
      role: "USER",
      content: "昨天聊了一会儿。",
      occurredAt: new Date(resolveDayWindow(dayKey, TIME_ZONE).start.getTime() + 12 * 60 * 60_000),
    },
  });
  await prisma.characterMemorySetting.create({
    data: {
      characterId: scheduledCharacterId,
      timezone: TIME_ZONE,
      autoSnapshotEnabled: true,
      anchorAt: new Date(),
      nextSnapshotAt: new Date(Date.now() + 100 * 24 * 60 * 60_000),
    },
  });
  const report = await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId });
  const journalJob = await prisma.memoryJob.findFirst({
    where: { memoryScopeId: scheduledScope.id, type: "GENERATE_JOURNAL" },
    select: { idempotencyKey: true, journalDayKey: true, journalTarget: true },
  });
  assert.ok(journalJob, "昨天有对话时应排出手账任务");
  assert.equal(journalJob?.idempotencyKey, `journal:${scheduledScope.id}:${dayKey}`);
  assert.equal(journalJob?.journalDayKey, dayKey, "任务必须带显式日期，不能靠幂等键猜");
  assert.equal(journalJob?.journalTarget, "BOTH", "两份都缺时目标是 BOTH");
  assert.ok(report.jobsQueued >= 1);

  /**
   * 12. P1-1：关掉「自动生成阶段总结」不能连带停掉日记/手账。
   * 13. P1-2：只剩一种文本时，另一份要能补齐（幂等键带缺的那一种）。
   * 两个用例共用一套脚手架，只改设置与已有版本。
   */
  const buildJournalScaffold = async (label: string, autoSnapshotEnabled: boolean) => {
    const characterId = randomUUID();
    await prisma.character.create({
      data: { id: characterId, ownerId, name: `journal-${label}`, basePrompt: "test persona" },
    });
    createdCharacterIds.add(characterId);
    const scope = await prisma.memoryScope.create({
      data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
      select: { id: true },
    });
    const conversation = await prisma.conversation.create({
      data: { characterId, memoryScopeId: scope.id, title: `手账 ${label}` },
      select: { id: true },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content: "昨天聊了一会儿。",
        occurredAt: new Date(resolveDayWindow(dayKey, TIME_ZONE).start.getTime() + 12 * 60 * 60_000),
      },
    });
    await prisma.characterMemorySetting.create({
      data: {
        characterId,
        timezone: TIME_ZONE,
        autoSnapshotEnabled,
        anchorAt: new Date(),
        nextSnapshotAt: new Date(Date.now() + 100 * 24 * 60 * 60_000),
      },
    });
    return { characterId, scopeId: scope.id };
  };

  // 12. autoSnapshotEnabled = false：阶段总结不排，日记/手账照排。
  const disabled = await buildJournalScaffold("snapshot-off", false);
  await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId });
  const journalUnderDisabled = await prisma.memoryJob.findFirst({
    where: { memoryScopeId: disabled.scopeId, type: "GENERATE_JOURNAL" },
    select: { idempotencyKey: true },
  });
  assert.ok(journalUnderDisabled, "关掉阶段总结后，日记/手账仍应排程（P1-1）");
  assert.equal(
    await prisma.memoryJob.count({
      where: { memoryScopeId: disabled.scopeId, type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT"] } },
    }),
    0,
    "关掉阶段总结后不应再排快照任务",
  );

  // 13. 只有 DIARY：调度器要补 HANDBOOK。
  const partial = await buildJournalScaffold("diary-only", true);
  const partialJournal = await prisma.characterJournal.create({
    data: {
      memoryScopeId: partial.scopeId,
      dayKey,
      status: "ACTIVE",
      revisions: {
        create: { kind: "DIARY", version: 1, revisionType: "AI_GENERATED", content: "只写了日记的那一天。", sourceMessageIds: [], sourceEventIds: [] },
      },
    },
    select: { id: true },
  });
  await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId });
  const handbookFillJob = await prisma.memoryJob.findFirst({
    where: { memoryScopeId: partial.scopeId, type: "GENERATE_JOURNAL" },
    select: { idempotencyKey: true, status: true, journalDayKey: true, journalTarget: true },
  });
  assert.ok(handbookFillJob, "只有日记时仍应排任务补齐手账（P1-2）");
  assert.equal(
    handbookFillJob?.idempotencyKey,
    `journal:${partial.scopeId}:${dayKey}:HANDBOOK`,
    "补齐任务要用带 kind 的幂等键，否则会被首轮任务占住",
  );
  assert.equal(handbookFillJob?.journalDayKey, dayKey);
  assert.equal(handbookFillJob?.journalTarget, "HANDBOOK", "补齐任务必须显式说明只补手账");
  // 再扫一遍不能重复造任务。
  await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId });
  assert.equal(
    await prisma.memoryJob.count({ where: { memoryScopeId: partial.scopeId, type: "GENERATE_JOURNAL" } }),
    1,
    "重复扫描不应重复排同类补齐任务",
  );
  // 两份都在时不再排。
  await prisma.journalRevision.create({
    data: { journalId: partialJournal.id, kind: "HANDBOOK", version: 1, revisionType: "AI_GENERATED", content: "## 片段\n补齐了。", tags: [] },
  });
  await prisma.memoryJob.deleteMany({ where: { memoryScopeId: partial.scopeId, type: "GENERATE_JOURNAL" } });
  await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId });
  assert.equal(
    await prisma.memoryJob.count({ where: { memoryScopeId: partial.scopeId, type: "GENERATE_JOURNAL" } }),
    0,
    "两份文本都在时不应再排任务",
  );

  // 12. 清理（第二组角色 + 任务）
  await prisma.memoryJob.deleteMany({ where: { memoryScopeId: scheduledScope.id } });
  await prisma.conversation.deleteMany({ where: { memoryScopeId: scheduledScope.id } });
  await prisma.memoryScope.deleteMany({ where: { characterId: scheduledCharacterId } });
  await prisma.character.delete({ where: { id: scheduledCharacterId } });

  console.log("✅ test-journal-db 全部通过");
  console.log("   日记 / 手账独立版本：改一份不动另一份");
  console.log("   一句追溯：指向被引用的那一版日记");
  console.log("   恢复 / 次日读取 / 唯一约束 / 级联删除 / 调度器");

  // 14. P1-4：并发写入只留一版（auto/manual），regenerate 仍能追加。
  const concurrent = await buildJournalScaffold("concurrent", true);
  const persistInput = {
    globalScopeId: concurrent.scopeId,
    dayKey,
    kind: "DIARY" as const,
    mode: "manual" as const,
    title: "并发测试",
    content: "并发写入的正文。",
    sourceMessageIds: [],
    sourceEventIds: [],
    model: "test-model",
    promptVersion: "journal-diary-v2",
  };
  const [firstWrite, secondWrite] = await Promise.all([
    persistRevision(prisma, persistInput),
    persistRevision(prisma, persistInput),
  ]);
  const diaryRevisions = await prisma.journalRevision.count({
    where: { journal: { is: { memoryScopeId: concurrent.scopeId, dayKey } }, kind: "DIARY" },
  });
  assert.equal(diaryRevisions, 1, "两个并发写入只能留下一个 DIARY 版本（P1-4）");
  assert.equal(
    [firstWrite.reused, secondWrite.reused].filter(Boolean).length,
    1,
    "并发写入里应该恰好一个是新建、一个是复用",
  );
  assert.equal(
    firstWrite.revision.content,
    secondWrite.revision.content,
    "复用方拿到的应是同一个版本，而不是自己再写一份",
  );
  // 另一份文本不受影响。
  assert.equal(
    await prisma.journalRevision.count({
      where: { journal: { is: { memoryScopeId: concurrent.scopeId, dayKey } }, kind: "HANDBOOK" },
    }),
    0,
    "写 DIARY 不应顺手创建 HANDBOOK",
  );
  // regenerate：明确要求重写时仍要追加新版本。
  const [rewriteA, rewriteB] = await Promise.all([
    persistRevision(prisma, { ...persistInput, mode: "regenerate" }),
    persistRevision(prisma, { ...persistInput, mode: "regenerate" }),
  ]);
  assert.equal(rewriteA.reused || rewriteB.reused, false, "regenerate 不应走复用分支");
  assert.equal(
    await prisma.journalRevision.count({
      where: { journal: { is: { memoryScopeId: concurrent.scopeId, dayKey } }, kind: "DIARY" },
    }),
    3,
    "两次 regenerate 各自追加一版（1 + 2），版本号互不覆盖",
  );

  /**
   * 15. P1-3 回归：群聊发言人必须真的进到喂给模型的那份数组里。
   *
   * 之前从 metadata 读到了 speaker/member，但 collectJournalSources 最后又重新组装
   * 了一份对象、把这两个字段漏掉 —— 类型检查发现不了，只有断言这一步能挡住。
   */
  const speakerScaffold = await buildJournalScaffold("speaker", true);
  const groupConversation = await prisma.conversation.create({
    data: {
      characterId: speakerScaffold.characterId,
      memoryScopeId: speakerScaffold.scopeId,
      externalConversationId: "g:987654321",
      title: "QQ群 987654321",
    },
    select: { id: true },
  });
  const dayStart = resolveDayWindow(dayKey, TIME_ZONE).start.getTime();
  await prisma.message.createMany({
    data: [
      {
        conversationId: groupConversation.id,
        role: "USER",
        content: "我昨天去旅行了。",
        occurredAt: new Date(dayStart + 11 * 60 * 60_000),
        metadata: { authorDisplayName: "群友A", member: "member_2", mentionTargets: ["other"] },
      },
      {
        conversationId: groupConversation.id,
        role: "USER",
        content: "最近心情不太好。",
        occurredAt: new Date(dayStart + 11 * 60 * 60_000 + 60_000),
        metadata: { authorDisplayName: "群友B", member: "member_3" },
      },
      {
        conversationId: groupConversation.id,
        role: "USER",
        content: "今天工作很累。",
        occurredAt: new Date(dayStart + 11 * 60 * 60_000 + 120_000),
        metadata: { authorDisplayName: "主人", isOwner: true },
      },
      {
        conversationId: groupConversation.id,
        role: "ASSISTANT",
        content: "大家今天都聊了很多。",
        occurredAt: new Date(dayStart + 11 * 60 * 60_000 + 180_000),
      },
    ],
  });
  const journalSources = await collectJournalSources(prisma, {
    scopeIds: [speakerScaffold.scopeId],
    dayKey,
    timeZone: TIME_ZONE,
  });
  const traveler = journalSources.messages.find((message) => message.content.includes("去旅行"));
  assert.equal(traveler?.speaker, "群友A", "群友 A 的发言必须带上 speaker");
  assert.equal(traveler?.member, "member_2", "群成员的稳定代号也要带上");
  const sadOne = journalSources.messages.find((message) => message.content.includes("心情不太好"));
  assert.equal(sadOne?.speaker, "群友B", "不同群成员要能区分开，不能都变成 USER");
  const ownerMessage = journalSources.messages.find((message) => message.content.includes("工作很累"));
  assert.equal(ownerMessage?.isOwner, true, "主人的发言仍要标 isOwner");
  assert.equal(ownerMessage?.speaker, "主人", "主人的显示名也要带");
  const selfMessage = journalSources.messages.find((message) => message.content.includes("聊了很多"));
  assert.equal(selfMessage?.speaker, undefined, "她自己说的那句不带 speaker，靠 role 区分");
  // P2-2：人工编辑与 AI 生成共用同一套日记有效性校验。
  const shortDiaryScaffold = await buildJournalScaffold("short-diary", true);
  await prisma.characterJournal.create({
    data: { memoryScopeId: shortDiaryScaffold.scopeId, dayKey, status: "ACTIVE" },
  });
  const shortDiary = await saveJournalEdit({
    characterId: shortDiaryScaffold.characterId,
    dayKey,
    kind: "DIARY",
    content: "今天有点累，想早点睡。",
    actorUserId: ownerId,
  }, prisma);
  assert.equal(shortDiary.ok, true, "短而完整的日记应能人工保存");
  const blankDiary = await saveJournalEdit({
    characterId: shortDiaryScaffold.characterId,
    dayKey,
    kind: "DIARY",
    content: "   \n  ",
    actorUserId: ownerId,
  }, prisma);
  assert.equal(blankDiary.ok, false, "空白日记仍要拒绝");

  // P3-2：隔离 schema 里验证 migration 的状态回填结果。
  await verifyJournalStateMigration();
}

// 清理一律走 finally：成功和失败都跑同一段，不再有两套容易漂移的逻辑。
main()
  .then(async () => {
    await cleanup();
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("❌ test-journal-db 失败：", error);
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("⚠️ 测试数据回滚失败，库里可能残留 journal-test-* 数据，需要手动清理：", cleanupError);
    }
    await prisma.$disconnect();
    process.exit(1);
  });
