<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Operation, Search } from "@element-plus/icons-vue";
import type { BiliCatalogGroup } from "./types";

/**
 * 管理菜单 —— 只影响侧栏显示，命令表本身一条都不动。
 *
 * 编辑态（draft）和已保存态分开：勾到一半点「取消」就什么都没发生。
 * 保存时把两份数组丢给父页面，落 localStorage + 立刻重算侧栏，都是父页面的事
 * （那份状态还要驱动侧栏渲染，不适合藏在这个弹窗里）。
 */
const props = defineProps<{
  modelValue: boolean;
  groups: BiliCatalogGroup[];
  hiddenGroups: string[];
  hiddenItems: string[];
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  save: [{ hiddenGroups: string[]; hiddenItems: string[] }];
}>();

const query = ref("");
const draftHiddenGroups = ref<string[]>([]);
const draftHiddenItems = ref<string[]>([]);

/** 每次打开都从已保存态重新起草，不带上一次的残留 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    draftHiddenGroups.value = [...props.hiddenGroups];
    draftHiddenItems.value = [...props.hiddenItems];
    query.value = "";
  },
);

/** 「常用可见、其余收起」的初始布局：没有 common 标记的全藏起来 */
function defaultHiddenIds(): string[] {
  return props.groups.flatMap((group) => group.items.filter((item) => !item.common).map((item) => item.id));
}

function fullOf(group: string) {
  return props.groups.find((g) => g.group === group);
}

const total = computed(() => props.groups.reduce((n, g) => n + g.items.length, 0));

const hiddenCount = computed(() => {
  const gs = new Set(draftHiddenGroups.value);
  const is = new Set(draftHiddenItems.value);
  let n = 0;
  for (const g of props.groups) {
    n += gs.has(g.group) ? g.items.length : g.items.filter((i) => is.has(i.id)).length;
  }
  return n;
});
const visibleCount = computed(() => total.value - hiddenCount.value);
const allShown = computed(() => total.value > 0 && hiddenCount.value === 0);

/** 分组勾选三态：全显示 / 显示一部分 / 全隐藏 */
function groupState(g: BiliCatalogGroup): "all" | "some" | "none" {
  if (draftHiddenGroups.value.includes(g.group)) return "none";
  const full = fullOf(g.group) ?? g;
  const hidden = full.items.filter((i) => draftHiddenItems.value.includes(i.id)).length;
  if (!hidden) return "all";
  return hidden === full.items.length ? "none" : "some";
}

function toggleGroup(group: string, show: boolean) {
  const ids = new Set((fullOf(group)?.items ?? []).map((i) => i.id));
  // 整组切换时清掉组内单条记录，免得留下互相矛盾的配置
  draftHiddenItems.value = draftHiddenItems.value.filter((id) => !ids.has(id));
  draftHiddenGroups.value = show
    ? draftHiddenGroups.value.filter((x) => x !== group)
    : [...new Set([...draftHiddenGroups.value, group])];
}

function toggleItem(id: string, show: boolean) {
  draftHiddenItems.value = show
    ? draftHiddenItems.value.filter((x) => x !== id)
    : [...new Set([...draftHiddenItems.value, id])];
}

function toggleAll(show: boolean) {
  if (show) {
    draftHiddenGroups.value = [];
    draftHiddenItems.value = [];
  } else {
    draftHiddenGroups.value = props.groups.map((g) => g.group);
    draftHiddenItems.value = [];
  }
}

function resetDefaults() {
  draftHiddenGroups.value = [];
  draftHiddenItems.value = defaultHiddenIds();
}

/** 弹窗内搜索：组名或命令命中就保留整组（45 条盲翻太费劲） */
const shownGroups = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.groups;
  return props.groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) =>
        g.group.toLowerCase().includes(q)
        || i.label.toLowerCase().includes(q)
        || i.id.toLowerCase().includes(q)
        || i.argv.join(" ").toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);
});

function save() {
  emit("save", {
    hiddenGroups: [...draftHiddenGroups.value],
    hiddenItems: [...draftHiddenItems.value],
  });
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="680px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="bd-menu-h">
        <span>管理菜单</span>
        <span class="bd-menu-hsub">已选 {{ visibleCount }} / {{ total }} 条</span>
      </div>
    </template>

    <p class="bd-menu-hint">
      勾上要用的，取消勾就藏起来 —— 改动只影响显示，命令本身都还在，随时能勾回来。
    </p>

    <div class="bd-menu-mgr">
      <div class="bd-menu-bar">
        <el-checkbox
          :model-value="allShown"
          :indeterminate="!allShown && visibleCount > 0"
          @change="(v: string | number | boolean) => toggleAll(Boolean(v))"
        >
          全选
        </el-checkbox>
        <el-input
          v-model="query"
          size="small"
          placeholder="搜组名 / 命令名 / 命令…"
          clearable
          class="bd-menu-search"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <span class="bd-menu-cnt">显示 {{ visibleCount }} / {{ total }}</span>
        <el-button
          size="small"
          text
          @click="resetDefaults"
        >
          恢复默认
        </el-button>
      </div>

      <div
        v-for="g in shownGroups"
        :key="g.group"
        class="bd-menu-grp"
      >
        <div class="bd-menu-grp-h">
          <el-checkbox
            :model-value="groupState(g) === 'all'"
            :indeterminate="groupState(g) === 'some'"
            @change="(v: string | number | boolean) => toggleGroup(g.group, Boolean(v))"
          >
            <b :class="{ 'is-off': draftHiddenGroups.includes(g.group) }">{{ g.group }}</b>
          </el-checkbox>
          <span class="bd-menu-badge">{{ (fullOf(g.group) ?? g).items.length }}</span>
        </div>
        <div class="bd-menu-items">
          <el-checkbox
            v-for="it in g.items"
            :key="it.id"
            class="bd-menu-item"
            :model-value="!draftHiddenGroups.includes(g.group) && !draftHiddenItems.includes(it.id)"
            :disabled="draftHiddenGroups.includes(g.group)"
            @change="(v: string | number | boolean) => toggleItem(it.id, Boolean(v))"
          >
            <span
              class="bd-menu-label"
              :class="{ 'is-off': draftHiddenGroups.includes(g.group) || draftHiddenItems.includes(it.id) }"
            >{{ it.label }}</span>
            <code class="bd-menu-cmd">{{ it.argv.join(" ") }}</code>
          </el-checkbox>
        </div>
      </div>

      <div
        v-if="!total"
        class="bd-menu-empty"
      >
        <el-icon :size="22">
          <Operation />
        </el-icon>
        <p>命令表还没加载出来</p>
      </div>
      <div
        v-else-if="!shownGroups.length"
        class="bd-menu-empty"
      >
        <el-icon :size="22">
          <Search />
        </el-icon>
        <p>没找到「{{ query }}」相关的命令</p>
      </div>
    </div>

    <template #footer>
      <div class="bd-menu-foot">
        <span class="bd-menu-foottip">配置存在本机浏览器，换台机器需要重新勾。</span>
        <el-button @click="emit('update:modelValue', false)">
          取消
        </el-button>
        <el-button
          type="primary"
          @click="save"
        >
          保存
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>
