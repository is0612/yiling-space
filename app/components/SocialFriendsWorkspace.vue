<script setup lang="ts">
/**
 * 她的朋友。
 *
 * 一行 = 某角色认识的某个人（一条关系），不是一个账号。同一个 QQ 号跟两个角色都聊过
 * 就有两行。页面通过全局角色选择器确定当前角色，再读取该角色的关系名单。
 *
 * 私聊来访或群里发过言的人都会出现在名单；群成员第一次发言只建立「遇到过」记录，
 * 不增加互动次数。只有她真的回了对方，群聊互动次数才 +1。
 *
 * 名单会一直长（群里认人会一直往上加），所以筛选、排序、翻页全在服务端做：
 * 页面每次只拿一页，统计带和来源计数由接口按「这个角色的全部朋友」另算，
 * 不会因为翻了页或筛了来源就变形。
 */
import { Delete, Refresh, Search, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

await useCharacterListData();
const { id } = useCharacterSelection("/growth/social/friends");

type Friend = {
  scopeId: string;
  characterId: string;
  characterName: string;
  identityId: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  status: string;
  linkedUserId: string | null;
  identityKind: "UNKNOWN" | "HUMAN" | "AI";
  identityKindSource: "AUTO" | "MANUAL";
  friendChatPolicy: "DEFAULT" | "ALLOW" | "BLOCK";
  proactiveContactEnabled: boolean;
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
  /** 她私底下的叫法。空数组 = 没设过，卡片上显示「＋ 加备注」。 */
  aliases: string[];
};

type Character = { id: string; name: string; status: string; friendCount: number };

type FriendPage = {
  items: Friend[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  characters: Character[];
  /** 后端兜底选好的角色：没传 characterId 时落在「朋友最多的那个」 */
  activeCharacterId: string;
  /** 都按这个角色的全部朋友算，不受关键词/来源筛选影响 */
  stats: { total: number; familiar: number; recent: number };
  sourceCounts: { all: number; private: number; group: number };
  /** 待审备注条数：顶部按钮角标用。 */
  pendingSuggestions: number;
};

/** 一页 12 个＝四列三行，正好铺满不剩半行。与接口默认值保持一致。 */
const PAGE_SIZE = 12;

const loading = ref(true);
const friends = ref<Friend[]>([]);
const characters = ref<Character[]>([]);
const activeCharacterId = computed(() => id.value);
const query = ref("");
const sourceFilter = ref<"ALL" | "PRIVATE" | "GROUP">("ALL");
type SortBy = "recent" | "count" | "closeness" | "known";
type SortDirection = "asc" | "desc";
const sortBy = ref<SortBy>("recent");

const page = ref(1);
const total = ref(0);
const totalPages = ref(1);
const stats = ref({ total: 0, familiar: 0, recent: 0 });
const sourceCounts = ref({ all: 0, private: 0, group: 0 });
const pendingSuggestions = ref(0);

const SORT_OPTIONS: ReadonlyArray<{ value: SortBy; label: string }> = [
  { value: "recent", label: "最近互动" },
  { value: "count", label: "互动次数" },
  { value: "closeness", label: "关系亲疏" },
  { value: "known", label: "认识先后" },
];

/**
 * 每个维度各记各的方向。
 *
 * 不是「一个下拉选字段 + 一个全局箭头」：那样子切换字段方向会被带跑（刚把次数翻成升序，
 * 切到时间又变成升序）。这里每个维度自己存，点当前那个再点一次才翻转。
 */
const sortDirections = ref<Record<SortBy, SortDirection>>({
  recent: "desc",
  count: "desc",
  closeness: "desc",
  known: "asc",
});

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function platformLabel(platform: string) {
  if (platform === "bili") return "B站";
  if (platform === "qq-onebot") return "QQ";
  if (platform === "wechat") return "微信";
  return platform;
}

function sourceLabel(source: string | null) {
  if (source === "GROUP") return "群里认识";
  if (source === "PRIVATE") return "私聊认识";
  return "来源不明";
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function proactiveAttemptLabel(friend: Friend) {
  const attempt = friend.lastProactiveContactAttempt;
  if (!attempt) return "暂无联系记录";
  const labels: Record<typeof attempt.status, string> = {
    SENDING: "发送中",
    SENT: "已发送",
    SKIPPED: "已跳过",
    FAILED: "发送失败",
    EXPIRED: "已过期",
  };
  const reasons: Record<string, string> = {
    no_common_group: "没有共同群",
    group_mode_forbids: "群设置为仅 @ 回复",
    quiet_hours: "群安静时段",
    target_not_verified: "无法确认好友仍在群内",
    nothing_to_say: "暂时没有自然话题",
    friend_cooldown: "好友冷却中",
    ai_dialogue_limit: "AI 连续对话保护",
    daily_limit: "今日次数已达上限",
    not_authorized: "未授权",
    relationship_not_close: "关系还不够熟",
    relationship_not_healthy: "关系状态不适合",
    friend_blocked: "已禁止交流",
    model_error: "模型调用失败",
    send_failed: "消息发送失败",
    sent_but_transcript_failed: "已发送，转录写入失败",
    dispatch_lease_expired: "发送中断，已过期",
    already_attempted: "本时间窗已尝试",
    dispatch_in_progress: "发送处理中",
    dispatching: "正在发送",
  };
  const reason = attempt.reason === "ok" ? "" : reasons[attempt.reason] ?? attempt.reason;
  const when = formatDateTime(attempt.sentAt ?? attempt.attemptedAt);
  return [labels[attempt.status], reason, when].filter(Boolean).join(" · ");
}

/** 头像只放一个字：昵称取首字，没有昵称就取 UID 首位。真头像取不到时也回落到这里。 */
function initialOf(friend: Friend) {
  const source = friend.displayName || friend.platformUid || "?";
  return Array.from(source)[0] ?? "?";
}

/**
 * 真头像：只有 QQ 能纯前端拼出来。
 *
 * `q1.qlogo.cn` 是 QQ 的公开头像服务，URL 里带 QQ 号就能取（实测 image/jpeg，3–23KB，
 * `Cache-Control: max-age=2592000`）。所以服务端不存图、不加接口、不加字段，
 * 浏览器直连腾讯 CDN，一个月只下一次。
 *
 * 只对「纯数字 QQ 号」生效：onebot 的陌生人是 `u_xxxx` 这种，拼不出东西。
 * B站需要先用 view 接口换 face（`bili/cover.get.ts` 那套），微信没有公开途径，
 * 这两种都继续用首字。
 */
function avatarUrl(friend: Friend) {
  if (friend.platform !== "qq-onebot") return null;
  if (!/^\d{5,12}$/.test(friend.platformUid)) return null;
  // s=100 是 100×100，卡片显示 40px，2x 屏也够。
  return `https://q1.qlogo.cn/g?b=qq&nk=${friend.platformUid}&s=100`;
}

/** 图裂了（隐私设置 / 防盗链）就退回首字，按 scopeId 记，翻页回来不用重试。 */
const brokenAvatars = ref<Record<string, boolean>>({});

function markAvatarBroken(scopeId: string) {
  brokenAvatars.value = { ...brokenAvatars.value, [scopeId]: true };
}

const currentCharacter = computed(
  () => characters.value.find((item) => item.id === activeCharacterId.value) ?? null,
);

const sourceOptions = computed<Array<{ value: "ALL" | "PRIVATE" | "GROUP"; label: string; count: number }>>(() => [
  { value: "ALL", label: "全部", count: sourceCounts.value.all },
  { value: "PRIVATE", label: "私聊认识", count: sourceCounts.value.private },
  { value: "GROUP", label: "群里认识", count: sourceCounts.value.group },
]);

// 列表请求序号：快速切角色 / 搜索 / 翻页时，只允许最后一次请求提交页面状态。
let loadSequence = 0;

async function load(target = page.value) {
  const requestId = ++loadSequence;
  // 请求参数在发出时固定下来，不能让响应对应的筛选条件在等待期间变化。
  const requestQuery = {
    characterId: activeCharacterId.value || undefined,
    q: query.value.trim() || undefined,
    source: sourceFilter.value,
    sort: sortBy.value,
    dir: sortDirections.value[sortBy.value],
    page: target,
    pageSize: PAGE_SIZE,
  };
  loading.value = true;
  // 换角色 / 换筛选 / 翻页之后，之前勾的人可能已经不在这一页上了，先清空勾选。
  selectedIds.value = [];
  try {
    const response = await $fetch<FriendPage>("/api/admin/identities", { query: requestQuery });
    if (requestId !== loadSequence) return;
    friends.value = response.items;
    characters.value = response.characters;
    page.value = response.page;
    total.value = response.total;
    totalPages.value = response.totalPages;
    stats.value = response.stats;
    sourceCounts.value = response.sourceCounts;
    pendingSuggestions.value = response.pendingSuggestions ?? 0;
  } catch (error) {
    if (requestId !== loadSequence) return;
    ElMessage.error(readErrorMessage(error, "无法读取朋友列表。"));
  } finally {
    if (requestId === loadSequence) loading.value = false;
  }
}

/** 换角色直接重取：名单变了，停在原来的页码上没有意义。 */

function pickSource(value: "ALL" | "PRIVATE" | "GROUP") {
  if (value === sourceFilter.value) return;
  sourceFilter.value = value;
  load(1);
}

function pickSort(value: SortBy) {
  if (sortBy.value === value) {
    sortDirections.value[value] = sortDirections.value[value] === "asc" ? "desc" : "asc";
  } else {
    sortBy.value = value;
  }
  load(1);
}

/** 搜索防抖：每敲一个字就发一次请求，中文输入法下等于连打十次。 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onQueryInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    load(1);
  }, 260);
}

/**
 * 备注：她私底下怎么叫这个人。
 *
 * 编辑放在这张页面上，而不是角色资料里 —— 备注是「按人」的，翻角色资料去改一个人的外号
 * 得先想起他属于哪个角色。保存走全量替换，返回值是服务端归一化之后的结果
 * （截断、去重、去本名都在那边做），页面直接拿它渲染，用户看到的和库里永远一致。
 */
const editingScopeId = ref("");
const aliasDraft = ref("");
const aliasSaving = ref(false);

/**
 * 身份与交流：点一下就是最终决定，没有「保存设置」那一步。
 *
 * 两个维度各三个选项，用单选框而不是下拉 —— 只有三个值，下拉要点两下、还得读一遍才知道有哪些选择；
 * 平铺出来一眼看全，点完立刻生效。选项说明放 title 里，不占版面。
 * 行首不再挂「身份 / 交流」两个字：选项自己说明得清，省下的横向空间给按钮。
 * 读屏用 aria-label 补回分组名。
 */
const IDENTITY_KIND_OPTIONS: ReadonlyArray<{ value: Friend["identityKind"]; label: string; hint: string }> = [
  { value: "UNKNOWN", label: "未知", hint: "还没判断过：按默认规则处理" },
  { value: "HUMAN", label: "真人", hint: "确认是真人：她正常接话" },
  { value: "AI", label: "AI", hint: "确认是 AI：她默认不接话" },
];

const CHAT_POLICY_OPTIONS: ReadonlyArray<{ value: Friend["friendChatPolicy"]; label: string; hint: string }> = [
  { value: "DEFAULT", label: "默认", hint: "默认规则：真人正常回，AI 默认不回" },
  { value: "ALLOW", label: "允许交流", hint: "这个角色一定接这个人的话" },
  { value: "BLOCK", label: "禁止交流", hint: "这个角色不理这个人" },
];

/** 每张卡片的保存状态：saving 显示「保存中」，saved 显示「已保存」并在 1.6 秒后自己消失。 */
type SaveState = "saving" | "saved";
const saveStates = ref<Record<string, SaveState>>({});
const saveTokens = new Map<string, number>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function markSaveState(scopeId: string, state: SaveState | null) {
  const existing = saveTimers.get(scopeId);
  if (existing) {
    clearTimeout(existing);
    saveTimers.delete(scopeId);
  }
  const next = { ...saveStates.value };
  if (state) next[scopeId] = state;
  else delete next[scopeId];
  saveStates.value = next;
  if (state === "saved") {
    saveTimers.set(scopeId, setTimeout(() => markSaveState(scopeId, null), 1600));
  }
}

function saveStateLabel(scopeId: string) {
  const state = saveStates.value[scopeId];
  if (state === "saving") return "保存中…";
  if (state === "saved") return "已保存";
  return "";
}

/**
 * 改一个字段就 PATCH 一次，带序号防乱序：连点两下时只认最后一次的响应，
 * 否则先发的请求后回来，会把界面上新的选择又改回旧值。
 */
async function patchFriend(friend: Friend, patch: {
  identityKind?: Friend["identityKind"];
  friendChatPolicy?: Friend["friendChatPolicy"];
  proactiveContactEnabled?: boolean;
}) {
  const scopeId = friend.scopeId;
  const token = (saveTokens.get(scopeId) ?? 0) + 1;
  saveTokens.set(scopeId, token);
  markSaveState(scopeId, "saving");
  try {
    const response = await $fetch<
      Partial<Pick<Friend, "identityKind" | "identityKindSource" | "friendChatPolicy" | "proactiveContactEnabled">> & { scopeId: string }
    >(`/api/admin/identities/${scopeId}`, { method: "PATCH", body: patch });
    if (saveTokens.get(scopeId) !== token) return;
    friends.value = friends.value.map((item) => (item.scopeId === scopeId ? { ...item, ...response } : item));
    markSaveState(scopeId, "saved");
  } catch (error) {
    if (saveTokens.get(scopeId) !== token) return;
    markSaveState(scopeId, null);
    ElMessage.error(readErrorMessage(error, "没保存上，已恢复成服务端的设置。"));
    await load(page.value);
  }
}

function setIdentityKind(friend: Friend, kind: Friend["identityKind"]) {
  if (friend.identityKind === kind) return;
  // 先改本地再发请求：单选框必须立刻有反馈，等服务端回来再动会像卡了一下。
  friend.identityKind = kind;
  // 手动选过就是人工确认，服务端也会这么写，先把标记对上来。
  friend.identityKindSource = "MANUAL";
  void patchFriend(friend, { identityKind: kind });
}

function setChatPolicy(friend: Friend, policy: Friend["friendChatPolicy"]) {
  if (friend.friendChatPolicy === policy) return;
  friend.friendChatPolicy = policy;
  void patchFriend(friend, { friendChatPolicy: policy });
}

/** 主动联系许可独立于普通交流权限；BLOCK 仍由服务端安全闸门优先处理。 */
function setProactiveContactEnabled(friend: Friend, enabled: boolean) {
  if (friend.proactiveContactEnabled === enabled) return;
  friend.proactiveContactEnabled = enabled;
  void patchFriend(friend, { proactiveContactEnabled: enabled });
}

function proactiveContactAttemptLabel(friend: Friend): string {
  const attempt = friend.lastProactiveContactAttempt;
  if (!attempt) return "";
  const labels: Record<NonNullable<Friend["lastProactiveContactAttempt"]>["status"], string> = {
    SENDING: "正在发送",
    SENT: "已发送",
    SKIPPED: "已跳过",
    FAILED: "发送失败",
    EXPIRED: "已过期",
  };
  return `最近主动联系：${labels[attempt.status]} · ${formatDateTime(attempt.sentAt ?? attempt.attemptedAt)}`;
}

/**
 * 多选：给「很少聊的那几个人」准备的一次性清理。
 *
 * 不在卡片上常驻勾选框 —— 平时这张页面是「看人」的，勾选框会让每张卡都像待办事项。
 * 点页头的「多选」才进这个模式：卡片变可选、身份/交流暂时不可改（避免一边选一边写）。
 */
const selecting = ref(false);
const selectedIds = ref<string[]>([]);

const selectedFriends = computed(() =>
  friends.value.filter((friend) => selectedIds.value.includes(friend.scopeId)),
);

const allSelected = computed(
  () => friends.value.length > 0 && selectedIds.value.length === friends.value.length,
);

function isPicked(friend: Friend) {
  return selectedIds.value.includes(friend.scopeId);
}

function toggleSelect(friend: Friend) {
  selectedIds.value = isPicked(friend)
    ? selectedIds.value.filter((id) => id !== friend.scopeId)
    : [...selectedIds.value, friend.scopeId];
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value ? [] : friends.value.map((friend) => friend.scopeId);
}

function exitSelecting() {
  selecting.value = false;
  selectedIds.value = [];
}

function toggleSelecting() {
  if (selecting.value) exitSelecting();
  else selecting.value = true;
}

/**
 * 删朋友：把这条关系和它名下的对话、忆泡、阶段总结、长期记忆一起删掉。
 *
 * 不是「隐藏」—— 对方下次再来会重新建一条空关系，从 0 开始计数。
 * 所以先在弹窗里把要连带删掉的数量摆出来（这些数字列表里就有，不用再多打一次接口）。
 * 单个删除和批量删除共用这一个弹窗：`deleteTargets` 里几个就是几个。
 */
const deleteTargets = ref<Friend[]>([]);
const deleteDialogOpen = ref(false);
const deleteSubmitting = ref(false);

const deleteIsBatch = computed(() => deleteTargets.value.length > 1);
const deleteSingle = computed(() => (deleteTargets.value.length === 1 ? deleteTargets.value[0]! : null));
const deleteConversationTotal = computed(
  () => deleteTargets.value.reduce((sum, friend) => sum + friend.conversationCount, 0),
);
const deleteAliasTotal = computed(
  () => deleteTargets.value.reduce((sum, friend) => sum + friend.aliases.length, 0),
);

function askDelete(friend: Friend) {
  deleteTargets.value = [friend];
  deleteDialogOpen.value = true;
}

function askBatchDelete() {
  if (!selectedFriends.value.length) return;
  deleteTargets.value = [...selectedFriends.value];
  deleteDialogOpen.value = true;
}

async function confirmDelete() {
  const targets = deleteTargets.value;
  if (!targets.length || deleteSubmitting.value) return;
  deleteSubmitting.value = true;
  try {
    if (targets.length === 1) {
      const only = targets[0]!;
      await $fetch(`/api/admin/identities/${only.scopeId}`, { method: "DELETE" });
      ElMessage.success(`已删掉和「${only.displayName || only.platformUid}」的关系。`);
    } else {
      const response = await $fetch<{ deleted: number; failed: number }>(
        "/api/admin/identities/batch-delete",
        { method: "POST", body: { scopeIds: targets.map((friend) => friend.scopeId) } },
      );
      if (response.failed > 0) {
        ElMessage.warning(`删掉 ${response.deleted} 个，还有 ${response.failed} 个没删掉，刷新后重试。`);
      } else {
        ElMessage.success(`已删掉 ${response.deleted} 个朋友关系。`);
      }
    }
    deleteDialogOpen.value = false;
    exitSelecting();
    // 这一页删空了就往前翻一页，不然会停在空页上。
    const remaining = friends.value.length - targets.length;
    await load(remaining > 0 ? page.value : Math.max(1, page.value - 1));
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "没删掉，稍后重试。"));
  } finally {
    deleteSubmitting.value = false;
  }
}

async function startEdit(friend: Friend) {
  editingScopeId.value = friend.scopeId;
  // 回填用全角逗号：这一栏本来就是给人用中文输入法写的。
  aliasDraft.value = friend.aliases.join("，");
  await nextTick();
  document.querySelector<HTMLInputElement>(`[data-alias-input="${friend.scopeId}"]`)?.focus();
}

function cancelEdit() {
  editingScopeId.value = "";
  aliasDraft.value = "";
}

function applyAliases(scopeId: string, aliases: string[]) {
  friends.value = friends.value.map((item) => (item.scopeId === scopeId ? { ...item, aliases } : item));
}

async function saveAliases(friend: Friend, aliases: string | string[], closeEditor = false) {
  if (aliasSaving.value) return;
  aliasSaving.value = true;
  try {
    const response = await $fetch<{ aliases: string[]; dropped: number }>(
      `/api/admin/identities/aliases/${friend.scopeId}`,
      { method: "PATCH", body: { aliases } },
    );
    applyAliases(friend.scopeId, response.aliases);
    if (closeEditor) cancelEdit();
    if (response.dropped > 0) {
      ElMessage.info(`有 ${response.dropped} 个重复或超出上限，没有保存。`);
    }
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "备注没保存上。"));
  } finally {
    aliasSaving.value = false;
  }
}

