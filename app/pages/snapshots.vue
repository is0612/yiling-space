<script setup lang="ts">
/** 兼容旧收藏：阶段总结已迁入成长系统，保留角色、查询参数和页内位置。 */
const route = useRoute();
await navigateTo(
  { path: "/growth/memory/snapshots", query: route.query, hash: route.hash },
  { replace: true, redirectCode: 301 },
);
</script>
