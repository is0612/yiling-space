/**
 * 「谁的聊天算知识来源」的判定闸门。
 *
 * 知识本身是角色全局的：检索、去重、生命周期都不分人。但**收集入口**不该一视同仁 ——
 * 群里几十个人的日常闲聊里，绝大多数成不了知识，却照样会变成候选堆着等人清。
 *
 * 所以这里只做一件事：在写入候选之前，判断这一轮该不该收。
 * 角色级开关 `knowledgeAutoCollectEnabled` 决定「收不收」，这里决定「收谁的」。
 *
 * 两种范围：
 * - `ALL`：现状，任何人说的话都可能成为候选（默认，升级不改变行为）。
 * - `SELECTED`：只收被标记过的人 —— 好友档案里打开「作为知识来源」，或主人本人。
 *
 * 知识条目本身不加归属人字段：一旦入库就是角色的公共知识。
 * 白名单只拦「进来的门」，不影响「查出去的窗」。
 */
import type { PrismaClient } from "../../src/generated/prisma/client";

export const KNOWLEDGE_COLLECT_SCOPES = ["ALL", "SELECTED"] as const;
export type KnowledgeCollectScope = (typeof KNOWLEDGE_COLLECT_SCOPES)[number];

/** 缺省 ALL：老角色没有这个键，行为必须和升级前一模一样。 */
export function readKnowledgeCollectScope(modelConfig: unknown): KnowledgeCollectScope {
  const config = modelConfig && typeof modelConfig === "object" && !Array.isArray(modelConfig)
    ? modelConfig as Record<string, unknown>
    : {};
  return config.knowledgeCollectScope === "SELECTED" ? "SELECTED" : "ALL";
}

type PrismaLike = Pick<PrismaClient, "memoryScope">;

/**
 * 私聊：这一轮是不是「选定的人」。
 *
 * 主人永远算来源，而且要单独判 —— 主人的私聊挂在 `USER_PRIVATE` 范围上，
 * 那一行没有 `knowledgeCollectEnabled` 的语义，按列取值只会得到 false，
 * 于是最该被记住的那个人反而一句都收不进来。
 */
export async function isPrivateKnowledgeSource(
  prisma: PrismaLike,
  input: { characterId: string; memoryScopeId: string | null; isOwnerTurn: boolean; scope: KnowledgeCollectScope },
): Promise<boolean> {
  if (input.scope === "ALL") return true;
  if (input.isOwnerTurn) return true;
  if (!input.memoryScopeId) return false;
  const row = await prisma.memoryScope.findFirst({
    where: { id: input.memoryScopeId, characterId: input.characterId, scopeType: "EXTERNAL_IDENTITY" },
    select: { knowledgeCollectEnabled: true },
  });
  return row?.knowledgeCollectEnabled === true;
}

/**
 * 群聊：候选证据里只要有「选定的人」说过话就收。
 *
 * 一条群聊候选往往是好几个人接出来的。按「主要发言者」判会把
 * 「主人问、别人答」这种最该记的一轮整个丢掉，所以这里任一命中即收。
 *
 * 判不出作者（证据 id 一条都对不上人）时 fail-closed：宁可漏，不要又堆一屏噪音。
 */
export async function isGroupKnowledgeSource(
  prisma: PrismaLike,
  input: {
    characterId: string;
    platform: string;
    evidence: ReadonlyArray<{ platformUid: string; isOwner: boolean }>;
    scope: KnowledgeCollectScope;
  },
): Promise<boolean> {
  if (input.scope === "ALL") return true;
  if (input.evidence.some((item) => item.isOwner)) return true;
  const uids = [...new Set(input.evidence.map((item) => item.platformUid).filter(Boolean))];
  if (!uids.length) return false;
  const row = await prisma.memoryScope.findFirst({
    where: {
      characterId: input.characterId,
      scopeType: "EXTERNAL_IDENTITY",
      knowledgeCollectEnabled: true,
      externalIdentity: { platform: input.platform, platformUid: { in: uids } },
    },
    select: { id: true },
  });
  return Boolean(row);
}