/** 单个 ×：立刻提交剩下的。删错了重打两个字就行，不值得为此弹一个确认框。 */
function removeAlias(friend: Friend, alias: string) {
  void saveAliases(friend, friend.aliases.filter((item) => item !== alias));
}

/**
 * 待审备注弹窗：她（在快照提炼时）想给朋友起的叫法，等用户点头。
 *
 * 同意 = 写进那个人的 aliases；删掉 = 标记 REJECTED（不删行，唯一约束挡着不再被提回来）。
 * 裁决后从本地列表移除并刷新角标，不用整页重载。
 */
type Suggestion = {
  id: string;
  scopeId: string;
  alias: string;
  reason: string;
  friendName: string;
  platform: string;
  platformUid: string;
};

const suggestionDialogOpen = ref(false);
const suggestions = ref<Suggestion[]>([]);
const suggestionsLoading = ref(false);
const resolvingSuggestionId = ref("");
let suggestionRequestSequence = 0;

async function openSuggestions() {
  const requestId = ++suggestionRequestSequence;
  const requestedCharacterId = activeCharacterId.value;
  suggestionDialogOpen.value = true;
  suggestionsLoading.value = true;
  try {
    const response = await $fetch<{ items: Suggestion[] }>("/api/admin/identities/aliases/suggestions", {
      query: { characterId: requestedCharacterId || undefined },
    });
    if (requestId !== suggestionRequestSequence || requestedCharacterId !== activeCharacterId.value) return;
    suggestions.value = response.items;
  } catch (error) {
    if (requestId !== suggestionRequestSequence) return;
    ElMessage.error(readErrorMessage(error, "读取待审备注失败。"));
  } finally {
    if (requestId === suggestionRequestSequence) suggestionsLoading.value = false;
  }
}

