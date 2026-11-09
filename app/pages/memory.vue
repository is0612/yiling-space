<script setup lang="ts">
/** 兼容旧收藏：记忆查看入口统一归属成长系统，保留角色与其他查询参数。 */
const route = useRoute();
await navigateTo(
  { path: "/growth/memory/long-term", query: route.query, hash: route.hash },
  { replace: true, redirectCode: 301 },
);
</script>
