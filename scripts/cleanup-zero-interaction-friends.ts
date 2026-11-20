/**
 * 清掉「聊过 0 次」的好友档案。
 *
 * 背景：2026-11-21 起，群里只是发言、她还没搭理过的人不再建档 —— 关系行只在她真的
 * 回过对方（或私聊收到消息）之后才出现（见 `server/utils/friends.ts`）。
 * 这个脚本清历史遗留：`interactionCount = 0` 的 `EXTERNAL_IDENTITY` 关系。
 *
 * 判据（缺一不可，宁漏不误删）：
 *   `interactionCount <= 0`，且 conversation / memoryItem / snapshot / event /
 *   eventDay / job / journal 全部为 0（有对话或记忆就绝不删）。
 *   默认还要求备注建议、社交经历、关系变更、评估、主动联系尝试也都是 0；
 *   加 `--include-with-data` 才连这些社交附属数据一起删 —— 它们没有对话，
 *   只是评估流程留下的记录。
 *
 * 删除走 `deleteFriendScope`：和页面上「删除这条关系」完全同一条语义，
 * 会写一条 `FRIEND_DELETED` 审计。`ExternalIdentity` 不删 ——
 * 同一个号可能还是别的角色的朋友。
 *
 * 用法：
 *   tsx scripts/cleanup-zero-interaction-friends.ts                            # 只统计，不删
 *   tsx scripts/cleanup-zero-interaction-friends.ts --apply                    # 删完全空的
 *   tsx scripts/cleanup-zero-interaction-friends.ts --apply --include-with-data # 连社交附属数据一起删
 */

import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { deleteFriendScope } from "../server/utils/friend-delete";

const apply = process.argv.includes("--apply");
const includeWithData = process.argv.includes("--include-with-data");
const prisma = getPrisma();

/** 有这些就说明真的产生过对话或记忆，绝不删。 */
const STRUCTURAL_SCOPE_COUNTS = {
  conversations: true,
  memoryItems: true,
  snapshots: true,
  events: true,
  eventDays: true,
  jobs: true,
  journals: true,
} as const;

/** 没有对话，但代表系统在这个人身上留下过社交记录。默认只有当它们全为 0 才删。 */
const SOCIAL_SCOPE_COUNTS = {
  aliasSuggestions: true,
  socialExperiences: true,
  socialRelationChanges: true,
  socialAssessments: true,
  socialProactiveContactAttempts: true,
} as const;

type ZeroFriend = {
  scopeId: string;
  characterId: string;
  characterName: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  createdAt: Date;
};

function pad(value: string, width: number) {
  const chars = Array.from(value);
  if (chars.length >= width) return chars.slice(0, width - 1).join("") + " ";
  return value + " ".repeat(width - chars.length);
}

type ScopeCounts = {
  conversations: number;
  memoryItems: number;
  snapshots: number;
  events: number;
  eventDays: number;
  jobs: number;
  journals: number;
  aliasSuggestions: number;
  socialExperiences: number;
  socialRelationChanges: number;
  socialAssessments: number;
  socialProactiveContactAttempts: number;
};

/** 有对话或记忆就绝不删；社交附属数据只在 `--include-with-data` 下允许存在。 */
function isDeletable(counts: ScopeCounts, task: { status: string } | null): boolean {
  const structural = counts.conversations + counts.memoryItems + counts.snapshots
    + counts.events + counts.eventDays + counts.jobs + counts.journals;
  if (structural > 0) return false;
  // 正在跑的评估绝不能动：它可能在删的同时往这条关系里写结果。
  if (task?.status === "RUNNING") return false;
  if (includeWithData) return true;
  // 默认模式把「有评估任务 / 社交记录」也算作有数据，只清完全空的那种。
  if (task) return false;
  const social = counts.aliasSuggestions + counts.socialExperiences + counts.socialRelationChanges
    + counts.socialAssessments + counts.socialProactiveContactAttempts;
  return social === 0;
}