async function resolveSuggestion(suggestion: Suggestion, approve: boolean) {
  if (resolvingSuggestionId.value) return;
  resolvingSuggestionId.value = suggestion.id;
  try {
    await $fetch(`/api/admin/identities/aliases/suggestions/${suggestion.id}`, {
      method: "POST",
      body: { approve },
    });
    suggestions.value = suggestions.value.filter((item) => item.id !== suggestion.id);
    pendingSuggestions.value = Math.max(0, pendingSuggestions.value - 1);
    // 同意了就把这条叫法即时反映到卡片上，用户不用等下次刷新才知道生效了。
    if (approve) {
      const friend = friends.value.find((item) => item.scopeId === suggestion.scopeId);
      if (friend && !friend.aliases.includes(suggestion.alias)) {
        applyAliases(suggestion.scopeId, [...friend.aliases, suggestion.alias]);
      }
    }
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "操作没成功。"));
  } finally {
    resolvingSuggestionId.value = "";
  }
}

watch(id, (nextId, previousId) => {
  if (!nextId || nextId === previousId) return;
  // 全局角色切换时先作废旧请求，再清理属于旧角色的弹窗、编辑态与列表。
  // 不能等新请求回来才清空，否则切换期间会短暂展示上一个角色的好友。
  loadSequence += 1;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  suggestionRequestSequence += 1;
  suggestionDialogOpen.value = false;
  suggestions.value = [];
  suggestionsLoading.value = false;
  editingScopeId.value = "";
  aliasDraft.value = "";
  exitSelecting();
  friends.value = [];
  stats.value = { total: 0, familiar: 0, recent: 0 };
  sourceCounts.value = { all: 0, private: 0, group: 0 };
  pendingSuggestions.value = 0;
  page.value = 1;
  load(1);
});

