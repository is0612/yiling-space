<script setup lang="ts">
import { ArrowDown, CopyDocument, Cpu, Plus, Promotion, Search, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { Character } from "~/utils/mock-data";

type ChatCharacter = {
  id: string;
  name: string;
  chatModel: string;
  chatTemperature: number;
  chatMaxTokens: number;
  chatApiBaseUrl: string;
  chatApiKeyConfigured: boolean;
  chatApiKeySource: "character" | "environment" | "missing";
};
type MemoryScopeOrigin = "character" | "private";
type ChatMemorySource = { id: string; category: string; content: string; scope?: MemoryScopeOrigin };
type ChatSnapshotSource = { id: string; summary: string; periodStart: string; periodEnd: string; version: number; scope?: MemoryScopeOrigin };
type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  occurredAt: string;
  sources?: { memories: ChatMemorySource[]; snapshots: ChatSnapshotSource[] };
};
type ConversationSummary = {
  id: string;
  title: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
};
type ChatHistoryResponse = {
  character: ChatCharacter;
  modelConfigured: boolean;
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  messages: ChatMessage[];
};
type ChatExportPage = {
  conversationId: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  page: number;
  pageSize: number;
  total: number;
  messages: ChatMessage[];
};
type ChatSendResponse = {
  conversationId: string;
  title: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  model: { name: string; provider: string; promptTemplateVersion: string };
  retrieval: { memoriesAvailable: number; snapshotsAvailable: number; privateScopeActive?: boolean };
};

const route = useRoute();
const characters = useCharacterList();
await useCharacterListData();

/** 菜单页：当前角色由 ?c= 决定，选择和 /memory 共用一份 cookie */
const { id } = useCharacterSelection("/chat");

/** 角色列表里的头像 / 状态 / 名字（比聊天接口返回的更全，头像只有列表里有） */
const current = computed<Character | null>(
  () => characters.value.find((item) => item.id === id.value) ?? null,
);
const characterInitial = computed(() => current.value?.avatar || "忆");

const character = ref<ChatCharacter | null>(null);
const modelConfigured = ref(false);
const conversations = ref<ConversationSummary[]>([]);
const conversationView = ref<"ACTIVE" | "ARCHIVED">("ACTIVE");
const conversationSearchDraft = ref("");
const conversationSearch = ref("");
const conversationId = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]);
/** 记忆来源默认收起：每条回复都挂一块面板会把对话本身挤掉 */
const expandedSources = ref<string[]>([]);
const draft = ref("");
const loading = ref(false);
const sending = ref(false);
const pendingRequestKey = ref<string | null>(null);
const pendingRequestContent = ref<string | null>(null);
const pendingRequestConversationId = ref<string | null>(null);
const exporting = ref(false);
const messagePanel = ref<HTMLElement | null>(null);
const activeConversation = computed(() => conversations.value.find((item) => item.id === conversationId.value) ?? null);
/** 角色给你的称呼：空 = 没设，不显示这句提示 */
const addressNote = computed(() => {
  const address = (current.value?.userAddress ?? "").trim();
  return address ? `她会叫你「${address}」 · ` : "";
});
const canSend = computed(() => Boolean(draft.value.trim()) && modelConfigured.value && conversationView.value === "ACTIVE" && !sending.value);

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) return String(error.statusMessage);
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** 记忆分类代码 → 中文标签：来源面板不该把 FACT / PREFERENCE 直接摆给用户看 */
const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  FACT: "事实",
  PREFERENCE: "偏好",
  RELATIONSHIP: "关系",
  COMMITMENT: "约定",
  GOAL: "目标",
  EVENT: "事件",
  SUMMARY: "总结",
  OTHER: "其他",
};
function categoryLabel(value: string): string {
  return MEMORY_CATEGORY_LABELS[value] || value;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "尚无消息";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function scrollToLatest() {
  await nextTick();
  if (messagePanel.value) messagePanel.value.scrollTop = messagePanel.value.scrollHeight;
}

function openModelSettings() {
  if (!id.value) return;
  navigateTo("/characters/" + id.value + "/settings/model?from=chat");
}

/** 换角色等于换一整套会话：清干净再拉，别让上一个角色的会话/草稿串过来 */
function resetForCharacter() {
  conversations.value = [];
  conversationId.value = null;
  messages.value = [];
  expandedSources.value = [];
  draft.value = "";
  conversationSearch.value = "";
  conversationSearchDraft.value = "";
  conversationView.value = "ACTIVE";
  modelConfigured.value = false;
  character.value = null;
}

async function switchCharacter(nextId: string) {
  if (!nextId || nextId === id.value || sending.value) return;
  // CharacterBar 负责 navigateTo 到 ?c= 新 id，这里只做跳转前的清场，避免闪一帧上一角色的会话
  resetForCharacter();
}

async function loadCharacter() {
  if (!id.value) {
    character.value = null;
    return;
  }
  character.value = await $fetch<ChatCharacter>("/api/characters/" + encodeURIComponent(id.value));
}

async function copyMessage(content: string) {
  try {
    await navigator.clipboard.writeText(content);
    ElMessage.success("回复已复制。");
  } catch {
    ElMessage.error("复制失败，请检查浏览器剪贴板权限。");
  }
}

async function renameConversation(item: ConversationSummary) {
  if (sending.value) return;
  let title: string;
  try {
    const result = await ElMessageBox.prompt("输入新的会话标题（最多 255 个字符）。", "重命名会话", {
      inputValue: item.title,
      inputValidator: (value) => {
        if (!value.trim()) return "标题不能为空。";
        if (value.trim().length > 255) return "标题不能超过 255 个字符。";
        return true;
      },
      confirmButtonText: "保存标题",
      cancelButtonText: "取消",
    });
    title = result.value.trim();
  } catch {
    return;
  }
  if (!title || title === item.title) return;
  try {
    const updated = await $fetch<{ id: string; title: string; status: "ACTIVE" | "ARCHIVED"; updatedAt: string }>(
      "/api/characters/" + encodeURIComponent(id.value) + "/chat/" + encodeURIComponent(item.id),
      { method: "PATCH", body: { title } },
    );
    conversations.value = conversations.value.map((entry) => entry.id === updated.id
      ? { ...entry, title: updated.title, updatedAt: updated.updatedAt }
      : entry);
    ElMessage.success("会话标题已更新，并已记录审计日志。");
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "重命名会话失败。"));
  }
}

