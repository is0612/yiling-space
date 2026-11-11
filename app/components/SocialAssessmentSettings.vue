<script setup lang="ts">
import { MODEL_PURPOSE_DEFAULTS } from "#shared/utils/model-purpose-defaults";
import { ElMessage } from "element-plus";
import { MODEL_PROVIDERS, buildModelOptions, providerByBaseUrl, providerByKey } from "~/utils/model-catalog";

const props = defineProps<{ characterId: string; embedded?: boolean }>();

type CharacterSettings = {
  id: string;
  socialRelationshipAssessmentAssistantEnabled?: boolean;
  socialRelationshipAssessmentAssistantModel?: string;
  socialRelationshipAssessmentAssistantTemperature?: number;
  socialRelationshipAssessmentAssistantMaxInputTokens?: number;
  socialRelationshipAssessmentAssistantMaxOutputTokens?: number;
  socialRelationshipAssessmentAssistantApiBaseUrl?: string;
  socialRelationshipAssessmentAssistantApiKeyConfigured?: boolean;
  socialRelationshipAssessmentAssistantConfigured?: boolean;
};
const characterId = computed(() => props.characterId);
const character = ref<CharacterSettings | null>(null);
const loading = ref(false);
const saving = ref(false);
const fetchingModels = ref(false);
const testing = ref(false);
const model = ref("");
const apiBaseUrl = ref("");
const apiKey = ref("");
const providerKey = ref("custom");
const enabled = ref(false);
const temperature = ref<number>(MODEL_PURPOSE_DEFAULTS.social.temperature);
const maxInputTokens = ref<number>(MODEL_PURPOSE_DEFAULTS.social.maxInputTokens);
const maxOutputTokens = ref<number>(MODEL_PURPOSE_DEFAULTS.social.maxOutputTokens);
const models = ref<string[]>([]);

const savedDraft = ref("");
function draftSignature() { return JSON.stringify([model.value.trim(), apiBaseUrl.value.trim(), enabled.value, temperature.value, maxInputTokens.value, maxOutputTokens.value]); }
const hasUnsavedChanges = computed(() => Boolean(apiKey.value) || Boolean(savedDraft.value && draftSignature() !== savedDraft.value));
const busy = computed(() => saving.value || fetchingModels.value || testing.value);
defineExpose({ hasUnsavedChanges, busy });

let loadVersion = 0;
let roleVersion = 0;
let operationVersion = 0;
let modelFetchVersion = 0;
let testVersion = 0;
let pageDisposed = false;

const providerPreset = computed(() => providerByBaseUrl(apiBaseUrl.value) ?? providerByKey(providerKey.value));
const providerConsoleUrl = computed(() => providerPreset.value?.consoleUrl ?? "");
const providerLabel = computed(() => providerPreset.value?.name ?? "自定义");
const modelOptions = computed(() => buildModelOptions({ baseUrl: apiBaseUrl.value, current: model.value, fetched: models.value }));

function isCurrentRole(targetCharacterId: string, expectedRoleVersion: number): boolean {
  return !pageDisposed && characterId.value === targetCharacterId && roleVersion === expectedRoleVersion;
}

function resetRecommendedParameters() {
  temperature.value = MODEL_PURPOSE_DEFAULTS.social.temperature;
  maxInputTokens.value = MODEL_PURPOSE_DEFAULTS.social.maxInputTokens;
  maxOutputTokens.value = MODEL_PURPOSE_DEFAULTS.social.maxOutputTokens;
  ElMessage.success("已恢复本用途推荐参数，点击保存设置后生效。");
}

function resetDraft() {
  savedDraft.value = "";
  character.value = null;
  model.value = "";
  apiBaseUrl.value = "";
  apiKey.value = "";
  providerKey.value = "custom";
  enabled.value = false;
  temperature.value = MODEL_PURPOSE_DEFAULTS.social.temperature;
  maxInputTokens.value = MODEL_PURPOSE_DEFAULTS.social.maxInputTokens;
  maxOutputTokens.value = MODEL_PURPOSE_DEFAULTS.social.maxOutputTokens;
  models.value = [];
  loading.value = false;
  saving.value = false;
  fetchingModels.value = false;
  testing.value = false;
}

