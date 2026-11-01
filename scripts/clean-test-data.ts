import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * 清理本地开发环境里的测试数据。
 *
 * 两种模式：
 *
 * `--usage-only`（推荐日常用）：**只**清理 model_usages 里的测试账单行，不碰任何业务数据。
 *   删除范围：① 角色已不存在的孤儿行；② `model=ci-channel-test` 的行（CI 假模型）。
 *   保留：现存角色的全部账单（删角色时账单按设计保留，那是产品语义，不是脏数据）、
 *   `characterId` 为 null 的行（后台任务/系统调用，没有归属不代表是测试）。
 *
 * 默认模式：清空开发库。
 *   删除范围：
 *     1. 测试角色：名字以「CI 」开头，或等于「id-test-character」。
 *     2. 测试用户：用户名以「id-test-owner-」或「id-test-user-」开头。
 *     3. 运行数据：全部会话、消息、记忆项、快照、快照来源、记忆任务、审计日志、登录尝试、
 *        聊天请求、会话（sessions）清空。
 *
 *   保留：
 *     - local-dev 用户（DEV_OWNER_ID）
 *     - 大肥鱼角色及其 B站连接绑定
 *     - 平台连接、外部身份
 *
 * 用法：
 *   tsx scripts/clean-test-data.ts --usage-only          # 预览孤儿账单
 *   tsx scripts/clean-test-data.ts --usage-only --apply  # 真正删除
 *   tsx scripts/clean-test-data.ts                       # 预览全量清理
 *   tsx scripts/clean-test-data.ts --apply               # 真正执行全量清理
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，请先配置 .env。");

const apply = process.argv.includes("--apply");
const usageOnly = process.argv.includes("--usage-only");
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

/** CI 用的假模型名：不是价目表里的真实模型，出现就一定是测试留下的。 */
const CI_MOCK_MODEL = "ci-channel-test";

const TEST_CHAR_PREFIX = "CI ";
const TEST_CHAR_EXACT = new Set(["id-test-character"]);
/**
 * 测试账号前缀。**新增 db 测试脚本时记得回来登记** —— 漏登记的残留会被这里当成真人账号
 * 跳过去，只能手工捞。`bili-test-` 就是这么漏的：脚本一直在用，名单里没有。
 * 现有测试脚本用到的前缀见 `grep -rh "username: *[\"\`]" scripts/*.ts`。
 */
const TEST_USER_PREFIXES = [
  "id-test-owner-",
  "id-test-user-",
  "scheduler-test-",
  "journal-test-",
  "bili-test-",
  "card-test-",
  "del-test-",
  "group-initiative-test-",
  "onebot-test-",
  "proactive-test-",
  "scope-test-",
];

function isTestCharacter(name: string): boolean {
  return name.startsWith(TEST_CHAR_PREFIX) || TEST_CHAR_EXACT.has(name);
}
function isTestUser(username: string): boolean {
  return TEST_USER_PREFIXES.some((prefix) => username.startsWith(prefix));
}

/**
 * 只清账单噪声（`--usage-only`）。
 *
 * 和全量清理分开，因为风险差着量级：全量清理会删掉所有会话和记忆，
 * 而孤儿账单删错了只影响历史报表。默认只预览，要 `--apply` 才动手。
 */
async function cleanOrphanUsage() {
  const groups = await prisma.modelUsage.groupBy({ by: ["characterId"], _count: { _all: true } });
  const ids = groups.map((group) => group.characterId).filter((id): id is string => Boolean(id));
  const existing = new Set(
    (await prisma.character.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id),
  );
  const orphanIds = ids.filter((id) => !existing.has(id));
  const orphanIdSet = new Set(orphanIds);

  // 两个来源取并集：角色已不存在的行 + CI 假模型的行（后者即使角色还在也一定是测试）。
  const scope = {
    OR: [
      ...(orphanIds.length ? [{ characterId: { in: orphanIds } }] : []),
      { model: CI_MOCK_MODEL },
    ],
  };
  if (!scope.OR.length) {
    console.log("没有需要清理的账单行。");
    return;
  }

  const rows = await prisma.modelUsage.findMany({ where: scope, select: { characterId: true, model: true } });
  const orphanRows = rows.filter((row) => row.characterId !== null && orphanIdSet.has(row.characterId)).length;
  const ciRows = rows.filter((row) => row.model === CI_MOCK_MODEL).length;

  console.log("======================================================");
  console.log("账单清理预览（--usage-only）");
  console.log("======================================================");
  console.log(`角色已不存在：${orphanIds.length} 个角色 → ${orphanRows} 行`);
  console.log(`CI 假模型（${CI_MOCK_MODEL}）：${ciRows} 行`);
  console.log(`去重后共 ${rows.length} 行（两个条件可能重叠）`);
  console.log("保留：现存角色的全部账单、characterId 为 null 的系统调用");
  console.log("======================================================");

  if (!apply) {
    console.log("预览模式。加 --apply 参数真正执行删除。");
    return;
  }

  const deleted = await prisma.modelUsage.deleteMany({ where: scope });
  const after = await prisma.modelUsage.aggregate({ _count: { _all: true }, _sum: { totalTokens: true } });
  console.log(`\n已删除 ${deleted.count} 行。`);
  console.log(`剩余 ${after._count._all} 行 / ${after._sum.totalTokens ?? 0} tokens（全部属于现存角色）。`);
}