async function loadHistory(requestedId?: string | null) {
  if (!id.value) return;
  const params = new URLSearchParams({ status: conversationView.value });
  if (requestedId) params.set("conversationId", requestedId);
  if (conversationSearch.value) params.set("q", conversationSearch.value);
  const data = await $fetch<ChatHistoryResponse>("/api/characters/" + encodeURIComponent(id.value) + "/chat?" + params.toString());
  modelConfigured.value = data.modelConfigured;
  conversations.value = data.conversations;
  conversationId.value = data.selectedConversationId;
  messages.value = data.messages;
  expandedSources.value = [];
  await scrollToLatest();
}

async function reload() {
  if (!id.value) return;
  loading.value = true;
  conversationView.value = route.query.view === "archived" ? "ARCHIVED" : "ACTIVE";
  conversationSearch.value = typeof route.query.q === "string" ? route.query.q.trim().slice(0, 120) : "";
  conversationSearchDraft.value = conversationSearch.value;
  try {
    await Promise.all([
      loadCharacter(),
      loadHistory(typeof route.query.conversationId === "string" ? route.query.conversationId : null),
    ]);
    const selectedId = conversationId.value;
    if (selectedId && route.query.conversationId !== selectedId) {
      await navigateTo({ path: route.path, query: { ...route.query, conversationId: selectedId } }, { replace: true });
    } else if (!selectedId && typeof route.query.conversationId === "string") {
      // 会话被删/被归档后 URL 上的 id 会过期，服务端已退回列表，这里把脏参数摘掉
      const nextQuery = { ...route.query };
      delete nextQuery.conversationId;
      await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
    }
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "读取角色对话失败，请检查本地数据库和开发服务器。"));
  } finally {
    loading.value = false;
  }
}

async function openConversation(item: ConversationSummary) {
  if (sending.value || item.id === conversationId.value) return;
  loading.value = true;
  try {
    await loadHistory(item.id);
    await navigateTo({ path: route.path, query: { ...route.query, conversationId: item.id } });
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "读取会话失败。"));
  } finally {
    loading.value = false;
  }
}

async function startNewConversation() {
  if (sending.value) return;
  conversationView.value = "ACTIVE";
  conversationSearch.value = "";
  conversationSearchDraft.value = "";
  conversationId.value = null;
  messages.value = [];
  expandedSources.value = [];
  draft.value = "";
  const nextQuery = { ...route.query };
  delete nextQuery.conversationId;
  delete nextQuery.q;
  delete nextQuery.view;
  await navigateTo({ path: route.path, query: nextQuery });
  await loadHistory(null);
  conversationId.value = null;
  messages.value = [];
}

async function changeConversationView(status: "ACTIVE" | "ARCHIVED") {
  if (sending.value || status === conversationView.value) return;
  const nextQuery = { ...route.query };
  delete nextQuery.conversationId;
  if (status === "ARCHIVED") nextQuery.view = "archived";
  else delete nextQuery.view;
  conversationView.value = status;
  await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
  await reload();
}

async function searchConversations() {
  if (sending.value) return;
  const term = conversationSearchDraft.value.trim().slice(0, 120);
  const nextQuery = { ...route.query };
  delete nextQuery.conversationId;
  if (term) nextQuery.q = term;
  else delete nextQuery.q;
  await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
  await reload();
}

