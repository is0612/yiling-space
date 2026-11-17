import type { ApiRequest } from "../utils/request";

export type IdentityKind = "UNKNOWN" | "HUMAN" | "AI";
export type IdentityKindSource = "AUTO" | "MANUAL";
export type FriendChatPolicy = "DEFAULT" | "ALLOW" | "BLOCK";
export type FriendSourceFilter = "ALL" | "PRIVATE" | "GROUP";
export type FriendSortBy = "recent" | "count" | "closeness" | "known";
export type FriendSortDirection = "asc" | "desc";

/** 一行 = 某个角色与某个人的一条关系，不是账号本身。 */
export type Friend = {
  scopeId: string;
  characterId: string;
  characterName: string;
  identityId: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  status: string;
  linkedUserId: string | null;
  identityKind: IdentityKind;
  identityKindSource: IdentityKindSource;
  friendChatPolicy: FriendChatPolicy;
  proactiveContactEnabled: boolean;
  educationEnabled: boolean;
  /** 她的聊天算不算知识来源；只在角色设成「仅指定成员」时才起作用。 */
  knowledgeCollectEnabled: boolean;
  /** 当前角色实际的知识收集范围，用来提示这个开关现在生不生效。 */
  characterKnowledgeCollectScope: "ALL" | "SELECTED";
  lastProactiveContactAttempt: {
    status: "SENDING" | "SENT" | "SKIPPED" | "FAILED" | "EXPIRED";
    reason: string;
    attemptedAt: string;
    sentAt: string | null;
  } | null;
  interactionCount: number;
  lastInteractedAt: string | null;
  knownSince: string;
  firstSource: string | null;
  conversationCount: number;
  /** 她私底下的叫法。空数组 = 没设过。 */
  aliases: string[];
};

export type FriendCharacter = { id: string; name: string; status: string; friendCount: number };

export type FriendPage = {
  items: Friend[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  characters: FriendCharacter[];
  /** 后端兜底选好的角色：没传 characterId 时落在「朋友最多的那个」。 */
  activeCharacterId: string;
  /** 都按这个角色的全部朋友算，不受关键词/来源筛选影响。 */
  stats: { total: number; familiar: number; recent: number };
  sourceCounts: { all: number; private: number; group: number };
  /** 待审备注条数：顶部按钮角标用。 */
  pendingSuggestions: number;
};

export type FriendPatch = {
  identityKind?: IdentityKind;
  friendChatPolicy?: FriendChatPolicy;
  proactiveContactEnabled?: boolean;
  educationEnabled?: boolean;
  knowledgeCollectEnabled?: boolean;
};

export type FriendPatchResult = Partial<Pick<Friend,
  "identityKind" | "identityKindSource" | "friendChatPolicy" |
  "proactiveContactEnabled" | "educationEnabled" | "knowledgeCollectEnabled"
>> & { scopeId: string };

/** 她（在快照提炼时）想给朋友起的叫法，等用户点头。 */
export type AliasSuggestion = {
  id: string;
  scopeId: string;
  alias: string;
  reason: string;
  friendName: string;
  platform: string;
  platformUid: string;
};

export type FriendListQuery = {
  characterId?: string;
  q?: string;
  source: FriendSourceFilter;
  sort: FriendSortBy;
  dir: FriendSortDirection;
  page: number;
  pageSize: number;
};

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
