<script setup lang="ts">
import type { Character } from "~/utils/mock-data";

/**
 * 三个菜单页（角色记忆 / AI 对话 / 阶段总结）共用顶部的角色切换条。
 * 以前这三页各自复制了一份 char-bar 的模板 + CSS，漂到数值都不一样
 * （memory 是 12px 18px / 240px，另两页是 10px 16px / 220px）。这里收成一处。
 *
 * 选角色的逻辑走 useCharacterSelection(path)，切角色时先把新 id 抛给页面
 * （页面要在跳转前清掉旧角色的会话/草稿/列表，避免闪一帧上一角色的数据），
 * 再 navigateTo 到 ?c= 新 id，由各页自己的 watch(id) 统一重拉。
 */
const props = withDefaults(
  defineProps<{
    /** useCharacterSelection 的停留路径，如 "/memory" */
    path: string;
    /** 额外的禁用条件：对话页 sending、阶段总结页 creating */
    disabled?: boolean;
    /** 没有角色时整块空态的文案（三页措辞不同） */
    emptyText: string;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{ change: [nextId: string] }>();

const characters = useCharacterList();
await useCharacterListData();
const { id, go } = useCharacterSelection(props.path);

const current = computed<Character | null>(
  () => characters.value.find((item) => item.id === id.value) ?? null,
);
const initial = computed(() => current.value?.avatar || "忆");
const tone = computed(() => current.value?.avatarTone || "mint");
const status = computed(() => current.value?.status ?? null);

function statusTone(value: Character["status"]) {
  if (value === "运行中") return "pill-green";
  return value === "已暂停" ? "pill-amber" : "pill-gray";
}

async function switchCharacter(nextId: string) {
  if (!nextId || nextId === id.value || props.disabled) return;
  emit("change", nextId);
  await go(nextId);
}
</script>

<template>
  <div>
    <div class="card char-bar">
      <span class="char-bar-label">当前角色</span>
      <el-select
        :model-value="id"
        class="char-select"
        placeholder="选择角色"
        :disabled="!characters.length || disabled"
        @change="switchCharacter"
      >
        <template #prefix>
          <span
            class="avatar sel-avatar"
            :class="'avatar-' + tone"
          >{{ initial }}</span>
        </template>
        <el-option
          v-for="item in characters"
          :key="item.id"
          :label="item.name"
          :value="item.id"
        />
      </el-select>
      <span
        v-if="status"
        class="pill"
        :class="statusTone(status)"
      >{{ status }}</span>
      <slot />
      <span class="char-bar-note">共 {{ characters.length }} 个角色</span>
      <NuxtLink
        v-if="!characters.length"
        to="/characters"
        class="char-bar-link"
      >
        去创建角色
      </NuxtLink>
    </div>

    <div
      v-if="!characters.length"
      class="card no-character"
    >
      <p>{{ emptyText }}</p>
      <NuxtLink
        to="/characters"
        class="btn primary"
      >
        去创建角色
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
/* 白砖：与三页各自的 .card 覆盖一致（零描边零阴影） */
.card{border:0;border-radius:10px;box-shadow:none}

.char-bar{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:10px 16px}
.char-bar-label{flex:none;color:var(--dim);font-size:12px}
.char-select{width:220px;flex:none}
.sel-avatar{width:24px;height:24px;border-radius:6px;font-size:12px}
.char-select :deep(.el-select__placeholder),
.char-select :deep(.el-select__selected-item){color:var(--text);font-weight:600}
.char-bar-note{margin-left:auto;color:var(--dim);font-size:12px}
.char-bar-link{color:var(--brand-strong);font-size:12px;font-weight:600}
.char-bar-link:hover{text-decoration:underline}

/* 状态药丸文字加深（和 main.css 的 AA 修正一致，这里不重复定义颜色） */

.no-character{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px}
.no-character p{margin:0;color:var(--dim);font-size:14px}

@media(max-width:640px){
  .char-bar{flex-wrap:wrap;gap:8px;padding:10px 12px}
  .char-select{width:auto;min-width:0;flex:1 1 160px}
  .char-bar-note{display:none}
}
</style>