onBeforeUnmount(() => {
  // 让卸载前仍在途的列表 / 待审备注请求失效，避免迟到响应继续改状态。
  loadSequence += 1;
  suggestionRequestSequence += 1;
  if (searchTimer) clearTimeout(searchTimer);
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
});

onMounted(() => load(1));
</script>

<template>
  <div class="page-wrap fr-a">
    <PageHeader
      eyebrow="成长系统 / 社交系统 / 好友档案"
      description="私聊来访、群里见过的人都会记录下来。可以手动标记真人 / AI，并按当前角色决定她是否与对方交流。"
    >
      <template #actions>
        <button
          type="button"
          class="btn btn-select-mode"
          :class="{ 'is-on': selecting }"
          @click="toggleSelecting"
        >
          {{ selecting ? "退出多选" : "多选" }}
        </button>
        <button
          type="button"
          class="btn btn-suggest"
          @click="openSuggestions"
        >
          待审备注
          <span
            v-if="pendingSuggestions"
            class="suggest-badge"
          >{{ pendingSuggestions }}</span>
        </button>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="load()"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
      </template>
    </PageHeader>

    <div
      v-if="loading && !friends.length"
      class="friend-grid"
    >
      <div
        v-for="i in 4"
        :key="'sk-' + i"
        class="friend-card is-skeleton"
      >
        <div
          v-for="n in 3"
          :key="n"
          class="sk"
          :style="{ height: n === 1 ? '32px' : '14px', width: n === 1 ? '58%' : '100%' }"
        />
      </div>
    </div>

    <div
      v-else-if="!characters.length"
      class="empty-block"
    >
      <span class="empty-icon"><el-icon><User /></el-icon></span>
      <h3>还没有角色</h3>
      <p>先建一个角色，她在平台上认识的人才会记到这里。</p>
    </div>

    <template v-else>
      <div class="toolbar">
        <label class="fr-search">
          <el-icon><Search /></el-icon>
          <input
            v-model="query"
            type="search"
            placeholder="搜昵称、UID 或备注"
            @input="onQueryInput"
          >
        </label>
        <span class="seg-label">来源</span>
        <div class="seg">
          <button
            v-for="option in sourceOptions"
            :key="option.value"
            type="button"
            class="seg-btn"
            :class="{ 'is-on': sourceFilter === option.value }"
            @click="pickSource(option.value)"
          >
            {{ option.label }}<span class="seg-n">{{ option.count }}</span>
          </button>
        </div>
        <span class="seg-label">排序</span>
        <div class="seg seg-sort">
          <button
            v-for="option in SORT_OPTIONS"
            :key="option.value"
            type="button"
            class="seg-btn"
            :class="{ 'is-on': sortBy === option.value }"
            :title="sortBy === option.value ? '再点一次切换升降序' : `按「${option.label}」排序`"
            @click="pickSort(option.value)"
          >
            {{ option.label }}<span
              v-if="sortBy === option.value"
              class="seg-dir"
            >{{ sortDirections[option.value] === "asc" ? "↑" : "↓" }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="selecting"
        class="sel-bar"
      >
        <span class="sel-count">已选 <b>{{ selectedIds.length }}</b> 人</span>
        <button
          type="button"
          class="sel-link"
          @click="toggleSelectAll"
        >
          {{ allSelected ? "取消全选" : "全选本页" }}
        </button>
        <span class="sel-note">多选时卡片上的身份 / 交流暂时不能改</span>
        <button
          type="button"
          class="sel-del"
          :disabled="!selectedIds.length"
          @click="askBatchDelete"
        >
          删除所选
        </button>
      </div>

      <div
        v-if="stats.total"
        class="band"
      >
        <div class="band-cell">
          <span class="band-k">{{ currentCharacter?.name ?? "她" }}认识的人</span>
          <span class="band-v">{{ stats.total }}<small>个</small></span>
          <span class="band-f">私聊来访或在群里发过言的人都会出现</span>
        </div>
        <div class="band-cell">
          <span class="band-k">聊过两次以上</span>
          <span class="band-v">{{ stats.familiar }}<small>个</small></span>
          <span class="band-f">只回一句就消失的算路人</span>
        </div>
        <div class="band-cell">
          <span class="band-k">最近七天有来往</span>
          <span class="band-v">{{ stats.recent }}<small>个</small></span>
          <span class="band-f">按最后一次互动算</span>
        </div>
      </div>

      <div
        v-if="!friends.length && !loading"
        class="empty-block"
      >
        <span class="empty-icon"><el-icon><User /></el-icon></span>
        <h3>{{ stats.total ? "没有找到这个人" : "还没遇到人" }}</h3>
        <p v-if="stats.total">
          换个关键词，或者把来源切回「全部」。
        </p>
        <p v-else>
          有人私聊她或在群里发言后，就会出现在这里；即使还没互动，也能先设置身份和交流权限。
        </p>
      </div>

      <div
        v-else
        class="friend-grid"
      >
        <article
          v-for="friend in friends"
          :key="friend.scopeId"
          class="friend-card"
          :class="{ 'is-selecting': selecting, 'is-picked': selecting && isPicked(friend) }"
          @click="selecting && toggleSelect(friend)"
        >
          <div class="fr-head">
            <input
              v-if="selecting"
              class="fr-check"
              type="checkbox"
              :checked="isPicked(friend)"
              :aria-label="`选中 ${friend.displayName || friend.platformUid}`"
              @click.stop
              @change="toggleSelect(friend)"
            >
            <img
              v-if="avatarUrl(friend) && !brokenAvatars[friend.scopeId]"
              class="fr-avatar is-photo"
              :src="avatarUrl(friend) || ''"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              @error="markAvatarBroken(friend.scopeId)"
            >
            <span
              v-else
              class="fr-avatar"
            >{{ initialOf(friend) }}</span>
            <div class="fr-id">
              <h3 class="fr-name">
                {{ friend.displayName || friend.platformUid }}
              </h3>
              <p class="fr-sub">
                {{ platformLabel(friend.platform) }}<span class="sep">·</span>{{ friend.platformUid }}
              </p>
            </div>
            <div class="fr-head-actions">
              <span class="pill pill-gray">{{ friend.interactionCount > 0 ? sourceLabel(friend.firstSource) : "群里见过" }}</span>
              <button
                v-if="!selecting"
                type="button"
                class="fr-del"
                :title="`删掉「${friend.displayName || friend.platformUid}」这条朋友关系和她的相关记忆`"
                aria-label="删除朋友"
                @click="askDelete(friend)"
              >
                <el-icon><Delete /></el-icon>
              </button>
            </div>
          </div>

          <div class="fr-alias">
            <span
              v-for="alias in friend.aliases"
              :key="alias"
              class="alias-chip"
            >
              {{ alias }}
              <button
                type="button"
                class="alias-x"
                :title="`删掉「${alias}」`"
                @click="removeAlias(friend, alias)"
              >×</button>
            </span>
            <button
              v-if="editingScopeId !== friend.scopeId"
              type="button"
              class="alias-add"
              :title="friend.aliases.length ? '改这些叫法' : '她按心情换着叫对方的名字'"
              @click="startEdit(friend)"
            >
              {{ friend.aliases.length ? "编辑" : "＋ 加备注" }}
            </button>
          </div>

          <div
            v-if="editingScopeId === friend.scopeId"
            class="alias-editor"
          >
            <input
              v-model="aliasDraft"
              :data-alias-input="friend.scopeId"
              type="text"
              placeholder="用逗号隔开，例如：小鱼干，宝，笨蛋鱼"
              @keydown.enter.prevent="saveAliases(friend, aliasDraft, true)"
              @keydown.esc="cancelEdit"
            >
            <p class="alias-hint">
              最多 8 个、每个 12 字。她会在私聊和这个群的熟人面前，按当时的心情挑一个叫。
            </p>
            <div class="alias-actions">
              <button
                type="button"
                class="alias-save"
                :disabled="aliasSaving"
                @click="saveAliases(friend, aliasDraft, true)"
              >
                保存
              </button>
              <button
                type="button"
                class="alias-cancel"
                @click="cancelEdit"
              >
                取消
              </button>
            </div>
          </div>

          <div
            class="friend-controls"
            :class="{ 'is-locked': selecting }"
          >
            <div
              class="friend-opts"
              role="radiogroup"
              aria-label="身份"
            >
              <label
                v-for="option in IDENTITY_KIND_OPTIONS"
                :key="option.value"
                class="friend-opt"
                :class="{ 'is-on': friend.identityKind === option.value }"
                :title="option.hint"
              >
                <input
                  type="radio"
                  :name="`friend-kind-${friend.scopeId}`"
                  :value="option.value"
                  :checked="friend.identityKind === option.value"
                  @change="setIdentityKind(friend, option.value)"
                >
                {{ option.label }}
              </label>
            </div>
            <div
              class="friend-opts"
              role="radiogroup"
              aria-label="交流权限"
            >
              <label
                v-for="option in CHAT_POLICY_OPTIONS"
                :key="option.value"
                class="friend-opt"
                :class="{
                  'is-on': friend.friendChatPolicy === option.value,
                  'is-block': option.value === 'BLOCK',
                }"
                :title="option.hint"
              >
                <input
                  type="radio"
                  :name="`friend-policy-${friend.scopeId}`"
                  :value="option.value"
                  :checked="friend.friendChatPolicy === option.value"
                  @change="setChatPolicy(friend, option.value)"
                >
                {{ option.label }}
              </label>
            </div>
            <label
              class="friend-opt"
              :class="{ 'is-on': friend.proactiveContactEnabled }"
              title="单独允许她主动联系这位好友；仍受关系阶段、禁止交流、共同群和频率保护限制"
            >
              <input
                type="checkbox"
                :checked="friend.proactiveContactEnabled"
                @change="setProactiveContactEnabled(friend, ($event.target as HTMLInputElement).checked)"
              >
              主动联系 {{ friend.proactiveContactEnabled ? "已允许" : "未授权" }}
            </label>
            <p class="friend-save-state">
              {{ saveStateLabel(friend.scopeId) }}
            </p>
            <p
              v-if="friend.lastProactiveContactAttempt"
              class="friend-save-state"
              :title="friend.lastProactiveContactAttempt.reason"
            >
              {{ proactiveContactAttemptLabel(friend) }}
            </p>
          </div>

          <dl class="fr-kv">
            <div>
              <dt>聊过</dt>
              <dd>{{ friend.interactionCount }} 次</dd>
            </div>
            <div>
              <dt>最近一次</dt>
              <dd :class="{ 'is-muted': !friend.lastInteractedAt }">
                {{ formatDateTime(friend.lastInteractedAt) }}
              </dd>
            </div>
            <div>
              <dt>认识于</dt>
              <dd>{{ formatDateTime(friend.knownSince) }}</dd>
            </div>
            <div>
              <dt>主动联系</dt>
              <dd :class="{ 'is-muted': !friend.lastProactiveContactAttempt }">
                {{ proactiveAttemptLabel(friend) }}
              </dd>
            </div>
          </dl>
        </article>
      </div>

      <PagerBar
        :page="page"
        :total="total"
        :total-pages="totalPages"
        :page-size="PAGE_SIZE"
        unit="人"
        @update:page="load"
      />
    </template>

    <el-dialog
      v-model="suggestionDialogOpen"
      title="待审备注"
      width="560px"
      class="suggest-dialog"
    >
      <p class="suggest-desc">
        她回想自己平时怎么叫这些人，想出来的叫法先放在这里。你点头才写进备注，点「不用」就删掉，她不会再提。
      </p>
      <div
        v-if="suggestionsLoading"
        class="suggest-loading"
      >
        正在读取…
      </div>
      <div
        v-else-if="!suggestions.length"
        class="suggest-empty"
      >
        还没有待审的叫法。等她的记忆周期跑一轮，或者聊得多一点，她也许就会想出几个。
      </div>
      <ul
        v-else
        class="suggest-list"
      >
        <li
          v-for="suggestion in suggestions"
          :key="suggestion.id"
          class="suggest-item"
        >
          <div class="suggest-main">
            <span class="suggest-alias">{{ suggestion.alias }}</span>
            <span class="suggest-for">给「{{ suggestion.friendName }}」</span>
            <p
              v-if="suggestion.reason"
              class="suggest-reason"
            >
              {{ suggestion.reason }}
            </p>
          </div>
          <div class="suggest-actions">
            <button
              type="button"
              class="suggest-ok"
              :disabled="resolvingSuggestionId === suggestion.id"
              @click="resolveSuggestion(suggestion, true)"
            >
              同意
            </button>
            <button
              type="button"
              class="suggest-no"
              :disabled="resolvingSuggestionId === suggestion.id"
              @click="resolveSuggestion(suggestion, false)"
            >
              不用
            </button>
          </div>
        </li>
      </ul>
    </el-dialog>

    <el-dialog
      v-model="deleteDialogOpen"
      :title="deleteIsBatch ? `删掉选中的 ${deleteTargets.length} 个朋友？` : '删掉这个朋友？'"
      width="460px"
      class="friend-del-dialog"
    >
      <template v-if="deleteTargets.length">
        <div
          v-if="deleteSingle"
          class="del-who"
        >
          <span class="del-avatar">{{ initialOf(deleteSingle) }}</span>
          <span class="del-id">
            <b>{{ deleteSingle.displayName || deleteSingle.platformUid }}</b>
            <span>{{ platformLabel(deleteSingle.platform) }} · {{ deleteSingle.platformUid }} · 跟「{{ deleteSingle.characterName }}」</span>
          </span>
        </div>
        <ul
          v-else
          class="del-names"
        >
          <li
            v-for="friend in deleteTargets.slice(0, 8)"
            :key="friend.scopeId"
          >
            {{ friend.displayName || friend.platformUid }}
          </li>
          <li
            v-if="deleteTargets.length > 8"
            class="del-names-more"
          >
            还有 {{ deleteTargets.length - 8 }} 人
          </li>
        </ul>

        <p class="del-desc">
          删掉之后不能撤销，会一起带走：
        </p>
        <ul class="del-list">
          <li>{{ deleteIsBatch ? "这些朋友关系本身" : "这条朋友关系本身" }}（在哪认识的、聊过几次）</li>
          <li v-if="deleteConversationTotal">
            {{ deleteConversationTotal }} 段对话，以及对话里的聊天记录
          </li>
          <!-- 忆泡 / 阶段总结 / 长期记忆都是从那几段私聊里提炼出来的，没有会话就没有它们要删 -->
          <li v-if="deleteConversationTotal">
            {{ deleteIsBatch ? "这些关系" : "这段关系" }}里攒下的忆泡、阶段总结和长期记忆
          </li>
          <li v-if="deleteAliasTotal">
            她给对方起的备注（{{ deleteSingle ? deleteSingle.aliases.join("、") : `${deleteAliasTotal} 条` }}）
          </li>
        </ul>
        <!-- 只在群里见过的人没有单独会话，conversationCount 就是 0，也是「清名单」时最常见的那种。
             直接把「0 段对话」摆出来会让人以为「没什么可删的，你确定要点吗」，所以这里只说清原因。 -->
        <p
          v-if="!deleteConversationTotal"
          class="del-note"
        >
          {{ deleteIsBatch ? "选中的这些人" : "这个人" }}只在群里出现过、没单独聊过天，所以没有对话和记忆要删。
        </p>
        <p class="del-note">
          平台账号本身不删 —— 同一个号跟别的角色聊过的话，那边不受影响。{{ deleteIsBatch ? "这些人" : "对方" }}下次再来，会重新建一条空关系，从 0 开始算。
        </p>
      </template>
      <template #footer>
        <button
          type="button"
          class="del-cancel"
          @click="deleteDialogOpen = false"
        >
          取消
        </button>
        <button
          type="button"
          class="del-ok"
          :disabled="deleteSubmitting"
          @click="confirmDelete"
        >
          {{ deleteSubmitting ? "删除中…" : deleteIsBatch ? `删除 ${deleteTargets.length} 人` : "删除" }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* A 套：白砖、零描边、零阴影。全部规则挂在 .fr-a 下（作用域 + 压过 main.css 单类规则）。 */
.fr-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.fr-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }

