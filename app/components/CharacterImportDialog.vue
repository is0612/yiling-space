<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { Character } from "~/utils/mock-data";

/**
 * 导入角色卡。
 *
 * 两段式：先读文件做**本地预检**（只解析、不提交），把人设名和条数摆出来让人确认；
 * 点「导入」才真正 POST。理由很实际 —— 角色卡是别人发来的文件，一选文件就写库，
 * 选错文件就得删一个角色。
 *
 * 真正的字段校验在服务端（`server/utils/character-portable.ts`）。这里只做够用的预览，
 * 不重复实现一套规则，否则两边迟早会长歪。
 */
type BundleCounts = {
  memories: number;
  privateMemories: number;
  events: number;
  /** 忆泡日历里有记录的天数。老卡没有这一段，缺省按 0 显示。 */
  eventDays?: number;
  snapshots: number;
  /** 日记 / 手账的天数；老卡没有这一段。 */
  journals?: number;
  journalRevisions?: number;
  catchphrases: number;
  friends: number;
  friendMemories: number;
  /** 朋友们名下的备注（她私底下的叫法）总条数；v2 及更早的卡没有这一段。 */
  friendAliases?: number;
};

type BundlePreview = {
  name: string;
  alias: string;
  description: string;
  exportedAt: string | null;
  formatVersion: number | null;
  /** 卡片的同步根 ID；null = 老卡没带，认不出同源角色，只能新建。 */
  originId: string | null;
  counts: BundleCounts;
};

/** 合并后实际写进库的条数，用来告诉人「这次到底补进去多少」。 */
type BundleAdded = {
  memories: number;
  events: number;
  eventDays: number;
  snapshots: number;
  journals: number;
  journalRevisions: number;
  catchphrases: number;
  friends: number;
};

/** 与服务端 `CHARACTER_BUNDLE_MAX_BYTES` 保持一致：日记/手账的历史版本让它变大了。 */
const MAX_BYTES = 32 * 1024 * 1024;

const props = defineProps<{
  modelValue: boolean;
  /** 本机已有角色：用来判断这张卡是不是「同一个她」，从而提供合并。 */
  characters?: Character[];
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  imported: [character: Character];
}>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const fileName = ref("");
const errorMessage = ref("");
const importing = ref(false);
const dragging = ref(false);
const preview = ref<BundlePreview | null>(null);
/** 本机所有同源角色；可能有多个副本，不能只取列表中的第一个。 */
const mergeTargets = ref<Character[]>([]);
const mergeTargetId = ref("");
const mergeTarget = computed(() => mergeTargets.value.find((item) => item.id === mergeTargetId.value) ?? null);
/** merge = 并进 mergeTarget；copy = 新建副本（并排养两个）。 */
const mergeMode = ref<"merge" | "copy">("copy");
/** 原样保留解析结果，提交时不再二次序列化字符串，避免编码/BOM 相关问题 */
const payload = ref<Record<string, unknown> | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function reset() {
  fileName.value = "";
  errorMessage.value = "";
  importing.value = false;
  dragging.value = false;
  preview.value = null;
  payload.value = null;
  mergeTargets.value = [];
  mergeTargetId.value = "";
  mergeMode.value = "copy";
  if (fileInput.value) fileInput.value.value = "";
}

