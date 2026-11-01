/**
 * 排查「某个角色删掉之后，还有没有留着她的数据」。
 *
 * 用法：
 *   tsx scripts/check-deleted-character.ts 小鲸鱼i        # 按名字找
 *   tsx scripts/check-deleted-character.ts 2013b2f2-...   # 直接给 id
 *
 * 名字未必还能查到 —— 角色行都没了，`characters` 表里当然搜不到。
 * 所以名字这条路要先翻审计日志（导入/导出/删除都写了一条，details 里带名字），
 * 从里面把角色 id 捞出来，再逐表核对。
 *
 * 这是排查工具，不是清理工具；清理用 `cleanup-character-orphans.ts`。
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needle = (process.argv[2] ?? "").trim();
if (!needle) throw new Error("用法：tsx scripts/check-deleted-character.ts <角色名或角色 id>");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL。");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const ids = new Set<string>();

if (UUID_PATTERN.test(needle)) {
  ids.add(needle);
} else {
  // 1. 还活着的同名角色
  const alive = await prisma.character.findMany({
    where: { name: { contains: needle, mode: "insensitive" } },
    select: { id: true, name: true, createdAt: true },
  });
  console.log(`存活角色里名字含「${needle}」的：${alive.length} 个`);
  for (const row of alive) {
    ids.add(row.id);
    console.log(`  - ${row.name}  ${row.id}  ${row.createdAt.toISOString()}`);
  }

  // 2. 已经删掉的，只能在审计里找：details 里带名字的那几条，
  //    加上它前后紧挨着的 character.* 事件（同一个角色的导入/导出/删除都挨在一起）。
  const logs = await prisma.auditLog.findMany({
    where: { action: { startsWith: "character." } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, action: true, characterId: true, entityId: true, createdAt: true, details: true },
  });
  const hits = logs.filter((log) => JSON.stringify(log.details ?? {}).includes(needle));
  console.log(`\n审计日志里提到「${needle}」的：${hits.length} 条`);
  for (const log of hits) {
    console.log(`  ${log.createdAt.toISOString()} ${log.action}  entity=${log.entityId ?? "-"}`);
    console.log(`    ${JSON.stringify(log.details ?? {}).slice(0, 300)}`);
    for (const value of [log.entityId, log.characterId]) {
      if (value && UUID_PATTERN.test(value)) ids.add(value);
    }
  }
  if (hits.length === 0) {
    console.log("  （没找到。可能是这次删除发生在我加 character.deleted 审计之前，");
    console.log("    导入那条审计的 details.sourceCharacterName 里应该有名字 —— 换成那个名字再试。）");
  }
}

if (ids.size === 0) {
  console.log("\n没能定位到角色 id，无法逐表核对。");
  await prisma.$disconnect();
  process.exit(0);
}

const idList = [...ids];
console.log(`\n开始核对 ${idList.length} 个角色 id：${idList.join(", ")}`);

const tables: [string, boolean, () => Promise<number>][] = [
  ["characters", false, () => prisma.character.count({ where: { id: { in: idList } } })],
  ["memory_scopes", false, () => prisma.memoryScope.count({ where: { characterId: { in: idList } } })],
  ["conversations", false, () => prisma.conversation.count({ where: { characterId: { in: idList } } })],
  ["messages", false, () => prisma.message.count({ where: { conversation: { characterId: { in: idList } } } })],
  ["memory_items", false, () => prisma.memoryItem.count({ where: { memoryScope: { characterId: { in: idList } } } })],
  ["memory_events", false, () => prisma.memoryEvent.count({ where: { memoryScope: { characterId: { in: idList } } } })],
  ["memory_snapshots", false, () => prisma.memorySnapshot.count({ where: { memoryScope: { characterId: { in: idList } } } })],
  ["memory_jobs", false, () => prisma.memoryJob.count({ where: { memoryScope: { characterId: { in: idList } } } })],
  ["character_stickers", false, () => prisma.characterSticker.count({ where: { characterId: { in: idList } } })],
  ["character_catchphrases", false, () => prisma.characterCatchphrase.count({ where: { characterId: { in: idList } } })],
  ["character_memory_settings", false, () => prisma.characterMemorySetting.count({ where: { characterId: { in: idList } } })],
  ["proactive_intents", false, () => prisma.proactiveIntent.count({ where: { characterId: { in: idList } } })],
  ["character_channel_bindings", false, () => prisma.characterChannelBinding.count({ where: { characterId: { in: idList } } })],
  ["chat_requests", false, () => prisma.chatRequest.count({ where: { characterId: { in: idList } } })],
  ["group_activities", false, () => prisma.groupActivity.count({ where: { characterId: { in: idList } } })],
  ["onebot_group_announcements", false, () => prisma.onebotGroupAnnouncement.count({ where: { characterId: { in: idList } } })],
  ["model_usages（故意保留）", true, () => prisma.modelUsage.count({ where: { characterId: { in: idList } } })],
];

let dirty = 0;
console.log("\n逐表核对：");
for (const [label, intentional, run] of tables) {
  const count = await run();
  const mark = count === 0 ? "" : intentional ? "  ← 设计如此" : "  ← 残留";
  if (count > 0 && !intentional) dirty += 1;
  console.log(`  ${label.padEnd(30)}${String(count).padEnd(6)}${mark}`);
}

console.log("\n磁盘目录：");
for (const dirName of ["stickers", "sticker-originals"]) {
  for (const id of idList) {
    const dir = path.join(process.cwd(), ".data", dirName, id);
    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      console.log(`  ${dirName}/${id}: 不存在`);
      continue;
    }
    const files = await fs.readdir(dir);
    console.log(`  ${dirName}/${id}: 还在（${files.length} 个文件）  ← 残留`);
    dirty += 1;
  }
}

// 角色本身用不着担心（它要么删了要么还在），单独说一句更清楚。
const stillAlive = await prisma.character.count({ where: { id: { in: idList } } });
console.log(
  `\n角色行：${stillAlive === 0 ? "已删除（核对的是残留）" : `还在 ${stillAlive} 个（核对的是完整数据）`}`,
);
console.log(dirty === 0 ? "结论：干净，没有残留。" : `结论：有 ${dirty} 处残留（见上面的「残留」）。`);

await prisma.$disconnect();
