<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { readErrorMessage } from "./utils";

/**
 * 添加 B站 账号 —— 只管接入（显示名 / 配置目录 / CLI 路径）。
 * 值班设置（每天几条、谷时窗口、刷站口味）在账号建好后的「值班设置」里配。
 *
 * 请求和表单都归这个组件；父页面只接 `saved` 事件去重拉 dashboard。
 */
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
}>();

const saving = ref(false);
const form = reactive({ displayName: "", dataHome: "", biliBin: "" });

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    form.displayName = "";
    form.dataHome = "";
    form.biliBin = "";
  },
);

function close() {
  emit("update:modelValue", false);
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    await $fetch("/api/admin/channels", {
      method: "POST",
      body: {
        platform: "bili",
        displayName: form.displayName.trim(),
        dataHome: form.dataHome.trim(),
        biliBin: form.biliBin.trim(),
      },
    });
    ElMessage.success("B站 账号已添加，值班设置等账号出现后再配。");
    close();
    emit("saved");
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "添加账号失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="添加 B站 账号"
    width="520px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top">
      <el-form-item label="显示名（可选）">
        <el-input
          v-model="form.displayName"
          placeholder="例如：我的 B站 账号"
        />
      </el-form-item>
      <el-form-item label="配置目录（可选，bili CLI 的 credential / owner 所在处）">
        <el-input
          v-model="form.dataHome"
          placeholder="留空 = %APPDATA%\bili-cli（多账号要各填一个目录）"
        />
      </el-form-item>
      <el-form-item label="bili 可执行文件路径（可选）">
        <el-input
          v-model="form.biliBin"
          placeholder="留空则从 BILI_BIN 或 PATH 里找"
        />
      </el-form-item>
    </el-form>
    <p class="bd-form-tip">
      值班设置（每天挑几条、谷时窗口、刷站口味等）在账号建好后的「值班设置」里配，这里只管接入。
    </p>
    <template #footer>
      <el-button @click="close">
        取消
      </el-button>
      <el-button
        type="primary"
        :loading="saving"
        @click="save"
      >
        保存
      </el-button>
    </template>
  </el-dialog>
</template>