watch(open, (isOpen) => {
  if (!isOpen) reset();
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readCounts(source: unknown, memories: unknown[], events: unknown[], snapshots: unknown[], phrases: unknown[], friends: unknown[]): BundleCounts {
  const declared = asRecord(asRecord(source).counts);
  const journalList = asArray(asRecord(source).journals);
  const privateMemories = Array.isArray(memories)
    ? memories.filter((item) => asRecord(item).scope === "private").length
    : 0;
  const friendMemories = friends.reduce<number>((total, friend) => {
    const list = asRecord(friend).memories;
    return total + (Array.isArray(list) ? list.length : 0);
  }, 0);
  // 备注同样是老卡没有的东西：读不到数就按内容数一遍（缺省是空数组）。
  const friendAliases = friends.reduce<number>((total, friend) => {
    const list = asRecord(friend).aliases;
    return total + (Array.isArray(list) ? list.length : 0);
  }, 0);
  // 日历天数与版本数：服务端 counts 优先，老卡没写就按内容数一遍。
  const eventDays = typeof declared.eventDays === "number"
    ? declared.eventDays
    : asArray(asRecord(source).eventDays).length;
  const journalRevisions = typeof declared.journalRevisions === "number"
    ? declared.journalRevisions
    : journalList.reduce<number>((total, journal) => total + asArray(asRecord(journal).revisions).length, 0);
  return {
    memories: typeof declared.memories === "number" ? declared.memories : memories.length,
    privateMemories: typeof declared.privateMemories === "number" ? declared.privateMemories : privateMemories,
    events: typeof declared.events === "number" ? declared.events : events.length,
    eventDays,
    snapshots: typeof declared.snapshots === "number" ? declared.snapshots : snapshots.length,
    journals: typeof declared.journals === "number" ? declared.journals : journalList.length,
    journalRevisions,
    catchphrases: typeof declared.catchphrases === "number" ? declared.catchphrases : phrases.length,
    friends: typeof declared.friends === "number" ? declared.friends : friends.length,
    friendMemories: typeof declared.friendMemories === "number" ? declared.friendMemories : friendMemories,
    friendAliases: typeof declared.friendAliases === "number" ? declared.friendAliases : friendAliases,
  };
}

const ORIGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 卡片里的同步根 ID。只认 UUID：不像 id 的一律当「没带」，别拿它去猜角色。 */
function readOriginId(source: Record<string, unknown>): string | null {
  const value = asRecord(source.origin).characterId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ORIGIN_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** 返回全部同源实例；一个同步根允许在本机对应多个角色副本。 */
function findSameOrigin(originId: string | null): Character[] {
  if (!originId) return [];
  return (props.characters ?? []).filter(
    (item) => item.id === originId || item.originId === originId,
  );
}

function buildPreview(source: Record<string, unknown>): BundlePreview {
  const character = asRecord(source.character);
  const memories = asArray(source.memories);
  const events = asArray(source.events);
  const snapshots = asArray(source.snapshots);
  const phrases = asArray(source.catchphrases);
  const friends = asArray(source.friends);
  return {
    name: typeof character.name === "string" && character.name.trim() ? character.name.trim() : "未命名角色",
    alias: typeof character.alias === "string" ? character.alias : "",
    description: typeof character.description === "string" ? character.description : "",
    exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : null,
    formatVersion: typeof source.formatVersion === "number" ? source.formatVersion : null,
    originId: readOriginId(source),
    counts: readCounts(source, memories, events, snapshots, phrases, friends),
  };
}

/**
 * 朋友段的一句话。有备注才提备注 —— 「0 个备注」只会让人以为哪里丢了东西。
 * 卡片还没读出来时 preview 为空，模板那一行本来就不渲染，这里给空串兜底。
 */
const friendNote = computed(() => {
  const counts = preview.value?.counts;
  if (!counts) return "";
  const aliases = counts.friendAliases ?? 0;
  return `还带着 ${counts.friends} 位朋友（${counts.friendMemories} 条关于他们的记忆${aliases > 0 ? `、${aliases} 个备注` : ""}）。`;
});

/** 合并成功后要说清「补进去多少」：条数全为 0 也有意义（本机已经全有了）。 */
function describeAdded(added: BundleAdded): string {
  const parts: string[] = [];
  if (added.memories) parts.push(`${added.memories} 条记忆`);
  if (added.events) parts.push(`${added.events} 条忆泡`);
  if (added.eventDays) parts.push(`${added.eventDays} 天日历`);
  if (added.snapshots) parts.push(`${added.snapshots} 篇阶段总结`);
  if (added.journalRevisions) parts.push(`${added.journalRevisions} 版日记手账`);
  else if (added.journals) parts.push(`${added.journals} 天日记手账`);
  if (added.catchphrases) parts.push(`${added.catchphrases} 条梗`);
  if (added.friends) parts.push(`${added.friends} 位朋友`);
  return parts.length ? `新增 ${parts.join("、")}` : "没有新内容（本机已经全有了）";
}

async function handleFile(file: File) {
  reset();
  fileName.value = file.name;

  if (file.size > MAX_BYTES) {
    errorMessage.value = `文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，请确认选对了文件。`;
    return;
  }

  let text: string;
  try {
    text = await file.text();
  } catch {
    errorMessage.value = "读不了这个文件，请确认它没有损坏。";
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    errorMessage.value = "这不是一个 JSON 文件。角色卡应该是导出时下载的 .json 文件。";
    return;
  }

  const record = asRecord(parsed);
  if (record.format !== "yiling-hub.character") {
    errorMessage.value = "这不是忆灵空间的角色卡（缺少 format 标记）。";
    return;
  }

  preview.value = buildPreview(record);
  payload.value = record;
  // 只有唯一同源目标时才默认合并；存在多个副本必须由用户明确选择，不能按更新时间猜。
  mergeTargets.value = findSameOrigin(preview.value.originId);
  mergeTargetId.value = mergeTargets.value.length === 1 ? mergeTargets.value[0]!.id : "";
  mergeMode.value = mergeTargets.value.length === 1 ? "merge" : "copy";
}

function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement | null;
  const file = target?.files?.[0];
  if (file) void handleFile(file);
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
}

function pickFile() {
  if (importing.value) return;
  fileInput.value?.click();
}

function readError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

const merging = computed(() => mergeMode.value === "merge" && Boolean(mergeTarget.value));

async function submit() {
  if (!payload.value || importing.value) return;
  importing.value = true;
  try {
    // 合并走 ?target=：包本身不动，服务端按同步根再次校验目标确实同源。
    const url = merging.value && mergeTarget.value
      ? `/api/characters/import?target=${encodeURIComponent(mergeTarget.value.id)}`
      : "/api/characters/import";
    const result = await $fetch<{
      character: Character;
      mode: "new" | "merge";
      counts: BundleCounts;
      added: BundleAdded;
    }>(url, { method: "POST", body: payload.value });
    emit("imported", result.character);
    emit("update:modelValue", false);
    ElMessage.success(result.mode === "merge"
      ? `已并进「${result.character.name}」：${describeAdded(result.added)}。`
      : `已导入「${result.character.name}」。到「模型设置」填 API Key 就能开始对话。`);
  } catch (error) {
    errorMessage.value = readError(error, "导入失败，请稍后重试。");
  } finally {
    importing.value = false;
  }
}

function formatExportedAt(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="导入角色卡"
    width="min(600px, 94vw)"
    destroy-on-close
    :close-on-click-modal="!importing"
    :close-on-press-escape="!importing"
  >
    <p class="lead">
      导入会优先识别同源角色：找到一个时可直接合并，找到多个时由你选择目标；也可以新建副本。没有来源信息的旧卡会作为新角色导入。
      包里是人设、记忆、忆泡、忆泡日历、日记手账（含历史版本）、梗和阶段总结；表情包与 API Key 不在包内，新机器上重新同步 / 重新填写即可。
    </p>

    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      class="file-input"
      @change="onFileChange"
    >

    <div
      v-if="!preview"
      class="drop"
      :class="{ 'is-dragging': dragging, 'is-error': Boolean(errorMessage) }"
      role="button"
      tabindex="0"
      @click="pickFile"
      @keydown.enter.prevent="pickFile"
      @keydown.space.prevent="pickFile"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="drop-title">
        {{ fileName ? "换个文件" : "选择或拖入角色卡 .json" }}
      </div>
      <div class="drop-hint">
        从另一台电脑的「角色管理 → 更多 → 导出角色」拿到这个文件
      </div>
    </div>

    <div
      v-if="errorMessage"
      class="alert is-error"
    >
      {{ errorMessage }}
    </div>

    <div
      v-if="preview"
      class="preview"
    >
      <div class="preview-head">
        <div class="preview-avatar">
          {{ preview.name.slice(0, 1) }}
        </div>
        <div class="preview-id">
          <div class="preview-name">
            {{ preview.name }}
          </div>
          <div class="preview-meta">
            <span v-if="preview.alias">{{ preview.alias }}</span>
            <span v-if="preview.exportedAt">导出于 {{ formatExportedAt(preview.exportedAt) }}</span>
            <span
              v-if="fileName"
              class="preview-file"
            >{{ fileName }}</span>
          </div>
        </div>
        <button
          type="button"
          class="link"
          :disabled="importing"
          @click="pickFile"
        >
          换一个
        </button>
      </div>

      <p
        v-if="preview.description"
        class="preview-desc"
      >
        {{ preview.description }}
      </p>

      <dl class="preview-counts">
        <div>
          <dt>长期记忆</dt>
          <dd>{{ preview.counts.memories }} 条</dd>
        </div>
        <div>
          <dt>忆泡</dt>
          <dd>{{ preview.counts.events }} 条</dd>
        </div>
        <div>
          <dt>忆泡日历</dt>
          <dd>{{ preview.counts.eventDays ?? 0 }} 天</dd>
        </div>
        <div>
          <dt>日记 / 手账</dt>
          <dd>{{ preview.counts.journals ?? 0 }} 天</dd>
        </div>
        <div>
          <dt>阶段总结</dt>
          <dd>{{ preview.counts.snapshots }} 篇</dd>
        </div>
        <div>
          <dt>梗语录</dt>
          <dd>{{ preview.counts.catchphrases }} 条</dd>
        </div>
        <div>
          <dt>她的朋友</dt>
          <dd>{{ preview.counts.friends }} 位</dd>
        </div>
      </dl>

      <!-- 同一同步根可能有多个本地副本；多目标时必须明确选择，绝不自动取第一个。 -->
      <div
        v-if="mergeTargets.length"
        class="merge-box"
      >
        <div class="merge-head">
          <template v-if="mergeTargets.length === 1">
            本机找到同源角色：<strong>{{ mergeTargets[0]?.name }}</strong>
            <span class="merge-meta">{{ mergeTargets[0]?.memoryCount ?? 0 }} 条记忆</span>
          </template>
          <template v-else>
            本机找到 {{ mergeTargets.length }} 个同源角色，请选择要合并到哪一个。
          </template>
        </div>
        <el-select
          v-if="mergeTargets.length > 1"
          v-model="mergeTargetId"
          class="merge-target-select"
          placeholder="选择合并目标"
          style="width: 100%; margin-top: 8px"
        >
          <el-option
            v-for="candidate in mergeTargets"
            :key="candidate.id"
            :value="candidate.id"
            :label="`${candidate.name} · ${candidate.memoryCount} 条记忆 · ${candidate.id.slice(0, 8)}`"
          />
        </el-select>
        <div
          v-if="mergeTarget && mergeTargets.length > 1"
          class="merge-meta merge-selected"
        >
          已选择：{{ mergeTarget.name }}（{{ mergeTarget.memoryCount }} 条记忆）
        </div>
        <el-radio-group
          v-model="mergeMode"
          class="merge-options"
        >
          <el-radio
            value="merge"
            :disabled="!mergeTarget"
          >
            合并进去（本地内容不动，导入的接成新版本）
          </el-radio>
          <el-radio value="copy">
            新建副本（两个并排养）
          </el-radio>
        </el-radio-group>
      </div>

      <p
        v-else-if="preview && !preview.originId"
        class="friend-note"
      >
        这张卡没有来源角色信息（老版本导出的，或手改过），认不出是本机哪个角色，只能新建。
        想合并的话，到导出方用新版重新导一次。
      </p>

      <p
        v-if="preview.counts.privateMemories > 0"
        class="private-note"
      >
        其中 {{ preview.counts.privateMemories }} 条是导出者的私人记忆，导入后会成为你的私人记忆，只在你和她对话时参与检索。
      </p>

      <p
        v-if="preview.counts.friends > 0"
        class="friend-note"
      >
        {{ friendNote }}
        对方的 QQ 号会留在本机；同一个人若已存在，会沿用已有身份，不会重复建。
      </p>

      <p
        v-if="(preview.counts.journalRevisions ?? 0) > 0"
        class="friend-note"
      >
        日记 / 手账共 {{ preview.counts.journalRevisions }} 个版本，历史版本一并带过来；
        「今日一句」的出处会重新指向本机新建的那一版日记。
      </p>
    </div>

    <template #footer>
      <div class="foot">
        <span class="foot-note">
          {{
            preview
              ? (merging
                ? "合并只补数据：人设与设置不动，本地的记忆和日记一版都不会被覆盖。"
                : "导入后到「模型设置」填 API Key，再到「记忆设置」确认归档周期。")
              : "还没选文件。"
          }}
        </span>
        <span class="foot-actions">
          <el-button
            :disabled="importing"
            @click="open = false"
          >
            取消
          </el-button>
          <el-button
            type="primary"
            :loading="importing"
            :disabled="!preview"
            @click="submit"
          >
            {{ merging ? "合并进去" : "导入角色" }}
          </el-button>
        </span>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.lead {
  margin: 0 0 var(--sp-4);
  color: var(--dim);
  font-size: 12px;
  line-height: 1.7;
}
.file-input { display: none; }

.drop {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
  background: transparent;
  padding: 28px 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color .14s var(--ease), background .14s var(--ease);
}
.drop:hover,
.drop:focus-visible,
.drop.is-dragging {
  border-color: var(--brand-line);
  background: #fff8fa;
  outline: none;
}
.drop.is-error { border-color: var(--rose); }
.drop-title { color: var(--text-2); font-size: 14px; font-weight: 600; }
.drop-hint { color: var(--dim); font-size: 12px; }

.alert {
  margin-top: var(--sp-3);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
}
.alert.is-error { background: #fdecef; color: var(--rose); }

.preview {
  margin-top: var(--sp-4);
  border-radius: 10px;
  background: var(--surface-2);
  padding: var(--sp-4);
}
.preview-head { display: flex; align-items: center; gap: var(--sp-3); }
.preview-avatar {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: 10px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 16px;
  font-weight: 700;
}
.preview-id { min-width: 0; flex: 1; }
.preview-name { color: var(--text); font-size: 15px; font-weight: 600; }
.preview-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 2px;
  color: var(--dim);
  font-size: 12px;
}
.preview-file { overflow-wrap: anywhere; }
.preview-desc {
  margin: var(--sp-3) 0 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.preview-counts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: var(--sp-3);
  margin: var(--sp-4) 0 0;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--surface-3);
}
.preview-counts dt { color: var(--dim); font-size: 12px; }
.preview-counts dd { margin: 2px 0 0; color: var(--text-2); font-size: 14px; font-weight: 600; }
.private-note {
  margin: var(--sp-3) 0 0;
  border-radius: 8px;
  background: #fff8ec;
  padding: 8px 10px;
  color: #8a5a12;
  font-size: 12px;
  line-height: 1.6;
}
.merge-box {
  margin: var(--sp-3) 0 0;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 10px 12px;
}

.merge-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  color: var(--text-2);
  font-size: 13px;
}

.merge-head strong { color: var(--text); font-weight: 600; }

.merge-meta { color: var(--dim); font-size: 12px; }

/* 两个选项都是长句，竖排更好读；radio 本身别被拉满整行。 */
.merge-options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin-top: 8px;
}

.merge-options :deep(.el-radio) {
  height: auto;
  margin-right: 0;
  padding: 2px 0;
  font-size: 12px;
  line-height: 1.6;
  white-space: normal;
}

.merge-options :deep(.el-radio__label) { padding-left: 8px; }

.friend-note {
  margin: var(--sp-2) 0 0;
  border-radius: 8px;
  background: var(--surface-3);
  padding: 8px 10px;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}
.link {
  flex: none;
  border: 0;
  background: none;
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.link:disabled { color: var(--faint); cursor: default; }

.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.foot-note { color: var(--dim); font-size: 12px; text-align: left; }
.foot-actions { display: flex; }

@media (max-width: 560px) {
  .preview-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .foot { flex-direction: column; align-items: stretch; }
}
</style>