async function toggleConversationStatus(item: ConversationSummary) {
  if (sending.value) return;
  const nextStatus = conversationView.value === "ACTIVE" ? "ARCHIVED" : "ACTIVE";
  if (nextStatus === "ARCHIVED") {
    try {
      await ElMessageBox.confirm(
        "归档不会删除对话内容；之后可以从归档列表恢复。",
        "归档会话",
        { confirmButtonText: "确认归档", cancelButtonText: "取消", type: "warning" },
      );
    } catch {
      return;
    }
  }

  try {
    await $fetch("/api/characters/" + encodeURIComponent(id.value) + "/chat/" + encodeURIComponent(item.id), {
      method: "PATCH",
      body: { status: nextStatus },
    });
    ElMessage.success(nextStatus === "ARCHIVED" ? "会话已归档，消息和来源记录均已保留。" : "会话已恢复。");
    const nextQuery = { ...route.query };
    delete nextQuery.conversationId;
    await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
    await reload();
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "更新会话状态失败。"));
  }
}

/**
 * 删掉一段对话，消息跟着走。
 *
 * 记忆不挂在会话下面，所以已经沉淀的记忆不会跟着消失；后端把保留条数带回来，
 * 这里明确说一句，否则删完发现记忆页还在，人反而会怀疑删干净没有。
 */
async function deleteConversation(item: ConversationSummary) {
  if (sending.value) return;
  const count = item.messageCount ? `这 ${item.messageCount} 条消息` : "会话内容";
  try {
    await ElMessageBox.confirm(
      `「${item.title}」删除后无法恢复，${count}会被永久删除。已经沉淀成记忆的内容不受影响，会继续留在记忆页。`,
      "删除会话",
      { confirmButtonText: "确认删除", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  const wasSelected = item.id === conversationId.value;
  try {
    const result = await $fetch<{
      deletedMessages: number;
      retainedMemories: number;
      retainedSnapshotSources: number;
    }>(
      "/api/characters/" + encodeURIComponent(id.value) + "/chat/" + encodeURIComponent(item.id),
      { method: "DELETE" },
    );
    // 有可能一条长期记忆都没有、但快照已经总结过这段（实测库里就是这样），
    // 所以只按 retainedMemories 拼文案的话，人删完什么都看不到，反而会担心记忆没了。
    const kept = result.retainedMemories
      ? `，${result.retainedMemories} 条相关记忆仍保留在记忆页`
      : result.retainedSnapshotSources
        ? "，相关记忆快照仍保留"
        : "";
    ElMessage.success(`会话已删除${kept}。`);
    // 先摘掉 URL 里的会话 id 再重新加载：不然 reload 会拿已删的 id 去查，直接 404。
    if (wasSelected) {
      const nextQuery = { ...route.query };
      delete nextQuery.conversationId;
      await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
    }
    await reload();
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "删除会话失败。"));
  }
}

/** 会话菜单：列表行和对话面板头共用一套命令，避免两处行为不一致 */
async function runConversationCommand(item: ConversationSummary | null, command: string) {
  if (!item) return;
  if (command === "rename") {
    await renameConversation(item);
    return;
  }
  if (command === "status") {
    await toggleConversationStatus(item);
    return;
  }
  if (command === "delete") {
    await deleteConversation(item);
    return;
  }
  if (command === "export") await exportConversation();
}

function toggleSources(messageId: string) {
  expandedSources.value = expandedSources.value.includes(messageId)
    ? expandedSources.value.filter((entry) => entry !== messageId)
    : [...expandedSources.value, messageId];
}

function sourcesOpen(messageId: string) {
  return expandedSources.value.includes(messageId);
}

async function exportConversation() {
  const exportConversationId = conversationId.value;
  if (!exportConversationId || !messages.value.length || exporting.value) return;
  exporting.value = true;
  try {
    const exportMessages: ChatMessage[] = [];
    let expectedTotal = 0;
    for (let page = 1; ; page += 1) {
      const result = await $fetch<ChatExportPage>(
        "/api/characters/" + encodeURIComponent(id.value) + "/chat/" + encodeURIComponent(exportConversationId) +
          "?page=" + page + "&pageSize=200",
      );
      if (page === 1) expectedTotal = result.total;
      exportMessages.push(...result.messages);
      if (exportMessages.length >= expectedTotal || result.messages.length === 0) break;
      if (page > Math.ceil(expectedTotal / 200) + 1) throw new Error("导出分页没有正常结束，请刷新后重试。");
    }
    if (!exportMessages.length) {
      ElMessage.info("当前会话没有可导出的消息。");
      return;
    }

    const title = activeConversation.value?.title || "对话记录";
    const lines = [
      "# " + title,
      "",
      "- 角色：" + (character.value?.name || "未知角色"),
      "- 导出时间：" + new Date().toISOString(),
      "- 消息数量：" + exportMessages.length,
      "",
      "---",
      "",
    ];

    for (const message of exportMessages) {
      lines.push("## " + (message.role === "USER" ? "用户" : (character.value?.name || "角色")));
      lines.push("");
      lines.push("发生时间：" + message.occurredAt);
      lines.push("");
      lines.push(message.content);
      lines.push("");
      const sources = messageSources(message);
      if (sources.memories.length || sources.snapshots.length) {
        lines.push("引用来源：");
        for (const memory of sources.memories) {
          const scopeLabel = memory.scope === "private" ? "私人记忆" : "角色全局记忆";
          lines.push("- " + scopeLabel + "（" + memory.category + "）：" + memory.content + " [ID: " + memory.id + "]");
        }
        for (const snapshot of sources.snapshots) {
          const scopeLabel = snapshot.scope === "private" ? "私人记忆" : "角色全局记忆";
          lines.push("- " + scopeLabel + "阶段总结 v" + snapshot.version + "（" + snapshot.periodStart + " — " + snapshot.periodEnd + "）：" + snapshot.summary + " [ID: " + snapshot.id + "]");
        }
        lines.push("");
      }
    }

    const safeName = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "对话记录";
    const objectUrl = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = safeName + ".md";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    ElMessage.success("已导出完整对话，共 " + exportMessages.length + " 条消息，包含可追溯的记忆来源。");
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "导出对话失败，请稍后重试。"));
  } finally {
    exporting.value = false;
  }
}
function messageSources(message: ChatMessage) {
  return message.role === "ASSISTANT"
    ? { memories: message.sources?.memories ?? [], snapshots: message.sources?.snapshots ?? [] }
    : { memories: [], snapshots: [] };
}

