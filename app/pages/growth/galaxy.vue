<script setup lang="ts">
import { ArrowRight, Close, Compass, Moon, Sunny } from "@element-plus/icons-vue";
import {
  galaxyEdgeKey, galaxyEdgePath, galaxyEdges, galaxyGrowthRoles, galaxyKinds, galaxyNodeIds, galaxyNodes, galaxySize,
  type GalaxyNodeId,
} from "~/utils/growth-galaxy";

definePageMeta({ topbar: { title: "成长星图", crumbs: [{ label: "成长系统" }] } });

const { character } = useCharacterSelection("/growth/galaxy");
const selected = ref<GalaxyNodeId | null>(null);
const hovered = ref<GalaxyNodeId | null>(null);
const focused = ref<GalaxyNodeId | null>(null);
const motionOff = ref(false);
const pageHidden = ref(false);
const detailPanel = ref<HTMLElement | null>(null);
const atlas = ref<HTMLElement | null>(null);
const preview = computed(() => hovered.value ?? focused.value);
const highlighted = computed(() => selected.value ?? preview.value);
const current = computed(() => selected.value ? galaxyNodes[selected.value] : null);
const connections = computed(() => [
  { label: "向外提供", empty: "星图暂无已收录的传出关系。", edges: galaxyEdges.filter(edge => edge.from === selected.value) },
  { label: "读取或接收", empty: "星图暂无已收录的传入关系。", edges: galaxyEdges.filter(edge => edge.to === selected.value) },
]);
const routes = galaxyEdges.map(edge => ({ ...edge, key: galaxyEdgeKey(edge.from, edge.to), path: galaxyEdgePath(edge) }));
const visibleRoutes = computed(() => routes.filter(edge => edge.from === selected.value || edge.to === selected.value));
// Draw from the faint tip to the bright head so overlapping samples read as one trail.
const lightTrail = Array.from({ length: 21 }, (_, index) => {
  const strength = index / 20;
  return { lag: (20 - index) * 0.008, radius: 0.45 + 2.75 * strength - 0.55 * strength ** 4, opacity: 0.06 + 0.94 * strength ** 1.7 };
});
const related = computed(() => new Set([highlighted.value, ...visibleRoutes.value.flatMap(edge => [edge.from, edge.to])]));
const nodeName = (id: GalaxyNodeId) => id === "core" ? character.value?.name || galaxyNodes.core.name : galaxyNodes[id].name;
const destination = computed(() => current.value && character.value
  ? { path: current.value.path, query: { c: character.value.id } }
  : null);

