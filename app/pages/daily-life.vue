<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Camera, Check, Plus, Refresh, VideoPlay } from "@element-plus/icons-vue";
import { createDailyLifeApi, type DailyLifeOverview, type DailyLifePlanItem, type DailyPhoto } from "~/api/daily-life";
import { readApiErrorMessage } from "~/utils/api-error";

definePageMeta({
  topbar: {
    title: "日常生活",
    crumbs: [{ label: "工作空间" }],
  },
});

await useCharacterListData();
const { id } = useCharacterSelection("/daily-life");
const characters = useCharacterList();
const currentCharacter = computed(() => characters.value.find(item => item.id === id.value) ?? null);
const api = createDailyLifeApi(useApiRequest());

function todayInDefaultZone() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

const dayKey = ref(todayInDefaultZone());
const overview = ref<DailyLifeOverview | null>(null);
const loading = ref(false);
const saving = ref(false);
const actingId = ref("");
const requestSeq = ref(0);
const planDialog = ref(false);
const planForm = reactive({
  lifeType: "FREE",
  summary: "",
  items: [{ title: "", detail: "", startTime: "09:00", endTime: "10:00", place: "", scene: "", outfitDescription: "", propsDescription: "" }],
});

const lifeTypes = [
  { label: "上班日", value: "WORKDAY" },
  { label: "休息日", value: "REST" },
  { label: "外出日", value: "OUTING" },
  { label: "宅家日", value: "HOME" },
  { label: "加班日", value: "OVERTIME" },
  { label: "自由日", value: "FREE" },
];

const photos = computed<DailyPhoto[]>(() => overview.value?.photos ?? []);
const photoUrl = (photoId: string) => `/api/characters/${encodeURIComponent(id.value)}/daily-life/photos/${encodeURIComponent(photoId)}`;

async function load() {
  const characterId = id.value;
  if (!characterId) { overview.value = null; return; }
  const seq = ++requestSeq.value;
  loading.value = true;
  try {
    const result = await api.getOverview(characterId, dayKey.value);
    if (seq === requestSeq.value && characterId === id.value) overview.value = result;
  } catch (error) {
    if (seq === requestSeq.value) ElMessage.error(readApiErrorMessage(error));
  } finally {
    if (seq === requestSeq.value) loading.value = false;
  }
}

function timestamp(time: string) {
  if (!time) return undefined;
  const value = new Date(`${dayKey.value}T${time}:00+08:00`);
  return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
}

function addPlanItem() {
  if (planForm.items.length >= 24) return;
  planForm.items.push({ title: "", detail: "", startTime: "12:00", endTime: "13:00", place: "", scene: "", outfitDescription: "", propsDescription: "" });
}
function removePlanItem(index: number) {
  if (planForm.items.length > 1) planForm.items.splice(index, 1);
}

async function savePlan() {
  if (!id.value) return;
  const items = planForm.items.filter(item => item.title.trim()).map(item => ({
    title: item.title.trim(),
    detail: item.detail,
    plannedStartAt: timestamp(item.startTime),
    plannedEndAt: timestamp(item.endTime),
    place: item.place,
    scene: item.scene,
    outfitDescription: item.outfitDescription,
    propsDescription: item.propsDescription,
  }));
  if (!items.length) { ElMessage.warning("至少填写一项活动。"); return; }
  saving.value = true;
  try {
    await api.createPlan(id.value, { dayKey: dayKey.value, timeZone: "Asia/Shanghai", lifeType: planForm.lifeType, summary: planForm.summary, items });
    planDialog.value = false;
    ElMessage.success("今天的生活计划已保存。");
    await load();
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error));
  } finally { saving.value = false; }
}

async function startPlanned(item: DailyLifePlanItem) {
  if (!id.value) return;
  actingId.value = item.id;
  try {
    await api.startActivity(id.value, { planItemId: item.id, source: "PLAN" });
    ElMessage.success("已记录这项活动开始。");
    await load();
  } catch (error) { ElMessage.error(readApiErrorMessage(error)); }
  finally { actingId.value = ""; }
}

