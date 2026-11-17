<script setup lang="ts">
// 标题与面包屑放顶栏（AppShell 读 route.meta.topbar）
definePageMeta({
  topbar: {
    title: "状态系统",
    crumbs: [{ label: "成长系统" }],
  },
});
</script>

<template>
  <GrowthPlaceholder
    description="她此刻的情绪与状态，以及状态怎样随时间变化。"
  />
</template>