async function selectNode(id: GalaxyNodeId) {
  if (selected.value === id) {
    clearSelection();
    return;
  }
  selected.value = id;
  hovered.value = null;
  await nextTick();
  detailPanel.value?.focus({ preventScroll: true });
  if (window.matchMedia('(max-width: 760px)').matches) {
    detailPanel.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
}

function clearSelection() {
  const id = selected.value;
  selected.value = null;
  if (id) atlas.value?.querySelector<HTMLElement>(`.planet-${id}`)?.focus();
  hovered.value = null;
  focused.value = null;
}

function syncVisibility() {
  pageHidden.value = document.hidden;
}

onMounted(() => {
  syncVisibility();
  document.addEventListener("visibilitychange", syncVisibility);
});
onBeforeUnmount(() => document.removeEventListener("visibilitychange", syncVisibility));
</script>

<template>
  <main
    class="page-wrap galaxy-page"
    @keydown.esc="clearSelection"
  >
    <div
      class="galaxy-shell"
      :class="{ 'motion-paused': motionOff || pageHidden }"
    >
      <header class="galaxy-header">
        <div>
          <div class="kicker atlas-eyebrow">
            <el-icon><Compass /></el-icon> YILING SPACE <span> / </span> CELESTIAL ATLAS
          </div>
          <h1>成长星图</h1>
          <p>探索系统如何协作，以及一次互动如何影响下一次相遇。</p>
        </div>
        <el-button
          class="motion-button"
          :icon="motionOff ? Sunny : Moon"
          :aria-pressed="motionOff"
          @click="motionOff = !motionOff"
        >
          {{ motionOff ? '恢复动画' : '暂停动画' }}
        </el-button>
      </header>

      <div
        class="galaxy-layout"
        :class="{ 'is-exploring': selected }"
      >
        <section
          class="chart"
          aria-label="成长星图星系坐标"
        >
          <div
            ref="atlas"
            class="map"
            @pointerleave="hovered = null"
          >
            <svg
              class="space"
              :viewBox="`0 0 ${galaxySize.width} ${galaxySize.height}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <marker
                  v-for="(kind, key) in galaxyKinds"
                  :id="`galaxy-arrow-${key}`"
                  :key="key"
                  viewBox="0 0 8 8"
                  refX="6"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M1 1l5 3-5 3"
                    fill="none"
                    :stroke="kind.color"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </marker>
              </defs>
              <path
                v-for="edge in visibleRoutes"
                :key="edge.key"
                class="route route-active"
                :d="edge.path"
                :stroke="galaxyKinds[edge.kind].color"
                :stroke-dasharray="galaxyKinds[edge.kind].dash"
                :marker-end="`url(#galaxy-arrow-${edge.kind})`"
              />
              <g
                v-if="selected && !motionOff && !pageHidden"
                :key="selected"
                class="route-lights"
              >
                <g
                  v-for="(edge, index) in visibleRoutes"
                  :key="edge.key"
                  :fill="galaxyKinds[edge.kind].color"
                >
                  <circle
                    v-for="(sample, part) in lightTrail"
                    :key="part"
                    :r="sample.radius"
                    :fill-opacity="sample.opacity"
                    :class="{ 'route-light-head': part === lightTrail.length - 1 }"
                    opacity="0"
                  >
                    <animateMotion
                      :path="edge.path"
                      :begin="`${index * 0.17 + sample.lag}s`"
                      dur="3s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0;1;1;0"
                      keyTimes="0;0.1;0.88;1"
                      :begin="`${index * 0.17 + sample.lag}s`"
                      dur="3s"
                      repeatCount="indefinite"
                    />
                  </circle>
                </g>
              </g>
            </svg>
            <div
              v-for="id in galaxyNodeIds"
              :key="id"
              class="planet"
              :class="[`planet-${id}`, { 'is-active': highlighted === id, 'is-dim': highlighted && !related.has(id), 'is-selected': selected === id }]"
              :style="{ left: `${galaxyNodes[id].x / galaxySize.width * 100}%`, top: `${galaxyNodes[id].y / galaxySize.height * 100}%`, '--diameter': `${galaxyNodes[id].size / galaxySize.width * 100}cqw`, '--tone': galaxyNodes[id].color }"
              role="button"
              tabindex="0"
              :aria-label="`${nodeName(id)}，${galaxyNodes[id].description}`"
              :aria-pressed="selected === id"
              :aria-expanded="selected === id"
              :aria-controls="selected === id ? 'galaxy-detail' : undefined"
              @pointerenter="event => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') hovered = id }"
              @pointerleave="hovered = null"
              @focus="focused = id"
              @blur="focused = null"
              @click="selectNode(id)"
              @keydown.enter.self.prevent="!$event.repeat && selectNode(id)"
              @keydown.space.self.prevent
              @keyup.space.self.prevent="selectNode(id)"
            >
              <div
                class="planet-orb"
                aria-hidden="true"
              />
              <span class="planet-name">{{ id === 'core' ? character?.name || '忆灵空间' : galaxyNodes[id].planet }}<small
                v-if="id === 'core'"
                class="core-caption"
              >互动核心</small></span>
            </div>
          </div>
          <div
            class="chart-hint"
            aria-hidden="true"
          >
            <template v-if="preview && !selected">
              <strong>{{ nodeName(preview) }}</strong><span>{{ galaxyNodes[preview].description }}</span>
            </template>
            <template v-else>
              <strong>探索指引</strong><span>{{ selected ? '箭头从来源指向使用方；再次点击星球可返回全景。' : '悬停预览星球，点击查看它与其他系统的关系。' }}</span>
            </template>
          </div>
        </section>

        <Transition name="detail">
          <aside
            v-if="selected && current"
            id="galaxy-detail"
            ref="detailPanel"
            tabindex="-1"
            class="galaxy-detail"
            aria-label="系统关系详情"
            :style="{ '--detail-tone': current.color }"
          >
            <div class="detail-heading">
              <span class="kicker"><span class="detail-signal" /> {{ current.orbit }}</span>
              <el-button
                class="clear-button"
                circle
                text
                :icon="Close"
                aria-label="清除选中的星球"
                @click="clearSelection"
              />
            </div>
            <div aria-live="polite">
              <h2>{{ nodeName(selected) }}</h2>
              <p class="detail-description">
                {{ current.description }}
              </p>
            </div>
            <div class="details-body">
              <p class="growth-role">
                <strong>在成长中的作用</strong>{{ galaxyGrowthRoles[selected] }}
              </p>
              <div class="relationship-groups">
                <section
                  v-for="group in connections"
                  :key="group.label"
                >
                  <h3>{{ group.label }} <span>{{ group.edges.length }}</span></h3>
                  <ul
                    v-if="group.edges.length"
                    class="relationships"
                  >
                    <li
                      v-for="edge in group.edges"
                      :key="galaxyEdgeKey(edge.from, edge.to)"
                    >
                      <button
                        class="relationship"
                        type="button"
                        :style="{ '--edge-tone': galaxyKinds[edge.kind].color }"
                        @click="selectNode(edge.from === selected ? edge.to : edge.from)"
                      >
                        <span class="relation-heading"><strong>{{ nodeName(edge.from === selected ? edge.to : edge.from) }}</strong><span>{{ galaxyKinds[edge.kind].label }}</span></span>
                        <span class="relation-text">{{ edge.description }}</span>
                      </button>
                    </li>
                  </ul>
                  <p
                    v-else
                    class="empty-connections"
                  >
                    {{ group.empty }}
                  </p>
                </section>
              </div>
              <NuxtLink
                v-if="destination"
                class="system-link"
                :to="destination"
              >
                打开{{ selected === 'core' ? '聊天' : current?.name }} <el-icon><ArrowRight /></el-icon>
              </NuxtLink>
            </div>
          </aside>
        </Transition>
      </div>

      <footer
        class="galaxy-footer"
        aria-label="星图图例"
      >
        <span class="footer-title">连线图例</span>
        <span
          v-for="(kind, name) in galaxyKinds"
          :key="name"
          class="legend-item"
        >
          <svg
            width="32"
            height="10"
            viewBox="0 0 32 10"
            aria-hidden="true"
          ><path
            d="M1 5h24"
            :stroke="kind.color"
            :stroke-dasharray="kind.dash"
          /><path
            d="m24 2 5 3-5 3"
            fill="none"
            :stroke="kind.color"
          /></svg>
          {{ kind.label }}
        </span>
        <span class="footer-note">按需显示关系 · 箭头从来源指向使用方</span>
      </footer>
    </div>
  </main>
</template>

<style scoped src="~/assets/css/growth-galaxy.css"></style>
