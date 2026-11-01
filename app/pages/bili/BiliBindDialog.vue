<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { readErrorMessage } from "./utils";

/**
 * 绑定角色 —— 一个账号可绑多个角色，各自独立记报告、判重和每日额度。
 * 角色列表由父页面传进来（和角色管理页共用 useCharacterList 那份数据）。
 */
const props = defineProps<{
  modelValue: boolean;
  connectionId: string;
  characters: { id: string; name: string }[];
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
}>();

const saving = ref(false);
const form = reactive({ characterId: "" });

watch(
  () => props.modelValue,
  (open) => {
    if (open) form.characterId = "";
  },
);

async function bind() {
  if (saving.value || !props.connectionId) return;
  if (!form.characterId) {
    ElMessage.warning("请选择要绑定的角色。");
    return;
  }
  saving.value = true;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(props.connectionId)}/bindings`, {
      method: "POST",
      body: { characterId: form.characterId },
    });
    ElMessage.success("角色已绑定到这个账号。");
    emit("update:modelValue", false);
    emit("saved");
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "绑定失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="绑定角色"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top">
      <el-form-item label="角色">
        <el-select
          v-model="form.characterId"
          placeholder="选择要绑定的角色"
          style="width:100%"
        >
          <el-option
            v-for="character in characters"
            :key="character.id"
            :label="character.name"
            :value="character.id"
          />
        </el-select>
      </el-form-item>
    </el-form>
    <p class="bd-form-tip">
      一个账号可绑多个角色，各自独立记报告、判重和每日额度。
    </p>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">
        取消
      </el-button>
      <el-button
        type="primary"
        :loading="saving"
        @click="bind"
      >
        绑定
      </el-button>
    </template>
  </el-dialog>
</template>
