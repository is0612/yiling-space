<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { Character } from "~/utils/mock-data";

/**
 * 编辑角色资料：只改名称和基础人设。
 *
 * 简介 / 她对你的称呼 / 对话示例已经从这个弹窗撤掉（只在「创建角色」时写一次），
 * 所以这里也不再持有它们的草稿，保存时更不会把它们一并提交 ——
 * 老角色库里的值原样留着，不会因为一次改名被清空。
 *
 * 字段区（身份条 + 主次两栏 + 列头字数）在 `CharacterProfileFields` 里，
 * 「创建角色」弹窗共用同一份，用 `mode` 决定给几个字段。这个文件只管弹窗外壳：
 * 草稿、提交、页脚。
 *
 * 页脚左侧放「上次保存」而不是留白：右下角两个按钮孤零零的，一行 12px 时间戳就够配平。
 */
type ProfileCharacter = {
  id: string;
  name: string;
  personality?: string;
  /** ISO 时间；有就在页脚左侧显示「上次保存」，没有就不显示 */
  updatedAt?: string;
};

const props = defineProps<{
  modelValue: boolean;
  character: ProfileCharacter | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [character: Character];
}>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const saving = ref(false);
const draftName = ref("");
const draftPersonality = ref("");

/** 每次打开都从当前角色重新灌一遍草稿，避免上次没保存的残值留下来 */
watch(open, (isOpen) => {
  if (!isOpen) return;
  const current = props.character;
  draftName.value = current?.name ?? "";
  draftPersonality.value = current?.personality ?? "";
}, { immediate: true });

function readError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

/** 「上次保存 10 月 28 日 11:20」；字段缺失或时间非法时整条不显示，不留半截文案 */
const savedNote = computed(() => {
  const raw = props.character?.updatedAt;
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `上次保存 ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
});

async function save() {
  if (saving.value || !props.character) return;
  const name = draftName.value.trim();
  if (!name) {
    ElMessage.warning("请先填写角色名称。");
    return;
  }
  saving.value = true;
  try {
    const updated = await $fetch<Character>(`/api/characters/${encodeURIComponent(props.character.id)}`, {
      method: "PATCH",
      body: { name, personality: draftPersonality.value.trim() },
    });
    emit("saved", updated);
    open.value = false;
    ElMessage.success("角色资料已保存。");
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="编辑角色资料"
    width="min(1160px, 96vw)"
    destroy-on-close
  >
    <el-form
      label-position="top"
      class="cp-form"
      @submit.prevent="save"
    >
      <CharacterProfileFields
        v-model:name="draftName"
        v-model:personality="draftPersonality"
        mode="edit"
      />
    </el-form>

    <template #footer>
      <div class="cp-foot">
        <span class="cp-foot-note">{{ savedNote }}</span>
        <span class="cp-foot-actions">
          <el-button @click="open = false">
            取消
          </el-button>
          <el-button
            type="primary"
            :loading="saving"
            @click="save"
          >
            保存
          </el-button>
        </span>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ── 页脚：左「上次保存」，右动作。保存是唯一主操作 ── */
.cp-foot {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.cp-foot-note {
  color: var(--faint);
  font-size: 12px;
}
.cp-foot-actions {
  display: flex;
}
</style>
