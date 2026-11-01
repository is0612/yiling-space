<script setup lang="ts">
import {
  ArrowRight, Clock, Close, Document, Expand, Fold, Grid, Operation, Search,
} from "@element-plus/icons-vue";
import { useBiliDesk } from "./useBiliDesk";

/**
 * 值班台侧栏 —— 搜索 / 工作台入口 / 常用（可取消固定）/ 全部命令（就地折叠）。
 *
 * 这里拿的是页面 provide 的同一份外壳状态（useBiliDesk），
 * 所以不需要一堆 props：点了就改，页面和侧栏看到的是同一个 ref。
 * 只有「运行记录」上的条数来自页面（runLog 属于命令执行，不归外壳）。
 */
defineProps<{ runCount: number }>();

const {
  query, searchRef, visibleCount, view, isCmdActive,
  rail, railManual, toggleRail,
  pins, pinIcon, pinLabel, unpin, restorePins, selectItem,
  groups, searching, filteredGroups, catalogLoading, isGroupOpen, toggleGroup, groupIcon,
  menuEmpty, menuTotal, openMenuManager, goWorkbench,
} = useBiliDesk();
</script>

<template>
  <aside class="bd-side">
    <div class="bd-side-head">
      <el-input
        ref="searchRef"
        v-model="query"
        :placeholder="`搜索 ${visibleCount} 条命令`"
        clearable
        title="按 Ctrl K 直接定位到这里"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
        <template #suffix>
          <kbd class="bd-kbd">Ctrl K</kbd>
        </template>
      </el-input>
    </div>

    <div class="bd-side-scroll">
      <!-- ① 工作台：视图入口，不是命令 -->
      <div class="bd-sec-label">
        工作台
      </div>
      <button
        class="bd-nav-ov"
        :class="{ on: view === 'overview' }"
        type="button"
        title="概览"
        @click="goWorkbench('overview')"
      >
        <el-icon><Grid /></el-icon>
        <span>概览</span>
      </button>
      <button
        class="bd-nav-ov"
        :class="{ on: view === 'history' }"
        type="button"
        title="运行记录"
        @click="goWorkbench('history')"
      >
        <el-icon><Clock /></el-icon>
        <span>运行记录</span>
        <span
          v-if="runCount"
          class="cnt"
        >{{ runCount }}</span>
      </button>

      <!-- ② 常用：日常 90% 的操作都在这里，可以取消固定 -->
      <template v-if="!searching">
        <div class="bd-sec-label">
          常用<span class="cnt">{{ pins.length }} 条</span>
        </div>
        <button
          v-for="p in pins"
          :key="p.key"
          class="bd-pin"
          :class="{ on: isCmdActive(p.item.id) }"
          type="button"
          :title="p.item.id"
          @click="selectItem(p.item)"
        >
          <el-icon class="pi">
            <component :is="pinIcon(p.item)" />
          </el-icon>
          <span class="pl">{{ pinLabel(p.item) }}</span>
          <span
            class="bd-pin-mark"
            title="取消固定"
            @click="unpin(p.key, $event)"
          >
            <el-icon><Close /></el-icon>
          </span>
        </button>
        <div
          v-if="!pins.length"
          class="bd-side-empty"
        >
          <template v-if="menuEmpty">
            常用栏里的命令也被藏起来了<br>
            <button
              type="button"
              @click="openMenuManager"
            >
              点这里勾回来
            </button>
          </template>
          <template v-else>
            常用栏空了<br>
            <button
              type="button"
              @click="restorePins"
            >
              恢复默认 4 条
            </button>
          </template>
        </div>
      </template>

      <!-- ③ 全部命令：就地折叠，不弹窗 -->
      <div class="bd-sec-label">
        全部命令<span class="cnt">{{ filteredGroups.length }} 组 · {{ visibleCount }} 条</span>
      </div>
      <el-skeleton
        v-if="catalogLoading"
        :rows="4"
        animated
      />
      <div
        v-for="g in filteredGroups"
        :key="g.group"
        class="bd-grp-wrap"
        :class="{ open: isGroupOpen(g.group) }"
      >
        <button
          class="bd-grp"
          type="button"
          :title="g.group"
          @click="toggleGroup(g.group)"
        >
          <el-icon class="gi">
            <component :is="groupIcon(g.group)" />
          </el-icon>
          <span class="grn">{{ g.group }}</span>
          <span class="cnt">{{ g.items.length }}</span>
          <el-icon class="chev">
            <ArrowRight />
          </el-icon>
        </button>
        <div class="bd-items">
          <button
            v-for="it in g.items"
            :key="it.id"
            class="bd-item"
            :class="{ on: isCmdActive(it.id) }"
            type="button"
            :title="it.id"
            @click="selectItem(it)"
          >
            <span class="lb">{{ it.label }}</span>
            <span
              v-if="it.write"
              class="bd-wtag"
            >写</span>
          </button>
        </div>
      </div>

      <div
        v-if="!catalogLoading && !groups.length"
        class="bd-side-empty"
      >
        命令目录还没读出来<br>
        刷新一下页面再试
      </div>
      <div
        v-else-if="menuEmpty && !searching"
        class="bd-side-empty"
      >
        菜单都被藏起来了<br>
        <button
          type="button"
          @click="openMenuManager"
        >
          点这里勾回来
        </button>
      </div>
      <div
        v-else-if="searching && !filteredGroups.length"
        class="bd-side-empty"
      >
        没有匹配「{{ query }}」的命令<br>共 {{ visibleCount }} 条
      </div>
      <!-- 默认收起 20 多条命令，得留一句说明，否则像命令丢了 -->
      <div
        v-if="!searching && menuTotal > visibleCount"
        class="bd-side-empty"
      >
        还有 {{ menuTotal - visibleCount }} 条命令收着
        <br>
        <button
          type="button"
          @click="openMenuManager"
        >
          要用的在这里打开
        </button>
      </div>
    </div>

    <div class="bd-side-foot">
      <NuxtLink
        to="/"
        class="bd-foot-btn"
        title="回到忆灵空间总览"
      >
        <el-icon><Document /></el-icon><span>回空间</span>
      </NuxtLink>
      <button
        type="button"
        title="管理菜单：只显示你在用的命令"
        @click="openMenuManager"
      >
        <el-icon><Operation /></el-icon><span>管理菜单</span>
      </button>
      <button
        type="button"
        :title="rail ? '展开侧栏' : '收起侧栏，把宽度让给内容'"
        @click="toggleRail"
      >
        <el-icon>
          <Expand v-if="rail" />
          <Fold v-else />
        </el-icon>
        <span>{{ rail ? "展开" : "收起" }}</span>
      </button>
    </div>
  </aside>
</template>