async function startUnplanned() {
  if (!id.value) return;
  try {
    const title = window.prompt("现在想做什么？");
    if (!title?.trim()) return;
    await api.startActivity(id.value, { title: title.trim(), source: "USER_CONFIRMED" });
    ElMessage.success("已记录这项临时活动。");
    await load();
  } catch (error) { ElMessage.error(readApiErrorMessage(error)); }
}

async function completeCurrent() {
  if (!id.value || !overview.value?.currentActivity) return;
  const activity = overview.value.currentActivity;
  actingId.value = activity.id;
  try {
    await api.completeActivity(id.value, activity.id);
    ElMessage.success("这段经历已记录。");
    await load();
  } catch (error) { ElMessage.error(readApiErrorMessage(error)); }
  finally { actingId.value = ""; }
}

async function associate(photo: DailyPhoto, value: string) {
  if (!id.value) return;
  try {
    await api.associatePhoto(id.value, photo.id, value || null);
    ElMessage.success(value ? "照片已关联到这段活动。" : "已解除照片关联。");
    await load();
  } catch (error) { ElMessage.error(readApiErrorMessage(error)); }
}

function statusLabel(status: string) {
  return ({ PLANNED: "计划中", COMPLETED: "已完成", CANCELLED: "已取消", SKIPPED: "已跳过", CHANGED: "已调整",
    IN_PROGRESS: "进行中", GENERATED: "已生成", DELIVERY_PENDING: "发送结果待确认", DELIVERED: "已发送", DELIVERY_FAILED: "发送失败", GENERATION_FAILED: "生成失败" } as Record<string, string>)[status] ?? status;
}

watch([id, dayKey], () => { void load(); }, { immediate: true });
</script>

