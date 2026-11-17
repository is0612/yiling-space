<script setup lang="ts">
import SnapshotsWorkspace from "~/components/SnapshotsWorkspace.vue";

definePageMeta({
  topbar: {
    title: "阶段总结",
    crumbs: [{ label: "成长系统" }, { label: "记忆系统", to: "/growth/memory" }],
  },
});
</script>

<template>
  <SnapshotsWorkspace />
</template>
