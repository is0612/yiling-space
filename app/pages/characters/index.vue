<script setup lang="ts">
import {
  ArrowDown,
  Calendar,
  ChatDotRound,
  ChatLineSquare,
  Clock,
  Collection,
  Connection,
  CopyDocument,
  Cpu,
  Delete,
  Document,
  Download,
  Edit,
  Key,
  Odometer,
  Picture,
  Plus,
  Timer,
  Upload,
  User,
  VideoPause,
  VideoPlay,
  Warning,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { Character, CharacterStatus } from "~/utils/mock-data";

/**
 * 上列表 + 下档案：点上面的卡片切换下面看谁。
 * 数据走 useCharacterListData（SSR 转发 cookie，和侧边栏共用同一份），
 * 所以档案里的简介 / 人设 / 模型 / 周期全部来自列表接口，不需要为选中项再打一次请求。
 */
const characters = useCharacterList();
const loadErrorMessage = useCharacterListError();
const { pending: loading } = await useCharacterListData();

const selectedId = ref("");
/**
 * 默认看第一个角色。选中的角色被删除后，find 落空会自动回落到第一个，
 * 不需要 watch 去修 selectedId，也就不会出现「选中了不存在的人」的中间态。
 */
const selected = computed(
  () => characters.value.find((item) => item.id === selectedId.value) ?? characters.value[0] ?? null,
);

const savedAt = computed(() => formatSavedAt(selected.value?.updatedAt));

const dialogOpen = ref(false);
const name = ref("");
const description = ref("");
const personality = ref("");
const examples = ref("");
/** 新建角色默认就喊「主人」；清空 = 不特意称呼 */
const userAddress = ref("主人");
/** 创建中：连点两次会建出两个同名角色，跟 deleteCharacter / toggle 那些一样需要闸门 */
const creating = ref(false);

/** 草稿存在页面而不是弹窗里（ref 在 <script setup> 顶层），所以取消/关闭也要清 */
function resetDraft() {
  name.value = "";
  description.value = "";
  personality.value = "";
  examples.value = "";
  userAddress.value = "主人";
}

const profileOpen = ref(false);
const profileTarget = ref<Character | null>(null);
/** 导入角色卡：文件解析与预检都在弹窗里，这里只负责开合和回写结果 */
const importOpen = ref(false);
/** 正在导出的角色 id：导出要打包几百条记忆，连点会重复下载同一个文件 */
const exportingId = ref("");

async function reload() {
  await loadCharacters();
}

function selectCharacter(character: Character) {
  selectedId.value = character.id;
}

/** 方向键在角色卡之间切换：键盘用户不该被迫去摸鼠标。创建卡的右键不该顺手切换选中项。 */
function onTabsKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  if ((event.target as HTMLElement | null)?.classList.contains("is-create")) return;
  const total = characters.value.length;
  if (total < 2) return;
  event.preventDefault();
  const current = characters.value.findIndex((item) => item.id === selected.value?.id);
  const step = event.key === "ArrowRight" ? 1 : -1;
  const next = characters.value[(current + step + total) % total];
  if (!next) return;
  selectedId.value = next.id;
  if (import.meta.client) document.getElementById(`char-tab-${next.id}`)?.focus();
}

async function createCharacter() {
  if (creating.value) return;
  const trimmed = name.value.trim();
  if (!trimmed) {
    ElMessage.warning("请先填写角色名称。");
    return;
  }

  creating.value = true;
  try {
    const item = await $fetch<Character>("/api/characters", {
      method: "POST",
      body: {
        name: trimmed,
        description: description.value.trim(),
        personality: personality.value.trim(),
        examples: examples.value.trim(),
        userAddress: userAddress.value.trim(),
      },
    });
    characters.value.unshift(item);
    // 刚建完就该看到他，而不是让人回列表里再找一次
    selectedId.value = item.id;
    dialogOpen.value = false;
    resetDraft();
    ElMessage.success("角色已保存到本地数据库。");
  } catch (error) {
    ElMessage.error(readError(error, "创建失败，请检查数据库连接和本地开发配置。"));
  } finally {
    creating.value = false;
  }
}