async function main() {
  if (usageOnly) {
    await cleanOrphanUsage();
    return;
  }

  // ── 盘点 ──────────────────────────────────────────────
  const allCharacters = await prisma.character.findMany({ select: { id: true, name: true, ownerId: true } });
  const testCharacters = allCharacters.filter((c) => isTestCharacter(c.name));
  const keptCharacters = allCharacters.filter((c) => !isTestCharacter(c.name));

  const allUsers = await prisma.user.findMany({ select: { id: true, username: true, role: true } });
  const testUsers = allUsers.filter((u) => isTestUser(u.username));
  const keptUsers = allUsers.filter((u) => !isTestUser(u.username));

  const testCharacterIds = testCharacters.map((c) => c.id);
  const testUserIds = testUsers.map((u) => u.id);

  // 测试角色/用户关联的会话、记忆范围数量
  const testConversations = testCharacterIds.length
    ? await prisma.conversation.count({ where: { characterId: { in: testCharacterIds } } })
    : 0;
  const testScopes = testCharacterIds.length
    ? await prisma.memoryScope.count({ where: { characterId: { in: testCharacterIds } } })
    : 0;

  const runStats = {
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count(),
    memoryItems: await prisma.memoryItem.count(),
    snapshots: await prisma.memorySnapshot.count(),
    snapshotSources: await prisma.memorySnapshotSource.count(),
    memoryJobs: await prisma.memoryJob.count(),
    auditLogs: await prisma.auditLog.count(),
    loginAttempts: await prisma.loginAttempt.count(),
    chatRequests: await prisma.chatRequest.count(),
    sessions: await prisma.session.count(),
  };

  console.log("======================================================");
  console.log("本地测试数据清理预览");
  console.log("======================================================");
  console.log(`测试角色：${testCharacters.length} 个`);
  for (const c of testCharacters) console.log(`  - ${c.name}`);
  console.log(`保留角色：${keptCharacters.length} 个`);
  for (const c of keptCharacters) console.log(`  - ${c.name}`);
  console.log(`测试用户：${testUsers.length} 个`);
  for (const u of testUsers) console.log(`  - ${u.username} (${u.role})`);
  console.log(`保留用户：${keptUsers.length} 个`);
  for (const u of keptUsers) console.log(`  - ${u.username} (${u.role})`);
  console.log(`测试角色关联的会话：${testConversations}，记忆范围：${testScopes}`);
  console.log("------------------------------------------------------");
  console.log("将清空的运行数据：");
  for (const [k, v] of Object.entries(runStats)) console.log(`  - ${k}: ${v}`);
  console.log("======================================================");

  if (!apply) {
    console.log("预览模式。加 --apply 参数真正执行删除。");
    return;
  }

  // ── 执行 ──────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    // 1. 删测试角色的关联数据（会话 → 记忆范围 → 角色）
    if (testCharacterIds.length) {
      await tx.conversation.deleteMany({ where: { characterId: { in: testCharacterIds } } });
      await tx.memoryScope.deleteMany({ where: { characterId: { in: testCharacterIds } } });
      await tx.character.deleteMany({ where: { id: { in: testCharacterIds } } });
    }

    // 2. 删测试用户（关联的角色已在上面删掉；user 相关外键多 SetNull/Cascade）
    if (testUserIds.length) {
      await tx.user.deleteMany({ where: { id: { in: testUserIds } } });
    }

    // 3. 清空所有运行数据
    await tx.message.deleteMany();
    await tx.conversation.deleteMany();
    await tx.memoryItem.deleteMany();
    await tx.memorySnapshotSource.deleteMany();
    await tx.memorySnapshot.deleteMany();
    await tx.memoryJob.deleteMany();
    await tx.auditLog.deleteMany();
    await tx.loginAttempt.deleteMany();
    await tx.chatRequest.deleteMany();
    await tx.session.deleteMany();
  });

  console.log("\n清理完成。");
  console.log(`已删除测试角色 ${testCharacters.length} 个、测试用户 ${testUsers.length} 个。`);
  console.log("运行数据（会话/消息/记忆/快照/审计日志等）已全部清空。");
  console.log(`保留角色：${keptCharacters.map((c) => c.name).join("、")}；保留用户：${keptUsers.map((u) => u.username).join("、")}。`);
}

main()
  .catch((error) => {
    console.error("清理失败：", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
