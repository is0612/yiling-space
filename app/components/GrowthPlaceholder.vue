<script setup lang="ts">
/**
 * 成长系统各页的共用骨架。
 *
 * 标题归顶栏；这里负责说明和统一的当前角色上下文。
 * 各成长页不再自行解析 query / cookie，也不各自维护角色选择状态。
 * 具体业务数据仍由后续阶段按模块接入，本组件不预置业务结构。
 */
defineProps<{
  eyebrow: string;
  description?: string;
}>();

const route = useRoute();
const characters = useCharacterList();
const characterListError = useCharacterListError();
const { character: activeCharacter } = useCharacterSelection(route.path);

const unavailableMessage = computed(() => {
  if (characterListError.value) {
    return "暂时无法读取角色列表，请检查登录状态与数据库连接后重试。";
  }
  if (characters.value.length) {
    return "当前角色暂不可用，请从左下角重新选择角色。";
  }
  return "还没有角色。先创建一个角色，再开始记录成长。";
});
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :description="description"
    />

    <section
      v-if="activeCharacter"
      class="growth-character-context"
      aria-label="当前角色范围"
    >
      <el-avatar
        :size="38"
        class="growth-character-avatar"
      >
        {{ activeCharacter.avatar || activeCharacter.name.slice(0, 1) || "忆" }}
      </el-avatar>
      <div class="growth-character-copy">
        <span class="growth-character-label">当前角色</span>
        <strong>{{ activeCharacter.name }}</strong>
      </div>
      <span class="growth-character-note">本板块后续数据将按角色独立保存</span>
    </section>

    <div
      v-if="activeCharacter"
      class="card growth-blank"
    >
      <p class="muted-note">
        页面框架已就绪，内容与数据在后续阶段接入。
      </p>
    </div>
    <div
      v-else
      class="card growth-blank growth-blank-empty"
    >
      <p class="muted-note">
        {{ unavailableMessage }}
      </p>
      <NuxtLink
        to="/characters"
        class="card-link"
      >
        打开角色管理
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.growth-character-context {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0;
  padding: 12px 16px;
  border: 0;
  border-radius: 12px;
  background: var(--surface);
}
.growth-character-avatar {
  flex: none;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-weight: 700;
}
.growth-character-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.growth-character-label {
  color: var(--dim);
  font-size: 12px;
}
.growth-character-copy strong {
  color: var(--ink);
  font-size: 14px;
  font-weight: 650;
}
.growth-character-note {
  margin-left: auto;
  color: var(--dim);
  font-size: 12px;
}
.growth-blank { padding: 26px 22px; border: 0; border-radius: 12px; box-shadow: none; }
.growth-blank-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.growth-blank-empty p { margin: 0; }
@media (max-width: 640px) {
  .growth-character-context { align-items: flex-start; }
  .growth-character-note { width: 100%; margin-left: 50px; }
}
</style>
