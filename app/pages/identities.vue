<script setup lang="ts">
/** 兼容旧入口：好友管理已迁入成长系统，保留旧 URL 并带上原角色选择参数。 */
const route = useRoute();
await navigateTo(
  { path: "/growth/social/friends", query: route.query },
  { replace: true },
);
</script>