/* 工具栏：角色分段 + 搜索 + 来源分段 + 排序，一行排开，宽度不够自动换行 */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: var(--sp-4); }
/* 搜索框固定窄宽，剩下的空隙靠 margin-right: auto 撑开，把来源/排序推到右边 */
.fr-search { display: flex; height: 36px; flex: 0 0 200px; align-items: center; gap: 8px; margin-right: auto; border-radius: 8px; background: var(--surface); padding: 0 12px; color: var(--dim); }
.fr-search input { width: 100%; min-width: 0; border: 0; background: none; color: var(--text); font-size: 13px; outline: none; }
.fr-search input::placeholder { color: var(--faint); }
.seg { display: flex; gap: 2px; border-radius: 8px; background: var(--surface); padding: 3px; }
/* 两组分段挨着放，标一下哪组是筛来源、哪组是换排序 */
.seg-label { color: var(--dim); font-size: 12px; font-weight: 500; }
.seg-btn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.seg-btn:hover { background: var(--surface-2); }
.seg-btn.is-on { background: var(--surface-2); color: var(--text); }
.seg-n { color: var(--dim); font-variant-numeric: tabular-nums; font-weight: 500; }
/* 当前排序维度后面的箭头：点同一个按钮就翻转，每个维度各记各的方向 */
.seg-dir { color: var(--brand-strong); font-size: 12px; font-weight: 600; line-height: 1; }