function sourceCount(message: ChatMessage) {
  const sources = messageSources(message);
  return sources.memories.length + sources.snapshots.length;
}

/**
 * Enter 发送、Shift + Enter 换行。
 * ⚠️ 输入法选词时的 Enter 也会触发 keydown（composition 未结束），不拦掉就会把半截拼音发出去。
 */
function onComposerKeydown(evt: Event | KeyboardEvent) {
  const event = evt as KeyboardEvent;
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void sendMessage();
}

async function sendMessage() {
  const content = draft.value.trim();
  if (!content || sending.value) return;
  if (conversationView.value === "ARCHIVED") {
    ElMessage.info("归档会话为只读状态，请先恢复会话再继续发送消息。");
    return;
  }
  if (!modelConfigured.value) {
    ElMessage.warning("请先配置模型：API 地址、API Key 和模型名称。");
    return;
  }

  if (
    !pendingRequestKey.value ||
    pendingRequestContent.value !== content ||
    pendingRequestConversationId.value !== conversationId.value
  ) {
    pendingRequestKey.value = crypto.randomUUID();
    pendingRequestContent.value = content;
    pendingRequestConversationId.value = conversationId.value;
  }
  const requestKey = pendingRequestKey.value;
  sending.value = true;
  draft.value = "";
  await scrollToLatest();
  try {
    const result = await $fetch<ChatSendResponse>("/api/characters/" + encodeURIComponent(id.value) + "/chat", {
      method: "POST",
      body: { requestKey, message: content, ...(conversationId.value ? { conversationId: conversationId.value } : {}) },
    });
    pendingRequestKey.value = null;
    pendingRequestContent.value = null;
    pendingRequestConversationId.value = null;

    conversationId.value = result.conversationId;
    messages.value.push(result.userMessage, result.assistantMessage);
    const lastMessageAt = result.assistantMessage.occurredAt;
    const oldIndex = conversations.value.findIndex((item) => item.id === result.conversationId);
    const oldMessageCount = oldIndex >= 0 ? conversations.value[oldIndex]!.messageCount : 0;
    const summary: ConversationSummary = {
      id: result.conversationId,
      title: result.title,
      lastMessageAt,
      updatedAt: lastMessageAt,
      messageCount: oldMessageCount + 2,
    };
    conversations.value = [summary, ...conversations.value.filter((item) => item.id !== summary.id)].slice(0, 20);

    await navigateTo({ path: route.path, query: { ...route.query, conversationId: result.conversationId } }, { replace: true });
    await scrollToLatest();
  } catch (error) {
    draft.value = content;
    ElMessage.error(getErrorMessage(error, "模型回复失败，请检查模型配置或服务端日志。"));
  } finally {
    sending.value = false;
  }
}

onMounted(() => void reload());
watch(id, (next, previous) => {
  // cookie 兜底（比如从侧栏进来）改了角色，也要按新角色重拉
  if (!next || next === previous) return;
  void reload();
});
</script>

