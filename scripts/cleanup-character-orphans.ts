/**
 * 清理「角色已删除、但数据还留着」的残留。
 *
 * 背景：`chat_requests` / `group_activities` / `onebot_group_announcements` 三张表的
 * `characterId` 没有外键（见 prisma/schema.prisma 的注释），删角色时不会被级联。
 * 删除接口现在已经显式清理（server/utils/character-delete.ts），但历史上删过的角色
 * 会留下孤儿行；表情包目录同理 —— 库里的行 cascade 掉了，`.data/stickers/<角色 id>/`
 * 那批图还躺在磁盘上。
 *
 * 故意**不清理** `model_usages`：token 账单不随角色消失，这是设计。
 * 它只会被统计，不会被删 —— 用量页按 characterId 聚合，孤儿行不会串到别的角色上。
 *
 * 判据：`characterId` 不在 characters 表里，就是孤儿。没有模糊地带，不会误删。
 *
 * 用法：
 *   yarn clean:character-orphans            # 只统计，不删
 *   yarn clean:character-orphans --apply    # 真删
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { removeCharacterStickerDirs } from "../server/utils/character-delete";

const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，清理脚本无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 三张「有 characterId、没外键」的表。逐表显式写而不是按字符串动态取 model ——
 * 表名拼错时编译器能拦住，动态那一套只能等运行时报 undefined。
 */
function orphanTables(liveIds: string[]) {
  const where = { characterId: { notIn: liveIds } };
  return [
    {
      label: "chat_requests",
      count: () => prisma.chatRequest.count({ where }),
      delete: async () => (await prisma.chatRequest.deleteMany({ where })).count,
    },
    {
      label: "group_activities",
      count: () => prisma.groupActivity.count({ where }),
      delete: async () => (await prisma.groupActivity.deleteMany({ where })).count,
    },
    {
      label: "onebot_group_announcements",
      count: () => prisma.onebotGroupAnnouncement.count({ where }),
      delete: async () => (await prisma.onebotGroupAnnouncement.deleteMany({ where })).count,
    },
  ];
}

async function listStaleStickerDirs(liveIds: Set<string>): Promise<string[]> {
  const stale: string[] = [];
  for (const dirName of ["stickers", "sticker-originals"]) {
    const dir = path.join(process.cwd(), ".data", dirName);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      // 只认 uuid 形状：万一手动往里放过 `.gitkeep` 之类的东西，不要当成角色目录处理。
      if (!UUID_PATTERN.test(entry)) continue;
      if (liveIds.has(entry)) continue;
      if (!stale.includes(entry)) stale.push(entry);
    }
  }
  return stale;
}

async function main() {
  const characters = await prisma.character.findMany({ select: { id: true } });
  const liveIds = characters.map((row) => row.id);

  if (liveIds.length === 0) {
    // 一个角色都没有时 `notIn: []` 会把整张表删光。这几乎只可能是连错库了。
    console.log("当前库里一个角色都没有。为免误删整个库，脚本不做任何处理。");
    return;
  }

  const tables = orphanTables(liveIds);
  const counts: number[] = [];
  for (const table of tables) counts.push(await table.count());
  // 账单单独统计：它同样指向已删角色，但按设计保留。
  const keptUsage = await prisma.modelUsage.count({ where: { characterId: { notIn: liveIds } } });
  const staleDirs = await listStaleStickerDirs(new Set(liveIds));

  // 第二类孤儿：角色还在，但绑它的渠道被解绑了 —— group_activities 的 channelBindingId
  // 同样没有外键。只在确实有绑定残留时才统计，避免 `notIn: []` 把整张表当孤儿。
  const liveBindingIds = (await prisma.characterChannelBinding.findMany({ select: { id: true } })).map((row) => row.id);
  const deadBindingCount = liveBindingIds.length
    ? await prisma.groupActivity.count({ where: { channelBindingId: { notIn: liveBindingIds } } })
    : 0;

  console.log(`现有角色 ${liveIds.length} 个，渠道绑定 ${liveBindingIds.length} 个。`);
  console.log("");
  console.log("孤儿行（characterId 指向已不存在的角色）：");
  for (const [index, table] of tables.entries()) {
    console.log(`  ${table.label.padEnd(28)}${counts[index]}`);
  }
  console.log("");
  console.log("孤儿群活跃度（channelBindingId 指向已解绑的渠道）：");
  console.log(`  group_activities            ${deadBindingCount}`);
  console.log("");
  console.log(`磁盘上属于已删角色的表情包目录：${staleDirs.length} 个`);
  for (const id of staleDirs.slice(0, 20)) console.log(`  - ${id}`);
  if (staleDirs.length > 20) console.log(`  …… 其余 ${staleDirs.length - 20} 个省略`);
  console.log("");
  console.log(`model_usages 里有 ${keptUsage} 行指向已删角色 —— 属于账单，按设计保留，不清理。`);

  const totalRows = counts.reduce((sum, count) => sum + count, 0) + deadBindingCount;
  if (totalRows === 0 && staleDirs.length === 0) {
    console.log("");
    console.log("没有需要清理的东西。");
    return;
  }

  if (!apply) {
    console.log("");
    console.log("这是干跑，什么都没删。确认后加 --apply 执行。");
    return;
  }

  console.log("");
  for (const table of tables) {
    console.log(`已删除 ${table.label} 孤儿行 ${await table.delete()} 条。`);
  }
  if (deadBindingCount > 0) {
    const deleted = await prisma.groupActivity.deleteMany({ where: { channelBindingId: { notIn: liveBindingIds } } });
    console.log(`已删除 group_activities 死绑定行 ${deleted.count} 条。`);
  }
  let removedDirs = 0;
  for (const id of staleDirs) {
    // 删之前复查一遍：列表是几秒前算的，中间可能刚好有人导入了个同 id 的角色（概率为零，但便宜）。
    if (await prisma.character.count({ where: { id } })) continue;
    if (await removeCharacterStickerDirs(id)) removedDirs += 1;
  }
  console.log(`已删除表情包目录 ${removedDirs} 个。`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
