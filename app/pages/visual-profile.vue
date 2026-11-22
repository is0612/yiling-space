<script setup lang="ts">
import { Picture, User, Files, EditPen } from "@element-plus/icons-vue";

definePageMeta({
  topbar: {
    title: "形象档案",
    crumbs: [{ label: "工作空间" }],
  },
});

const sections = [
  {
    title: "核心形象",
    description: "保存稳定的外貌特征：发色、眼睛、发型、体型与鲸鱼元素。",
    icon: User,
  },
  {
    title: "三视图与参考素材",
    description: "管理正面、侧面、背面设定图，以及表情、配饰和服装参考图。",
    icon: Picture,
  },
  {
    title: "绘图提示词",
    description: "分别维护基础提示词、负面提示词和可组合的场景描述。",
    icon: EditPen,
  },
  {
    title: "版本管理",
    description: "草稿修改不覆盖当前正式形象；经确认后再发布为新版本。",
    icon: Files,
  },
];
</script>

<template>
  <div class="page-container visual-profile-page">
    <section class="page-intro">
      <div class="page-eyebrow">CHARACTER VISUAL IDENTITY</div>
      <h2>让她每次画自己，都还是她自己。</h2>
      <p>形象档案独立保存角色的视觉身份，为绘图 API 提供稳定的参考资料。它不替代角色设定，也不把每次生成结果自动写成正式形象。</p>
    </section>

    <el-alert
      title="形象档案正在搭建"
      description="当前先确定资料结构与管理边界。下一步接入角色级持久化、图片上传和绘图调用；在正式保存链路完成前，不会把浏览器临时数据冒充成已保存档案。"
      type="info"
      :closable="false"
      show-icon
    />

    <div class="visual-profile-grid">
      <el-card
        v-for="item in sections"
        :key="item.title"
        shadow="never"
        class="visual-profile-card"
      >
        <div class="visual-profile-card-icon">
          <el-icon :size="22"><component :is="item.icon" /></el-icon>
        </div>
        <h3>{{ item.title }}</h3>
        <p>{{ item.description }}</p>
      </el-card>
    </div>

    <el-card shadow="never" class="visual-profile-principle">
      <h3>资料管理原则</h3>
      <ul>
        <li>每份档案归属于当前选中的角色，不同角色之间严格隔离。</li>
        <li>核心外貌与服装造型分开维护，换装不改变角色本身。</li>
        <li>三视图是结构参考，标准形象图是视觉参考，两者用途不同。</li>
        <li>生成图片只能作为候选素材，不能未经确认覆盖正式版本。</li>
      </ul>
    </el-card>
  </div>
</template>

<style scoped>
.visual-profile-page { display: grid; gap: 20px; }
.page-intro { padding: 8px 2px 4px; }
.page-eyebrow { color: var(--el-color-primary); font-size: 11px; font-weight: 700; letter-spacing: .14em; }
.page-intro h2 { margin: 10px 0; font-size: 25px; color: var(--el-text-color-primary); }
.page-intro p { max-width: 760px; margin: 0; color: var(--el-text-color-secondary); line-height: 1.8; }
.visual-profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.visual-profile-card { min-height: 156px; }
.visual-profile-card-icon { color: var(--el-color-primary); }
.visual-profile-card h3, .visual-profile-principle h3 { margin: 12px 0 8px; font-size: 16px; }
.visual-profile-card p { margin: 0; color: var(--el-text-color-secondary); line-height: 1.7; }
.visual-profile-principle ul { margin: 8px 0 0; padding-left: 20px; color: var(--el-text-color-secondary); line-height: 2; }
@media (max-width: 720px) { .visual-profile-grid { grid-template-columns: 1fr; } }
</style>