async function findZeroFriends(): Promise<{ candidates: ZeroFriend[]; kept: number }> {
  const scopes = await prisma.memoryScope.findMany({
    where: {
      scopeType: "EXTERNAL_IDENTITY",
      externalIdentityId: { not: null },
      interactionCount: { lte: 0 },
    },
    orderBy: [{ characterId: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      characterId: true,
      createdAt: true,
      character: { select: { name: true } },
      externalIdentity: { select: { platform: true, platformUid: true, displayName: true } },
      socialAssessmentTask: { select: { id: true, status: true } },
      _count: { select: { ...STRUCTURAL_SCOPE_COUNTS, ...SOCIAL_SCOPE_COUNTS } },
    },
  });

  const candidates: ZeroFriend[] = [];
  let kept = 0;
  for (const scope of scopes) {
    if (!scope.externalIdentity || !isDeletable(scope._count, scope.socialAssessmentTask)) {
      kept += 1;
      continue;
    }
    candidates.push({
      scopeId: scope.id,
      characterId: scope.characterId,
      characterName: scope.character.name,
      platform: scope.externalIdentity.platform,
      platformUid: scope.externalIdentity.platformUid,
      displayName: scope.externalIdentity.displayName,
      createdAt: scope.createdAt,
    });
  }
  return { candidates, kept };
}

async function main() {
  const [totalFriends, { candidates, kept }] = await Promise.all([
    prisma.memoryScope.count({ where: { scopeType: "EXTERNAL_IDENTITY", externalIdentityId: { not: null } } }),
    findZeroFriends(),
  ]);

  console.log(`好友关系共 ${totalFriends} 条；聊过 0 次且无任何关联数据的候选 ${candidates.length} 条；保留 ${kept} 条。`);
  console.log(
    includeWithData
      ? "模式：连社交经历 / 评估记录一起清（--include-with-data）。"
      : "模式：只清完全空的；加 --include-with-data 可连社交经历 / 评估一起清。",
  );

  if (candidates.length) {
    const byCharacter = new Map<string, number>();
    for (const item of candidates) {
      byCharacter.set(item.characterName, (byCharacter.get(item.characterName) ?? 0) + 1);
    }
    console.log(`按角色：${[...byCharacter].map(([name, count]) => `${name}=${count}`).join("  ")}`);
    console.log("");
    console.log(`${pad("角色", 16)}${pad("平台", 12)}${pad("UID", 22)}${pad("昵称", 18)}建立时间`);
    for (const item of candidates.slice(0, 40)) {
      const created = item.createdAt.toISOString().slice(0, 16).replace("T", " ");
      console.log(
        pad(item.characterName, 16)
        + pad(item.platform, 12)
        + pad(item.platformUid, 22)
        + pad(item.displayName ?? "—", 18)
        + created,
      );
    }
    if (candidates.length > 40) console.log(`…… 其余 ${candidates.length - 40} 条省略`);
  }

  if (!apply) {
    console.log("");
    console.log("这是干跑，什么都没删。确认后加 --apply 执行。");
    return;
  }

  let deleted = 0;
  let skipped = 0;
  for (const item of candidates) {
    // 复查：统计到执行的这段时间里可能刚有人来聊过，别把新关系删掉。
    const fresh = await prisma.memoryScope.findUnique({
      where: { id: item.scopeId },
      select: {
        interactionCount: true,
        socialAssessmentTask: { select: { id: true, status: true } },
        _count: { select: { ...STRUCTURAL_SCOPE_COUNTS, ...SOCIAL_SCOPE_COUNTS } },
      },
    });
    if (
      !fresh
      || fresh.interactionCount > 0
      || !isDeletable(fresh._count, fresh.socialAssessmentTask)
    ) {
      skipped += 1;
      continue;
    }
    const outcome = await deleteFriendScope({ scopeId: item.scopeId, actorId: null });
    if (outcome) deleted += 1;
    else skipped += 1;
  }

  const remaining = await prisma.memoryScope.count({
    where: { scopeType: "EXTERNAL_IDENTITY", externalIdentityId: { not: null } },
  });
  console.log("");
  console.log(`已删除 ${deleted} 条零互动关系；复查跳过 ${skipped} 条；好友关系剩 ${remaining} 条。`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
