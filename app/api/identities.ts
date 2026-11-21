import type { ApiRequest } from "../utils/request";

// 身份与好友的形状与后端共用（`shared/types/identities.ts`）。
// 状态（验证到哪一步）、类型（真人/AI）、类型来源（人工/自动）三者独立，注释写在那份文件里。
export type * from "#shared/types/identities";

const identitiesBase = "/admin/identities";
const friendPath = (scopeId: string) => `${identitiesBase}/${encodeURIComponent(scopeId)}`;
const aliasPath = (scopeId: string) => `${identitiesBase}/aliases/${encodeURIComponent(scopeId)}`;
const suggestionsPath = `${identitiesBase}/aliases/suggestions`;

/**
 * 好友身份接口：关系名单分页、身份与交流开关、单个/批量删除、备注与待审备注。
 *
 * `scopeId` 是「角色 × 人」的关系主键；同一个 QQ 号跟两个角色都聊过就是两行。
 */

export function createIdentitiesApi(request: ApiRequest) {
  function listFriends(query: FriendListQuery): Promise<FriendPage> {
    return request<FriendPage>({ url: identitiesBase, method: "get", params: query });
  }

  function updateFriend(scopeId: string, patch: FriendPatch): Promise<FriendPatchResult> {
    return request<FriendPatchResult>({ url: friendPath(scopeId), method: "patch", data: patch });
  }

  function deleteFriend(scopeId: string): Promise<unknown> {
    return request<unknown>({ url: friendPath(scopeId), method: "delete" });
  }

  function batchDeleteFriends(scopeIds: string[]): Promise<{ deleted: number; failed: number }> {
    return request<{ deleted: number; failed: number }>({
      url: `${identitiesBase}/batch-delete`,
      method: "post",
      data: { scopeIds },
    });
  }

  function updateAliases(scopeId: string, aliases: string | string[]): Promise<{ aliases: string[]; dropped: number }> {
    return request<{ aliases: string[]; dropped: number }>({
      url: aliasPath(scopeId),
      method: "patch",
      data: { aliases },
    });
  }

  function listAliasSuggestions(characterId?: string): Promise<{ items: AliasSuggestion[] }> {
    return request<{ items: AliasSuggestion[] }>({
      url: suggestionsPath,
      method: "get",
      params: { characterId },
    });
  }

  function resolveAliasSuggestion(suggestionId: string, approve: boolean): Promise<{ aliases: string[] }> {
    return request<{ aliases: string[] }>({
      url: `${suggestionsPath}/${encodeURIComponent(suggestionId)}`,
      method: "post",
      data: { approve },
    });
  }

  return {
    listFriends,
    updateFriend,
    deleteFriend,
    batchDeleteFriends,
    updateAliases,
    listAliasSuggestions,
    resolveAliasSuggestion,
  };
}

export type IdentitiesApi = ReturnType<typeof createIdentitiesApi>;
