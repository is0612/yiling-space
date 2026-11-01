<script setup lang="ts">
import { Calendar, InfoFilled, RefreshLeft, Lock, Select } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { initialCharacters, type Character } from "~/utils/mock-data";

type MemorySettings = {
  snapshotIntervalDays: number;
  activeSnapshotIntervalDays: number;
  pendingSnapshotIntervalDays: number | null;
  timezone: string;
  anchorAt: string;
  rawMessageRetentionDays: number;
  rawMessageCleanupEnabled: boolean;
  autoSnapshotEnabled: boolean;
  changePolicy: "NEXT_CYCLE" | "IMMEDIATE_RECALC";
  nextSnapshotAt: string | null;
  updatedAt: string;
};

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const character = ref<Character>({ ...initialCharacters[0]!, id: "", name: "角色加载中" });
const interval = ref(8);
const activeInterval = ref(8);
const pendingInterval = ref<number | null>(null);
const savedAnchorAt = ref<string | null>(null);
const savedTimezone = ref("Asia/Shanghai");
const savedAutoSnapshot = ref(false);
const timezone = ref("Asia/Shanghai");
const anchor = ref("2026-10-21T09:00:00");
const retention = ref(0);
const savedRetention = ref(0);
const savedRetentionCleanupEnabled = ref(false);
const autoSnapshot = ref(false);
const nextSnapshotAt = ref<string | null>(null);
const effectivePolicy = ref("下一个周期生效");
const loading = ref(true);
const saving = ref(false);
const safeInterval = computed(() => Math.min(365, Math.max(1, Number(interval.value) || 8)));

function formatAnchor(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function zonedInputToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("周期启用锚点无效。");
  const targetUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const displayedAsUtc = Date.UTC(
      values.year ?? Number(match[1]),
      (values.month ?? Number(match[2])) - 1,
      values.day ?? Number(match[3]),
      values.hour ?? Number(match[4]),
      values.minute ?? Number(match[5]),
      values.second ?? Number(match[6] || 0),
    );
    const difference = targetUtc - displayedAsUtc;
    candidate += difference;
    if (difference === 0) break;
  }
  return new Date(candidate).toISOString();
}