function applyProvider(key: string) {
  providerKey.value = key;
  const preset = providerByKey(key);
  if (!preset?.baseUrl) {
    models.value = [];
    return;
  }
  apiBaseUrl.value = preset.baseUrl;
  const current = model.value.trim();
  const belongsToAnotherProvider = MODEL_PROVIDERS.some(provider =>
    provider.key !== key && provider.models.includes(current),
  );
  if ((!current || belongsToAnotherProvider) && preset.models[0]) model.value = preset.models[0];
  models.value = [];
}

watch(apiBaseUrl, value => {
  providerKey.value = providerByBaseUrl(value)?.key ?? "custom";
  models.value = [];
});

async function load(targetCharacterId: string) {
  const currentLoad = ++loadVersion;
  const expectedRoleVersion = roleVersion;
  if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  loading.value = true;
  try {
    const data = await $fetch<CharacterSettings>(`/api/characters/${encodeURIComponent(targetCharacterId)}`);
    if (currentLoad !== loadVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    character.value = data;
    model.value = data.socialRelationshipAssessmentAssistantModel ?? "";
    apiBaseUrl.value = data.socialRelationshipAssessmentAssistantApiBaseUrl ?? "";
    providerKey.value = providerByBaseUrl(apiBaseUrl.value)?.key ?? "custom";
    enabled.value = data.socialRelationshipAssessmentAssistantEnabled === true;
    temperature.value = data.socialRelationshipAssessmentAssistantTemperature ?? MODEL_PURPOSE_DEFAULTS.social.temperature;
    maxInputTokens.value = data.socialRelationshipAssessmentAssistantMaxInputTokens ?? MODEL_PURPOSE_DEFAULTS.social.maxInputTokens;
    maxOutputTokens.value = data.socialRelationshipAssessmentAssistantMaxOutputTokens ?? MODEL_PURPOSE_DEFAULTS.social.maxOutputTokens;
    apiKey.value = "";
    models.value = [];
    savedDraft.value = draftSignature();
  } catch {
    if (currentLoad === loadVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      ElMessage.error("读取关系评估 AI 配置失败。");
    }
  } finally {
    if (currentLoad === loadVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) loading.value = false;
  }
}

watch(characterId, nextCharacterId => {
  roleVersion += 1;
  loadVersion += 1;
  operationVersion += 1;
  modelFetchVersion += 1;
  testVersion += 1;
  resetDraft();
  if (nextCharacterId) void load(nextCharacterId);
}, { immediate: true, flush: "sync" });

async function save(silent = false) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || saving.value || pageDisposed) return false;
  if (enabled.value && !model.value.trim()) {
    ElMessage.warning("启用关系评估 AI 前，请填写模型名称。");
    return false;
  }
  if (enabled.value && !apiBaseUrl.value.trim()) {
    ElMessage.warning("启用关系评估 AI 前，请填写独立 API 地址。");
    return false;
  }
  if (enabled.value && !apiKey.value.trim() && !character.value?.socialRelationshipAssessmentAssistantApiKeyConfigured) {
    ElMessage.warning("启用关系评估 AI 前，请先填写独立 API Key。");
    return false;
  }

  const currentOperation = ++operationVersion;
  const body = {
    socialRelationshipAssessmentAssistantEnabled: enabled.value,
    socialRelationshipAssessmentAssistantModel: model.value.trim(),
    socialRelationshipAssessmentAssistantApiBaseUrl: apiBaseUrl.value.trim(),
    socialRelationshipAssessmentAssistantApiKey: apiKey.value,
    socialRelationshipAssessmentAssistantTemperature: temperature.value,
    socialRelationshipAssessmentAssistantMaxInputTokens: maxInputTokens.value,
    socialRelationshipAssessmentAssistantMaxOutputTokens: maxOutputTokens.value,
  };
  const submittedDraft = draftSignature();
  const submittedKey = apiKey.value;
  saving.value = true;
  try {
    const data = await $fetch<CharacterSettings>(`/api/characters/${encodeURIComponent(targetCharacterId)}`, {
      method: "PATCH",
      body,
    });
    if (currentOperation !== operationVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return false;
    character.value = data;
    if (apiKey.value === submittedKey) apiKey.value = "";
    savedDraft.value = submittedDraft;
    if (!silent) ElMessage.success("关系评估 AI 配置已保存。");
    return true;
  } catch (error) {
    if (currentOperation !== operationVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return false;
    const e = error as { data?: { statusMessage?: string }; message?: string };
    ElMessage.error(e.data?.statusMessage || e.message || "保存关系评估 AI 配置失败。");
    return false;
  } finally {
    if (currentOperation === operationVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) saving.value = false;
  }
}

async function testConnection() {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  const currentTest = ++testVersion;
  if (!targetCharacterId || testing.value || saving.value || pageDisposed) return;
  if (!model.value.trim() || !apiBaseUrl.value.trim()) {
    ElMessage.warning("请先填写关系评估助手的模型名称和独立 API 地址。");
    return;
  }
  if (!apiKey.value.trim() && !character.value?.socialRelationshipAssessmentAssistantApiKeyConfigured) {
    ElMessage.warning("请先填写关系评估助手专用 API Key。");
    return;
  }
  if (!await save(true)) return;
  if (currentTest !== testVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  testing.value = true;
  try {
    const result = await $fetch<{ ok: boolean; message: string; model?: string }>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/social/assessment-test`,
      { method: "POST" },
    );
    if (currentTest !== testVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.warning(result.message);
  } catch (error) {
    if (currentTest !== testVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string }; message?: string };
    ElMessage.error(e.data?.statusMessage || e.message || "关系评估助手连接测试失败。");
  } finally {
    if (currentTest === testVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) testing.value = false;
  }
}

async function fetchModels() {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  const currentFetch = ++modelFetchVersion;
  if (!targetCharacterId || fetchingModels.value || pageDisposed) return;
  if (!await save(true)) return;
  if (currentFetch !== modelFetchVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  fetchingModels.value = true;
  try {
    const result = await $fetch<{ ok: boolean; models: string[]; message: string }>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/social/assessment-models`,
    );
    if (currentFetch !== modelFetchVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    models.value = result.models;
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.warning(result.message);
  } catch {
    if (currentFetch === modelFetchVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      ElMessage.error("获取关系评估模型列表失败。");
    }
  } finally {
    if (currentFetch === modelFetchVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) fetchingModels.value = false;
  }
}

onBeforeUnmount(() => {
  pageDisposed = true;
  roleVersion += 1;
  loadVersion += 1;
  operationVersion += 1;
  modelFetchVersion += 1;
  testVersion += 1;
});
</script>

<template>
  <div class="page-wrap assessment-settings">
    <PageHeader
      v-if="!props.embedded"
      description="为社交关系评估配置独立模型服务。API 地址与 Key 不继承任何其他助手的设置。"
    />
    <div class="settings-toolbar">
      <NuxtLink
        v-if="!props.embedded"
        :to="`/growth/social?c=${encodeURIComponent(characterId)}`"
      >
        ← 返回社交系统
      </NuxtLink>
      <span
        v-if="character?.socialRelationshipAssessmentAssistantApiKeyConfigured"
        class="saved-key"
      >独立 API Key 已加密保存</span>
      <span
        v-else
        class="missing-key"
      >尚未保存 API Key</span>
    </div>
    <section
      v-if="!characterId"
      class="settings-card"
    >
      请先在侧栏选择一个角色。
    </section>
    <section
      v-else
      class="settings-card"
    >
      <div class="settings-heading">
        <div><span class="eyebrow">SOCIAL RELATIONSHIP ASSESSMENT</span><h2>关系评估 AI</h2></div>
        <label class="switch-label"><input
          v-model="enabled"
          type="checkbox"
        > 启用评估配置</label>
      </div>
      <p class="hint">
        它读取当前角色的有效社交经历并生成建议。后台 Worker 已接入评估执行；AI 不会直接修改关系阶段或相处状态，采纳前会再次核验证据和关系版本。
      </p>
      <label>服务商</label>
      <select
        v-model="providerKey"
        @change="applyProvider(providerKey)"
      >
        <option
          v-for="provider in MODEL_PROVIDERS"
          :key="provider.key"
          :value="provider.key"
        >
          {{ provider.name }}
        </option>
      </select>
      <label>API 地址</label>
      <div class="model-row">
        <input
          v-model="apiBaseUrl"
          placeholder="https://api.example.com/v1"
        >
        <a
          v-if="providerConsoleUrl"
          :href="providerConsoleUrl"
          target="_blank"
          rel="noopener noreferrer"
        >去 {{ providerLabel }} 开放平台</a>
      </div>
      <label>独立 API Key</label>
      <input
        v-model="apiKey"
        type="password"
        autocomplete="new-password"
        placeholder="输入新 Key；留空表示保持已保存的 Key"
      >
      <p class="hint">
        Key 只在服务端加密保存。此处不会读取或回显原文，也不会回落到聊天、记忆、语境或知识助手的 Key。
      </p>
      <label>模型名称</label>
      <div class="model-row">
        <input
          v-model="model"
          list="assessment-model-list"
          placeholder="选择，或直接输入模型名"
        >
        <datalist id="assessment-model-list">
          <option
            v-for="name in modelOptions"
            :key="name"
            :value="name"
          />
        </datalist>
        <el-button
          :disabled="fetchingModels || saving || testing"
          @click="fetchModels"
        >
          {{ fetchingModels ? "获取中…" : "获取模型" }}
        </el-button>
      </div>
      <section
        class="parameter-section"
        aria-label="用途参数"
      >
        <div class="parameter-heading">
          <div><h3>用途参数</h3><p>根据有效经历评估关系变化，只提建议，由你确认是否采纳。</p></div>
          <el-button
            text
            :disabled="busy || loading"
            @click="resetRecommendedParameters"
          >
            恢复用途推荐
          </el-button>
        </div>
        <p class="parameter-recommendation">
          推荐温度 0.1、输入 16,384、输出 8,192。关系判断需要保留证据，也要为思考与结构化正文留出空间。
        </p>
        <div class="numeric-grid">
          <div>
            <label>温度</label><input
              v-model.number="temperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
            >
          </div>
          <div>
            <label>最大输入 Token</label><input
              v-model.number="maxInputTokens"
              type="number"
              min="4096"
              max="32768"
              step="1024"
            >
          </div>
          <div>
            <label>最大输出 Token</label><input
              v-model.number="maxOutputTokens"
              type="number"
              min="1024"
              max="32768"
              step="256"
            >
          </div>
        </div>
        <p class="hint">
          输出预算包含思考与正文，思考型模型可能用完 6144 Token 仍未输出正文。建议从 8192 开始，必要时调至 16384 或 32768（需服务商支持）；截断时系统最多提高预算重试一次，上限 32768。若服务商限制更低，请换非思考模型。提高预算也可能增加实际费用。
        </p>
      </section>
      <div class="actions">
        <el-button
          :disabled="saving || loading || testing || fetchingModels"
          @click="testConnection"
        >
          {{ testing ? "测试中…" : "测试连接" }}
        </el-button>
        <el-button
          type="primary"
          :disabled="saving || loading || testing"
          @click="save()"
        >
          {{ saving ? "保存中…" : "保存设置" }}
        </el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.parameter-section{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
.parameter-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.parameter-heading h3{margin:0;font-size:15px;color:var(--text)}
.parameter-heading p,.parameter-recommendation{margin:6px 0 0;color:var(--dim);font-size:13px;line-height:1.7}
.parameter-recommendation{padding:10px 12px;border-radius:8px;background:var(--surface-2)}
@media(max-width:650px){.parameter-heading{flex-wrap:wrap}}
.assessment-settings{display:flex;flex-direction:column;gap:16px}
.settings-toolbar{display:flex;align-items:center;justify-content:space-between;color:var(--dim);font-size:13px}
.settings-toolbar a{color:var(--accent);text-decoration:none}
.saved-key,.missing-key{font-size:12px}
.saved-key{color:var(--success,var(--accent))}
.missing-key{color:var(--dim)}
.settings-card{border:0;border-radius:12px;background:var(--surface);box-shadow:none;padding:24px;max-width:960px}
.settings-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
.eyebrow{font-size:12px;letter-spacing:.08em;color:var(--dim)}
h2{margin:5px 0 0;font-size:18px;color:var(--ink)}
.hint{color:var(--dim);font-size:13px;line-height:1.7;margin:10px 0 18px}
label{display:block;color:var(--ink);font-size:13px;margin:14px 0 7px}
input:not([type=checkbox]),select{width:100%;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:10px 12px;font:inherit}
.model-row{display:flex;gap:8px;align-items:center}
.model-row select,.model-row input{flex:1;min-width:0}
.model-row a{font-size:12px;color:var(--accent);white-space:nowrap}
button{border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:9px 13px;cursor:pointer;white-space:nowrap}
button:disabled{opacity:.55;cursor:not-allowed}
.switch-label{display:flex;align-items:center;gap:7px;margin:0;white-space:nowrap}
.numeric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}
button.primary{background:var(--accent);color:white;border-color:var(--accent);padding-inline:22px}
@media(max-width:650px){.numeric-grid{grid-template-columns:1fr}.settings-card{padding:16px}.settings-heading{align-items:flex-start;flex-direction:column}}
</style>
