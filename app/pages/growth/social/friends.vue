<script setup lang="ts">
definePageMeta({
  topbar: {
    title: "好友档案",
    crumbs: [{ label: "成长系统" }, { label: "社交系统", to: "/growth/social" }],
  },
});
</script>

<template>
  <SocialFriendsWorkspace />
</template>
