<script setup lang="ts">
/**
 * 一个助手的「模型覆写」面板。
 *
 * 记忆 / 语境 / 知识 / 关系评估四个助手字段完全一样（服务商、地址、Key、模型名 + 三个参数），
 * 只有标题和拉取模型的接口不同。之前它们分散在三个组件、五套几乎一样的表单里，
 * 改一处文案要改五遍，还容易漏。
 *
 * 交互上最重要的一条：**留空即跟随对话模型**。占位符直接把对话模型的值写出来
 * （"跟随对话模型：deepseek-chat"），而不是留一句"可留空"让人猜回落到哪。
 */
import { Promotion, QuestionFilled, Refresh, TopRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { MODEL_PROVIDERS, buildModelOptions, providerByBaseUrl, providerByKey } from "~/utils/model-catalog";

const props = withDefaults(defineProps<{
  title: string;
  hint: string;
  /** 对话模型的当前值：占位符用它们说明「留空会变成什么」 */
  chatModel: string;
  chatApiBaseUrl: string;
  chatApiKeyConfigured: boolean;
  /** 拉取模型清单的接口；不给就只显示内置清单 */
  modelsUrl?: string;
  /** 测试连接的接口；不给就不显示测试按钮（知识助手没有探针） */
  testUrl?: string;
  /**
   * 拉模型 / 测试前先落库：这两个接口都读服务端已存的配置，
   * 不先保存就会拿旧配置去请求，报错还指向上一版。
   */
  requestSave?: () => Promise<boolean>;
  /** 是否显示温度 / Token 参数 */
  showNumeric?: boolean;
  disabled?: boolean;
}>(), {
  modelsUrl: "",
  testUrl: "",
  requestSave: undefined,
  showNumeric: true,
  disabled: false,
});

const model = defineModel<string>("model", { required: true });
const apiBaseUrl = defineModel<string>("apiBaseUrl", { required: true });
const apiKey = defineModel<string>("apiKey", { required: true });
const temperature = defineModel<number>("temperature", { default: 0.3 });
const maxInputTokens = defineModel<number>("maxInputTokens", { default: 8192 });
const maxOutputTokens = defineModel<number>("maxOutputTokens", { default: 2048 });

const emit = defineEmits<{ (event: "busy-change", busy: boolean): void }>();

const parametersOpen = ref(false);
const fetching = ref(false);
const testing = ref(false);
const fetched = ref<string[]>([]);

const effectiveBaseUrl = computed(() => apiBaseUrl.value.trim() || props.chatApiBaseUrl);
const providerKey = computed(() => providerByBaseUrl(apiBaseUrl.value)?.key ?? "");
const providerPreset = computed(() => providerByBaseUrl(effectiveBaseUrl.value) ?? providerByKey(providerKey.value));
const consoleUrl = computed(() => providerPreset.value?.consoleUrl ?? "");
const providerLabel = computed(() => providerPreset.value?.name ?? "自定义");

const modelOptions = computed(() => buildModelOptions({
  baseUrl: effectiveBaseUrl.value,
  current: model.value,
  fetched: fetched.value,
}));

/** 地址变了，上一家拉回来的清单立刻作废 —— 别让下拉里留着调不通的名字。 */
watch(effectiveBaseUrl, () => { fetched.value = []; });

function applyProvider(key: string) {
  const preset = providerByKey(key);
  if (!preset?.baseUrl) return;
  apiBaseUrl.value = preset.baseUrl;
  const current = model.value.trim();
  const belongsToOther = MODEL_PROVIDERS.some(p => p.key !== key && p.models.includes(current));
  if (!current || belongsToOther) model.value = preset.models[0] ?? "";
}

async function fetchModels() {
  if (fetching.value || !props.modelsUrl) return;
  fetching.value = true;
  emit("busy-change", true);
  try {
    if (props.requestSave && !(await props.requestSave())) return;
    const result = await $fetch<{ ok: boolean; models: string[]; message: string }>(props.modelsUrl);
    if (result.ok) {
      fetched.value = result.models;
      ElMessage.success(result.message || `获取到 ${result.models.length} 个模型。`);
    } else {
      ElMessage.warning(result.message || "获取模型列表失败。");
    }
  } catch (error) {
    const message = (error as { data?: { statusMessage?: string } })?.data?.statusMessage
      || (error as Error)?.message
      || "获取模型列表失败。";
    ElMessage.error(message);
  } finally {
    fetching.value = false;
    emit("busy-change", false);
  }
}

async function testConnection() {
  if (testing.value || !props.testUrl) return;
  testing.value = true;
  emit("busy-change", true);
  try {
    if (props.requestSave && !(await props.requestSave())) return;
    const result = await $fetch<{ ok: boolean; message: string; elapsedMs?: number }>(props.testUrl, { method: "POST" });
    const suffix = result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : "";
    if (result.ok) ElMessage.success(result.message + suffix);
    else ElMessage.error(result.message || `${props.title}连通性测试失败。`);
  } catch (error) {
    const message = (error as { data?: { statusMessage?: string } })?.data?.statusMessage
      || (error as Error)?.message
      || `${props.title}连接测试失败。`;
    ElMessage.error(message);
  } finally {
    testing.value = false;
    emit("busy-change", false);
  }
}
</script>

<template>
  <section class="brick assistant-brick">
    <div class="brick-head">
      <div class="brick-head-txt">
        <div class="brick-heading">
          <h2 class="brick-title">
            {{ title }}
          </h2>
          <el-tooltip
            :content="hint"
            placement="top"
            :show-after="150"
          >
            <button
              type="button"
              class="help-trigger"
              :aria-label="`了解${title}`"
            >
              <el-icon><QuestionFilled /></el-icon>
            </button>
          </el-tooltip>
        </div>
      </div>
      <div class="head-actions">
        <el-button
          v-if="showNumeric"
          :disabled="disabled"
          @click="parametersOpen = true"
        >
          生成参数
        </el-button>
      </div>
    </div>

    <div class="fields">
      <div class="field">
        <div class="field-head">
          <span class="field-label">服务商</span>
        </div>
        <el-select
          :model-value="providerKey"
          class="field-ctl"
          :aria-label="`${title}服务商`"
          placeholder="选择服务商，自动填好 API 地址"
          :disabled="disabled"
          @update:model-value="applyProvider"
        >
          <el-option
            v-for="provider in MODEL_PROVIDERS"
            :key="provider.key"
            :label="provider.name"
            :value="provider.key"
          />
        </el-select>
      </div>

      <div class="field">
        <div class="field-head">
          <span class="field-label">API 地址</span>
          <a
            v-if="consoleUrl"
            class="field-link"
            :href="consoleUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            去 {{ providerLabel }} 开放平台取 Key
            <el-icon><TopRight /></el-icon>
          </a>
        </div>
        <el-input
          v-model="apiBaseUrl"
          maxlength="500"
          :aria-label="`${title} API 地址`"
          :placeholder="`跟随对话模型：${chatApiBaseUrl}`"
          :disabled="disabled"
        />
      </div>

      <div class="field">
        <div class="field-head">
          <span class="field-label">API Key</span>
          <span
            class="pill"
            :class="apiKey.trim() ? 'pill-green' : chatApiKeyConfigured && !apiBaseUrl.trim() ? 'pill-blue' : 'pill-rose'"
          >{{ apiKey.trim() ? "单独配置" : chatApiKeyConfigured && !apiBaseUrl.trim() ? "跟随对话模型" : "未配置" }}</span>
        </div>
        <ApiKeyInput
          v-model="apiKey"
          :aria-label="`${title} API Key`"
          :placeholder="chatApiKeyConfigured && !apiBaseUrl.trim()
            ? '留空 = 使用对话模型的 Key'
            : '填写这个助手专用的 API Key'"
          :disabled="disabled"
        />
        <p
          v-if="apiBaseUrl.trim() && !apiKey.trim()"
          class="field-hint"
        >
          填了单独的地址就必须配自己的 Key —— 拿对话模型那家的 Key 打别家只会 401。
        </p>
      </div>

      <div class="field">
        <div class="field-head">
          <span class="field-label">模型名称</span>
        </div>
        <div class="model-row">
          <el-select
            v-model="model"
            class="model-select"
            filterable
            allow-create
            default-first-option
            :aria-label="`${title}模型名称`"
            :placeholder="`跟随对话模型：${chatModel}`"
            :disabled="disabled"
          >
            <el-option
              v-for="item in modelOptions"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
          <el-button
            v-if="modelsUrl"
            :loading="fetching"
            :disabled="disabled || fetching"
            @click="fetchModels"
          >
            <el-icon><Refresh /></el-icon>{{ fetching ? "获取中…" : "获取模型" }}
          </el-button>
          <el-button
            v-if="testUrl"
            :loading="testing"
            :disabled="disabled || testing"
            @click="testConnection"
          >
            <el-icon><Promotion /></el-icon>{{ testing ? "测试中…" : "测试" }}
          </el-button>
        </div>
      </div>

      <slot />
    </div>
    <el-dialog
      v-model="parametersOpen"
      :title="`${title} · 生成参数`"
      width="min(560px, calc(100vw - 32px))"
      append-to-body
    >
      <div class="field field-row-3">
        <label class="field-mini">
          <span class="field-label">温度</span>
          <el-input-number
            v-model="temperature"
            :min="0"
            :max="2"
            :step="0.1"
            :disabled="disabled"
            controls-position="right"
          />
        </label>
        <label class="field-mini">
          <span class="field-label">最大输入 Token</span>
          <el-input-number
            v-model="maxInputTokens"
            :min="4096"
            :max="32768"
            :step="1024"
            :disabled="disabled"
            controls-position="right"
          />
        </label>
        <label class="field-mini">
          <span class="field-label">最大输出 Token</span>
          <el-input-number
            v-model="maxOutputTokens"
            :min="512"
            :max="8192"
            :step="256"
            :disabled="disabled"
            controls-position="right"
          />
        </label>
      </div>

      <template #footer>
        <div class="parameter-footer">
          <span>仅修改草稿，保存设置后生效。</span>
          <el-button
            type="primary"
            @click="parametersOpen = false"
          >
            完成
          </el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
/* Parent scoped form rules cannot reach this component's internal fields. */
.help-trigger { display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 4px; padding: 2px; background: transparent; color: var(--dim); font-size: 16px; cursor: help; }
.help-trigger:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.brick-head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.brick-head-txt { min-width: 0; flex: 1; }
.brick-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.brick-title { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; letter-spacing: -.01em; line-height: 1.4; }
.head-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; }
.fields { display: flex; min-width: 0; flex-direction: column; margin-top: 16px; gap: 16px; }
.field { display: flex; min-width: 0; flex-direction: column; gap: 8px; }
.field-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.field-label { color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; }
.field-link { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; border-radius: var(--radius-xs); color: var(--brand-strong); font-size: 12px; font-weight: 600; text-decoration: none; }
.field-link:hover { color: var(--brand-btn-h); text-decoration: underline; }
.field-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.field-link .el-icon { font-size: 13px; }
.field-ctl { width: 100%; }
.model-row { display: flex; width: 100%; align-items: center; gap: 8px; }
.model-select { min-width: 180px; flex: 1; }
.model-row > .el-button { flex: none; }
:deep(.el-button) { height: 36px; margin-left: 0; border-radius: var(--radius-sm); padding: 0 16px; font-size: 14px; font-weight: 600; }
:deep(.el-button .el-icon) { font-size: 14px; }
.field-mini :deep(.el-input-number) { width: 100%; }
.parameter-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.parameter-footer > span { color: var(--dim); font-size: 12px; line-height: 1.7; }
@media (max-width: 640px) {
  .brick-head { flex-wrap: wrap; }
  .model-row { flex-wrap: wrap; }
  .model-select { flex-basis: 100%; }
  .field-link { margin-left: 0; }
}

.field-hint {
  margin: 6px 0 0;
  color: var(--el-color-warning);
  font-size: 12px;
  line-height: 1.5;
}

.field-row-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.field-mini {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

@media (max-width: 720px) {
  .field-row-3 {
    grid-template-columns: 1fr;
  }
}
</style>
