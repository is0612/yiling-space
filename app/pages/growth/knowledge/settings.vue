<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "知识处理助手设置" } });

type CharacterSettings = {
  id: string;
  knowledgeAutoCollectEnabled?: boolean;
  knowledgeAssistantEnabled?: boolean;
  knowledgeAssistantModel?: string;
  knowledgeAssistantTemperature?: number;
  knowledgeAssistantMaxInputTokens?: number;
  knowledgeAssistantMaxOutputTokens?: number;
  knowledgeAssistantApiBaseUrl?: string;
  knowledgeAssistantApiKeyConfigured?: boolean;
  updatedAt?: string;
};
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const loading = ref(false);
const saving = ref(false);
const fetchingModels = ref(false);
const character = ref<CharacterSettings | null>(null);
const model = ref("");
const apiBaseUrl = ref("");
const apiKey = ref("");
const enabled = ref(false);
const autoCollectEnabled = ref(false);
const temperature = ref(0.1);
const maxInputTokens = ref(12288);
const maxOutputTokens = ref(2048);
const models = ref<string[]>([]);

async function load() {
  if (!characterId.value) { character.value = null; return; }
  loading.value = true;
  try {
    const data = await $fetch<CharacterSettings>(`/api/characters/${encodeURIComponent(characterId.value)}`);
    character.value = data;
    model.value = data.knowledgeAssistantModel ?? "";
    apiBaseUrl.value = data.knowledgeAssistantApiBaseUrl ?? "";
    enabled.value = data.knowledgeAssistantEnabled === true;
    autoCollectEnabled.value = data.knowledgeAutoCollectEnabled === true;
    temperature.value = data.knowledgeAssistantTemperature ?? 0.1;
    maxInputTokens.value = data.knowledgeAssistantMaxInputTokens ?? 12288;
    maxOutputTokens.value = data.knowledgeAssistantMaxOutputTokens ?? 2048;
    apiKey.value = "";
    models.value = [];
  } catch {
    ElMessage.error("读取知识处理助手配置失败。");
  } finally { loading.value = false; }
}
watch(characterId, () => { void load(); }, { immediate: true });

async function save(silent = false) {
  if (!characterId.value || saving.value) return false;
  if (enabled.value && !model.value.trim()) { ElMessage.warning("启用知识处理助手前，请填写模型名称。"); return false; }
  saving.value = true;
  try {
    const data = await $fetch<CharacterSettings>(`/api/characters/${encodeURIComponent(characterId.value)}`, {
      method: "PATCH",
      body: {
        knowledgeAutoCollectEnabled: autoCollectEnabled.value,
        knowledgeAssistantEnabled: enabled.value,
        knowledgeAssistantModel: model.value.trim(),
        knowledgeAssistantApiBaseUrl: apiBaseUrl.value.trim(),
        knowledgeAssistantApiKey: apiKey.value,
        knowledgeAssistantTemperature: temperature.value,
        knowledgeAssistantMaxInputTokens: maxInputTokens.value,
        knowledgeAssistantMaxOutputTokens: maxOutputTokens.value,
      },
    });
    character.value = data;
    apiKey.value = "";
    if (!silent) ElMessage.success("知识处理助手设置已保存。");
    return true;
  } catch (error) {
    const e = error as { data?: { statusMessage?: string }; message?: string };
    ElMessage.error(e.data?.statusMessage || e.message || "保存失败。");
    return false;
  } finally { saving.value = false; }
}

async function fetchModels() {
  if (!await save(true)) return;
  fetchingModels.value = true;
  try {
    const result = await $fetch<{ ok: boolean; models: string[]; message: string }>(
      `/api/characters/${encodeURIComponent(characterId.value)}/growth/knowledge/models`,
    );
    models.value = result.models;
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.warning(result.message);
  } catch { ElMessage.error("获取模型列表失败。"); }
  finally { fetchingModels.value = false; }
}
</script>