<template>
  <div class="daily-life-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">HER EVERYDAY</div>
        <h1>{{ currentCharacter?.name ?? "她" }}的日常</h1>
        <p>计划只是参考，真正发生的事才会成为经历。没有安排、没有拍照，也可以是完整的一天。</p>
      </div>
      <div class="heading-actions">
        <el-date-picker v-model="dayKey" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        <el-button :icon="Refresh" circle :loading="loading" aria-label="刷新" @click="load" />
      </div>
    </div>

    <el-empty v-if="!currentCharacter" description="先在左下角选择一个角色。" />
    <template v-else>
      <section class="current-card">
        <div class="section-top">
          <div>
            <div class="eyebrow">RIGHT NOW</div>
            <h2>此刻</h2>
          </div>
          <el-tag v-if="overview?.currentActivity" type="success">正在进行</el-tag>
        </div>
        <template v-if="overview?.currentActivity">
          <div class="current-title">{{ overview.currentActivity.title }}</div>
          <p>{{ overview.currentActivity.detail || "这段时间正在做这件事。" }}</p>
          <div class="meta-line">
            <span v-if="overview.currentActivity.place">{{ overview.currentActivity.place }}</span>
            <span>{{ new Date(overview.currentActivity.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }} 开始</span>
          </div>
          <el-button type="primary" :icon="Check" :loading="actingId === overview.currentActivity.id" @click="completeCurrent">结束这段活动</el-button>
        </template>
        <el-empty v-else :image-size="64" description="暂时没有正在进行的活动。" />
        <el-button v-if="!overview?.currentActivity" plain :icon="Plus" @click="startUnplanned">记录一件临时想做的事</el-button>
      </section>

      <section class="plan-card">
        <div class="section-top">
          <div>
            <div class="eyebrow">TODAY'S PLAN</div>
            <h2>今天的安排</h2>
          </div>
          <el-button v-if="!overview?.plan" type="primary" :icon="Plus" @click="planDialog = true">安排一天</el-button>
        </div>
        <template v-if="overview?.plan">
          <div class="plan-summary">
            <el-tag>{{ lifeTypes.find(item => item.value === overview?.plan?.lifeType)?.label ?? overview.plan.lifeType }}</el-tag>
            <span>{{ overview.plan.summary || "给今天留一点空间。" }}</span>
          </div>
          <div v-if="overview.plan.items.length" class="timeline">
            <article v-for="item in overview.plan.items" :key="item.id" class="timeline-item">
              <div class="timeline-time">
                {{ item.plannedStartAt ? new Date(item.plannedStartAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "随时" }}
              </div>
              <div class="timeline-content">
                <div class="timeline-title">{{ item.title }} <el-tag size="small" :type="item.status === 'COMPLETED' ? 'success' : 'info'">{{ statusLabel(item.status) }}</el-tag></div>
                <p v-if="item.detail">{{ item.detail }}</p>
                <div class="meta-line">
                  <span v-if="item.place">{{ item.place }}</span>
                  <span v-if="item.outfitDescription">穿着：{{ item.outfitDescription }}</span>
                  <span v-if="item.scene">场景：{{ item.scene }}</span>
                </div>
                <el-button v-if="item.status === 'PLANNED' && !overview.currentActivity" size="small" plain :icon="VideoPlay" :loading="actingId === item.id" @click="startPlanned(item)">开始这项活动</el-button>
              </div>
            </article>
          </div>
          <el-empty v-else :image-size="64" description="今天没有安排活动，也没关系。" />
        </template>
        <el-empty v-else :image-size="64" description="这一天还没有计划。可以安排，也可以随心而动。" />
      </section>

      <section class="lower-grid">
        <div class="list-card">
          <div class="section-top"><div><div class="eyebrow">LIFE TRACE</div><h2>最近的经历</h2></div></div>
          <div v-if="overview?.recentActivities.length" class="activity-list">
            <article v-for="activity in overview.recentActivities" :key="activity.id" class="activity-row">
              <div><strong>{{ activity.title }}</strong><p>{{ activity.detail || activity.place || "留下一段生活记录" }}</p></div>
              <el-tag size="small" :type="activity.status === 'COMPLETED' ? 'success' : 'info'">{{ statusLabel(activity.status) }}</el-tag>
            </article>
          </div>
          <el-empty v-else :image-size="56" description="还没有确认过的活动。" />
        </div>
        <div class="list-card">
          <div class="section-top"><div><div class="eyebrow">PHOTOGRAPHY</div><h2>最近的照片</h2></div><el-icon :size="20"><Camera /></el-icon></div>
          <div v-if="photos.length" class="photo-list">
            <article v-for="photo in photos" :key="photo.id" class="photo-row">
              <img class="photo-preview" :src="photoUrl(photo.id)" :alt="photo.caption || '日常照片'" loading="lazy">
              <div class="photo-copy">
                <strong>{{ photo.caption || "日常照片" }}</strong>
                <p>{{ photo.prompt }}</p>
                <div class="meta-line">{{ photo.provider }} · {{ photo.model }} · {{ photo.generationMode }} · {{ statusLabel(photo.status) }}</div>
                <el-select :model-value="photo.activityId ?? ''" size="small" clearable placeholder="关联一段经历" @change="value => associate(photo, String(value ?? ''))">
                  <el-option v-for="activity in overview?.recentActivities ?? []" :key="activity.id" :label="activity.title" :value="activity.id" />
                </el-select>
              </div>
            </article>
          </div>
          <el-empty v-else :image-size="56" description="还没有留下照片。拍照不是每天必须完成的事。" />
        </div>
      </section>
    </template>

    <el-dialog v-model="planDialog" title="给这一天留一点安排" width="min(760px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="今天是什么类型">
          <el-select v-model="planForm.lifeType" class="full-width">
            <el-option v-for="item in lifeTypes" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="今天大概想做什么">
          <el-input v-model="planForm.summary" maxlength="1000" placeholder="不用把时间排满，留点自由。" />
        </el-form-item>
        <div v-for="(item, index) in planForm.items" :key="index" class="plan-editor-item">
          <div class="editor-title"><strong>活动 {{ index + 1 }}</strong><el-button v-if="planForm.items.length > 1" text type="danger" @click="removePlanItem(index)">移除</el-button></div>
          <el-form-item label="活动名称"><el-input v-model="item.title" maxlength="160" placeholder="例如：去公园散步" /></el-form-item>
          <el-form-item label="简单描述"><el-input v-model="item.detail" type="textarea" :rows="2" maxlength="4000" /></el-form-item>
          <div class="time-row"><el-form-item label="开始"><el-time-picker v-model="item.startTime" format="HH:mm" value-format="HH:mm" /></el-form-item><el-form-item label="结束"><el-time-picker v-model="item.endTime" format="HH:mm" value-format="HH:mm" /></el-form-item></div>
          <el-form-item label="地点"><el-input v-model="item.place" maxlength="200" /></el-form-item>
          <el-form-item label="场景 / 穿着"><el-input v-model="item.scene" placeholder="场景" /><el-input v-model="item.outfitDescription" placeholder="穿着" /></el-form-item>
        </div>
        <el-button text :icon="Plus" @click="addPlanItem">再加一项</el-button>
      </el-form>
      <template #footer><el-button @click="planDialog = false">先不安排</el-button><el-button type="primary" :loading="saving" @click="savePlan">保存安排</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.daily-life-page { display: flex; flex-direction: column; gap: 20px; padding: 24px; color: var(--el-text-color-primary); }
.page-heading, .section-top, .heading-actions, .meta-line, .editor-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-heading { align-items: flex-end; }
.eyebrow { color: var(--el-text-color-secondary); font-size: 12px; letter-spacing: .12em; font-weight: 700; }
h1 { margin: 6px 0; font-size: 28px; }
h2 { margin: 4px 0 0; font-size: 19px; }
.page-heading p, .current-card p, .timeline-content p, .activity-row p, .photo-copy p { color: var(--el-text-color-secondary); margin: 6px 0 12px; }
.current-card, .plan-card, .list-card { background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 14px; padding: 20px; }
.current-card { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
.current-card .section-top { width: 100%; }
.current-title { font-size: 22px; font-weight: 650; }
.meta-line { justify-content: flex-start; flex-wrap: wrap; color: var(--el-text-color-secondary); font-size: 13px; }
.plan-summary { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
.timeline { display: flex; flex-direction: column; }
.timeline-item { display: grid; grid-template-columns: 72px 1fr; gap: 14px; padding: 16px 0; border-top: 1px solid var(--el-border-color-lighter); }
.timeline-time { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; padding-top: 3px; }
.timeline-title { display: flex; align-items: center; gap: 8px; font-weight: 650; }
.timeline-content { min-width: 0; }
.lower-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.activity-list, .photo-list { display: flex; flex-direction: column; }
.activity-row, .photo-row { display: flex; gap: 12px; padding: 14px 0; border-top: 1px solid var(--el-border-color-lighter); }
.activity-row { justify-content: space-between; }
.activity-row strong, .photo-copy strong { font-weight: 650; }
.photo-preview { width: 112px; height: 112px; flex: 0 0 112px; object-fit: cover; border-radius: 10px; background: var(--el-fill-color-light); }
.photo-copy { min-width: 0; display: flex; flex-direction: column; gap: 8px; flex: 1; }
.photo-copy p { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.photo-copy .el-select { max-width: 240px; }
.plan-editor-item { padding: 14px; margin: 12px 0; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; }
.editor-title { margin-bottom: 10px; }
.time-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.full-width { width: 100%; }
@media (max-width: 760px) { .daily-life-page { padding: 16px; } .page-heading { align-items: flex-start; flex-direction: column; } .lower-grid { grid-template-columns: 1fr; } .heading-actions { width: 100%; } }
</style>
