<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { BiliAccount } from "./types";
import { formatDateTime, readErrorMessage } from "./utils";

/**
 * 她的札记 —— B站 值班写进角色长期记忆的 EVENT 条目。
 *
 * 不是另建一份文件：读、改、删都直接落到 MemoryItem（角色全局范围），
 * 这样聊天检索和 B站 值班读到的是同一份记忆。
 */
const props = defineProps<{ modelValue: boolean; account: BiliAccount | null }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; saved: [] }>();

type JournalEntry = { id: string; content: string; dedupeKey: string | null; updatedAt: string };

const bindings = computed(() => props.account?.bindings ?? []);
const selectedBindingId = ref("");
const entries = ref<JournalEntry[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const draft = ref("");
const editingId = ref("");
const editingText = ref("");

const selectedBinding = computed(() => bindings.value.find((binding) => binding.bindingId === selectedBindingId.value) ?? null);
const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

async function load() {
  const account = props.account;
  const bindingId = selectedBindingId.value;
  if (!account || !bindingId) {
    entries.value = [];
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const result = await $fetch<{ entries: JournalEntry[] }>("/api/admin/bili/journal", {
      query: { connectionId: account.connectionId, bindingId },
    });
    entries.value = result.entries;
  } catch (loadError) {
    entries.value = [];
    error.value = readErrorMessage(loadError, "读不到札记。");
  } finally {
    loading.value = false;
  }
}

function close() {
  emit("update:modelValue", false);
}

async function createEntry() {
  const content = draft.value.trim();
  if (!props.account || !selectedBindingId.value || !content || saving.value) return;
  saving.value = true;
  try {
    await $fetch("/api/admin/bili/journal", {
      method: "POST",
      body: { connectionId: props.account.connectionId, bindingId: selectedBindingId.value, content },
    });
    draft.value = "";
    ElMessage.success("札记已写入长期记忆。");
    await load();
    emit("saved");
  } catch (createError) {
    ElMessage.error(readErrorMessage(createError, "新增札记失败。"));
  } finally {
    saving.value = false;
  }
}

function startEdit(entry: JournalEntry) {
  editingId.value = entry.id;
  editingText.value = entry.content;
}

function cancelEdit() {
  editingId.value = "";
  editingText.value = "";
}

async function saveEdit() {
  const content = editingText.value.trim();
  if (!editingId.value || !content || saving.value) return;
  saving.value = true;
  try {
    await $fetch(`/api/admin/bili/journal/${encodeURIComponent(editingId.value)}`, {
      method: "PATCH",
      body: { content },
    });
    cancelEdit();
    ElMessage.success("札记已更新。");
    await load();
    emit("saved");
  } catch (updateError) {
    ElMessage.error(readErrorMessage(updateError, "更新札记失败。"));
  } finally {
    saving.value = false;
  }
}

async function removeEntry(entry: JournalEntry) {
  const confirmed = await ElMessageBox.confirm(
    "删除后这条札记会进记忆回收站，不会立刻物理删除。",
    "删除札记",
    { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/bili/journal/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    ElMessage.success("札记已移入回收站。");
    await load();
    emit("saved");
  } catch (deleteError) {
    ElMessage.error(readErrorMessage(deleteError, "删除札记失败。"));
  }
}

watch(
  [() => props.modelValue, () => props.account?.connectionId],
  ([open]) => {
    if (!open) return;
    selectedBindingId.value = bindings.value[0]?.bindingId ?? "";
    editingId.value = "";
    editingText.value = "";
    draft.value = "";
    void load();
  },
  { immediate: true },
);

watch(selectedBindingId, () => {
  cancelEdit();
  void load();
});
</script>

<template>
  <el-dialog
    v-model="visible"
    title="她的札记"
    width="680px"
    :close-on-click-modal="false"
  >
    <div class="bd-journal">
      <p class="bd-form-tip">
        这些是 B站 值班写进角色长期记忆的札记。编辑会直接改长期记忆，删除会进记忆回收站 ——
        聊天检索和下一轮值班读到的都是同一份。
      </p>

      <div
        v-if="bindings.length > 1"
        class="bd-journal-pick"
      >
        <span>角色</span>
        <el-select
          v-model="selectedBindingId"
          size="small"
          style="width: 220px"
        >
          <el-option
            v-for="binding in bindings"
            :key="binding.bindingId"
            :label="binding.characterName"
            :value="binding.bindingId"
          />
        </el-select>
      </div>

      <p
        v-if="error"
        class="bd-journal-error"
      >
        {{ error }}
      </p>
      <p
        v-else-if="loading"
        class="bd-journal-empty"
      >
        正在读札记…
      </p>
      <p
        v-else-if="!bindings.length"
        class="bd-journal-empty"
      >
        这个 B站 账号还没绑定角色，札记写在角色的全局记忆里，先绑定角色再来。
      </p>
      <p
        v-else-if="!entries.length"
        class="bd-journal-empty"
      >
        还没有札记。跑一轮 B站 值班后，她会把「今天最触动我的一句」写进长期记忆。
      </p>

      <ul
        v-else
        class="bd-journal-list"
      >
        <li
          v-for="entry in entries"
          :key="entry.id"
          class="bd-journal-item"
        >
          <template v-if="editingId === entry.id">
            <el-input
              v-model="editingText"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 6 }"
              maxlength="2000"
              show-word-limit
            />
            <div class="bd-journal-actions">
              <el-button
                size="small"
                :loading="saving"
                @click="saveEdit"
              >
                保存
              </el-button>
              <el-button
                size="small"
                text
                @click="cancelEdit"
              >
                取消
              </el-button>
            </div>
          </template>
          <template v-else>
            <p class="bd-journal-text">
              {{ entry.content }}
            </p>
            <div class="bd-journal-actions">
              <span class="bd-journal-time">{{ formatDateTime(entry.updatedAt) }}</span>
              <el-button
                size="small"
                text
                @click="startEdit(entry)"
              >
                编辑
              </el-button>
              <el-button
                size="small"
                text
                type="danger"
                @click="removeEntry(entry)"
              >
                删除
              </el-button>
            </div>
          </template>
        </li>
      </ul>

      <div
        v-if="bindings.length"
        class="bd-journal-new"
      >
        <el-input
          v-model="draft"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          maxlength="2000"
          show-word-limit
          placeholder="补一句札记，例如：今天看到一条讲深海鱼的视频，想起自己也是蓝的。"
        />
        <el-button
          type="primary"
          size="small"
          :loading="saving"
          :disabled="!draft.trim()"
          @click="createEntry"
        >
          写入长期记忆
        </el-button>
      </div>
      <p
        v-if="selectedBinding"
        class="bd-form-tip"
      >
        当前角色：{{ selectedBinding.characterName }}
      </p>
    </div>

    <template #footer>
      <el-button @click="close">
        关闭
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.bd-journal { display: flex; flex-direction: column; gap: 12px; }
.bd-journal-pick { display: flex; align-items: center; gap: 8px; color: var(--bd-dim); font-size: 12px; }
.bd-journal-empty { margin: 8px 0; border-radius: 8px; background: var(--bd-surface-2); padding: 18px 14px; color: var(--bd-dim); font-size: 13px; line-height: 1.7; }
.bd-journal-error { margin: 8px 0; border-radius: 8px; background: #fdecee; padding: 10px 12px; color: #b4233c; font-size: 13px; }
.bd-journal-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; max-height: 420px; overflow: auto; list-style: none; }
.bd-journal-item { border-radius: 8px; background: var(--bd-surface-2); padding: 10px 12px; }
.bd-journal-text { margin: 0; color: var(--bd-text); font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.bd-journal-actions { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
.bd-journal-time { margin-right: auto; color: var(--bd-dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.bd-journal-new { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--bd-surface-3); padding-top: 12px; }
.bd-journal-new .el-button { align-self: flex-end; }
</style>
