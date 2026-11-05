/**
 * 把历史群会话归位到角色全局记忆范围。
 *
 * 背景：会话按 `(binding, externalConversationId)` 唯一、找到就复用，而「群聊挂全局」是
 * 后来才定的规则。更早建出来的群会话仍挂在建群那一刻的 `EXTERNAL_IDENTITY` 上，于是：
 *
 * - 群消息写进那个身份范围，而按天忆泡只排「全局 + 主人私人 + 有私聊会话的外部身份范围」，
 *   这些消息永远不会被整理（`memory-scheduler.ts` 的 `conversationFilter`）；
 * - 群聊的检索范围是 `[global]`，于是她在群里查不到这个群自己说过的话；
 * - 记录页看起来一切正常，唯一的症状是「她怎么什么都不记得」。
 *
 * 写入侧已经堵住：`pipeline.ts` 的 `resolveGroupScopeRepair` 在她下一次在群里开口时
 * 顺手把会话迁走。本脚本处理那些**再也不会有人说话**的旧会话 —— 它们不会自己触发修复，
 * 但里面的原文和忆泡仍在库里。
 *
 * 判据：`externalConversationId` 以 `g:` 开头，且所在范围不是该角色的 `CHARACTER_GLOBAL`。
 * 迁移只改范围归属，不删任何消息；旧范围里属于这个会话的忆泡会跟着搬，同一天同标题的
 * 重复条目在目标范围已存在时按重复合并（`rehomeConversationScope`）。
 *
 * 用法：
 *   tsx scripts/fix-group-conversation-scope.ts          # 只统计，不改
 *   tsx scripts/fix-group-conversation-scope.ts --apply  # 真改（逐会话事务，改前复查）
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { rehomeConversationScope } from "../server/utils/memory-event-move";

const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，迁移脚本无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

type Target = {
  conversationId: string;
  characterId: string;
  title: string | null;
  externalConversationId: string;
  fromScopeId: string;
  fromScopeType: string;
  toScopeId: string;
  messages: number;
};

async function collect(): Promise<{ targets: Target[]; alreadyGlobal: number; noGlobalScope: number }> {
  const conversations = await prisma.conversation.findMany({
    where: { externalConversationId: { startsWith: "g:" } },
    select: {
      id: true,
      characterId: true,
      title: true,
      externalConversationId: true,
      memoryScopeId: true,
      memoryScope: { select: { scopeType: true } },
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const globalScopes = await prisma.memoryScope.findMany({
    where: { scopeType: "CHARACTER_GLOBAL", characterId: { in: [...new Set(conversations.map((c) => c.characterId))] } },
    select: { id: true, characterId: true },
  });
  const globalByCharacter = new Map(globalScopes.map((scope) => [scope.characterId, scope.id]));

  const targets: Target[] = [];
  let alreadyGlobal = 0;
  let noGlobalScope = 0;
  for (const conversation of conversations) {
    const globalScopeId = globalByCharacter.get(conversation.characterId);
    if (!globalScopeId) {
      noGlobalScope += 1;
      continue;
    }
    if (conversation.memoryScopeId === globalScopeId) {
      alreadyGlobal += 1;
      continue;
    }
    targets.push({
      conversationId: conversation.id,
      characterId: conversation.characterId,
      title: conversation.title,
      externalConversationId: conversation.externalConversationId!,
      fromScopeId: conversation.memoryScopeId,
      fromScopeType: conversation.memoryScope.scopeType,
      toScopeId: globalScopeId,
      messages: conversation._count.messages,
    });
  }
  return { targets, alreadyGlobal, noGlobalScope };
}

async function main(): Promise<void> {
  const { targets, alreadyGlobal, noGlobalScope } = await collect();
  const messageTotal = targets.reduce((sum, target) => sum + target.messages, 0);

  console.log(`群会话共 ${targets.length + alreadyGlobal + noGlobalScope} 个：`
    + `已在全局 ${alreadyGlobal} 个，需要归位 ${targets.length} 个（涉及 ${messageTotal} 条消息），`
    + `找不到全局范围 ${noGlobalScope} 个。`);

  for (const target of targets) {
    console.log(`  ${target.externalConversationId} | ${target.fromScopeType} → CHARACTER_GLOBAL`
      + ` | ${target.messages} 条消息 | ${target.title ?? "(无标题)"}`);
  }

  if (!apply) {
    console.log("未加 --apply，只做了统计。");
    return;
  }

  let migrated = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // 复查：统计与执行之间，她在群里开口过一次就会由 pipeline 抢先归位。
        const current = await tx.conversation.findUnique({
          where: { id: target.conversationId },
          select: { memoryScopeId: true },
        });
        if (!current || current.memoryScopeId !== target.fromScopeId) {
          return { status: "skipped" as const };
        }
        const stats = await rehomeConversationScope(tx, {
          conversationId: target.conversationId,
          fromScopeId: target.fromScopeId,
          toScopeId: target.toScopeId,
        });
        return { status: "migrated" as const, ...stats };
      });
      if (result.status === "migrated") {
        migrated += 1;
        console.log(`[ok] ${target.externalConversationId} 忆泡搬到全局：`
          + `移入 ${result.moved}，合并去重 ${result.merged}，涉及 ${result.days} 天`);
      } else {
        console.log(`[skip] ${target.externalConversationId} 范围已被改过，跳过。`);
      }
    } catch (error) {
      failed += 1;
      console.log(`[fail] ${target.externalConversationId} `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`完成：归位 ${migrated} 个，跳过/失败 ${failed} 个。`);
  if (migrated) {
    console.log("接下来跑一次调度器（scheduler:run），新归位的群会话才会排进按天忆泡。");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