<template>
  <div class="page-wrap chat-page">
    <PageHeader
      eyebrow="工作空间 / AI 对话"
      title="AI 对话"
    >
      <template #actions>
        <button
          type="button"
          class="btn primary"
          :disabled="sending || !characters.length"
          @click="void startNewConversation()"
        >
          <el-icon><Plus /></el-icon>新建对话
        </button>
      </template>
    </PageHeader>

    <!-- 角色切换：菜单页的第一件事，和角色记忆页用同一个位置、同一套控件 -->
    <CharacterBar
      path="/chat"
      :disabled="sending"
      empty-text="还没有角色。先创建一个角色，再回来和它说话。"
      @change="switchCharacter"
    >
      <!-- 模型是按角色配的，状态就挂在角色这一行：不再在页面顶部单独报警 -->
      <button
        v-if="id"
        type="button"
        class="model-chip"
        :class="{ 'is-warn': !modelConfigured }"
        @click="openModelSettings"
      >
        <el-icon><Warning v-if="!modelConfigured" /><Cpu v-else /></el-icon>
        {{ modelConfigured ? character?.chatModel || "模型已配置" : "模型未配置" }}
        <span class="model-chip-go">{{ modelConfigured ? "设置" : "去设置" }}</span>
      </button>
    </CharacterBar>

    <div
      v-if="characters.length"
      v-loading="loading && !messages.length"
      class="chat-layout"
    >
      <!-- 会话列表：一列，标题一行 + 时间一行，剩下的都收进悬停菜单 -->
      <aside class="card conv-pane">
        <div class="conv-head">
          <span>{{ conversationView === "ACTIVE" ? "历史会话" : "归档会话" }}</span>
          <span class="conv-count">{{ conversations.length }}</span>
        </div>
        <div class="conv-chips">
          <button
            type="button"
            class="chip"
            :class="{ on: conversationView === 'ACTIVE' }"
            :disabled="sending"
            @click="void changeConversationView('ACTIVE')"
          >
            正常
          </button>
          <button
            type="button"
            class="chip"
            :class="{ on: conversationView === 'ARCHIVED' }"
            :disabled="sending"
            @click="void changeConversationView('ARCHIVED')"
          >
            归档
          </button>
        </div>
        <el-input
          v-model="conversationSearchDraft"
          class="conv-search"
          size="small"
          clearable
          maxlength="120"
          placeholder="搜索标题或消息"
          aria-label="搜索历史会话"
          @keyup.enter="void searchConversations()"
          @clear="void searchConversations()"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <div class="conv-list">
          <div
            v-for="item in conversations"
            :key="item.id"
            class="conv-row"
            :class="{ on: item.id === conversationId }"
          >
            <button
              type="button"
              class="conv-open"
              :disabled="sending"
              @click="void openConversation(item)"
            >
              <span class="conv-title">{{ item.title }}</span>
              <span class="conv-meta">{{ formatTime(item.lastMessageAt) }} · {{ item.messageCount }} 条</span>
            </button>
            <el-dropdown
              trigger="click"
              placement="bottom-end"
              :disabled="sending"
              @command="runConversationCommand(item, String($event))"
            >
              <button
                type="button"
                class="conv-more"
                :aria-label="'会话操作：' + item.title"
              >
                ⋯
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename">
                    重命名
                  </el-dropdown-item>
                  <el-dropdown-item command="status">
                    {{ conversationView === "ACTIVE" ? "归档" : "恢复" }}
                  </el-dropdown-item>
                  <el-dropdown-item
                    command="delete"
                    divided
                    style="color: var(--red)"
                  >
                    删除
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <p
            v-if="!conversations.length"
            class="conv-empty"
          >
            {{ conversationSearch ? "没有匹配的会话" : "还没有会话" }}
          </p>
        </div>
      </aside>

      <section class="card chat-pane">
        <div class="chat-head">
          <div class="chat-title">
            <strong>{{ activeConversation?.title || "新对话" }}</strong>
            <span v-if="messages.length">{{ messages.length }} 条消息</span>
            <span v-else>发一条消息就会自动建一段新对话</span>
          </div>
          <el-dropdown
            v-if="activeConversation"
            trigger="click"
            placement="bottom-end"
            :disabled="sending"
            @command="runConversationCommand(activeConversation, String($event))"
          >
            <button
              type="button"
              class="head-more"
            >
              更多<el-icon><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  command="export"
                  :disabled="!messages.length || exporting"
                >
                  {{ exporting ? "导出中…" : "导出 Markdown" }}
                </el-dropdown-item>
                <el-dropdown-item command="rename">
                  重命名
                </el-dropdown-item>
                <el-dropdown-item command="status">
                  {{ conversationView === "ACTIVE" ? "归档" : "恢复" }}
                </el-dropdown-item>
                <el-dropdown-item
                  command="delete"
                  divided
                  style="color: var(--red)"
                >
                  删除
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <div
          ref="messagePanel"
          class="msg-scroll"
        >
          <div
            v-if="!messages.length && !loading"
            class="chat-welcome"
          >
            <span
              class="avatar welcome-avatar"
              :class="'avatar-' + (current?.avatarTone || 'mint')"
            >{{ characterInitial }}</span>
            <h2>和{{ current?.name || "角色" }}开始对话</h2>
            <p>回复会参考这个角色的设定、最近的对话和相关记忆。</p>
          </div>

          <template
            v-for="message in messages"
            :key="message.id"
          >
            <article
              v-if="message.role === 'ASSISTANT'"
              class="msg-row"
            >
              <span
                class="avatar msg-ava"
                :class="'avatar-' + (current?.avatarTone || 'mint')"
              >{{ characterInitial }}</span>
              <div class="msg-main">
                <div class="msg-meta">
                  <strong>{{ character?.name || current?.name || "角色" }}</strong>
                  <time>{{ formatTime(message.occurredAt) }}</time>
                  <button
                    type="button"
                    class="msg-copy"
                    @click="void copyMessage(message.content)"
                  >
                    <el-icon><CopyDocument /></el-icon>复制
                  </button>
                </div>
                <div class="msg-text">
                  {{ message.content }}
                </div>
                <template v-if="sourceCount(message)">
                  <button
                    type="button"
                    class="src-toggle"
                    :aria-expanded="sourcesOpen(message.id)"
                    @click="toggleSources(message.id)"
                  >
                    <el-icon
                      class="src-caret"
                      :class="{ open: sourcesOpen(message.id) }"
                    >
                      <ArrowDown />
                    </el-icon>
                    引用了 {{ sourceCount(message) }} 条记忆
                  </button>
                  <div
                    v-if="sourcesOpen(message.id)"
                    class="src-list"
                  >
                    <div
                      v-for="source in messageSources(message).memories"
                      :key="source.id"
                      class="src-item"
                    >
                      <span class="pill pill-purple">{{ categoryLabel(source.category) }}</span>
                      <span
                        v-if="source.scope === 'private'"
                        class="pill pill-amber"
                      >私人</span>
                      <span class="src-text">{{ source.content }}</span>
                    </div>
                    <div
                      v-for="snapshot in messageSources(message).snapshots"
                      :key="snapshot.id"
                      class="src-item"
                    >
                      <span class="pill pill-blue">总结 v{{ snapshot.version }}</span>
                      <span
                        v-if="snapshot.scope === 'private'"
                        class="pill pill-amber"
                      >私人</span>
                      <span class="src-text">{{ snapshot.summary }}</span>
                    </div>
                  </div>
                </template>
              </div>
            </article>

            <article
              v-else
              class="msg-row is-user"
            >
              <div class="msg-main">
                <div class="msg-meta">
                  <time>{{ formatTime(message.occurredAt) }}</time>
                </div>
                <div class="user-block">
                  {{ message.content }}
                </div>
              </div>
            </article>
          </template>

          <div
            v-if="sending"
            class="thinking"
          >
            <span class="thinking-dot" /><span>正在结合相关记忆思考……</span>
          </div>
        </div>

        <div class="composer">
          <div
            v-if="!modelConfigured"
            class="composer-note is-warn"
          >
            <el-icon><Warning /></el-icon>
            <span>模型还没配置，配好才能发送。</span>
            <button
              type="button"
              class="composer-note-link"
              @click="openModelSettings"
            >
              去设置
            </button>
          </div>
          <div
            v-else-if="conversationView === 'ARCHIVED'"
            class="composer-note"
          >
            <span>归档会话只读，恢复后才能继续发送。</span>
            <button
              type="button"
              class="composer-note-link"
              @click="activeConversation && void toggleConversationStatus(activeConversation)"
            >
              恢复会话
            </button>
          </div>
          <el-input
            v-model="draft"
            :disabled="conversationView === 'ARCHIVED' || sending || !modelConfigured"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 8 }"
            :maxlength="8000"
            resize="none"
            :placeholder="'和' + (current?.name || '角色') + '说点什么……（Enter 发送，Shift + Enter 换行）'"
            @keydown="onComposerKeydown"
          />
          <div class="composer-footer">
            <span class="composer-hint">{{ addressNote }}只检索这个角色与你的私人记忆</span>
            <button
              type="button"
              class="btn primary send-btn"
              :disabled="!canSend"
              @click="void sendMessage()"
            >
              <el-icon><Promotion /></el-icon>{{ sending ? "发送中" : "发送" }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   和角色记忆页同一套 A 套语言：白砖、零描边、零阴影，
   层次靠明度差 + 间距，颜色只给状态。
   差别在这页是个「应用」而不是「报表」：整页高度固定，
   只有消息列表内部滚动，页面本身不再滚。
   ══════════════════════════════════════════════════════════════ */

/* 固定高度：视口减去顶栏，底部留 22px；页面自身不滚。
   vh 那条是 dvh 不支持时的后备（没有它 flex:1 的列表会塌成 0 高） */
.chat-page{display:flex;flex-direction:column;height:calc(100vh - var(--topbar-h));height:calc(100dvh - var(--topbar-h));padding-bottom:22px;overflow:hidden}

.card{border:0;border-radius:10px;box-shadow:none}

/* 模型状态：按角色配置的，所以挂在角色这一行；可点进设置 */
.model-chip{display:inline-flex;flex:none;align-items:center;gap:5px;border:0;border-radius:999px;background:var(--surface-3);padding:4px 10px;color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;transition:background .14s var(--ease),color .14s var(--ease)}
.model-chip:hover{background:var(--surface-2);color:var(--text)}
.model-chip.is-warn .el-icon{color:#8f5c05}
.model-chip .el-icon{font-size:12px}
.model-chip-go{color:var(--dim);font-weight:400}
.model-chip:hover .model-chip-go{text-decoration:underline}

/* ── 两栏 ───────────────────────────────────────────── */
.chat-layout{display:grid;min-height:0;flex:1;grid-template-columns:248px minmax(0,1fr);gap:14px}

/* ── 会话列表 ──────────────────────────────────────── */
.conv-pane{display:flex;min-height:0;flex-direction:column;padding:12px 10px}
.conv-head{display:flex;align-items:center;gap:8px;padding:2px 6px 10px;color:var(--text-2);font-size:12px;font-weight:700;letter-spacing:.02em}
.conv-count{color:var(--dim);font-weight:400}
.conv-chips{display:flex;gap:6px;padding:0 4px 10px}
/* 覆盖 main.css 的 .chip：30px + 描边，这里的筛选条要更安静 */
.conv-chips .chip{height:24px;border:0;border-radius:999px;background:var(--surface-3);padding:0 10px;color:var(--text-2);font-size:12px}
.conv-chips .chip:hover{background:var(--surface-2);color:var(--text)}
.conv-chips .chip.on{background:var(--brand-soft);color:var(--brand-strong);font-weight:600}
.conv-search{padding:0 4px;margin-bottom:8px}
.conv-search :deep(.el-input__wrapper){box-shadow:none;background:var(--surface-3)}
.conv-search :deep(.el-input__wrapper.is-focus){background:var(--surface);box-shadow:0 0 0 1px var(--brand) inset}
.conv-list{display:flex;min-height:0;flex:1;flex-direction:column;gap:2px;overflow:auto;padding:0 2px}
.conv-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 24px;align-items:center;border-radius:8px;transition:background .14s var(--ease)}
.conv-row:hover{background:var(--surface-2)}
.conv-row.on{background:var(--brand-soft)}
.conv-open{display:block;min-width:0;border:0;border-radius:8px;background:none;padding:8px 0 8px 8px;text-align:left;cursor:pointer}
.conv-title{display:block;overflow:hidden;color:var(--text);font-size:14px;font-weight:600;line-height:1.5;text-overflow:ellipsis;white-space:nowrap}
.conv-row.on .conv-title{color:var(--brand-strong)}
.conv-meta{display:block;margin-top:2px;color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.conv-more{display:grid;width:24px;height:24px;place-items:center;border:0;border-radius:6px;background:none;color:var(--dim);font-size:14px;line-height:1;cursor:pointer;opacity:0;transition:opacity .14s var(--ease),color .14s var(--ease)}
.conv-row:hover .conv-more,
.conv-row:focus-within .conv-more,
.conv-row.on .conv-more{opacity:1}
.conv-more:hover{color:var(--text)}
@media (hover:none){.conv-more{opacity:1}}
.conv-empty{margin:0;padding:26px 8px;color:var(--dim);font-size:12px;text-align:center}

/* ── 对话面板 ──────────────────────────────────────── */
.chat-pane{display:flex;min-width:0;min-height:0;flex-direction:column;overflow:hidden}
.chat-head{display:flex;flex:none;align-items:center;gap:12px;padding:14px 20px 12px}
.chat-title{min-width:0;flex:1}
.chat-title strong{display:block;overflow:hidden;color:var(--text);font-size:16px;font-weight:700;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}
.chat-title span{display:block;margin-top:2px;color:var(--dim);font-size:12px}
.head-more{display:inline-flex;align-items:center;gap:2px;border:0;border-radius:6px;background:none;padding:4px 6px;color:var(--dim);font-size:12px;cursor:pointer;transition:color .14s var(--ease)}
.head-more:hover{color:var(--text)}
.head-more .el-icon{font-size:12px}

/* 消息区：唯一滚动的容器 */
.msg-scroll{display:flex;min-height:0;flex:1;flex-direction:column;gap:22px;overflow:auto;padding:8px 20px 18px;scroll-behavior:smooth}

.chat-welcome{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center}
.welcome-avatar{width:44px;height:44px;border-radius:12px;font-size:16px;font-weight:700}
.chat-welcome h2{margin:14px 0 6px;color:var(--text);font-size:16px;font-weight:700}
.chat-welcome p{max-width:400px;margin:0;color:var(--dim);font-size:14px;line-height:1.75}

/* ── 消息 ──────────────────────────────────────────── */
.msg-row{display:flex;gap:10px;flex:none}
.msg-ava{width:28px;height:28px;margin-top:1px;border-radius:8px;font-size:12px;font-weight:700}
.msg-main{min-width:0;flex:1}
.msg-meta{display:flex;align-items:center;gap:8px;margin-bottom:5px;color:var(--dim);font-size:12px}
.msg-meta strong{color:var(--text-2);font-size:12px;font-weight:600}
.msg-meta time{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.msg-copy{display:inline-flex;align-items:center;gap:3px;margin-left:auto;border:0;border-radius:6px;background:none;padding:2px 4px;color:var(--dim);font-size:12px;cursor:pointer;opacity:0;transition:opacity .14s var(--ease),color .14s var(--ease)}
.msg-row:hover .msg-copy,
.msg-row:focus-within .msg-copy{opacity:1}
.msg-copy:hover{color:var(--brand-strong)}
@media (hover:none){.msg-copy{opacity:1}}

/* 回复是这页要读的东西：16px / 1.85，直接落在白砖上，不套气泡 */
.msg-text{max-width:70ch;color:var(--text);font-size:16px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}

/* 自己的话右对齐、软底块：靠明度差和位置区分说话人，不画描边 */
.msg-row.is-user{justify-content:flex-end}
.msg-row.is-user .msg-main{display:flex;flex:0 1 auto;flex-direction:column;align-items:flex-end}
.msg-row.is-user .msg-meta{margin-bottom:4px}
.user-block{max-width:min(520px,100%);border-radius:10px;background:var(--accent-soft);padding:9px 13px;color:var(--text);font-size:16px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}

/* ── 记忆来源（默认收起） ──────────────────────────── */
.src-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:8px;border:0;border-radius:6px;background:none;padding:2px 0;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.src-toggle:hover{text-decoration:underline}
.src-caret{font-size:12px;transition:transform .16s var(--ease)}
.src-caret.open{transform:rotate(180deg)}
.src-list{display:flex;max-width:70ch;flex-direction:column;gap:8px;margin-top:8px;border-radius:8px;background:var(--surface-2);padding:10px 12px}
.src-item{display:flex;align-items:flex-start;gap:6px;color:var(--dim);font-size:12px;line-height:1.7}
.src-item .pill{flex:none;padding:3px 7px}
.src-text{min-width:0;overflow-wrap:anywhere}

.thinking{display:flex;flex:none;align-items:center;gap:8px;padding-bottom:4px;color:var(--dim);font-size:12px}
.thinking-dot{width:6px;height:6px;border-radius:50%;background:var(--brand);animation:breathe 1.3s var(--ease) infinite}
@keyframes breathe{0%,100%{opacity:.3;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}

/* ── 输入区 ────────────────────────────────────────── */
/* 凹下去的一块画布色：和整个 App 的「白砖浮在画布上」同一套明度差，
   比再加一条分隔线更像这个项目的东西 */
.composer{flex:none;margin:0 16px 16px;border-radius:10px;background:var(--bg);padding:10px 12px 10px}
.composer :deep(.el-textarea__inner){border-radius:8px;background:var(--surface);box-shadow:0 0 0 1px var(--line) inset;padding:9px 11px;font-size:14px;line-height:1.7}
.composer :deep(.el-textarea__inner:focus){box-shadow:0 0 0 1px var(--brand) inset}
.composer-note{display:flex;align-items:center;gap:6px;margin-bottom:8px;color:var(--text-2);font-size:12px;line-height:1.6}
.composer-note .el-icon{flex:none;color:var(--amber);font-size:13px}
.composer-note.is-warn{color:var(--text-2)}
.composer-note-link{border:0;background:none;padding:0;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.composer-note-link:hover{text-decoration:underline}
.composer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}
.composer-hint{min-width:0;overflow:hidden;color:var(--dim);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.send-btn{height:32px;padding:0 14px;font-size:14px;box-shadow:none}
.send-btn:disabled{opacity:.5;cursor:not-allowed}

/* ── 响应式 ────────────────────────────────────────── */
@media(max-width:1150px){.chat-layout{grid-template-columns:220px minmax(0,1fr)}}
/* 窄屏放弃「整页不滚」：两栏叠起来，页面恢复滚动，会话列表自己限高 */
@media(max-width:900px){
  .chat-page{height:auto;overflow:visible}
  .chat-layout{grid-template-columns:minmax(0,1fr);gap:12px}
  /* 窄屏先看对话：会话列表挪到下面，别让人先滚过一屏列表才看到消息 */
  .conv-pane{order:2;max-height:270px}
  .chat-pane{order:1;min-height:420px}
  .msg-scroll{max-height:58vh}
}
@media(max-width:640px){
  .chat-page{padding-bottom:16px}
  /* 角色名不能被挤成只剩头像：给个下限，放不下就让模型那颗药丸换行 */
  .chat-head{padding:12px 14px 10px}
  .msg-scroll{padding:4px 14px 8px;gap:18px}
  .composer{margin:0 10px 10px}
  .no-character{flex-direction:column;align-items:flex-start}
}
</style>