/* 统计带：三格数字并进一张白砖，脚注静音 */
.band {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 24px;
  margin-bottom: var(--sp-4);
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 20px 17px;
}
.band-cell { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.band-k { color: var(--dim); font-size: 12px; }
.band-v { color: var(--text); font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1.25; }
.band-v small { margin-left: 3px; color: var(--dim); font-size: 12px; font-weight: 500; letter-spacing: 0; }
.band-f { overflow: hidden; color: var(--dim); font-size: 12px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }

/* 一行四张；窄屏依次退到三列、两列、单列。
   阈值按视口算（左侧还有 240 的导航），1360 以下内容区不足 4×280，就退三列。 */
.friend-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-3); align-items: start; }
@media (max-width: 1360px) {
  .friend-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 1000px) {
  .friend-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.friend-card {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--surface);
  padding: 14px 16px 13px;
}
.friend-card.is-skeleton { gap: 10px; padding-bottom: 18px; }

.fr-head { display: flex; align-items: flex-start; gap: 11px; }
/* 来源标签 + 删除：两个都是「右上角的小东西」，贴在一起，别让 gap 11 把它们撑开 */
.fr-head-actions { display: flex; flex: none; align-items: center; gap: 2px; }
.fr-avatar {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 16px;
  font-weight: 700;
}
/* 真头像：裁成和首字方块同一个 40×40 圆角格，换脸不跳版；加载中露底色，不会闪白 */
.fr-avatar.is-photo { display: block; object-fit: cover; background: var(--surface-3); }
.fr-id { min-width: 0; flex: 1; }.fr-name { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.fr-sub { margin: 2px 0 0; color: var(--dim); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.fr-sub .sep { margin: 0 5px; color: var(--faint); }

/* 备注：她私底下怎么叫这个人。
   chips 用 brand-soft 而不是灰 pill —— 「群里认识」是事实标签，这里是可以改的内容。 */
.fr-alias { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 9px; }
.alias-chip {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  border-radius: 6px;
  background: var(--brand-soft);
  padding: 1px 3px 1px 8px;
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.7;
}
.alias-x { border: 0; background: none; padding: 0 3px; color: var(--brand-strong); opacity: .5; cursor: pointer; font-size: 13px; line-height: 1; }
.alias-x:hover { opacity: 1; }
.alias-add { border: 0; background: none; padding: 0 2px; color: var(--dim); font-size: 12px; font-weight: 500; cursor: pointer; }
.alias-add:hover { color: var(--brand-strong); text-decoration: underline; text-underline-offset: 3px; }

/* 编辑区：浅底一块，不描边不投影，和卡片的白砖分出层级 */
.alias-editor { margin-top: 9px; border-radius: 8px; background: var(--surface-2); padding: 9px 11px 10px; }
.alias-editor input { width: 100%; border: 0; background: none; color: var(--text); font-size: 13px; line-height: 1.6; outline: none; }
.alias-editor input::placeholder { color: var(--faint); }
.alias-hint { margin: 5px 0 0; color: var(--dim); font-size: 11px; line-height: 1.6; }
.alias-actions { display: flex; gap: 8px; margin-top: 7px; }
.alias-actions button { height: 26px; border: 0; border-radius: 6px; padding: 0 11px; font-size: 12px; font-weight: 600; cursor: pointer; }
.alias-save { background: var(--brand); color: #fff; }
.alias-save:disabled { opacity: .5; cursor: default; }
.alias-cancel { background: none; color: var(--dim); }
.alias-cancel:hover { color: var(--text); }

/* 待审备注入口：按钮 + 角标 */
.btn-suggest { position: relative; display: inline-flex; align-items: center; gap: 6px; }
/* 多选开关：开着的时候要能一眼看出「现在点卡片是选人，不是看人」 */
.fr-a .btn-select-mode.is-on { background: var(--brand-soft); color: var(--brand-strong); }
.fr-a .btn-select-mode.is-on:hover { text-decoration: none; }
.suggest-badge {
  display: inline-grid;
  min-width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 9px;
  background: var(--brand);
  padding: 0 5px;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* 待审弹窗 */
.suggest-desc { margin: 0 0 12px; color: var(--dim); font-size: 13px; line-height: 1.7; }
.suggest-loading, .suggest-empty { padding: 24px 0; color: var(--dim); font-size: 13px; text-align: center; }
.suggest-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; max-height: 50vh; overflow-y: auto; }
.suggest-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; border-radius: 10px; background: var(--surface-2); padding: 12px 14px; }
.suggest-main { min-width: 0; flex: 1; }
.suggest-alias { color: var(--text); font-size: 15px; font-weight: 700; }
.suggest-for { margin-left: 8px; color: var(--dim); font-size: 12px; }
.suggest-reason { margin: 5px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.suggest-actions { display: flex; flex: none; gap: 8px; align-items: center; }
.suggest-actions button { height: 28px; border: 0; border-radius: 6px; padding: 0 13px; font-size: 12px; font-weight: 600; cursor: pointer; }
.suggest-actions button:disabled { opacity: .5; cursor: default; }
.suggest-ok { background: var(--brand); color: #fff; }
.suggest-no { background: none; color: var(--dim); }
.suggest-no:hover { color: var(--text); }

/* 身份与交流权限：三个值平铺成单选，点一下就是最终决定，没有保存按钮。
   身份是平台账号属性，交流政策是当前角色的关系属性 —— 所以只有下面这行提示说清范围，
   每个选项的说明放在 title 里，不占版面。 */
.friend-controls {
  display: grid;
  gap: 8px;
  margin-top: 13px;
  border-top: 1px solid var(--surface-3);
  padding-top: 12px;
}
/* 多选时整块锁住：只改选择，不改设置。用透明度 + 断掉指针，比直接 v-if 掉更稳 —— 卡片高度不会跳。 */
.friend-controls.is-locked { pointer-events: none; opacity: .45; }
.friend-opts { display: flex; min-width: 0; flex-wrap: wrap; gap: 4px; }
.friend-opt {
  position: relative;
  display: inline-flex;
  height: 26px;
  align-items: center;
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  padding: 0 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.friend-opt:hover { background: var(--surface-3); }
/* 原生 radio 藏起来但保留键盘可达：用 1px + opacity 而不是 display:none，
   Tab 和方向键仍然能选中，读屏也能念出「身份 / 真人」。 */
.friend-opt input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.friend-opt:has(input:focus-visible) { outline: 2px solid var(--brand); outline-offset: 2px; }
.friend-opt.is-on { background: var(--brand-soft); color: var(--brand-strong); }
/* 禁止交流是「关掉」的动作，选中时走红色，跟允许 / 默认区分开 */
.friend-opt.is-block.is-on { background: var(--red-soft); color: var(--red-text); }
/* 保存状态：固定占一行高度，出现/消失时卡片不会跳一下 */
.friend-save-state { min-height: 14px; margin: 0; color: var(--dim); font-size: 12px; line-height: 14px; text-align: right; }

/* 多选：勾选框只在多选模式出现，卡片整块可点 */
.fr-check {
  width: 16px;
  height: 16px;
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--brand);
  cursor: pointer;
}
.friend-card.is-selecting { cursor: pointer; }
.friend-card.is-picked { outline: 2px solid var(--brand); outline-offset: -2px; }
/* 多选时备注也别改：链接类按钮停掉指针，chips 本身只是显示 */
.friend-card.is-selecting .alias-add,
.friend-card.is-selecting .alias-x { pointer-events: none; }

/* 多选工具条：跟统计带同一块白砖的调子，只在多选模式出现 */
.sel-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: var(--sp-4);
  border-radius: 10px;
  background: var(--surface);
  padding: 10px 16px;
}
.sel-count { color: var(--text-2); font-size: 14px; font-weight: 600; }
.sel-count b { color: var(--brand-strong); font-variant-numeric: tabular-nums; }
.sel-link { border: 0; background: none; padding: 0; color: var(--brand-strong); font-size: 14px; font-weight: 600; cursor: pointer; }
.sel-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.sel-note { margin-right: auto; color: var(--dim); font-size: 12px; }
.sel-del {
  height: 30px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--red);
  padding: 0 14px;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.sel-del:disabled { background: var(--surface-3); color: var(--dim); cursor: default; }

/* 删朋友：平时隐身，指到卡片上才显形（触屏没有 hover，就常显） */.fr-del {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  padding: 0;
  color: var(--faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity .14s var(--ease), background .14s var(--ease), color .14s var(--ease);
}
.fr-del .el-icon { font-size: 14px; }
.friend-card:hover .fr-del, .friend-card:focus-within .fr-del { opacity: 1; }
.fr-del:hover { background: var(--red-soft); color: var(--red-text); }
.fr-del:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; opacity: 1; }
@media (hover: none) {
  .fr-del { opacity: 1; }
}

/* 删朋友弹窗：先摆清楚删的是谁、连带走什么，再给红色按钮 */
.del-who { display: flex; align-items: center; gap: 10px; border-radius: var(--radius-sm); background: var(--surface-2); padding: 10px 12px; }
.del-avatar {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border-radius: var(--radius-xs);
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 14px;
  font-weight: 700;
}
.del-id { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.del-id b { color: var(--text); font-size: 14px; font-weight: 700; }
.del-id span { color: var(--dim); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.del-desc { margin: 14px 0 6px; color: var(--text-2); font-size: 14px; }
.del-list { margin: 0; padding-left: 18px; color: var(--dim); font-size: 14px; line-height: 1.8; }
/* 批量删除：把要删的人名先列出来，比「N 个人」更有实感 */
.del-names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.del-names li {
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  padding: 3px 9px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
}
.del-names .del-names-more { background: none; color: var(--dim); font-weight: 500; }
.del-note { margin: 12px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.del-cancel, .del-ok {
  height: 32px;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 0 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.del-cancel { background: none; color: var(--dim); }
.del-cancel:hover { color: var(--text); }
.del-ok { margin-left: 8px; background: var(--red); color: #fff; }
.del-ok:disabled { cursor: default; opacity: .6; }

/* 释义行：label 定宽 56px，值紧跟在后 */
.fr-kv { display: flex; flex-direction: column; gap: 7px; margin: 14px 0 0; border-top: 1px solid var(--surface-3); padding-top: 12px; }
.fr-kv > div { display: flex; gap: 10px; align-items: baseline; }
.fr-kv dt { flex: 0 0 56px; color: var(--dim); font-size: 12px; }
.fr-kv dd { min-width: 0; flex: 1; margin: 0; color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.fr-kv dd.is-muted { color: var(--dim); font-weight: 500; }

/* 空态：居中白砖 + 圆形图标，不用虚线框 */
.empty-block {
  display: flex;
  min-height: 260px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--surface);
  padding: 32px 24px;
  text-align: center;
}
.empty-icon {
  display: grid;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 20px;
}
.empty-block h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.empty-block p { max-width: 440px; margin: 8px 0 0; color: var(--dim); font-size: 14px; line-height: 1.75; }

@media (max-width: 760px) {
  .friend-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  /* 搜索独占一行；两排分段各自横向滚动，不硬挤 */
  .fr-search { flex: 1 1 100%; }
  .seg { max-width: 100%; overflow-x: auto; }
}
@media (max-width: 560px) {
  .band { gap: 0 12px; padding: 14px 16px 15px; }
  .band-f { display: none; }
}
</style>
