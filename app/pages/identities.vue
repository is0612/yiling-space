<script setup lang="ts">
/**
 * 她的朋友。
 *
 * 一行 = 某角色认识的某个人（一条关系），不是一个账号。同一个 QQ 号跟两个角色都聊过
 * 就有两行，所以页面先选角色，再看这个角色的名单。
 *
 * 私聊来访或群里发过言的人都会出现在名单；群成员第一次发言只建立「遇到过」记录，
 * 不增加互动次数。只有她真的回了对方，群聊互动次数才 +1。
 *
 * 名单会一直长（群里认人会一直往上加），所以筛选、排序、翻页全在服务端做：
 * 页面每次只拿一页，统计带和来源计数由接口按「这个角色的全部朋友」另算，
 * 不会因为翻了页或筛了来源就变形。
 */
import { Refresh, Search, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

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
const activeCharacterId = ref("");
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

async function load(target = page.value) {
  loading.value = true;
  try {
    const response = await $fetch<FriendPage>("/api/admin/identities", {
      query: {
        characterId: activeCharacterId.value || undefined,
        q: query.value.trim() || undefined,
        source: sourceFilter.value,
        sort: sortBy.value,
        dir: sortDirections.value[sortBy.value],
        page: target,
        pageSize: PAGE_SIZE,
      },
    });
    friends.value = response.items;
    characters.value = response.characters;
    activeCharacterId.value = response.activeCharacterId;
    page.value = response.page;
    total.value = response.total;
    totalPages.value = response.totalPages;
    stats.value = response.stats;
    sourceCounts.value = response.sourceCounts;
    pendingSuggestions.value = response.pendingSuggestions ?? 0;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取朋友列表。"));
  } finally {
    loading.value = false;
  }
}

/** 换角色直接重取：名单变了，停在原来的页码上没有意义。 */
function pickCharacter(characterId: string) {
  if (characterId === activeCharacterId.value) return;
  activeCharacterId.value = characterId;
  load(1);
}

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
const friendSettingsSavingScopeId = ref("");

async function saveFriendSettings(friend: Friend) {
  if (friendSettingsSavingScopeId.value) return;
  friendSettingsSavingScopeId.value = friend.scopeId;
  try {
    const response = await $fetch<{
      identityKind: Friend["identityKind"];
      identityKindSource: Friend["identityKindSource"];
      friendChatPolicy: Friend["friendChatPolicy"];
    }>(`/api/admin/identities/${friend.scopeId}`, {
      method: "PATCH",
      body: {
        identityKind: friend.identityKind,
        friendChatPolicy: friend.friendChatPolicy,
      },
    });
    friends.value = friends.value.map((item) => item.scopeId === friend.scopeId
      ? { ...item, ...response }
      : item);
    ElMessage.success("身份与交流权限已保存。");
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "身份与交流权限没保存上。"));
    await load(page.value);
  } finally {
    friendSettingsSavingScopeId.value = "";
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

async function openSuggestions() {
  suggestionDialogOpen.value = true;
  suggestionsLoading.value = true;
  try {
    const response = await $fetch<{ items: Suggestion[] }>("/api/admin/identities/aliases/suggestions", {
      query: { characterId: activeCharacterId.value || undefined },
    });
    suggestions.value = response.items;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "读取待审备注失败。"));
  } finally {
    suggestionsLoading.value = false;
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

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

onMounted(() => load(1));
</script>

<template>
  <div class="page-wrap fr-a">
    <PageHeader
      eyebrow="角色 / 人际"
      title="她的朋友"
      description="私聊来访、群里见过的人都会记录下来。可以手动标记真人 / AI，并按角色决定她是否与对方交流。"
    >
      <template #actions>
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
        <div
          v-if="characters.length > 1"
          class="seg"
        >
          <button
            v-for="item in characters"
            :key="item.id"
            type="button"
            class="seg-btn"
            :class="{ 'is-on': activeCharacterId === item.id }"
            @click="pickCharacter(item.id)"
          >
            {{ item.name }}<span class="seg-n">{{ item.friendCount }}</span>
          </button>
        </div>
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
        >
          <div class="fr-head">
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
            <span class="pill pill-gray">{{ friend.interactionCount > 0 ? sourceLabel(friend.firstSource) : "群里见过" }}</span>
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

          <div class="friend-controls">
            <div class="friend-control-row">
              <label :for="`friend-kind-${friend.scopeId}`">身份</label>
              <select :id="`friend-kind-${friend.scopeId}`" v-model="friend.identityKind" class="friend-control-select">
                <option value="UNKNOWN">未知</option>
                <option value="HUMAN">真人</option>
                <option value="AI">AI 鱼</option>
              </select>
              <span v-if="friend.identityKindSource === 'MANUAL'" class="friend-control-note">人工确认</span>
            </div>
            <div class="friend-control-row">
              <label :for="`friend-policy-${friend.scopeId}`">交流</label>
              <select :id="`friend-policy-${friend.scopeId}`" v-model="friend.friendChatPolicy" class="friend-control-select">
                <option value="DEFAULT">默认规则（AI 默认不回）</option>
                <option value="ALLOW">允许交流</option>
                <option value="BLOCK">禁止交流</option>
              </select>
            </div>
            <div class="friend-control-actions">
              <span>身份类型目前由你手动确认，对同一平台账号生效；交流权限只对当前角色生效。</span>
              <button
                type="button"
                class="alias-save"
                :disabled="friendSettingsSavingScopeId === friend.scopeId"
                @click="saveFriendSettings(friend)"
              >
                {{ friendSettingsSavingScopeId === friend.scopeId ? "保存中…" : "保存设置" }}
              </button>
            </div>
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

/* 身份与交流权限：身份是平台账号属性，交流政策是当前角色的关系属性。 */
.friend-controls {
  display: grid;
  gap: 8px;
  margin-top: 13px;
  border-top: 1px solid var(--surface-3);
  padding-top: 12px;
}
.friend-control-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.friend-control-row label { flex: 0 0 38px; color: var(--dim); font-size: 12px; }
.friend-control-select {
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--surface-3);
  border-radius: 7px;
  background: var(--surface);
  padding: 6px 9px;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
}
.friend-control-note { color: var(--brand-strong); font-size: 11px; }
.friend-control-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.friend-control-actions > span { min-width: 0; color: var(--dim); font-size: 11px; line-height: 1.5; }
.friend-control-actions .alias-save { flex: none; }

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