async function loadSettings() {
  loading.value = true;
  try {
    const [loadedCharacter, settings] = await Promise.all([
      $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`),
      $fetch<MemorySettings>(`/api/characters/${encodeURIComponent(id.value)}/memory-settings`),
    ]);
    character.value = loadedCharacter;
    interval.value = settings.snapshotIntervalDays;
    activeInterval.value = settings.activeSnapshotIntervalDays;
    pendingInterval.value = settings.pendingSnapshotIntervalDays;
    savedAnchorAt.value = settings.anchorAt;
    savedTimezone.value = settings.timezone;
    savedAutoSnapshot.value = settings.autoSnapshotEnabled;
    timezone.value = settings.timezone;
    anchor.value = formatAnchor(settings.anchorAt, settings.timezone);
    retention.value = settings.rawMessageRetentionDays;
    savedRetention.value = settings.rawMessageRetentionDays;
    savedRetentionCleanupEnabled.value = settings.rawMessageCleanupEnabled;
    autoSnapshot.value = settings.autoSnapshotEnabled;
    nextSnapshotAt.value = settings.nextSnapshotAt;
    effectivePolicy.value = settings.changePolicy === "IMMEDIATE_RECALC" ? "立即重算" : "下一个周期生效";
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "无法读取记忆设置，请确认数据库已初始化。";
    ElMessage.error(message);
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  const previousRetention = savedRetention.value;
  const nextRetention = Number(retention.value);
  const retentionBecomesMoreDestructive = nextRetention > 0 &&
    (!savedRetentionCleanupEnabled.value || (previousRetention > 0 && nextRetention < previousRetention));
  if (retentionBecomesMoreDestructive) {
    const archiveWarning = autoSnapshot.value
      ? ""
      : "\n\n注意：当前自动归档处于关闭状态，历史原文可能没有对应的阶段总结。";
    try {
      await ElMessageBox.confirm(
        `此设置会允许系统在下一次调度后排队删除超过 ${nextRetention} 天的原始消息。原文删除不可恢复；已有阶段总结、长期记忆和来源追溯记录会保留。${archiveWarning}\n\n确认启用该保留期限吗？`,
        "确认原始消息自动清理",
        {
          confirmButtonText: "确认并保存",
          cancelButtonText: "返回检查",
          type: "warning",
          distinguishCancelAndClose: true,
        },
      );
    } catch {
      return;
    }
  }

  saving.value = true;
  try {
    const anchorAt = zonedInputToIso(anchor.value, timezone.value);
    const saved = await $fetch<MemorySettings>(`/api/characters/${encodeURIComponent(id.value)}/memory-settings`, {
      method: "PATCH",
      body: {
        snapshotIntervalDays: safeInterval.value,
        timezone: timezone.value,
        anchorAt,
        rawMessageRetentionDays: retention.value,
        rawMessageCleanupEnabled: nextRetention > 0,
        autoSnapshotEnabled: autoSnapshot.value,
        changePolicy: effectivePolicy.value === "立即重算" ? "IMMEDIATE_RECALC" : "NEXT_CYCLE",
      },
    });
    interval.value = saved.snapshotIntervalDays;
    activeInterval.value = saved.activeSnapshotIntervalDays;
    pendingInterval.value = saved.pendingSnapshotIntervalDays;
    savedAnchorAt.value = saved.anchorAt;
    savedTimezone.value = saved.timezone;
    savedAutoSnapshot.value = saved.autoSnapshotEnabled;
    nextSnapshotAt.value = saved.nextSnapshotAt;
    retention.value = saved.rawMessageRetentionDays;
    savedRetention.value = saved.rawMessageRetentionDays;
    savedRetentionCleanupEnabled.value = saved.rawMessageCleanupEnabled;
    autoSnapshot.value = saved.autoSnapshotEnabled;
    anchor.value = formatAnchor(saved.anchorAt, saved.timezone);
    effectivePolicy.value = saved.changePolicy === "IMMEDIATE_RECALC" ? "立即重算" : "下一个周期生效";
    ElMessage.success("记忆周期设置已保存到本地数据库。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "保存失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    saving.value = false;
  }
}

function resetSettings() {
  interval.value = 8;
  timezone.value = "Asia/Shanghai";
  const now = new Date();
  anchor.value = formatAnchor(now.toISOString(), timezone.value);
  retention.value = 0;
  autoSnapshot.value = false;
  nextSnapshotAt.value = null;
  effectivePolicy.value = "下一个周期生效";
  ElMessage.info("已将表单恢复为默认值；点击“保存设置”后才会写入数据库。");
}

const nextSnapshotPreview = computed(() => {
  if (!autoSnapshot.value) return "未启用";
  try {
    const editedAnchorAt = zonedInputToIso(anchor.value, timezone.value);
    const anchorChanged = savedAnchorAt.value !== null && (
      timezone.value !== savedTimezone.value ||
      Math.floor(new Date(editedAnchorAt).getTime() / 1000) !==
        Math.floor(new Date(savedAnchorAt.value).getTime() / 1000)
    );
    const immediateRecalc = effectivePolicy.value === "立即重算";
    const formatPreview = (date: Date) => new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone.value,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(date);

    if (savedAutoSnapshot.value && nextSnapshotAt.value && !anchorChanged && !immediateRecalc) {
      const boundary = formatPreview(new Date(nextSnapshotAt.value));
      if (safeInterval.value !== activeInterval.value) {
        return `${boundary}（当前周期结束后切换为 ${safeInterval.value} 天）`;
      }
      if (pendingInterval.value !== null) {
        return `${boundary}（保存后将取消待生效的周期调整）`;
      }
      return boundary;
    }

    const next = new Date(new Date(editedAnchorAt).getTime() + safeInterval.value * 24 * 60 * 60 * 1000);
    return formatPreview(next);
  } catch {
    return "保存后计算";
  }
});

const savedNextSnapshotLabel = computed(() => {
  if (!nextSnapshotAt.value) return "尚未安排";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: savedTimezone.value,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(nextSnapshotAt.value));
  } catch {
    return nextSnapshotAt.value;
  }
});

onMounted(() => void loadSettings());
watch(id, () => void loadSettings());
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :eyebrow="'角色管理 / ' + character.name + ' / 记忆设置'"
      title="记忆周期设置"
      description="控制角色多久归档一次阶段记忆。设置保存到 PostgreSQL，由 Scheduler 生成到期任务，再由 Worker 调用角色模型完成 AI 提炼。"
      :back-to="'/memory?c=' + character.id"
      back-label="返回角色记忆"
    />

    <div class="settings-grid">
      <div>
        <section
          v-loading="loading"
          class="surface form-section"
        >
          <div class="settings-section-head">
            <div>
              <div class="form-title">
                自动归档规则 <span class="pill pill-purple">核心设置</span>
              </div><p class="section-description">
                每完成一个周期，就为这个记忆范围生成阶段总结。
              </p>
            </div><el-icon class="section-icon">
              <Calendar />
            </el-icon>
          </div>
          <div class="interval-box">
            <div class="interval-top">
              <div>
                <div class="interval-label">
                  归档间隔
                </div><p class="form-help">
                  周期可设为 1–365 天；默认值为 8 天。
                </p>
              </div><div class="interval-input">
                <el-input-number
                  v-model="interval"
                  :min="1"
                  :max="365"
                  :controls="true"
                  size="large"
                /><span>天 / 次</span>
              </div>
            </div>
            <el-slider
              v-model="interval"
              :min="1"
              :max="30"
              :show-tooltip="true"
            />
            <div class="slider-labels">
              <span>1 天</span><span>15 天</span><span>30 天</span>
            </div>
            <div class="quick-days">
              <button
                v-for="day in [1, 3, 7, 8, 14, 30]"
                :key="day"
                type="button"
                class="chip"
                :class="{ on: safeInterval === day }"
                @click="interval = day"
              >
                {{ day }} 天
              </button>
            </div>
          </div>
          <el-form
            label-position="top"
            style="margin-top:24px"
          >
            <div class="form-grid">
              <el-form-item label="记忆时区">
                <el-select
                  v-model="timezone"
                  style="width:100%"
                >
                  <el-option
                    label="中国标准时间（Asia/Shanghai）"
                    value="Asia/Shanghai"
                  /><el-option
                    label="协调世界时（UTC）"
                    value="UTC"
                  /><el-option
                    label="美国太平洋时间（America/Los_Angeles）"
                    value="America/Los_Angeles"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="周期启用锚点">
                <el-date-picker
                  v-model="anchor"
                  type="datetime"
                  value-format="YYYY-MM-DDTHH:mm:ss"
                  placeholder="选择周期起始时间"
                  style="width:100%"
                />
              </el-form-item>
              <el-form-item label="原始消息保留期限">
                <el-select
                  v-model="retention"
                  style="width:100%"
                >
                  <el-option
                    label="30 天"
                    :value="30"
                  /><el-option
                    label="90 天"
                    :value="90"
                  /><el-option
                    label="180 天"
                    :value="180"
                  /><el-option
                    label="永久保留"
                    :value="0"
                  />
                </el-select><div class="form-help">
                  {{ Number(retention) === 0 ? "永久保留；保存后不会再排入原始消息清理任务。" : savedRetentionCleanupEnabled ? "自动清理已获授权；缩短保留期时会再次要求确认。较早的归档任务尚未完成时，Worker 会延后清理。" : "当前期限仅为配置，自动清理尚未获授权。保存时需要明确确认；未确认前不会排入清理任务。" }}
                </div>
                <div class="form-help">
                  分层保留：她看过但没开口的「上下文」消息只保留 7 天（期限填得比 7 天更短时以你的设置为准）；她回过话、或被点名的那部分才按上面的期限保留。
                </div>
              </el-form-item>
              <el-form-item label="修改何时生效">
                <el-radio-group v-model="effectivePolicy">
                  <el-radio value="下一个周期生效">
                    下一个周期
                  </el-radio><el-radio value="立即重算">
                    立即重算
                  </el-radio>
                </el-radio-group><div class="form-help">
                  下一个周期：保留当前已安排的周期边界，新间隔在该周期结束后生效。修改时区或启用锚点会重设计划。立即重算：按当前锚点和新间隔重新计算下次边界。
                </div>
              </el-form-item>
            </div>
          </el-form>
          <el-divider />
          <div class="toggle-row">
            <div>
              <strong>自动生成阶段总结</strong><p class="form-help">
                关闭后保留历史归档，停止自动生成新的阶段总结。
              </p>
            </div><el-switch v-model="autoSnapshot" />
          </div>
          <div class="form-actions">
            <button
              type="button"
              class="btn"
              @click="resetSettings"
            >
              <el-icon><RefreshLeft /></el-icon>恢复默认
            </button>
            <button
              type="button"
              class="btn primary"
              :disabled="saving"
              @click="saveSettings"
            >
              <el-icon><Select /></el-icon>{{ saving ? "保存中…" : "保存设置" }}
            </button>
          </div>
        </section>
      </div>

      <aside class="settings-side">
        <section class="surface panel">
          <div class="side-icon">
            <el-icon><Lock /></el-icon>
          </div>
          <h2 class="section-heading">
            记忆与归档说明
          </h2>
          <p class="section-description side-desc">
            这些规则影响角色如何归档阶段经历，不会自动清理历史归档。
          </p>
          <div class="rule-item">
            <span class="rule-number">01</span><div><strong>阶段总结记录的是一段时间</strong><p>每隔 N 天生成一份总结，不代表只保留最近 N 天的消息。</p></div>
          </div>
          <div class="rule-item">
            <span class="rule-number">02</span><div><strong>历史版本不会覆盖</strong><p>手动重新生成会产生新版本，旧版本仍可查看与追溯。</p></div>
          </div>
          <div class="rule-item">
            <span class="rule-number">03</span><div><strong>时区影响计划时间</strong><p>计划会基于角色设定的时区和启用锚点计算。</p></div>
          </div>
        </section>
        <section class="surface panel side-panel">
          <div class="card-head">
            <h2>当前计划预览</h2>
            <span class="sub">保存后写入数据库</span>
          </div>
          <div class="metric-row">
            <span>当前选择间隔</span><span class="metric-value">{{ safeInterval }} 天</span>
          </div>
          <div
            v-if="autoSnapshot && savedAutoSnapshot && pendingInterval !== null"
            class="metric-row"
          >
            <span>当前周期安排</span><span class="metric-value">现为 {{ activeInterval }} 天，下一边界后 {{ pendingInterval }} 天</span>
          </div>
          <div class="metric-row">
            <span>执行状态</span><span
              class="pill"
              :class="autoSnapshot ? 'pill-green' : 'pill-gray'"
            >{{ autoSnapshot ? '自动归档开启' : '自动归档已暂停' }}</span>
          </div>
          <div class="metric-row">
            <span>生效策略</span><span class="metric-value">{{ effectivePolicy }}</span>
          </div>
          <div class="metric-row">
            <span>下次归档（按当前表单）</span><span class="metric-value">{{ nextSnapshotPreview }}</span>
          </div>
          <div class="metric-row">
            <span>数据库中的计划时间</span><span class="metric-value">{{ savedNextSnapshotLabel }}</span>
          </div>
          <div class="info-callout side-callout">
            <el-icon><InfoFilled /></el-icon><span>计划时间以角色时区计算。要自动执行，请保持 Scheduler 与 Worker 进程运行；如果没有配置角色模型 API，任务会保留在队列中，不会被丢弃。</span>
          </div>
        </section>
      </aside>
    </div>
    <p class="footer-note">
      记忆周期、时区、锚点与原始消息保留期限已写入数据库。清理任务会删除截止时间之前的原始消息，并保留阶段总结与来源追溯记录。
    </p>
  </div>
</template>

<style scoped>
/* 这两个现在是 main.css 里的契约：`.settings-grid` 以前只在本文件写了 scoped 版本，
   表情包页引用它拿不到样式（两栏退化成上下堆叠），所以提上去和大家共用。
   要改形状就在本文件 scoped 里覆盖列宽，别再回到「只在某个页面里定义」。 */
.form-title{display:flex;align-items:center;gap:9px;color:var(--text);font-size:14px;font-weight:700}
.section-icon{color:var(--brand);font-size:18px}

/* 间隔选择块：品牌浅底 + 一行 chip 快捷选择 */
.interval-box{margin-top:20px;border:1px solid var(--brand-line);border-radius:var(--radius);background:var(--brand-soft);padding:16px 18px}
.interval-top{display:flex;align-items:center;justify-content:space-between;gap:15px}
.interval-label{color:var(--brand-strong);font-size:12px;font-weight:700}
.interval-input{display:flex;align-items:center;gap:10px}
.interval-input span{color:var(--dim);font-size:12px;font-weight:600}
.slider-labels{display:flex;justify-content:space-between;margin-top:-6px;color:var(--faint);font-size:12px}
.quick-days{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0}
/* 粉色底上用品牌实色作为选中态，比黑底更协调 */
.quick-days .chip.on{border-color:var(--brand-btn);background:var(--brand-btn);color:#fff}

.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}
.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:8px 0}
.toggle-row strong{color:var(--text-2);font-size:14px;font-weight:600}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}

.settings-side{display:flex;flex-direction:column;gap:16px}
.settings-side .panel{padding:18px 20px}
.side-icon{display:flex;width:36px;height:36px;align-items:center;justify-content:center;margin-bottom:12px;border-radius:var(--radius);background:var(--brand-soft);color:var(--brand);font-size:18px}
.side-desc{margin-top:8px}
.card-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.card-head h2{margin:0;color:var(--text-2);font-size:14px;font-weight:700}
.card-head .sub{color:var(--faint);font:400 12px/1 Consolas,monospace}
.side-callout{margin-top:14px}

.rule-item{display:flex;gap:10px;margin-top:18px}
.rule-number{display:flex;width:24px;height:24px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:var(--brand-soft);color:var(--brand-strong);font-size:12px;font-weight:700}
.rule-item strong{color:var(--text-2);font-size:12px;font-weight:600}
.rule-item p{margin-top:4px;color:var(--dim);font-size:12px;line-height:1.8}

@media(max-width:1050px){.settings-grid{grid-template-columns:1fr}.settings-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}}
@media(max-width:640px){.form-grid{grid-template-columns:1fr}.settings-side{grid-template-columns:1fr}.interval-top{align-items:flex-start;flex-direction:column}}
</style>