function statusTone(status: CharacterStatus) {
  return status === "运行中" ? "pill-green" : status === "已暂停" ? "pill-amber" : "pill-gray";
}

function readError(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function formatSavedAt(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * 「编辑资料」= 角色名称/简介/人设的弹窗；模型参数走独立的设置页。
 * 弹窗曾经把九字段（资料 + 服务商 + Key + 模型 + 温度 + Token）全装进去，
 * 在 1440×900 上一屏放不下，而 el-dialog 滚的是整层遮罩，保存按钮会跑到视野外。
 */
function openProfile(character: Character) {
  profileTarget.value = character;
  profileOpen.value = true;
}

/** 弹窗自己负责提交，这里只把结果回写，避免再发一次请求 */
function onProfileSaved(updated: Character) {
  const index = characters.value.findIndex((item) => item.id === updated.id);
  if (index >= 0) characters.value.splice(index, 1, updated);
}

/**
 * 复制角色：只复制人设/简介/标签，不带记忆、会话、阶段总结与渠道绑定。
 * 复制出来的角色是个「同名新生体」——记忆从零开始，避免两套记忆互相污染。
 */
async function duplicateCharacter(character: Character) {
  try {
    const copy = await $fetch<Character>("/api/characters", {
      method: "POST",
      body: {
        name: character.name + " 副本",
        alias: character.alias,
        description: character.description,
        personality: character.personality,
        userAddress: character.userAddress,
        avatarTone: character.avatarTone,
      },
    });
    characters.value.unshift(copy);
    selectedId.value = copy.id;
    ElMessage.success(`已复制「${character.name}」。人设沿用，记忆从零开始。`);
  } catch (error) {
    ElMessage.error(readError(error, "复制失败，请稍后重试。"));
  }
}

/** 停用 / 启用：停用后角色不再回复 AI 对话、渠道消息和 B站 值班。 */
async function toggleCharacterStatus(character: Character) {
  const pausing = character.status !== "已暂停";
  if (pausing) {
    const confirmed = await ElMessageBox.confirm(
      `停用「${character.name}」后，它不再回复 AI 对话、渠道消息，也不跑 B站 值班。已有记忆和阶段总结不受影响，自动归档仍按记忆设置单独控制。`,
      "停用角色",
      { confirmButtonText: "停用", cancelButtonText: "取消", type: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
  }
  try {
    const updated = await $fetch<Character>(`/api/characters/${character.id}`, {
      method: "PATCH",
      body: { status: pausing ? "已暂停" : "运行中" },
    });
    const index = characters.value.findIndex((item) => item.id === character.id);
    if (index >= 0) characters.value.splice(index, 1, updated);
    ElMessage.success(pausing ? "角色已停用。" : "角色已启用。");
  } catch (error) {
    ElMessage.error(readError(error, pausing ? "停用失败，请稍后重试。" : "启用失败，请稍后重试。"));
  }
}

async function deleteCharacter(character: Character) {
  try {
    await ElMessageBox.confirm(
      // 这里要列全，是因为删除是真的彻底删：会话、记忆、忆泡、阶段总结、梗、
      // 她的朋友关系、表情包图片都会没，没有回收站可以捞回来。
      `确定删除角色「${character.name}」吗？她的会话、记忆、忆泡、阶段总结、梗、朋友关系和表情包图片都会被彻底删除，无法恢复。`
        + "想留着的话，先「导出角色」再删。",
      "删除角色",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await $fetch(`/api/characters/${character.id}`, { method: "DELETE" });
    characters.value = characters.value.filter((c) => c.id !== character.id);
    if (selectedId.value === character.id) selectedId.value = "";
    ElMessage.success("角色已删除。");
  } catch (error) {
    ElMessage.error(readError(error, "删除失败，请稍后重试。"));
  }
}

/**
 * 导出角色卡：浏览器直接下载一个 .json。
 *
 * 这里用原生 fetch 而不是 `$fetch`：要的是原始文件流和 `Content-Disposition` 头，
 * 而 `$fetch` 会把响应按 JSON 解析（Nuxt 还会按路由反推类型）。
 * 下载失败（401 / 404）时也能读到服务端给的中文原因，而不是白页。
 *
 * `includeFriends` 是唯一一个要当场决定的段：她的朋友里存着别人的 QQ 号和「她怎么看他们」。
 * 换电脑继续养要带上，发给别人前应当关掉 —— 所以菜单里给两个入口，而不是默默替人决定。
 */
async function exportCharacter(character: Character, includeFriends = true) {
  if (exportingId.value) return;
  exportingId.value = character.id;
  try {
    const query = includeFriends ? "" : "?friends=0";
    const response = await fetch(`/api/characters/${character.id}/export${query}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { statusMessage?: string; message?: string } | null;
      throw new Error(detail?.statusMessage || detail?.message || "导出失败，请稍后重试。");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
    const fileName = encoded ? decodeURIComponent(encoded) : `yiling-character-${character.name}.json`;
    downloadBlob(blob, fileName);
    ElMessage.success(
      includeFriends
        ? "角色卡已下载：人设、记忆、忆泡、梗、阶段总结和她的朋友。表情包和 API Key 不在包内。"
        : "角色卡已下载（不含她的朋友）：适合发给别人。表情包和 API Key 也不在包内。",
    );
  } catch (error) {
    ElMessage.error(
      error instanceof Error && error.message ? error.message : "导出失败，请稍后重试。",
    );
  } finally {
    exportingId.value = "";
  }
}

function downloadBlob(blob: Blob, fileName: string) {
  if (!import.meta.client) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 在部分浏览器上会打断下载，等一帧再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导入完成：插到列表最前并选中它，人不用回列表里再找一遍 */
function onImported(character: Character) {
  characters.value.unshift(character);
  selectedId.value = character.id;
}

/** 档案头部的「更多」：只放低频和破坏性操作，改资料和跳转都摆在明面上 */
function runCharacterCommand(command: string) {
  const character = selected.value;
  if (!character) return;
  if (command === "export") void exportCharacter(character, true);
  else if (command === "export-public") void exportCharacter(character, false);
  else if (command === "duplicate") void duplicateCharacter(character);
  else if (command === "toggle") void toggleCharacterStatus(character);
  else if (command === "delete") void deleteCharacter(character);
}
</script>

<template>
  <div class="page-wrap chars-a">
    <PageHeader
      eyebrow="工作空间 / 角色管理"
      title="你的 AI 角色"
      description="集中管理不同的人设、模型配置与记忆周期。每个角色都拥有独立的经历和记忆。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          @click="importOpen = true"
        >
          <el-icon><Upload /></el-icon>导入角色
        </button>
      </template>
    </PageHeader>

    <div
      v-if="loading && !characters.length"
      class="char-tabs"
    >
      <div
        v-for="i in 3"
        :key="i"
        class="char-tab is-skeleton"
      >
        <div
          class="sk"
          style="width:38px;height:38px;border-radius:8px"
        />
        <div style="flex:1">
          <div
            class="sk"
            style="height:14px;width:58%;margin-bottom:8px"
          />
          <div
            class="sk"
            style="height:12px;width:82%"
          />
        </div>
      </div>
    </div>
    <div
      v-else-if="!characters.length"
      class="empty-block"
    >
      <div class="halo">
        <el-icon :size="22">
          <Warning v-if="loadErrorMessage" />
          <User v-else />
        </el-icon>
      </div>
      <h4>{{ loadErrorMessage ? "读取角色失败" : "还没有角色" }}</h4>
      <p v-if="loadErrorMessage">
        {{ loadErrorMessage }} 请先完成本地数据库迁移与开发用户初始化，再重试。
      </p>
      <p v-else>
        创建第一个角色，开始积累它独立的记忆与经历。
      </p>
      <button
        v-if="loadErrorMessage"
        class="btn primary"
        type="button"
        @click="reload"
      >
        重试
      </button>
      <button
        v-else
        class="btn primary"
        type="button"
        @click="dialogOpen = true"
      >
        <el-icon><Plus /></el-icon>创建角色
      </button>
    </div>

    <template v-else>
      <!-- 卡片行里除角色之外还有「创建角色」：同一个格子、同一种尺寸，
           入口不再挂在页头右上角。它是 div 不是 button —— 只是块面，
           role="button" + tabindex 补回键盘可达（Enter / 空格都能开弹窗） -->
      <div
        class="char-tabs"
        role="group"
        aria-label="角色列表"
        @keydown="onTabsKeydown"
      >
        <button
          v-for="character in characters"
          :id="`char-tab-${character.id}`"
          :key="character.id"
          type="button"
          class="char-tab"
          :class="{ 'is-on': selected?.id === character.id }"
          :aria-pressed="selected?.id === character.id"
          @click="selectCharacter(character)"
        >
          <span
            class="avatar"
            :class="'avatar-' + character.avatarTone"
          >{{ character.avatar }}</span>
          <span class="tab-body">
            <span class="tab-line">
              <span class="tab-name">{{ character.name }}</span>
              <span
                class="pill"
                :class="statusTone(character.status)"
              >{{ character.status }}</span>
            </span>
            <span class="tab-facts">{{ character.alias }} · {{ character.memoryCount }} 条记忆</span>
          </span>
        </button>

        <div
          class="char-tab is-create"
          role="button"
          tabindex="0"
          @click="dialogOpen = true"
          @keydown.enter.prevent="dialogOpen = true"
          @keydown.space.prevent="dialogOpen = true"
        >
          <el-icon><Plus /></el-icon>创建角色
        </div>
      </div>

      <section
        v-if="selected"
        class="detail"
        :aria-label="`${selected.name} 的档案`"
      >
        <header class="detail-head">
          <div
            class="avatar detail-avatar"
            :class="'avatar-' + selected.avatarTone"
          >
            {{ selected.avatar }}
          </div>
          <div class="detail-id">
            <div class="detail-name-row">
              <h2 class="detail-name">
                {{ selected.name }}
              </h2>
              <span
                class="pill"
                :class="statusTone(selected.status)"
              >{{ selected.status }}</span>
              <span
                v-if="!selected.chatModel"
                class="pill pill-rose"
              >未配置模型</span>
            </div>
            <div class="detail-sub">
              <span class="detail-alias">{{ selected.alias }}</span>
              <span
                v-if="selected.channels.length"
                class="detail-meta"
              >
                <el-icon><Connection /></el-icon>{{ selected.channels.join(" · ") }}
              </span>
              <span
                v-if="savedAt"
                class="detail-meta"
              >
                <el-icon><Clock /></el-icon>上次保存 {{ savedAt }}
              </span>
            </div>
          </div>
          <div class="detail-actions">
            <el-button
              type="primary"
              @click="navigateTo(`/chat?c=${selected.id}`)"
            >
              <el-icon><ChatDotRound /></el-icon>开始对话
            </el-button>
            <el-button @click="navigateTo(`/memory?c=${selected.id}`)">
              <el-icon><Collection /></el-icon>角色记忆
            </el-button>
            <el-button @click="openProfile(selected)">
              <el-icon><Edit /></el-icon>编辑资料
            </el-button>
            <el-button @click="navigateTo(`/characters/${selected.id}/settings/model?from=characters`)">
              <el-icon><Cpu /></el-icon>模型设置
            </el-button>
            <el-button @click="navigateTo(`/characters/${selected.id}/settings/stickers`)">
              <el-icon><Picture /></el-icon>表情包
            </el-button>
            <el-button @click="navigateTo(`/characters/${selected.id}/settings/catchphrases`)">
              <el-icon><ChatLineSquare /></el-icon>梗语录
            </el-button>
            <el-dropdown
              trigger="click"
              placement="bottom-end"
              @command="runCharacterCommand(String($event))"
            >
              <el-button>
                更多<el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="export">
                    <el-icon><Download /></el-icon>导出角色（含朋友）
                  </el-dropdown-item>
                  <el-dropdown-item command="export-public">
                    <el-icon><Download /></el-icon>导出（不含朋友，可分享）
                  </el-dropdown-item>
                  <el-dropdown-item command="duplicate">
                    <el-icon><CopyDocument /></el-icon>复制角色
                  </el-dropdown-item>
                  <el-dropdown-item command="toggle">
                    <el-icon>
                      <VideoPause v-if="selected.status !== '已暂停'" />
                      <VideoPlay v-else />
                    </el-icon>{{ selected.status === "已暂停" ? "启用角色" : "停用角色" }}
                  </el-dropdown-item>
                  <el-dropdown-item
                    divided
                    command="delete"
                  >
                    <el-icon><Delete /></el-icon>删除角色
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </header>

        <div class="detail-body">
          <div class="detail-main">
            <div class="d-field">
              <div class="d-field-h">
                <el-icon><Document /></el-icon>
                <h3>简介</h3>
              </div>
              <p
                v-if="selected.description"
                class="d-prose"
              >
                {{ selected.description }}
              </p>
              <p
                v-else
                class="d-empty"
              >
                还没有写简介。一句话说明她是什么类型的角色，方便以后自己认人。
              </p>
            </div>

            <div class="d-field">
              <div class="d-field-h">
                <el-icon><User /></el-icon>
                <h3>人设</h3>
                <span
                  v-if="selected.personality"
                  class="d-count"
                >{{ selected.personality.length }} 字</span>
              </div>
              <p
                v-if="selected.personality"
                class="d-prose"
              >
                {{ selected.personality }}
              </p>
              <p
                v-else
                class="d-empty"
              >
                还没有写人设。人设是「她是谁」，对话、QQ 和 B站 被动回复都用同一份。
              </p>
            </div>

            <div class="d-field">
              <div class="d-field-h">
                <el-icon><ChatLineSquare /></el-icon>
                <h3>对话示例</h3>
                <span
                  v-if="selected.examples"
                  class="d-count"
                >{{ selected.examples.length }} 字</span>
              </div>
              <p
                v-if="selected.examples"
                class="d-prose"
              >
                {{ selected.examples }}
              </p>
              <p
                v-else
                class="d-empty"
              >
                还没有写对话示例。示例只对齐语气，给两三句就能明显稳住口吻。
              </p>
            </div>
          </div>

          <aside class="detail-side">
            <div class="d-group">
              <div class="d-group-h">
                档案
              </div>
              <dl class="d-rows">
                <div class="d-row">
                  <dt>
                    <el-icon><Collection /></el-icon>长期记忆
                  </dt>
                  <dd>{{ selected.memoryCount }} 条</dd>
                </div>
                <div class="d-row">
                  <dt>
                    <el-icon><Calendar /></el-icon>归档周期
                  </dt>
                  <dd>{{ selected.intervalDays }} 天</dd>
                </div>
                <div class="d-row">
                  <dt>
                    <el-icon><Clock /></el-icon>最近归档
                  </dt>
                  <dd>{{ selected.latestSnapshot }}</dd>
                </div>
                <div class="d-row">
                  <dt>
                    <el-icon><Timer /></el-icon>下次归档
                  </dt>
                  <dd>{{ selected.nextSnapshot }}</dd>
                </div>
              </dl>
            </div>

            <div class="d-group">
              <div class="d-group-h">
                模型
              </div>
              <dl class="d-rows">
                <div class="d-row">
                  <dt>
                    <el-icon><Cpu /></el-icon>对话模型
                  </dt>
                  <dd :class="{ 'is-missing': !selected.chatModel }">
                    {{ selected.chatModel || "未配置" }}
                  </dd>
                </div>
                <div class="d-row">
                  <dt>
                    <el-icon><Odometer /></el-icon>温度 / 输出上限
                  </dt>
                  <dd>{{ selected.chatTemperature ?? "—" }} / {{ selected.chatMaxTokens ?? "—" }}</dd>
                </div>
                <div class="d-row">
                  <dt>
                    <el-icon><Key /></el-icon>API Key
                  </dt>
                  <dd :class="{ 'is-missing': !selected.chatApiKeyConfigured }">
                    {{ selected.chatApiKeyConfigured ? "已配置" : "未配置" }}
                  </dd>
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </section>
    </template>

    <el-dialog
      v-model="dialogOpen"
      title="创建角色"
      width="min(1160px, 96vw)"
      destroy-on-close
      :close-on-click-modal="!creating"
      :close-on-press-escape="!creating"
      @closed="resetDraft"
    >
      <el-form
        label-position="top"
        @submit.prevent="createCharacter"
      >
        <!-- 和「编辑角色资料」共用同一份字段区，版式只维护一处 -->
        <CharacterProfileFields
          v-model:name="name"
          v-model:description="description"
          v-model:user-address="userAddress"
          v-model:personality="personality"
          v-model:examples="examples"
        />
      </el-form>

      <template #footer>
        <div class="create-foot">
          <span class="create-foot-note">创建后到「模型设置」配服务商与 API Key、到「记忆设置」调归档周期，配好就能开始对话。</span>
          <span class="create-foot-actions">
            <el-button @click="dialogOpen = false">
              取消
            </el-button>
            <el-button
              type="primary"
              :loading="creating"
              @click="createCharacter"
            >
              创建角色
            </el-button>
          </span>
        </div>
      </template>
    </el-dialog>

    <CharacterProfileDialog
      v-model="profileOpen"
      :character="profileTarget"
      @saved="onProfileSaved"
    />

    <CharacterImportDialog
      v-model="importOpen"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览页 A 套「色块平铺」：一张白台面，零描边零阴影，
   层次只靠明度差 + 间距，颜色只给状态。
   L0 画布（--bg）→ L1 白砖 #fff → L2 卡内分节靠留白 → L3 状态药丸上色
   统一写 `.chars-a .xxx`：锁住本页，同时靠 (0,3,0) 压过
   main.css 里 .card / .kpi / .pill / .btn / .surface 的 (0,1,0)。
   ══════════════════════════════════════════════════════════════ */

/* ── 角色选择卡 ─────────────────────────────────────── */
/* auto-fill 而不是 auto-fit：只有一个角色时卡片保持一列宽，
   不会因为"右边空"就被拉成 1000px 的横条 */
.chars-a .char-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(224px, 1fr));
  gap: var(--sp-3); /* 卡片之间 */
}
.chars-a .char-tab {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--sp-3);
  border: 0;
  border-radius: 10px;
  background: var(--surface);
  padding: var(--sp-3) var(--sp-4);
  text-align: left;
  cursor: pointer;
  transition: background .14s var(--ease), box-shadow .14s var(--ease);
}
.chars-a .char-tab:hover { background: var(--surface-2); }
/* 选中：极淡品牌底 + 左侧 3px 品牌条。
   底和名字颜色的差别都属于「颜色通道」，色弱/灰度下会消失，所以必须再加一个形状通道 ——
   左侧竖条和侧栏 `.sidebar-link.active::before` 是同一套「当前项」语汇，灰度下照样看得见 */
.chars-a .char-tab.is-on,
.chars-a .char-tab.is-on:hover {
  background: #fff8fa;
  box-shadow: inset 0 0 0 1px var(--brand-line), inset 3px 0 0 var(--brand);
}
.chars-a .char-tab:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.chars-a .char-tab.is-skeleton { cursor: default; }
/* 创建卡：虚线 + 透明底，就是为了和「真卡片是白砖」拉开 —— 一眼看出这格是空位而不是角色。
   高度不用写，grid 的行高会把它拉成和旁边一样高 */
.chars-a .char-tab.is-create {
  justify-content: center;
  gap: var(--sp-2);
  border: 1px dashed var(--line-strong);
  background: transparent;
  color: var(--dim);
  font-size: 14px;
  font-weight: 600;
  text-align: center;
}
.chars-a .char-tab.is-create .el-icon { font-size: 16px; }
.chars-a .char-tab.is-create:hover,
.chars-a .char-tab.is-create:focus-visible {
  border-color: var(--brand-line);
  background: #fff8fa;
  color: var(--brand-strong);
}
.chars-a .char-tab .avatar { width: 38px; height: 38px; font-size: 15px; }
.chars-a .tab-body { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
.chars-a .tab-line { display: flex; min-width: 0; align-items: center; gap: var(--sp-2); }
.chars-a .tab-name {
  overflow: hidden;
  color: var(--text-2);
  font-size: 14px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chars-a .char-tab.is-on .tab-name { color: var(--text); }
/* 别名和条数是身份信息，不能落在 --faint（2.52:1）上 */
.chars-a .tab-facts {
  overflow: hidden;
  color: var(--dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态药丸：无描边；文字加深已在 main.css 的 .pill-* 里统一 */
.chars-a .pill { border: 0; }

/* ── 档案详情 ───────────────────────────────────────── */
/* 选择卡和档案是上下两个平级块，不是一张卡的两段：间距要大于卡内 16（页头到卡片是 18），
   三者若都在 12~18 之间，页面会读成三条等距的带子，看不出谁跟着谁 */
.chars-a .detail {
  margin-top: var(--sp-5);
  border-radius: 10px;
  background: var(--surface);
  padding: var(--sp-5);
}
.chars-a .detail-head { display: flex; align-items: flex-start; gap: var(--sp-4); }
.chars-a .detail-avatar { width: 56px; height: 56px; border-radius: 10px; font-size: 22px; }
.chars-a .detail-id { min-width: 0; flex: 1; }
.chars-a .detail-name-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.chars-a .detail-name { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.01em; line-height: 26px; }
/* 身份行：别名 · 渠道 · 上次保存。都带 13px 图标，一眼分得清哪些是"标识"、哪些是"时间" */
.chars-a .detail-sub { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-4); margin-top: var(--sp-1); color: var(--dim); font-size: 12px; }
.chars-a .detail-meta { display: inline-flex; align-items: center; gap: var(--sp-1); }
.chars-a .detail-meta .el-icon { color: var(--faint); font-size: 14px; }
.chars-a .detail-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 8px; }
/* Element 给相邻按钮加 12px margin-left，「更多」外面还套了 el-dropdown 不受影响，
   三颗按钮的间距会变成 20 / 8 两种。统一交给 gap */
.chars-a .detail-actions :deep(.el-button + .el-button) { margin-left: 0; }

/* 两栏：左是「她是谁」（要读的正文），右是「她现在什么状态」（要扫的数值）。
   卡内分组线用最淡的 --surface-3，不是 --line。 */
.chars-a .detail-body {
  display: grid;
  /* 右栏只装数字，给 288 上限就够；剩下的宽度留给正文，
     但正文自己再卡 576（≈41 汉字/行），别让它横着拉满 700px 读不动 */
  grid-template-columns: minmax(0, 1fr) minmax(232px, 288px);
  gap: var(--sp-7);
  margin-top: var(--sp-5);
  border-top: 1px solid var(--surface-3);
  padding-top: var(--sp-5);
}
/* 字段之间不再只靠留白：加一条最淡的分隔线 + 18px 内边距，
   人设本身常带空行，光有间距的话「人设到哪结束、示例从哪开始」看不出来 */
.chars-a .d-field + .d-field { margin-top: var(--sp-4); border-top: 1px solid var(--surface-3); padding-top: var(--sp-4); }
/* 分节标题 12px：和正文只差 2px，靠字重和明度分层，不靠字号；左侧图标再补一个形状锚点 */
.chars-a .d-field-h { display: flex; align-items: center; gap: var(--sp-2); color: var(--dim); font-size: 12px; font-weight: 700; }
.chars-a .d-field-h .el-icon { color: var(--faint); font-size: 16px; }
.chars-a .d-field-h h3 { margin: 0; font: inherit; }
.chars-a .d-count { color: var(--dim); font-weight: 400; }
.chars-a .d-prose { margin-top: var(--sp-2); max-width: 576px; color: var(--text-2); font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; white-space: pre-wrap; }
.chars-a .d-empty { margin-top: var(--sp-2); max-width: 576px; color: var(--dim); font-size: 14px; line-height: 1.8; }

.chars-a .d-group + .d-group { margin-top: var(--sp-4); border-top: 1px solid var(--surface-3); padding-top: var(--sp-4); }
.chars-a .d-group-h { display: flex; align-items: baseline; gap: 8px; color: var(--dim); font-size: 12px; font-weight: 700; }
/* 人设写得长时左栏会很高，右栏跟着吸顶，别在下半页留 400px 空白 */
.chars-a .detail-side { position: sticky; top: 72px; align-self: start; }
.chars-a .d-rows { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
.chars-a .d-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); font-size: 12px; line-height: 20px; }
/* 图标比标签低一档（--faint）：同样面积下图标比汉字「重」得多，同色会反压标签一头（§2.7.1），
   而 --faint 在契约里正好只给图标/分隔符用，不承载信息 */
.chars-a .d-row dt { display: flex; flex: none; align-items: center; gap: var(--sp-2); color: var(--dim); }
.chars-a .d-row dt .el-icon { color: var(--faint); font-size: 14px; }
.chars-a .d-row dd { margin: 0; color: var(--text-2); font-weight: 600; text-align: right; overflow-wrap: anywhere; }
.chars-a .d-row dd.is-missing { color: var(--rose); }

/* 空态：虚线框和渐变光晕都去掉，跟总览的引导块同一块白砖 */
.chars-a .empty-block {
  min-height: 260px;
  border: 0;
  border-radius: 10px;
  background: var(--surface);
  padding: var(--sp-6) var(--sp-5);
}
.chars-a .empty-block .halo {
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  border-radius: 50%;
  background: var(--brand-soft);
  box-shadow: none;
  color: var(--brand);
  font-size: 20px;
}
.chars-a .empty-block h4 { margin: 0 0 var(--sp-2); color: var(--text); font-size: 16px; font-weight: 600; }
.chars-a .empty-block p { max-width: 460px; margin: 0 0 16px; color: var(--dim); font-size: 14px; line-height: 1.7; }

/* 创建弹窗页脚：和「编辑角色资料」同一套（左说明、右动作）。
   文案和按钮是两处唯一不同的地方，所以版式写在各自文件里，字段区才走共用组件。 */
.create-foot { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
.create-foot-note { color: var(--dim); font-size: 12px; }
.create-foot-actions { display: flex; }

@media (max-width: 1020px) {
  .chars-a .detail-body { grid-template-columns: minmax(0, 1fr); gap: 22px; }
  .chars-a .detail-head { flex-wrap: wrap; }
  .chars-a .detail-actions { width: 100%; }
  /* 单列时右栏在正文之下，吸顶会把档案钉在视口里挡住内容 */
  .chars-a .detail-side { position: static; }
  /* 值挤到 900px 宽的行尾会离标签太远，改成两列短行 */
  .chars-a .d-rows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3) var(--sp-5); }
}
@media (max-width: 620px) {
  .chars-a .detail { padding: 16px; }
  .chars-a .char-tabs { grid-template-columns: minmax(0, 1fr); }
  .chars-a .d-rows { grid-template-columns: minmax(0, 1fr); }
}
</style>
