/**
 * 身份与好友域的前后端共享契约。
 *
 * 三个容易混的概念，这里分开写清楚：
 *
 * - `status`（`ExternalIdentityStatus`）：**这个账号绑定到哪个用户**的验证状态。
 *   默认 `UNVERIFIED`。只有 `VERIFIED` 才代表「已经确认这是谁」；
 *   `linkedUserId` 只有在验证通过后才有指向意义，别把 UNVERIFIED 的关联当成已知身份。
 * - `identityKind`（真人 / AI / 未知）与上面那个**完全独立**：一个已验证的账号可以是 AI。
 * - `identityKindSource`：`MANUAL` 优先，自动识别只能写 `AUTO`、不能覆盖人工判断。
 *
 * 所有绑定类接口（验证 / 解除 / 吊销）都要求管理员身份（`requireAdminActor`），
 * 这是「当前用户授权」的边界所在：好友列表本身也只给管理员看。
 */

export const IDENTITY_KINDS = ["UNKNOWN", "HUMAN", "AI"] as const;
export type IdentityKind = typeof IDENTITY_KINDS[number];

export const IDENTITY_KIND_SOURCES = ["AUTO", "MANUAL"] as const;
export type IdentityKindSource = typeof IDENTITY_KIND_SOURCES[number];

export const FRIEND_CHAT_POLICIES = ["DEFAULT", "ALLOW", "BLOCK"] as const;
export type FriendChatPolicy = typeof FRIEND_CHAT_POLICIES[number];

export const FRIEND_SOURCE_FILTERS = ["ALL", "PRIVATE", "GROUP"] as const;
export type FriendSourceFilter = typeof FRIEND_SOURCE_FILTERS[number];

export const FRIEND_SORT_BYS = ["recent", "count", "closeness", "known"] as const;
export type FriendSortBy = typeof FRIEND_SORT_BYS[number];

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
  /** 账号验证状态（UNVERIFIED / VERIFIED / …）。与 `identityKind` 无关。 */
  status: string;
  /** 只有 `status === "VERIFIED"` 时才代表「确认是这个人」；其余情况别当作已知身份。 */
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

/** 修改好友关系（**请求**）：只传要改的字段。 */
export type FriendPatch = {
  identityKind?: IdentityKind;
  friendChatPolicy?: FriendChatPolicy;
  proactiveContactEnabled?: boolean;
  educationEnabled?: boolean;
  knowledgeCollectEnabled?: boolean;
};

/** 修改结果：只回被改到的字段 + 行标识，页面据此就地更新那一行。 */
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
