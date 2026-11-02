import type { Prisma } from "../../src/generated/prisma/client";
import { getPrisma } from "./prisma";

/**
 * 待审备注（`FriendAliasSuggestion`）的查询与落库共享逻辑。
 *
 * 两条边界都写在这里，列表接口和裁决接口各用一半，避免口径分叉：
 * - PENDING 是唯一「还挂在弹窗上」的状态；APPROVED / REJECTED 都不再出现在待审列表里。
 * - REJECTED 的行**不删**：`aliasKey` 唯一约束挡着，删了它下个周期又会被提回来，
 *   用户就永远否不掉。APPROVED 同理 —— 已经写进 aliases，再提回来也没意义。
 */

/** 一条待审备注，进页面弹窗的形态。 */
export type FriendAliasSuggestionDto = {
  id: string;
  scopeId: string;
  alias: string;
  reason: string;
  status: string;
  createdAt: string;
  /** 这条建议是给谁的：人物 displayName / platformUid，让弹窗直接能念出「想给 XXX 起名」。 */
  friendName: string;
  platform: string;
  platformUid: string;
};

const SUGGESTION_SELECT = {
  id: true,
  scopeId: true,
  alias: true,
  reason: true,
  status: true,
  createdAt: true,
  scope: {
    select: {
      externalIdentity: { select: { displayName: true, platform: true, platformUid: true } },
    },
  },
} satisfies Prisma.FriendAliasSuggestionSelect;

type SuggestionRow = Prisma.FriendAliasSuggestionGetPayload<{ select: typeof SUGGESTION_SELECT }>;

export function toSuggestionDto(row: SuggestionRow): FriendAliasSuggestionDto {
  const identity = row.scope.externalIdentity;
  const name = (identity?.displayName ?? "").trim() || identity?.platformUid || "?";
  return {
    id: row.id,
    scopeId: row.scopeId,
    alias: row.alias,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    friendName: name,
    platform: identity?.platform ?? "",
    platformUid: identity?.platformUid ?? "",
  };
}

/** 待审条数：朋友页顶部角标用。 */
export async function countPendingSuggestions(characterId: string): Promise<number> {
  return getPrisma().friendAliasSuggestion.count({
    where: { status: "PENDING", scope: { characterId } },
  });
}
