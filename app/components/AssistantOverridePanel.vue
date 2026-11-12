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
import { Refresh, TopRight } from "@element-plus/icons-vue";
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
  /** 是否显示「启用」开关（默认显示） */
  showEnabled?: boolean;
  /** 是否显示温度 / Token 参数 */
  showNumeric?: boolean;
  disabled?: boolean;
}>(), {
  modelsUrl: "",
  testUrl: "",
  requestSave: undefined,
  showEnabled: true,
  showNumeric: true,
  disabled: false,
});

const enabled = defineModel<boolean>("enabled", { default: true });
const model = defineModel<string>("model", { required: true });
const apiBaseUrl = defineModel<string>("apiBaseUrl", { required: true });
const apiKey = defineModel<string>("apiKey", { required: true });
const temperature = defineModel<number>("temperature", { default: 0.3 });
const maxInputTokens = defineModel<number>("maxInputTokens", { default: 8192 });
const maxOutputTokens = defineModel<number>("maxOutputTokens", { default: 2048 });

const emit = defineEmits<{ (event: "busy-change", busy: boolean): void }>();

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

/** 三个继承状态，页面上用一枚小徽标说清楚「现在实际用的是哪套」。 */
const inheritanceLabel = computed(() => {
  const parts: string[] = [];
  if (!model.value.trim()) parts.push("模型");
  if (!apiBaseUrl.value.trim()) parts.push("地址");
  if (!apiKey.value.trim() && props.chatApiKeyConfigured && !apiBaseUrl.value.trim()) parts.push("Key");
  if (!parts.length) return "";
  return `正在沿用对话模型的${parts.join(" / ")}`;
});

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
  <section
    class="brick assistant-brick"
    :class="{ 'is-off': showEnabled && !enabled }"
  >
    <div class="brick-head">
      <div class="brick-head-txt">
        <div class="brick-heading">
          <h2 class="brick-title">
            {{ title }}
          </h2>
          <span
            v-if="inheritanceLabel"
            class="pill pill-blue"
          >{{ inheritanceLabel }}</span>
        </div>
        <p class="brick-note">
          {{ hint }}
        </p>
      </div>
      <el-switch
        v-if="showEnabled"
        v-model="enabled"
        :disabled="disabled"
        :aria-label="`启用${title}`"
      />
    </div>

    <div
      v-if="!showEnabled || enabled"
      class="fields"
    >
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
            {{ testing ? "测试中…" : "测试" }}
          </el-button>
        </div>
      </div>

      <template v-if="showNumeric">
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
      </template>

      <slot />
    </div>
  </section>
</template>

<style scoped>
.assistant-brick.is-off {
  opacity: 0.6;
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
