<script setup lang="ts">
/**
 * API Key 输入框：默认打码（暗文），右边一个眼睛按钮切成明文。
 *
 * 默认暗文（2026-11-07 用户决定，同一天从「默认明文」改回来）：这一页经常是开着屏幕
 * 顺手填配置，屏幕上默认不出现完整 Key 更稳妥；要核对有没有粘全时点一下眼睛，
 * 看完再点回去。Element 自带的 show-password 也能做这件事，抽出来的理由只是
 * 六个输入框要共用同一套显隐、图标和可访问属性，别各写一遍。
 *
 * 关于回显（2026-11-12 起）：Key 现在以明文存在角色配置里，登录后的管理员会看到
 * 库里那把；所以「输入框空着」不再等于「保持原样」，删除必须由调用方显式确认。
 * 这就是 `clearable` 的用途：只有调用方说能清，才显示「清除」按钮并发出 `clear`，
 * 由调用方把它翻译成保存时的 `clear*ApiKey`。
 */
import { Hide, View } from "@element-plus/icons-vue";

const key = defineModel<string>({ required: true });
const emit = defineEmits<{ (event: "clear"): void }>();

/** 每个输入框各管各的：只揭开会正在看的那一个，不该把整页六把 Key 一起露出来。 */
const visible = ref(false);

/** 三个都是「调用方一定会给」的透传参数，默认值只是为了让 lint 的 require-default-prop 过关。 */
withDefaults(defineProps<{
  placeholder?: string;
  ariaLabel?: string;
  maxlength?: number | string;
  /** 是否显示「清除」：真删 Key 走保存时的 clear 字段，所以要点一下再保存。 */
  clearable?: boolean;
}>(), { placeholder: "", ariaLabel: "", maxlength: 8192, clearable: false });
</script>

<template>
  <el-input
    v-model="key"
    :type="visible ? 'text' : 'password'"
    :maxlength="maxlength"
    :aria-label="ariaLabel"
    :placeholder="placeholder"
    autocomplete="new-password"
    autocapitalize="off"
    spellcheck="false"
  >
    <template #suffix>
      <button
        v-if="clearable && key"
        type="button"
        class="key-clear"
        aria-label="清除已保存的 Key"
        title="清除已保存的 Key（保存后生效）"
        @click="emit('clear')"
      >
        清除
      </button>
      <button
        type="button"
        class="key-eye"
        :aria-label="visible ? '隐藏 Key' : '显示 Key'"
        :title="visible ? '隐藏' : '显示'"
        @click="visible = !visible"
      >
        <el-icon><Hide v-if="visible" /><View v-else /></el-icon>
      </button>
    </template>
  </el-input>
</template>

<style scoped>
.key-clear {
  margin-right: 2px;
  border: 0;
  border-radius: 4px;
  background: none;
  padding: 0 4px;
  color: var(--rose, #c45656);
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}
.key-clear:hover { text-decoration: underline; }
.key-clear:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.key-eye {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: none;
  padding: 0;
  color: var(--dim);
  cursor: pointer;
}
.key-eye:hover { color: var(--text); }
.key-eye:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.key-eye .el-icon { font-size: 14px; }
</style>
