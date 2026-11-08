<script setup lang="ts">
import SnapshotsWorkspace from "~/components/SnapshotsWorkspace.vue";

definePageMeta({
  topbar: { title: "阶段总结" },
});
</script>

<template>
  <SnapshotsWorkspace growth-mode />
</template>
