/**
 * 清理「空壳外部身份」。
 *
 * 背景：`handleChannelMessage` 曾经对**群聊这一轮的每个发言者**都 upsert 一条
 * `ExternalIdentity` 并开一个 `EXTERNAL_IDENTITY` 记忆范围。但群会话挂在角色全局
 * scope 下，那批身份 scope 从来没有会话、没有记忆、也没有任何读取路径 —— 身份表被
 * 整群群友灌满，真正的私聊来访者反而找不到。
 *
 * 写入侧已经改成只记私聊（`pipeline.ts` 的 `if (!isGroup)`）。本脚本清历史遗留。
 *
 * 判据（缺一不可，宁漏不误删）：
 *   status = UNVERIFIED 且 linkedUserId 为空
 *   且它的每个记忆范围里：memoryItem / conversation / snapshot / memoryEvent /
 *      memoryEventDay / memoryJob 全部为 0
 *
 * 也就是说：任何真正聊过的身份都不会被删 —— 私聊第一句就会建一条 conversation
 * 挂在自己的 scope 下。
 *
 * 用法：
 *   tsx scripts/cleanup-identity-orphans.ts          # 只统计，不删
 *   tsx scripts/cleanup-identity-orphans.ts --apply  # 真删（逐个事务，删前复查）
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，清理脚本无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

type Orphan = {
  id: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  createdAt: Date;
  scopeIds: string[];
};

async function isScopeEmpty(scopeId: string): Promise<boolean> {
  const [items, conversations, snapshots, events, eventDays, jobs] = await Promise.all([
    prisma.memoryItem.count({ where: { memoryScopeId: scopeId } }),
    prisma.conversation.count({ where: { memoryScopeId: scopeId } }),
    prisma.memorySnapshot.count({ where: { memoryScopeId: scopeId } }),
    prisma.memoryEvent.count({ where: { memoryScopeId: scopeId } }),
    prisma.memoryEventDay.count({ where: { memoryScopeId: scopeId } }),
    prisma.memoryJob.count({ where: { memoryScopeId: scopeId } }),
  ]);
  return items + conversations + snapshots + events + eventDays + jobs === 0;
}

async function findOrphans(): Promise<{ orphans: Orphan[]; kept: number }> {
  const identities = await prisma.externalIdentity.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      platform: true,
      platformUid: true,
      displayName: true,
      status: true,
      linkedUserId: true,
      createdAt: true,
      memoryScopes: { select: { id: true } },
    },
  });

  const orphans: Orphan[] = [];
  let kept = 0;
  for (const identity of identities) {
    if (identity.status !== "UNVERIFIED" || identity.linkedUserId) {
      kept += 1;
      continue;
    }
    const scopeIds = identity.memoryScopes.map((scope) => scope.id);
    let empty = true;
    for (const scopeId of scopeIds) {
      if (!(await isScopeEmpty(scopeId))) {
        empty = false;
        break;
      }
    }
    if (!empty) {
      kept += 1;
      continue;
    }
    orphans.push({
      id: identity.id,
      platform: identity.platform,
      platformUid: identity.platformUid,
      displayName: identity.displayName,
      createdAt: identity.createdAt,
      scopeIds,
    });
  }
  return { orphans, kept };
}

function pad(value: string, width: number) {
  const chars = Array.from(value);
  if (chars.length >= width) return chars.slice(0, width - 1).join("") + " ";
  return value + " ".repeat(width - chars.length);
}

async function main() {
  const total = await prisma.externalIdentity.count();
  const { orphans, kept } = await findOrphans();

  console.log(`外部身份共 ${total} 条；空壳候选 ${orphans.length} 条；保留 ${kept} 条。`);
  if (orphans.length) {
    const byPlatform = new Map<string, number>();
    for (const orphan of orphans) {
      byPlatform.set(orphan.platform, (byPlatform.get(orphan.platform) ?? 0) + 1);
    }
    console.log(`按平台：${[...byPlatform].map(([p, n]) => `${p}=${n}`).join("  ")}`);
    console.log("");
    console.log(`${pad("平台", 14)}${pad("UID", 20)}${pad("昵称", 20)}建立时间`);
    for (const orphan of orphans.slice(0, 40)) {
      const created = orphan.createdAt.toISOString().slice(0, 16).replace("T", " ");
      console.log(
        pad(orphan.platform, 14)
        + pad(orphan.platformUid, 20)
        + pad(orphan.displayName ?? "—", 20)
        + created,
      );
    }
    if (orphans.length > 40) console.log(`…… 其余 ${orphans.length - 40} 条省略`);
  }

  if (!apply) {
    console.log("");
    console.log("这是干跑，什么都没删。确认后加 --apply 执行。");
    return;
  }

  let deleted = 0;
  for (const orphan of orphans) {
    await prisma.$transaction(async (tx) => {
      // 复查一次：统计到执行的这段时间里可能刚有人来私聊过。
      const fresh = await tx.externalIdentity.findUnique({
        where: { id: orphan.id },
        select: { status: true, linkedUserId: true, memoryScopes: { select: { id: true } } },
      });
      if (!fresh || fresh.status !== "UNVERIFIED" || fresh.linkedUserId) return;
      for (const scope of fresh.memoryScopes) {
        const [items, conversations, snapshots, events, eventDays, jobs] = await Promise.all([
          tx.memoryItem.count({ where: { memoryScopeId: scope.id } }),
          tx.conversation.count({ where: { memoryScopeId: scope.id } }),
          tx.memorySnapshot.count({ where: { memoryScopeId: scope.id } }),
          tx.memoryEvent.count({ where: { memoryScopeId: scope.id } }),
          tx.memoryEventDay.count({ where: { memoryScopeId: scope.id } }),
          tx.memoryJob.count({ where: { memoryScopeId: scope.id } }),
        ]);
        if (items + conversations + snapshots + events + eventDays + jobs > 0) return;
      }
      await tx.memoryScope.deleteMany({ where: { externalIdentityId: orphan.id } });
      await tx.externalIdentity.delete({ where: { id: orphan.id } });
      deleted += 1;
    });
  }

  const remaining = await prisma.externalIdentity.count();
  console.log("");
  console.log(`已删除 ${deleted} 条空壳身份；外部身份剩 ${remaining} 条。`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