<template>
  <div class="page-wrap knowledge-settings">
    <PageHeader eyebrow="成长系统 / 知识系统" description="为知识整理配置独立模型。这里的 API Key 不会与聊天模型、记忆助手或语境助手共用。" />
    <div class="settings-toolbar">
      <NuxtLink :to="`/growth/knowledge?c=${characterId}`">← 返回知识系统</NuxtLink>
      <span v-if="character?.knowledgeAssistantApiKeyConfigured" class="saved-key">独立 API Key 已加密保存</span>
      <span v-else class="missing-key">尚未保存 API Key</span>
    </div>
    <section v-if="!characterId" class="settings-card">请先在侧栏选择一个角色。</section>
    <section v-else class="settings-card">
      <div class="settings-heading">
        <div><span class="eyebrow">KNOWLEDGE ASSISTANT</span><h2>知识处理助手</h2></div>
        <label class="switch-label"><input v-model="enabled" type="checkbox"> 启用助手</label>
      </div>
      <p class="hint">助手负责判断候选是否值得保存、整理内容、识别重复与冲突。处理结果先进入待确认，不会自行写入正式知识库。</p>
      <div class="collection-option">
        <label class="switch-label"><input v-model="autoCollectEnabled" type="checkbox"> 从聊天中自动发现知识候选</label>
        <p class="hint">开启后，群聊由群聊语境分析发现候选；好友私聊会先经过本地规则筛选，仅对可能有知识价值的内容调用私聊分析。候选原文进入候选箱，不会自动处理或入库。关闭时仍可手动添加候选。</p>
      </div>
      <label>模型名称</label>
      <div class="model-row">
        <input v-model="model" list="knowledge-model-list" placeholder="例如 deepseek-chat">
        <datalist id="knowledge-model-list"><option v-for="name in models" :key="name" :value="name" /></datalist>
        <button type="button" :disabled="fetchingModels || saving" @click="fetchModels">{{ fetchingModels ? "获取中…" : "获取模型" }}</button>
      </div>
      <label>API 地址（留空时沿用角色聊天 API 地址）</label>
      <input v-model="apiBaseUrl" placeholder="https://api.example.com/v1">
      <label>独立 API Key</label>
      <input v-model="apiKey" type="password" autocomplete="new-password" placeholder="输入新 Key；留空表示保持已保存的 Key">
      <div class="hint">Key 仅在服务端加密保存，页面不会读取或回显原文。更换服务商时请填写对应服务商的 Key。</div>
      <div class="numeric-grid">
        <div><label>温度</label><input v-model.number="temperature" type="number" min="0" max="2" step="0.1"></div>
        <div><label>最大输入 Token</label><input v-model.number="maxInputTokens" type="number" min="4096" max="32768" step="1024"></div>
        <div><label>最大输出 Token</label><input v-model.number="maxOutputTokens" type="number" min="512" max="8192" step="256"></div>
      </div>
      <div class="actions">
        <button class="primary" type="button" :disabled="saving || loading" @click="save()">{{ saving ? "保存中…" : "保存设置" }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.knowledge-settings{display:flex;flex-direction:column;gap:16px}
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
input:not([type=checkbox]){width:100%;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:10px 12px;font:inherit}
.model-row{display:flex;gap:8px}
button{border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:9px 13px;cursor:pointer;white-space:nowrap}
button:disabled{opacity:.55;cursor:not-allowed}
.switch-label{display:flex;align-items:center;gap:7px;margin:0;white-space:nowrap}
.collection-option{border:1px solid var(--line);border-radius:9px;padding:12px;background:var(--surface-2)}
.collection-option .hint{margin:8px 0 0}
.numeric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.actions{display:flex;justify-content:flex-end;margin-top:22px}
button.primary{background:var(--accent);color:white;border-color:var(--accent);padding-inline:22px}
@media(max-width:650px){.numeric-grid{grid-template-columns:1fr}.settings-card{padding:16px}.settings-heading{align-items:flex-start;flex-direction:column}}
</style>
