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
 * 卡片按「名片」排版：上面是「他是谁、聊过几次、多久没见」，设置默认折成一行摘要，
 * 点「调整」才铺开。理由见 docs 里的视觉/体验规范：540 条规模下这一页的读法是
 * 「先筛后人」，设置常驻会把每张卡撑成 660px 的表单，扫列时根本认不出人。
 *
 * 名单会一直长，所以筛选、排序、翻页全在服务端做：页面每次只拿一页，
 * 统计带与来源计数由接口按「这个角色的全部朋友」另算，不会因为翻了页或筛了来源就变形。
 */
import { Delete, Refresh, Search, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import {
  createIdentitiesApi,
  type AliasSuggestion as Suggestion,
  type Friend,
  type FriendCharacter as Character,
  type FriendPage,
  type FriendPatch,
  type FriendSortBy as SortBy,
  type FriendSortDirection as SortDirection,
  type FriendSourceFilter,
} from "~/api/identities";
import { readApiErrorMessage } from "~/utils/api-error";

// setup 里同步捕获本次 SSR 的请求实例，事件回调复用同一个客户端。
const identitiesApi = createIdentitiesApi(useApiRequest());

await useCharacterListData();
const { id } = useCharacterSelection("/growth/social/friends");

/** 一页 12 个＝四列三行，正好铺满不剩半行。与接口默认值保持一致。 */
const PAGE_SIZE = 12;

const loading = ref(true);
const friends = ref<Friend[]>([]);
const characters = ref<Character[]>([]);
const activeCharacterId = computed(() => id.value);
const query = ref("");
const sourceFilter = ref<FriendSourceFilter>("ALL");
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

const readErrorMessage = readApiErrorMessage;

function platformLabel(platform: string) {
  if (platform === "qq-onebot") return "QQ";
  if (platform === "wechat") return "微信";
  return platform;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 相对时间：卡片上写「3 天前」，完整时间放 title。
 *
 * 卡片只有一行宽度，绝对时间（2026-11-08 14:22）既占地方又要在脑子里做减法；
 * 而「多久没来往」正是这一页要判断的事。绝对值没丢，挂在 title 上。
 */
function relativeTime(value: string | null): { text: string; title: string } {
  if (!value) return { text: "还没聊过", title: "从没互动过" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { text: "—", title: "" };
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  const title = formatDateTime(value);
  if (minutes < 1) return { text: "刚刚", title };
  if (minutes < 60) return { text: `${minutes} 分钟前`, title };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `${hours} 小时前`, title };
  const days = Math.floor(hours / 24);
  if (days < 30) return { text: `${days} 天前`, title };
  const months = Math.floor(days / 30);
  if (months < 12) return { text: `${months} 个月前`, title };
  return { text: `${Math.floor(months / 12)} 年前`, title };
}

/**
 * 关系强度：三档，只按累计互动次数，**不含时间条件**。
 *
 * 不带时间是有意的：新鲜度已经写在信号行右侧（「2 小时前」），顶部条再编码一次时间，
 * 就会出现「昨天绿的卡今天自己变粉、用户什么都没做」——会自己变的标记不值钱。
 * 阈值 30 按当前样本的中位数偏上取整：这一页要的是「一眼认出自己人」，
 * 一半人都算「常来往」等于没标。`禁止交流` 永远覆盖强度（用户显式决定优先）。
 */
const STRENGTH_L3_MIN = 30;

type Strength = "l3" | "l2" | "l1" | "block";

function strengthOf(friend: Friend): Strength {
  if (friend.friendChatPolicy === "BLOCK") return "block";
  if (friend.interactionCount >= STRENGTH_L3_MIN) return "l3";
  if (friend.interactionCount >= 1) return "l2";
  return "l1";
}

const STRENGTH_LABEL: Record<Strength, string> = {
  l3: "常来往",
  l2: "说过话",
  l1: "只见过",
  block: "不交流",
};

/** 读屏用的规则句：药丸是三个字，光看颜色不够，说出来要能自解释。 */
const STRENGTH_RULE: Record<Strength, string> = {
  l3: `聊过 ${STRENGTH_L3_MIN} 次以上`,
  l2: `聊过 1 到 ${STRENGTH_L3_MIN - 1} 次`,
  l1: "还没回过",
  block: "已设为禁止交流",
};

/**
 * 展开态：一次只展开一张。
 *
 * 同时展开多张会让整页变成长短不一的表单堆；只留一张，视线始终在刚点的那张上。
 * 展开的内容全是既有控件，没有新增任何设置。
 */
const expandedScopeId = ref("");

function isExpanded(friend: Friend) {
  return expandedScopeId.value === friend.scopeId;
}

function toggleExpand(friend: Friend) {
  expandedScopeId.value = isExpanded(friend) ? "" : friend.scopeId;
}

function collapse(friend: Friend) {
  if (isExpanded(friend)) expandedScopeId.value = "";
}

/** 收起态最多两个备注，其余折成「＋N」；展开后全放出来。 */
const COLLAPSED_ALIAS_LIMIT = 2;

function visibleAliases(friend: Friend) {
  return isExpanded(friend) ? friend.aliases : friend.aliases.slice(0, COLLAPSED_ALIAS_LIMIT);
}

function hiddenAliasCount(friend: Friend) {
  if (isExpanded(friend)) return 0;
  return Math.max(0, friend.aliases.length - COLLAPSED_ALIAS_LIMIT);
}

/** 副行只写「平台 · UID」；「私聊认识」是少数派，只有它值得占那几个字。 */
function sourceNote(friend: Friend) {
  if (friend.firstSource !== "PRIVATE") return "";
  // 已经筛成「群里认识」时，这一页不会有私聊来源，写出来只会自相矛盾。
  if (sourceFilter.value === "GROUP" && !query.value.trim()) return "";
  return "私聊认识";
}

function subTitle(friend: Friend) {
  return `认识于 ${formatDateTime(friend.knownSince)}`;
}

/**
 * 摘要行：把每个开关的当前值写在明处，收起也不藏信息。
 *
 * 身份和交流权限永远显示（它们回答「她跟这个人怎么相处」）；
 * 三个能力开关只在打开时出现 —— 关掉的能力不占文字，靠「调整」发现。
 */
type SummaryChip = {
  key: string;
  label: string;
  prefix: string;
  variant: "muted" | "brand" | "ai" | "block";
  title: string;
};

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

function summaryChips(friend: Friend): SummaryChip[] {
  const chips: SummaryChip[] = [];
  const kind = IDENTITY_KIND_OPTIONS.find((option) => option.value === friend.identityKind);
  if (kind) {
    chips.push({
      key: "kind",
      label: kind.label,
      prefix: "身份：",
      variant: kind.value === "AI" ? "ai" : "muted",
      title: kind.hint,
    });
  }
  const policy = CHAT_POLICY_OPTIONS.find((option) => option.value === friend.friendChatPolicy);
  if (policy) {
    chips.push({
      key: "policy",
      label: policy.label,
      prefix: "交流权限：",
      variant: policy.value === "BLOCK" ? "block" : policy.value === "ALLOW" ? "brand" : "muted",
      title: policy.hint,
    });
  }
  if (friend.proactiveContactEnabled) {
    chips.push({ key: "proactive", label: "主动", prefix: "已允许主动联系，", variant: "brand", title: "已允许她主动联系这个人" });
  }
  if (friend.educationEnabled) {
    chips.push({ key: "education", label: "教育", prefix: "允许提出教育候选，", variant: "brand", title: "允许此好友提出跨场景教育候选" });
  }
  if (friend.knowledgeCollectEnabled) {
    const active = friend.characterKnowledgeCollectScope === "SELECTED";
    chips.push({
      key: "knowledge",
      label: "知识",
      prefix: active ? "作为知识来源，" : "",
      variant: active ? "brand" : "ai",
      title: active
        ? "这个角色只收选定成员的聊天，他的话会进知识候选"
        : "当前不生效：这个角色现在收所有人的聊天，知识设置改成「仅指定成员」后才会用上",
    });
  }
  return chips;
}

/** 主动联系最近一次的失败原因：只有「要处理」的三种状态才在卡片上占一行。 */
const PROACTIVE_ATTEMPT_LABELS: Record<NonNullable<Friend["lastProactiveContactAttempt"]>["status"], string> = {
  SENDING: "正在发送",
  SENT: "已发送",
  SKIPPED: "已跳过",
  FAILED: "发送失败",
  EXPIRED: "已过期",
};

const PROACTIVE_REASONS: Record<string, string> = {
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

/** 卡片上那一行：省略号截断，完整原因进 title。 */
function warnLine(friend: Friend) {
  const attempt = friend.lastProactiveContactAttempt;
  if (!attempt) return "";
  if (attempt.status !== "FAILED" && attempt.status !== "SKIPPED" && attempt.status !== "EXPIRED") return "";
  const reason = attempt.reason && attempt.reason !== "ok" ? PROACTIVE_REASONS[attempt.reason] ?? attempt.reason : "";
  return `最近主动联系：${PROACTIVE_ATTEMPT_LABELS[attempt.status]}${reason ? `（${reason}）` : ""}`;
}

/** 展开区那一行：任何状态都显示，含时间。 */
function proactiveContactAttemptLabel(friend: Friend): string {
  const attempt = friend.lastProactiveContactAttempt;
  if (!attempt) return "最近主动联系：暂无记录";
  const reason = attempt.reason && attempt.reason !== "ok" ? PROACTIVE_REASONS[attempt.reason] ?? attempt.reason : "";
  const when = formatDateTime(attempt.sentAt ?? attempt.attemptedAt);
  return ["最近主动联系：" + PROACTIVE_ATTEMPT_LABELS[attempt.status], reason, when].filter(Boolean).join(" · ");
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
 * 微信等其它平台没有公开途径，继续用首字。
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

const sourceOptions = computed<Array<{ value: FriendSourceFilter; label: string; count: number }>>(() => [
  { value: "ALL", label: "全部", count: sourceCounts.value.all },
  { value: "PRIVATE", label: "私聊认识", count: sourceCounts.value.private },
  { value: "GROUP", label: "群里认识", count: sourceCounts.value.group },
]);

/** 空结果时把生效的筛选念出来，用户才知道要清什么。 */
const activeFilterLabel = computed(() => {
  const parts: string[] = [];
  if (sourceFilter.value === "PRIVATE") parts.push("私聊认识");
  if (sourceFilter.value === "GROUP") parts.push("群里认识");
  const keyword = query.value.trim();
  if (keyword) parts.push(`搜「${keyword}」`);
  return parts.join(" · ");
});

function clearFilters() {
  query.value = "";
  sourceFilter.value = "ALL";
  load(1);
}

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
    const response = await identitiesApi.listFriends(requestQuery);
    if (requestId !== loadSequence) return;
    friends.value = response.items;
    characters.value = response.characters;
    page.value = response.page;
    total.value = response.total;
    totalPages.value = response.totalPages;
    stats.value = response.stats;
    sourceCounts.value = response.sourceCounts;
    pendingSuggestions.value = response.pendingSuggestions ?? 0;
    // 展开的那张可能已经被删掉 / 翻页翻走了，别让 id 悬空。
    if (expandedScopeId.value && !response.items.some((item) => item.scopeId === expandedScopeId.value)) {
      expandedScopeId.value = "";
    }
  } catch (error) {
    if (requestId !== loadSequence) return;
    ElMessage.error(readErrorMessage(error, "无法读取朋友列表。"));
  } finally {
    if (requestId === loadSequence) loading.value = false;
  }
}

function pickSource(value: FriendSourceFilter) {
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

/** 每张卡片的保存状态：saving 显示「保存中」，saved 显示「已保存」并在 2.4 秒后自己消失。 */
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
    // 1.6s 对读屏的 polite 队列偏短，可能还没念完就消失。
    saveTimers.set(scopeId, setTimeout(() => markSaveState(scopeId, null), 2400));
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
async function patchFriend(friend: Friend, patch: FriendPatch) {
  const scopeId = friend.scopeId;
  const token = (saveTokens.get(scopeId) ?? 0) + 1;
  saveTokens.set(scopeId, token);
  markSaveState(scopeId, "saving");
  try {
    const response = await identitiesApi.updateFriend(scopeId, patch);
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

function setEducationEnabled(friend: Friend, enabled: boolean) {
  if (friend.educationEnabled === enabled) return;
  friend.educationEnabled = enabled;
  void patchFriend(friend, { educationEnabled: enabled });
}

/** 知识来源：只影响「要不要把这个人的聊天记成知识候选」，不影响她怎么回这个人。 */
function setKnowledgeCollectEnabled(friend: Friend, enabled: boolean) {
  if (friend.knowledgeCollectEnabled === enabled) return;
  friend.knowledgeCollectEnabled = enabled;
  void patchFriend(friend, { knowledgeCollectEnabled: enabled });
}

/**
 * 多选：给「很少聊的那几个人」准备的一次性清理。
 *
 * 不在卡片上常驻勾选框 —— 平时这张页面是「看人」的，勾选框会让每张卡都像待办事项。
 * 点页头的「多选」才进这个模式：卡片变可选、身份/交流暂时不可改（避免一边选一边写）。
 * 跨页不保留勾选：540 条规模下没人会核对「已选 37 人里有 25 人不在本页」，误删代价更大。
 */
const selecting = ref(false);
const selectedIds = ref<string[]>([]);

const selectedFriends = computed(() =>
  friends.value.filter((friend) => selectedIds.value.includes(friend.scopeId)),
);

/** 判据必须是「本页 id 全在当前勾选里」；用长度比会被删完重载后的巧合骗过。 */
const allSelected = computed(
  () => friends.value.length > 0 && friends.value.every((friend) => selectedIds.value.includes(friend.scopeId)),
);

/** 勾选里混进聊过天的人时提醒一句，把「我清的是零互动群友」变成可见事实。 */
const selectedInteracted = computed(
  () => selectedFriends.value.filter((friend) => friend.interactionCount >= 1).length,
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
      await identitiesApi.deleteFriend(only.scopeId);
      ElMessage.success(`已删掉和「${only.displayName || only.platformUid}」的关系。`);
    } else {
      const response = await identitiesApi.batchDeleteFriends(targets.map((friend) => friend.scopeId));
      if (response.failed > 0) {
        ElMessage.warning(`删掉 ${response.deleted} 个，还有 ${response.failed} 个没删掉，刷新后重试。`);
      } else {
        ElMessage.success(`已删掉 ${response.deleted} 个朋友关系。`);
      }
    }
    deleteDialogOpen.value = false;
    // 删完停在多选态：清一批人往往要连清几页，每页都重进多选等于白点一次。
    selectedIds.value = [];
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
    const response = await identitiesApi.updateAliases(friend.scopeId, aliases);
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
const suggestionDialogOpen = ref(false);
const suggestions = ref<Suggestion[]>([]);
const suggestionsLoading = ref(false);
const resolvingSuggestionId = ref("");
let suggestionRequestSequence = 0;
let suggestionResolveSequence = 0;
const suggestionsError = ref("");

async function openSuggestions() {
  const requestId = ++suggestionRequestSequence;
  const requestedCharacterId = activeCharacterId.value;
  if (!requestedCharacterId) return;
  suggestionDialogOpen.value = true;
  suggestions.value = [];
  suggestionsError.value = "";
  suggestionsLoading.value = true;
  try {
    const response = await identitiesApi.listAliasSuggestions(requestedCharacterId);
    if (requestId !== suggestionRequestSequence || requestedCharacterId !== activeCharacterId.value) return;
    suggestions.value = response.items;
  } catch (error) {
    if (requestId !== suggestionRequestSequence) return;
    suggestionsError.value = readErrorMessage(error, "读取待审备注失败。");
  } finally {
    if (requestId === suggestionRequestSequence) suggestionsLoading.value = false;
  }
}

async function resolveSuggestion(suggestion: Suggestion, approve: boolean) {
  if (resolvingSuggestionId.value) return;
  const characterId = activeCharacterId.value;
  const sequence = ++suggestionResolveSequence;
  const current = () => sequence === suggestionResolveSequence && characterId === activeCharacterId.value;
  resolvingSuggestionId.value = suggestion.id;
  try {
    const result = await identitiesApi.resolveAliasSuggestion(suggestion.id, approve);
    if (!current()) return;
    suggestions.value = suggestions.value.filter((item) => item.id !== suggestion.id);
    pendingSuggestions.value = Math.max(0, pendingSuggestions.value - 1);
    // 同意了就把这条叫法即时反映到卡片上，用户不用等下次刷新才知道生效了。
    if (approve) {
      applyAliases(suggestion.scopeId, result.aliases);
    }
  } catch (error) {
    if (current()) ElMessage.error(readErrorMessage(error, "操作没成功。"));
  } finally {
    if (current()) resolvingSuggestionId.value = "";
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
  suggestionResolveSequence += 1;
  resolvingSuggestionId.value = "";
  suggestionDialogOpen.value = false;
  suggestions.value = [];
  suggestionsLoading.value = false;
  editingScopeId.value = "";
  aliasDraft.value = "";
  expandedScopeId.value = "";
  exitSelecting();
  friends.value = [];
  stats.value = { total: 0, familiar: 0, recent: 0 };
  sourceCounts.value = { all: 0, private: 0, group: 0 };
  pendingSuggestions.value = 0;
  // 换角色 = 换数据集，筛选条件不能跟着走：来源计数是按角色算的，同一个「私聊认识」
  // 在新角色身上含义已经变了；留着关键词更容易让人以为「这个角色没朋友」。
  // 排序是纯偏好，保留。
  query.value = "";
  sourceFilter.value = "ALL";
  page.value = 1;
  load(1);
});

onBeforeUnmount(() => {
  // 让卸载前仍在途的列表 / 待审备注请求失效，避免迟到响应继续改状态。
  loadSequence += 1;
  suggestionRequestSequence += 1;
  suggestionResolveSequence += 1;
  resolvingSuggestionId.value = "";
  if (searchTimer) clearTimeout(searchTimer);
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
});

/** 有了旧数据就不再显示骨架屏，改用半透明遮住（换角色时 friends 已清空，会走骨架屏）。 */
const showSkeleton = computed(() => loading.value && !friends.value.length);

onMounted(() => load(1));
</script>

<template>
  <div
    class="page-wrap fr-a"
    :class="{ 'is-selecting': selecting }"
  >
    <PageHeader
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

    <!-- 骨架屏：12 张锁 220 高，和真实卡片同一个格子，加载完不跳版 -->
    <div
      v-if="showSkeleton"
      class="grid"
      aria-hidden="true"
    >
      <div
        v-for="i in PAGE_SIZE"
        :key="'sk-' + i"
        class="card is-skeleton"
      >
        <div class="sk sk-avatar" />
        <div class="sk sk-name" />
        <div class="sk sk-sub" />
        <div class="sk sk-line" />
      </div>
    </div>

    <div
      v-else-if="!characters.length"
      class="empty"
    >
      <span class="empty-ico"><el-icon><User /></el-icon></span>
      <h3>还没有角色</h3>
      <p>先建一个角色，她在平台上认识的人才会记到这里。</p>
    </div>

    <template v-else>
      <!-- 工具栏：搜索固定 240，两组分段各带 aria-label，不再挂两个 12px 文字标签 -->
      <div class="toolbar">
        <label class="search">
          <el-icon><Search /></el-icon>
          <input
            v-model="query"
            type="search"
            placeholder="搜昵称、UID 或备注"
            @input="onQueryInput"
          >
        </label>
        <div
          class="seg"
          role="group"
          aria-label="筛选来源"
        >
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
        <div
          class="seg"
          role="group"
          aria-label="排序方式"
        >
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

      <!-- 多选条与统计带同槽位同高：进出多选零垂直位移 -->
      <div
        v-if="selecting"
        class="sel-bar"
      >
        <span class="sel-count">已选 <b>{{ selectedIds.length }}</b> 人</span>
        <button
          type="button"
          class="sel-link"
          :title="`只选这一页的 ${friends.length} 人，翻页后要重新选`"
          @click="toggleSelectAll"
        >
          {{ allSelected ? "取消全选" : `全选本页 ${friends.length} 人` }}
        </button>
        <span
          v-if="selectedInteracted"
          class="sel-note"
        >已选里 {{ selectedInteracted }} 个聊过天</span>
        <span
          v-else
          class="sel-note is-plain"
        >多选时卡片上的身份 / 交流暂时不能改</span>
        <button
          type="button"
          class="sel-del"
          :class="{ 'is-armed': selectedIds.length > 0 }"
          :disabled="!selectedIds.length"
          @click="askBatchDelete"
        >
          删除所选
        </button>
      </div>

      <div
        v-else-if="stats.total"
        class="band"
      >
        <div class="band-cell">
          <span class="band-krow">
            <span
              class="band-k"
              title="私聊来访或在群里发过言的人都会出现"
            >{{ currentCharacter?.name ?? "她" }}认识的人</span>
            <span class="band-f">私聊 {{ sourceCounts.private }} · 群里 {{ sourceCounts.group }}</span>
          </span>
          <span class="band-v">{{ stats.total }}<small>个</small></span>
        </div>
        <div class="band-cell">
          <span
            class="band-k"
            title="只回一句就消失的算路人"
          >聊过两次以上</span>
          <span class="band-v">{{ stats.familiar }}<small>个</small></span>
        </div>
        <div class="band-cell">
          <span
            class="band-k"
            title="按最后一次互动算"
          >最近七天有来往</span>
          <span class="band-v">{{ stats.recent }}<small>个</small></span>
        </div>
      </div>

      <!-- 空结果：把生效的筛选念出来，并给一个能点的出口 -->
      <div
        v-if="!friends.length && !loading"
        class="empty"
      >
        <span class="empty-ico"><el-icon><User /></el-icon></span>
        <h3>{{ stats.total ? "没有找到这个人" : "还没遇到人" }}</h3>
        <p v-if="stats.total">
          换个关键词，或者把来源切回「全部」。
        </p>
        <p v-else>
          有人私聊她或在群里发言后，就会出现在这里；即使还没互动，也能先设置身份和交流权限。
        </p>
        <p
          v-if="stats.total && activeFilterLabel"
          class="empty-cond"
        >
          当前筛选：{{ activeFilterLabel }}
        </p>
        <button
          v-if="stats.total"
          type="button"
          class="empty-reset"
          @click="clearFilters"
        >
          清空筛选
        </button>
      </div>

      <div
        v-else
        class="grid"
        :style="loading ? { opacity: 0.55 } : undefined"
        :aria-busy="loading"
      >
        <article
          v-for="friend in friends"
          :key="friend.scopeId"
          class="card"
          :class="[
            `is-${strengthOf(friend)}`,
            {
              'is-open': isExpanded(friend),
              'is-picked': selecting && isPicked(friend),
            },
          ]"
          :aria-labelledby="`nm-${friend.scopeId}`"
          @click="selecting && toggleSelect(friend)"
        >
          <span
            class="card-bar"
            aria-hidden="true"
          />

          <!-- ① 身份区：头像 + 昵称（2 行钳制）。删除键绝对定位在右上，不占这里的宽度 -->
          <div class="head">
            <label
              v-if="selecting"
              class="pick"
              @click.stop
            >
              <input
                type="checkbox"
                :checked="isPicked(friend)"
                :aria-label="`选中 ${friend.displayName || friend.platformUid}`"
                @change="toggleSelect(friend)"
              >
            </label>
            <img
              v-if="avatarUrl(friend) && !brokenAvatars[friend.scopeId]"
              class="avatar is-photo"
              :src="avatarUrl(friend) || ''"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              @error="markAvatarBroken(friend.scopeId)"
            >
            <span
              v-else
              class="avatar"
              aria-hidden="true"
            >{{ initialOf(friend) }}</span>
            <div class="card-id">
              <h3
                :id="`nm-${friend.scopeId}`"
                class="name"
                :title="friend.displayName || friend.platformUid"
              >
                {{ friend.displayName || friend.platformUid }}
              </h3>
              <p
                class="sub"
                :title="subTitle(friend)"
              >
                <span class="sub-main">{{ platformLabel(friend.platform) }} · {{ friend.platformUid }}</span>
                <span
                  v-if="sourceNote(friend)"
                  class="sub-src"
                >· {{ sourceNote(friend) }}</span>
              </p>
            </div>
          </div>

          <!-- ② 关系信号：强度词 + 聊过几次 + 多久没来往，读成一句话 -->
          <div class="signal">
            <span
              class="pill"
              :class="`is-${strengthOf(friend)}`"
              :title="`${STRENGTH_LABEL[strengthOf(friend)]}：${STRENGTH_RULE[strengthOf(friend)]}`"
            >
              {{ STRENGTH_LABEL[strengthOf(friend)] }}<span class="sr-only">（{{ STRENGTH_RULE[strengthOf(friend)] }}）</span>
            </span>
            <span class="s-label">聊过</span><b
              class="s-num"
              :class="{ 'is-zero': !friend.interactionCount }"
            >{{ friend.interactionCount }}</b><span class="s-label">次</span>
            <span
              class="s-time"
              :title="relativeTime(friend.lastInteractedAt).title"
            >{{ relativeTime(friend.lastInteractedAt).text }}</span>
          </div>

          <!-- ③ 备注：收起最多两个 + ＋N；展开后全放出来 -->
          <div class="aliases">
            <span
              v-for="alias in visibleAliases(friend)"
              :key="alias"
              class="alias"
            >
              <span class="alias-txt">{{ alias }}</span>
              <button
                type="button"
                class="alias-x"
                :aria-label="`删掉「${alias}」`"
                :title="`删掉「${alias}」`"
                @click.stop="removeAlias(friend, alias)"
              >×</button>
            </span>
            <span
              v-if="hiddenAliasCount(friend)"
              class="alias-more"
              :title="friend.aliases.join('、')"
            >＋{{ hiddenAliasCount(friend) }}</span>
            <button
              v-if="editingScopeId !== friend.scopeId"
              type="button"
              class="alias-add"
              :title="friend.aliases.length ? '改这些叫法' : '她按心情换着叫对方的名字'"
              @click.stop="startEdit(friend)"
            >
              {{ friend.aliases.length ? "编辑" : "＋ 加备注" }}
            </button>
            <!-- 主动联系异常：并进这一行右端，不单独占一行 —— 否则卡片会为「可能出现的提示」常备一条 24px 空洞 -->
            <span
              v-if="warnLine(friend) && !isExpanded(friend)"
              class="alias-warn"
              :title="proactiveContactAttemptLabel(friend)"
            >{{ warnLine(friend) }}</span>
          </div>

          <div
            v-if="editingScopeId === friend.scopeId"
            class="alias-editor"
            @click.stop
          >
            <input
              v-model="aliasDraft"
              :data-alias-input="friend.scopeId"
              type="text"
              placeholder="用逗号隔开，例如：小鱼干，宝，笨蛋鱼"
              @keydown.enter.prevent="saveAliases(friend, aliasDraft, true)"
              @keydown.esc.stop="cancelEdit"
            >
            <p class="alias-hint">
              最多 8 个、每个 12 字
            </p>
            <div class="alias-actions">
              <button
                type="button"
                class="a-save"
                :disabled="aliasSaving"
                @click="saveAliases(friend, aliasDraft, true)"
              >
                保存
              </button>
              <button
                type="button"
                class="a-cancel"
                @click="cancelEdit"
              >
                取消
              </button>
            </div>
          </div>

          <!-- ④ 设置摘要：身份 + 交流常显，能力只在开启时出现；右侧「调整」是这一行唯一的可点物 -->
          <div class="sum">
            <div class="chips">
              <span
                v-for="chip in summaryChips(friend)"
                :key="chip.key"
                class="chip"
                :class="`is-${chip.variant}`"
                :title="chip.title"
              >
                <span
                  v-if="chip.prefix"
                  class="sr-only"
                >{{ chip.prefix }}</span>{{ chip.label }}
              </span>
            </div>
            <button
              type="button"
              class="adjust"
              :disabled="selecting"
              :aria-expanded="isExpanded(friend)"
              :aria-controls="`ctl-${friend.scopeId}`"
              :title="isExpanded(friend) ? '收起设置' : '改身份与权限'"
              @click.stop="toggleExpand(friend)"
            >
              <span class="txt">{{ isExpanded(friend) ? "收起" : "调整" }}</span>
              <span
                class="caret"
                aria-hidden="true"
              >{{ isExpanded(friend) ? "▴" : "▾" }}</span>
            </button>
          </div>

          <!-- 展开态：既有控件原样搬进来，一次只展开一张 -->
          <div
            v-if="isExpanded(friend)"
            :id="`ctl-${friend.scopeId}`"
            class="ctl"
            @keydown.esc.stop="collapse(friend)"
          >
            <div
              class="opts"
              role="radiogroup"
              :aria-label="`${friend.displayName || friend.platformUid} 的身份`"
            >
              <label
                v-for="option in IDENTITY_KIND_OPTIONS"
                :key="option.value"
                class="opt"
                :title="option.hint"
              >
                <input
                  type="radio"
                  :name="`friend-kind-${friend.scopeId}`"
                  :value="option.value"
                  :checked="friend.identityKind === option.value"
                  @change="setIdentityKind(friend, option.value)"
                >
                <span>{{ option.label }}</span>
              </label>
            </div>

            <div
              class="opts nowrap"
              role="radiogroup"
              :aria-label="`${friend.displayName || friend.platformUid} 的交流权限`"
            >
              <label
                v-for="option in CHAT_POLICY_OPTIONS"
                :key="option.value"
                class="opt"
                :class="{ 'is-block': option.value === 'BLOCK' }"
                :title="option.hint"
              >
                <input
                  type="radio"
                  :name="`friend-policy-${friend.scopeId}`"
                  :value="option.value"
                  :aria-label="option.label"
                  :checked="friend.friendChatPolicy === option.value"
                  @change="setChatPolicy(friend, option.value)"
                >
                <span>{{ option.value === "ALLOW" ? "允许" : option.value === "BLOCK" ? "禁止" : option.label }}</span>
              </label>
            </div>

            <label
              class="opt opt-wide proactive"
              title="单独允许她主动联系这位好友；仍受关系阶段、禁止交流、共同群和频率保护限制"
            >
              <input
                type="checkbox"
                :checked="friend.proactiveContactEnabled"
                aria-label="允许她主动联系这个人"
                @change="setProactiveContactEnabled(friend, ($event.target as HTMLInputElement).checked)"
              >
              <span>主动联系 <span class="pv-off">未授权</span><span class="pv-on">已允许</span></span>
            </label>

            <div class="switch-row">
              <span
                class="switch-label"
                title="仅影响新教育候选；关闭不会撤销已采纳的习惯。"
              >允许教育此角色</span>
              <label class="switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="允许此好友提出跨场景教育候选"
                  :checked="friend.educationEnabled"
                  @change="setEducationEnabled(friend, ($event.target as HTMLInputElement).checked)"
                >
                <span
                  class="track"
                  aria-hidden="true"
                />
              </label>
            </div>

            <div class="switch-row">
              <span
                class="switch-label"
                title="把这个人的聊天收进知识候选；不影响她怎么回这个人。"
              >作为知识来源</span>
              <label class="switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="把她和这位好友的聊天收进知识候选"
                  :checked="friend.knowledgeCollectEnabled"
                  @change="setKnowledgeCollectEnabled(friend, ($event.target as HTMLInputElement).checked)"
                >
                <span
                  class="track"
                  aria-hidden="true"
                />
              </label>
            </div>

            <!-- 说明只在真的不生效时出现，其余进 title（卡内不写段落） -->
            <p
              v-if="friend.knowledgeCollectEnabled && friend.characterKnowledgeCollectScope === 'ALL'"
              class="switch-note"
            >
              这个角色现在收所有人的聊天，这个开关暂时不生效；知识设置改成「仅指定成员」后才会用上。
            </p>

            <p
              class="save-state"
              aria-live="polite"
            >
              {{ saveStateLabel(friend.scopeId) }}
            </p>
            <p class="ctl-note">
              {{ proactiveContactAttemptLabel(friend) }}
            </p>
            <!-- 触屏没有 hover，删除入口收在这里（一屏 12 个灰图标是噪声，且紧挨强度词易误触） -->
            <button
              type="button"
              class="ctl-del"
              @click.stop="askDelete(friend)"
            >
              删除这条关系
            </button>
          </div>

          <!-- 删除键：DOM 里是最后一项，Tab 走到它时已经在所有设置之后 -->
          <button
            type="button"
            class="del"
            :aria-label="`删除「${friend.displayName || friend.platformUid}」`"
            :title="`删掉「${friend.displayName || friend.platformUid}」这条朋友关系和她的相关记忆`"
            @click.stop="askDelete(friend)"
          >
            <el-icon><Delete /></el-icon>
          </button>
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
        她回想自己平时怎么叫这些人，想出来的叫法先放在这里。你点头才写进备注，点「不用」会保留拒绝记录，避免同一建议再次出现。
      </p>
      <div
        v-if="suggestionsLoading"
        class="suggest-loading"
      >
        正在读取…
      </div>
      <div
        v-else-if="suggestionsError"
        class="suggest-empty"
        role="alert"
      >
        {{ suggestionsError }}<el-button @click="openSuggestions">
          重新读取
        </el-button>
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
        <!-- 名单里标出「聊过 N」：否则用户只知道「共 N 段对话」，不知道是这 12 人里的哪一个 -->
        <ul
          v-else
          class="del-names"
        >
          <li
            v-for="friend in deleteTargets.slice(0, 8)"
            :key="friend.scopeId"
          >
            {{ friend.displayName || friend.platformUid
            }}<em
              v-if="friend.conversationCount > 0"
              class="del-names-count"
            >聊过 {{ friend.interactionCount }}</em>
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
        <span class="del-hint">不可撤销</span>
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
/* 全部规则挂在 .fr-a 下：作用域 + 压过 main.css 的单类规则（比如全局 .card 有描边和阴影）。 */
.fr-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.fr-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
.fr-a .btn-select-mode.is-on { background: var(--brand-soft); color: var(--brand-strong); }
.fr-a .btn-select-mode.is-on:hover { text-decoration: none; }
.btn-suggest { position: relative; display: inline-flex; align-items: center; gap: 6px; }
.suggest-badge {
  display: inline-grid;
  min-width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 9px;
  background: var(--brand);
  padding: 0 5px;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* 屏读专用：四个字以内的前缀用隐藏文本，不要用 aria-label —— 无 role 的 span 上浏览器会忽略它。 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ── 工具栏 ── */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-4); margin-bottom: var(--sp-4); }
.search {
  display: flex;
  height: 36px;
  flex: 0 0 240px;
  align-items: center;
  gap: 8px;
  margin-right: auto;
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 0 12px;
  color: var(--dim);
}
.search input { width: 100%; min-width: 0; border: 0; background: none; color: var(--text); font-size: 14px; outline: none; }
.search input::placeholder { color: var(--faint); }
.search:focus-within { outline: 2px solid var(--brand); outline-offset: 2px; }

.seg { display: flex; gap: 2px; border-radius: var(--radius-sm); background: var(--surface); padding: 3px; }
.seg-btn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: var(--radius-xs);
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
.seg-dir { color: var(--brand-strong); font-size: 12px; font-weight: 600; line-height: 1; }

/* ── 统计带 / 多选条：同槽位同高 84，进出多选零垂直位移 ── */
.band, .sel-bar {
  display: flex;
  min-height: 84px;
  margin-bottom: var(--sp-4);
  border-radius: 12px;
  background: var(--surface);
  padding: 14px 18px;
}
.band { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 24px; }
.band-cell { display: flex; min-width: 0; flex-direction: column; justify-content: center; }
.band-krow { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 8px; }
.band-k { min-width: 0; overflow: hidden; color: var(--dim); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.band-v { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; line-height: 22px; }
.band-v small { margin-left: 3px; color: var(--dim); font-size: 12px; font-weight: 500; }
.band-f { flex: none; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; line-height: 18px; white-space: nowrap; }

.sel-bar { align-items: center; gap: 12px; }
.sel-count { color: var(--text-2); font-size: 14px; font-weight: 600; }
.sel-count b { color: var(--brand-strong); font-variant-numeric: tabular-nums; }
.sel-link { border: 0; background: none; padding: 0; color: var(--brand-strong); font-size: 14px; font-weight: 600; cursor: pointer; }
.sel-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.sel-note { margin-right: auto; color: var(--amber); font-size: 12px; }
.sel-note.is-plain { color: var(--dim); }
.sel-del {
  height: 30px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  padding: 0 14px;
  color: var(--dim);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.sel-del:hover { color: var(--red-text); }
.sel-del.is-armed { background: var(--red); color: #fff; }
.sel-del.is-armed:hover { background: #b32136; }
.sel-del:disabled { cursor: default; }

/* ── 网格：1440 = 四列 × 三行 = 12 张 ── */
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-3); align-items: start; }
@media (max-width: 1360px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 1000px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .grid { grid-template-columns: minmax(0, 1fr); } }

/* ── 卡片 ── */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  /* 全局 .card 有描边和阴影，这里必须显式清掉（A 套：白砖、零描边、零阴影） */
  border: 0;
  border-radius: 12px;
  background: var(--surface);
  box-shadow: none;
  padding: 18px 18px 14px;
}
/* 收起态严格等高（220）。不齐的两个来源：名字 1 行 vs 2 行、备注行有无。
   头区锁 60、备注行锁 24（异常提示也并在这一行里，不额外占高），剩下的交给 min-height。 */
.card:not(.is-open) { min-height: 220px; }
.card-bar { position: absolute; inset: 0 0 auto; height: 3px; border-radius: 12px 12px 0 0; background: transparent; }
.card.is-l3 .card-bar { background: var(--fr-l3-fg, var(--green)); }
.card.is-l2 .card-bar { background: var(--brand); }
.card.is-block .card-bar { background: var(--red); }

.head { display: flex; min-height: 60px; align-items: flex-start; gap: 11px; }
.pick { position: relative; display: none; align-self: center; }
.pick::after { position: absolute; inset: -8px; content: ""; }
.pick input { width: 16px; height: 16px; margin: 0; accent-color: var(--brand); cursor: pointer; }
.avatar {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 16px;
  font-weight: 700;
}
.avatar.is-photo { display: block; object-fit: cover; background: var(--surface-3); }
/* 昵称文本块给右上角绝对定位的删除键让位：键占 [右 14, 宽 24] → 侵入内容 20px，留 22 有 2px 余量 */
.card-id { min-width: 0; flex: 1; padding-right: 22px; }
.name {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--text);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
/* 副行必须单行：QQ · UID 段可省略，来源词 flex:none 挂在行尾永不被截 */
.sub {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 5px;
  margin: 2px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
}
.sub-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sub-src { flex: none; color: var(--brand-strong); font-weight: 500; }

/* ② 关系信号行：强度词在行首，和「聊过 N 次 / 最近」读成一句话 */
.signal { display: flex; align-items: center; gap: 4px; margin-top: 10px; }
.signal .pill { margin-right: 4px; }
.s-label { color: var(--dim); font-size: 12px; }
.s-num { color: var(--text); font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.s-num.is-zero { color: var(--dim); font-weight: 600; }
.s-time { margin-left: auto; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }

.pill {
  display: inline-flex;
  height: 20px;
  min-width: 52px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.pill.is-l3 { background: var(--fr-l3-bg, var(--green-soft)); color: var(--fr-l3-fg, var(--green)); }
.pill.is-l2 { background: var(--fr-l2-bg, var(--brand-soft)); color: var(--fr-l2-fg, var(--brand-strong)); }
.pill.is-l1 { background: var(--fr-l1-bg, var(--surface-3)); color: var(--fr-l1-fg, var(--dim)); }
.pill.is-block { background: var(--fr-block-bg, var(--red-soft)); color: var(--fr-block-fg, var(--red-text)); }

/* 主动联系异常：在备注行右端，1 行省略号，完整原因在 title 里。
   不单独占一行是有意的：单独一行就要给它常备高度，否则卡片会随提示出现/消失跳动。 */
.alias-warn {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--amber);
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ③ 备注行 */
.aliases { display: flex; min-height: 24px; align-items: center; gap: 6px; margin-top: 10px; overflow: hidden; flex-wrap: nowrap; }
.card.is-open .aliases { flex-wrap: wrap; }
.alias {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border-radius: var(--radius-xs);
  background: var(--brand-soft);
  padding: 1px 3px 1px 8px;
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.7;
  white-space: nowrap;
}
.alias-txt { overflow: hidden; text-overflow: ellipsis; }
.alias-x {
  position: relative;
  border: 0;
  background: none;
  padding: 0 3px;
  color: var(--brand-strong);
  font-size: 14px;
  line-height: 1;
  opacity: .5;
  cursor: pointer;
  transition: opacity .14s var(--ease);
}
.alias-x::after { position: absolute; inset: -6px -4px; content: ""; }
.alias-x:hover { opacity: 1; }
.alias-more { flex: none; color: var(--dim); font-size: 12px; font-weight: 600; }
.alias-add {
  position: relative;
  flex: none;
  border: 0;
  background: none;
  padding: 0 2px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: color .14s var(--ease);
}
.alias-add::after { position: absolute; inset: -8px -4px; content: ""; }
.alias-add:hover { color: var(--brand-strong); text-decoration: underline; text-underline-offset: 3px; }

.alias-editor { margin-top: 9px; border-radius: var(--radius-sm); background: var(--surface-2); padding: 9px 11px 10px; }
.alias-editor input { width: 100%; border: 0; background: none; color: var(--text); font-size: 14px; line-height: 1.6; outline: none; }
.alias-editor input::placeholder { color: var(--faint); }
.alias-hint { margin: 5px 0 0; color: var(--dim); font-size: 12px; line-height: 1.6; }
.alias-actions { display: flex; gap: 8px; margin-top: 7px; }
.alias-actions button { height: 26px; border: 0; border-radius: var(--radius-xs); padding: 0 11px; font-size: 12px; font-weight: 600; cursor: pointer; }
.a-save { background: var(--brand-btn); color: #fff; }
.a-save:hover { background: var(--brand-strong); }
.a-save:disabled { opacity: .5; cursor: default; }
.a-cancel { background: none; color: var(--dim); }
.a-cancel:hover { color: var(--text); }

/* ④ 设置摘要：chips 自己换行，右侧「调整」不孤立 */
.sum {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 10px;
  margin-top: auto;
  border-top: 1px solid var(--surface-3);
  padding-top: 12px;
  min-height: 24px;
}
.chips { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 6px; }
.chip {
  display: inline-flex;
  height: 20px;
  align-items: center;
  border-radius: var(--radius-xs);
  background: var(--surface-3);
  padding: 0 7px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
}
.chip.is-brand { background: var(--brand-soft); color: var(--brand-strong); }
.chip.is-ai { background: var(--amber-soft); color: var(--amber); }
.chip.is-block { background: var(--red-soft); color: var(--red-text); }
/* 「调整」：这一行唯一可交互物。盒高 32（真命中区）用负 margin 收回 22 的视觉占位 */
.adjust {
  display: inline-flex;
  height: 32px;
  flex: none;
  align-items: center;
  gap: 3px;
  justify-self: end;
  margin: -5px -4px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  padding: 0 4px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: color .14s var(--ease);
}
/* 悬停只变色，不加下划线：「收起 / 调整」是个动作入口，不是正文链接，划一道线会显得像被选中 */
.adjust:hover { color: var(--brand-strong); }
.adjust:disabled { color: var(--faint); cursor: default; text-decoration: none; }
.adjust .caret { font-size: 12px; line-height: 1; }

/* 删除键：绝对定位不占行内宽度；DOM 里是卡片最后一个子元素，Tab 最后才到 */
.del {
  position: absolute;
  top: 14px;
  right: 14px;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  padding: 0;
  color: var(--faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity .15s var(--ease), background .15s var(--ease), color .15s var(--ease);
}
.del::after { position: absolute; inset: -4px; content: ""; }
.card:hover .del, .card:focus-within .del { opacity: 1; }
/* 单写一条：只靠父级 :focus-within 会在过渡期间呈现半透明，键盘用户会聚焦到看不见的按钮 */
.del:focus-visible { opacity: 1; outline: 2px solid var(--brand); outline-offset: 1px; transition: none; }
.del:hover { background: var(--red-soft); color: var(--red-text); }

/* 展开区 */
.ctl { display: grid; gap: 8px; margin-top: 10px; border-radius: var(--radius-sm); background: var(--surface-2); padding: 12px; }
.opts { display: flex; min-width: 0; flex-wrap: wrap; gap: 4px; }
.opts.nowrap { flex-wrap: nowrap; }
/* 药丸 26px 视觉 + 32px 命中区；灰底上必须看清形状 → 唯一允许的内描边 */
.opt {
  position: relative;
  display: inline-flex;
  height: 26px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-xs);
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line);
  padding: 0 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease), box-shadow .14s var(--ease);
}
.opt::after { position: absolute; inset: -3px 0; content: ""; }
.opt:hover { background: var(--surface-2); }
.opt input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.opt:has(input:checked) { background: var(--brand-soft); box-shadow: inset 0 0 0 1px var(--brand-line); color: var(--brand-strong); }
.opt.is-block:has(input:checked) { background: var(--red-soft); box-shadow: inset 0 0 0 1px #f3c9cf; color: var(--red-text); }
.opt:has(input:focus-visible) { outline: 2px solid var(--brand); outline-offset: 2px; }
.opt-wide { width: max-content; max-width: 100%; justify-self: start; justify-content: flex-start; gap: 4px; }
.pv-on { display: none; }
.proactive input:checked ~ span .pv-off { display: none; }
.proactive input:checked ~ span .pv-on { display: inline; }

.switch-row { display: flex; height: 32px; align-items: center; justify-content: space-between; gap: 10px; }
.switch-label { color: var(--text-2); font-size: 14px; font-weight: 600; }
.switch { position: relative; display: inline-flex; width: 34px; height: 20px; flex: none; cursor: pointer; }
.switch::after { position: absolute; inset: -8px -6px; content: ""; }
.switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.switch .track { position: relative; width: 34px; height: 20px; border-radius: 999px; background: var(--line-strong); transition: background .16s var(--ease); }
.switch .track::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  content: "";
  transition: transform .16s var(--ease);
}
.switch input:checked + .track { background: var(--brand); }
.switch input:checked + .track::after { transform: translateX(14px); }
.switch input:focus-visible + .track { outline: 2px solid var(--brand); outline-offset: 3px; }
.switch-note { margin: 0; color: var(--amber); font-size: 12px; line-height: 1.5; }
.save-state { min-height: 14px; margin: 0; color: var(--dim); font-size: 12px; line-height: 14px; text-align: right; }
.ctl-note { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.ctl-del {
  display: none;
  height: 32px;
  align-items: center;
  justify-self: start;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  padding: 0 4px;
  color: var(--red-text);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.ctl-del:hover { text-decoration: underline; text-underline-offset: 3px; }

/* ── 多选态 ── */
.is-selecting .card { cursor: pointer; }
.is-selecting .card:hover { background: var(--surface-2); }
.is-selecting .pick { display: grid; }
/* 选中环外扩 1px：落在 12px 网格 gap 里，不裁切、也不压住顶部 3px 强度条 */
.is-selecting .card.is-picked { outline: 2px solid var(--brand); outline-offset: 1px; }
/* 多选锁设置：摘要与展开区一起变淡并断掉指针，「调整」同时真 disabled（不进 Tab 序） */
.is-selecting .sum, .is-selecting .ctl { opacity: .4; pointer-events: none; }

/* ── 骨架屏：和真实卡片同高，加载完不跳版 ── */
.card.is-skeleton { gap: 10px; min-height: 220px; }
.sk { border-radius: var(--radius-xs); background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 37%, var(--surface-2) 63%); background-size: 400% 100%; animation: sk-shimmer 1.4s ease-in-out infinite; }
.sk-avatar { width: 40px; height: 40px; border-radius: var(--radius-sm); }
.sk-name { width: 58%; height: 16px; }
.sk-sub { width: 40%; height: 12px; }
.sk-line { width: 100%; height: 14px; margin-top: 18px; }
@keyframes sk-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }

/* ── 空态 ── */
.empty {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--surface);
  padding: 22px;
  text-align: center;
}
.empty-ico {
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
.empty h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.empty p { max-width: 440px; margin: 8px 0 0; color: var(--dim); font-size: 14px; line-height: 1.75; }
.empty-cond { color: var(--dim); font-size: 12px; }
.empty-reset {
  margin-top: 12px;
  border: 0;
  background: none;
  padding: 4px 6px;
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.empty-reset:hover { text-decoration: underline; text-underline-offset: 3px; }

/* ── 待审备注弹窗 ── */
.suggest-desc { margin: 0 0 12px; color: var(--dim); font-size: 14px; line-height: 1.7; }
.suggest-loading, .suggest-empty { padding: 24px 0; color: var(--dim); font-size: 14px; text-align: center; }
.suggest-list { display: flex; max-height: 50vh; flex-direction: column; gap: 10px; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.suggest-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; border-radius: 12px; background: var(--surface-2); padding: 12px 14px; }
.suggest-main { min-width: 0; flex: 1; }
.suggest-alias { color: var(--text); font-size: 16px; font-weight: 700; }
.suggest-for { margin-left: 8px; color: var(--dim); font-size: 12px; }
.suggest-reason { margin: 5px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.suggest-actions { display: flex; flex: none; align-items: center; gap: 8px; }
.suggest-actions button { height: 28px; border: 0; border-radius: 6px; padding: 0 13px; font-size: 12px; font-weight: 600; cursor: pointer; }
.suggest-actions button:disabled { opacity: .5; cursor: default; }
.suggest-ok { background: var(--brand-btn); color: #fff; }
.suggest-no { background: none; color: var(--dim); }
.suggest-no:hover { color: var(--text); }

/* ── 删朋友弹窗 ── */
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
.del-names { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.del-names li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  padding: 3px 9px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
}
/* 有私聊记录的人在这里标出来：用户才知道自己勾没勾掉一个熟客 */
.del-names-count { color: var(--brand-strong); font-style: normal; font-weight: 600; }
.del-names .del-names-more { background: none; color: var(--dim); font-weight: 500; }
.del-note { margin: 12px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.del-hint { margin-right: 10px; color: var(--dim); font-size: 12px; }
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

/* ── 响应式收尾 ── */
@media (max-width: 900px) {
  /* 第一格的 label 与图注改上下排（横排会把 label 挤成半个字）；两档都锁 100，进出多选仍零位移 */
  .band, .sel-bar { min-height: 100px; }
  .band-krow { display: block; }
  .band-f { display: block; margin-top: 2px; }
}
@media (max-width: 760px) {
  .card { padding: 16px; }
  .del { top: 12px; right: 12px; }
  /* 展开区高于视口时自身滚动，不把整页拉长 */
  .card.is-open .ctl { max-height: 70vh; overflow-y: auto; }
}
@media (max-width: 720px) {
  .search { flex: 1 1 100%; }
  .seg { max-width: 100%; overflow-x: auto; }
}
@media (max-width: 560px) {
  .band { grid-template-columns: minmax(0, 1fr); gap: 12px 0; }
  .band-cell:nth-child(n+2) { display: none; }
  .sel-bar { flex-wrap: wrap; }
}
/* 触屏：不常显垃圾桶，删除入口收进展开区底部（一屏 12 个灰图标是噪声，且紧挨强度词易误触） */
@media (hover: none) {
  .del { display: none; }
  .ctl-del { display: inline-flex; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
</style>
