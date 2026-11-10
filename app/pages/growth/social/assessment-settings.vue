<script setup lang="ts">
import { ElMessage } from "element-plus";
import { MODEL_PROVIDERS, buildModelOptions, providerByBaseUrl, providerByKey } from "~/utils/model-catalog";

definePageMeta({ topbar: { title: "关系评估 AI 设置" } });

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
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
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
const temperature = ref(0.1);
const maxInputTokens = ref(16384);
const maxOutputTokens = ref(4096);
const models = ref<string[]>([]);

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

function resetDraft() {
  character.value = null;
  model.value = "";
  apiBaseUrl.value = "";
  apiKey.value = "";
  providerKey.value = "custom";
  enabled.value = false;
  temperature.value = 0.1;
  maxInputTokens.value = 16384;
  maxOutputTokens.value = 4096;
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
    temperature.value = data.socialRelationshipAssessmentAssistantTemperature ?? 0.1;
    maxInputTokens.value = data.socialRelationshipAssessmentAssistantMaxInputTokens ?? 16384;
    maxOutputTokens.value = data.socialRelationshipAssessmentAssistantMaxOutputTokens ?? 4096;
    apiKey.value = "";
    models.value = [];
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
  saving.value = true;
  try {
    const data = await $fetch<CharacterSettings>(`/api/characters/${encodeURIComponent(targetCharacterId)}`, {
      method: "PATCH",
      body,
    });
    if (currentOperation !== operationVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return false;
    character.value = data;
    apiKey.value = "";
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
    <PageHeader eyebrow="成长系统 / 社交关系系统" description="为社交关系评估配置独立模型服务。API 地址与 Key 不继承任何其他助手的设置。" />
    <div class="settings-toolbar">
      <NuxtLink to="/growth/social">← 返回社交关系系统</NuxtLink>
      <span v-if="character?.socialRelationshipAssessmentAssistantApiKeyConfigured" class="saved-key">独立 API Key 已加密保存</span>
      <span v-else class="missing-key">尚未保存 API Key</span>
    </div>
    <section v-if="!characterId" class="settings-card">请先在侧栏选择一个角色。</section>
    <section v-else class="settings-card">
      <div class="settings-heading">
        <div><span class="eyebrow">SOCIAL RELATIONSHIP ASSESSMENT</span><h2>关系评估 AI</h2></div>
        <label class="switch-label"><input v-model="enabled" type="checkbox"> 启用评估配置</label>
      </div>
      <p class="hint">它只负责阅读系统挂接给本次评估的关系经历，并输出结构化建议。AI 不会直接修改关系阶段或相处状态；结果还要经过证据核验和关系版本保护。当前批次只接入配置，评估执行器将在后续批次上线。</p>
      <label>服务商</label>
      <select v-model="providerKey" @change="applyProvider(providerKey)">
        <option v-for="provider in MODEL_PROVIDERS" :key="provider.key" :value="provider.key">{{ provider.name }}</option>
      </select>
      <label>API 地址</label>
      <div class="model-row">
        <input v-model="apiBaseUrl" placeholder="https://api.example.com/v1">
        <a v-if="providerConsoleUrl" :href="providerConsoleUrl" target="_blank" rel="noopener noreferrer">去 {{ providerLabel }} 开放平台</a>
      </div>
      <label>独立 API Key</label>
      <input v-model="apiKey" type="password" autocomplete="new-password" placeholder="输入新 Key；留空表示保持已保存的 Key">
      <p class="hint">Key 只在服务端加密保存。此处不会读取或回显原文，也不会回落到聊天、记忆、语境或知识助手的 Key。</p>
      <label>模型名称</label>
      <div class="model-row">
        <input v-model="model" list="assessment-model-list" placeholder="选择，或直接输入模型名">
        <datalist id="assessment-model-list"><option v-for="name in modelOptions" :key="name" :value="name" /></datalist>
        <button type="button" :disabled="fetchingModels || saving || testing" @click="fetchModels">{{ fetchingModels ? "获取中…" : "获取模型" }}</button>
      </div>
      <div class="numeric-grid">
        <div><label>温度</label><input v-model.number="temperature" type="number" min="0" max="2" step="0.1"></div>
        <div><label>最大输入 Token</label><input v-model.number="maxInputTokens" type="number" min="4096" max="32768" step="1024"></div>
        <div><label>最大输出 Token</label><input v-model.number="maxOutputTokens" type="number" min="1024" max="8192" step="256"></div>
      </div>
      <p class="hint">「最大输出 Token」要把模型的思考过程一起算进去：思考型模型常常先花 1500~2000 tokens 才开始写正文，给 2048 会被截断成空回复。评估反复失败时先把这项调到 4096 以上，或换一个非思考模型。</p>
      <div class="actions">
        <button type="button" :disabled="saving || loading || testing || fetchingModels" @click="testConnection">{{ testing ? "测试中…" : "测试连接" }}</button>
        <button class="primary" type="button" :disabled="saving || loading || testing" @click="save()">{{ saving ? "保存中…" : "保存设置" }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.assessment-settings{display:flex;flex-direction:column;gap:16px}
.settings-toolbar{display:flex;align-items:center;justify-content:space-between;color:var(--dim);font-size:13px}
.settings-toolbar a{color:var(--accent);text-decoration:none}
.saved-key,.missing-key{font-size:12px}
.saved-key{color:var(--success,var(--accent))}
.missing-key{color:var(--dim)}
.settings-card{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:22px;max-width:820px}
.settings-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
.eyebrow{font-size:11px;letter-spacing:.08em;color:var(--dim)}
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
