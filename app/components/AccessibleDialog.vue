<script setup lang="ts">
/**
 * 带完整键盘行为的弹窗容器。
 *
 * 打开：焦点进入弹窗（优先 [data-autofocus]，否则第一个可聚焦元素，否则弹窗本身）；
 * 打开期间：Tab / Shift+Tab 在弹窗内循环，不会跑到背后的页面；
 * Esc：关闭；关闭后：焦点回到打开它的那个元素。
 *
 * 只是容器：标题、正文、按钮都由调用方用默认插槽和 actions 插槽给。
 * 焦点计算抽在 ~/utils/focus-trap.ts，便于用假 DOM 单测。
 */
import { resolveTabFocus } from "~/utils/focus-trap";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string;
  /** 宽版用于需要对照长文的弹窗（如合并确认） */
  size?: "default" | "wide";
  /** 提交中禁止关闭，避免请求回来时弹窗已经消失 */
  closeDisabled?: boolean;
}>(), { description: "", size: "default", closeDisabled: false });

const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
/** 打开前的焦点元素，关闭后要把焦点还回去（键盘用户不能掉到页首）。 */
let returnFocus: HTMLElement | null = null;
let previousBodyOverflow = "";

function focusInitial() {
  const node = panel.value;
  if (!node) return;
  const preferred = node.querySelector<HTMLElement>("[data-autofocus]");
  const first = node.querySelector<HTMLElement>(
    "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
  );
  (preferred ?? first ?? node).focus();
}

watch(() => props.open, async (open) => {
  if (typeof document === "undefined") return;
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    await nextTick();
    focusInitial();
    return;
  }
  document.body.style.overflow = previousBodyOverflow;
  returnFocus?.focus();
  returnFocus = null;
});

onBeforeUnmount(() => {
  if (typeof document === "undefined") return;
  // 弹窗还没关就被卸载（切角色、路由离开）时也要把滚动条还回去。
  if (props.open) document.body.style.overflow = previousBodyOverflow;
});

function requestClose() {
  if (props.closeDisabled) return;
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    // 捕获阶段之外不再冒泡到页面的其他 Esc 处理，避免一次按键关两层。
    event.preventDefault();
    event.stopPropagation();
    requestClose();
    return;
  }
  if (event.key !== "Tab") return;
  const decision = resolveTabFocus(panel.value, document.activeElement, event.shiftKey);
  if (decision.kind === "native") return;
  event.preventDefault();
  decision.target.focus();
}
</script>

<template>
  <div
    v-if="open"
    class="dialog-overlay"
    @click.self="requestClose"
  >
    <section
      ref="panel"
      class="dialog-panel"
      :class="{ 'is-wide': size === 'wide' }"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="dialog-header">
        <h2 class="dialog-title">
          {{ title }}
        </h2>
        <button
          type="button"
          class="dialog-close"
          :disabled="closeDisabled"
          @click="requestClose"
        >
          关闭
        </button>
      </header>
      <p
        v-if="description"
        class="dialog-description"
      >
        {{ description }}
      </p>
      <div class="dialog-body">
        <slot />
      </div>
      <footer
        v-if="$slots.actions"
        class="dialog-actions"
      >
        <slot name="actions" />
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* 与知识页原有的 merge-overlay / merge-dialog 尺寸、色值保持一致，
   只是补上焦点与结构语义，不改视觉风格。 */
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, .52);
  padding: 20px;
}
.dialog-panel {
  display: flex;
  width: min(560px, 100%);
  max-height: min(90vh, 900px);
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  padding: 18px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, .25);
}
.dialog-panel.is-wide { width: min(720px, 100%); }
.dialog-panel:focus { outline: none; }
.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dialog-title {
  margin: 0;
  color: var(--ink);
  font-size: 16px;
}
.dialog-close {
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  padding: 6px 10px;
  color: var(--dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dialog-close:hover:not(:disabled) { background: var(--surface-2); color: var(--ink); }
.dialog-close:disabled { opacity: .5; cursor: not-allowed; }
.dialog-description {
  margin: 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.7;
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
/* 弹窗内按钮沿用页面现有按钮语汇；放这里是为了独立使用时也不至于没有样式。 */
.dialog-actions :deep(button),
.dialog-body :deep(button) {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-2);
  padding: 8px 12px;
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dialog-actions :deep(button:disabled),
.dialog-body :deep(button:disabled) { opacity: .5; cursor: not-allowed; }
.dialog-actions :deep(button.primary) {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.dialog-actions :deep(button.danger) {
  border-color: var(--red, #c92b41);
  background: var(--red, #c92b41);
  color: #fff;
}
</style>
