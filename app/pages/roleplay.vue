<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { createRoleplayApi, ROLEPLAY_QQ_COMMANDS, type RoleplayPersona, type RoleplaySession, type RoleplayDetail, type RoleplayPersonaInput, type RoleplaySettings, type RoleplaySettingsInput } from "~/api/roleplay";
import { readApiErrorMessage } from "~/utils/api-error";

definePageMeta({ topbar: { title: "角色扮演", crumbs: [{ label: "工作空间" }] } });
const api = createRoleplayApi(useApiRequest());
const { id: hostCharacterId } = useCharacterSelection("/roleplay");
const personas = ref<RoleplayPersona[]>([]);
const sessions = ref<RoleplaySession[]>([]);
const selectedPersonaId = ref("");
const detail = ref<RoleplayDetail | null>(null);
const loading = ref(false);
const sessionsLoading = ref(false);
const detailLoading = ref(false);
const working = ref(false);
const error = ref("");
const draft = ref("");
const pendingSend = ref<{ sessionId: string; content: string; requestId: string } | null>(null);
const chatBody = ref<HTMLElement | null>(null);
let listVersion = 0;
let detailVersion = 0;
let alive = true;
const selectedPersona = computed(() => personas.value.find((p) => p.id === selectedPersonaId.value));
const busy = computed(() => working.value || detailLoading.value || sessionsLoading.value);
const retryingPrevious = computed(() => !!detail.value && pendingSend.value?.sessionId === detail.value.id);
const changedPersona = computed(() => {
  const current = personas.value.find((p) => p.id === detail.value?.personaId);
  return !!detail.value && !!current && (["name", "prompt", "opening"] as const).some((key) => detail.value!.personaSnapshot[key] !== current[key]);
});
function report(e: unknown, fallback: string) { error.value = readApiErrorMessage(e, fallback); }
function upsertSession(session: RoleplaySession) {
  sessions.value = [session, ...sessions.value.filter((item) => item.id !== session.id)];
}
async function scrollChat() { await nextTick(); if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight; }
function restoreUnansweredMessage(session: RoleplayDetail) {
  const latest = [...session.messages].sort((a, b) => b.sequence - a.sequence)[0];
  if (latest?.role === "user" && latest.requestId) {
    draft.value = latest.content;
    pendingSend.value = { sessionId: session.id, content: latest.content, requestId: latest.requestId };
  }
}
async function loadPersonas() {
  loading.value = true; error.value = "";
  try { const result = await api.listPersonas(); if (alive) personas.value = result; }
  catch (e) { if (alive) report(e, "人设列表读取失败"); }
  finally { if (alive) loading.value = false; }
}
async function selectPersona(id: string) {
  if (working.value) return;
  const version = ++listVersion; ++detailVersion;
  selectedPersonaId.value = id; detail.value = null; sessions.value = []; draft.value = ""; pendingSend.value = null;
  detailLoading.value = false; sessionsLoading.value = true; error.value = "";
  try { const result = await api.listSessions(id); if (alive && version === listVersion) sessions.value = result; }
  catch (e) { if (alive && version === listVersion) report(e, "存档列表读取失败"); }
  finally { if (alive && version === listVersion) sessionsLoading.value = false; }
}
async function openSession(id: string) {
  if (working.value) return;
  const version = ++detailVersion; detailLoading.value = true; detail.value = null; draft.value = ""; pendingSend.value = null; error.value = "";
  try { const result = await api.getSession(id); if (alive && version === detailVersion) { detail.value = result; restoreUnansweredMessage(result); await scrollChat(); } }
  catch (e) { if (alive && version === detailVersion) report(e, "对话读取失败"); }
  finally { if (alive && version === detailVersion) detailLoading.value = false; }
}
async function newSession() {
  if (busy.value || !selectedPersonaId.value) return;
  working.value = true; error.value = "";
  try {
    const session = await api.createSession({ personaId: selectedPersonaId.value, ...(hostCharacterId.value ? { hostCharacterId: hostCharacterId.value } : {}) });
    if (!alive) return;
    upsertSession(session); detail.value = await api.getSession(session.id); draft.value = ""; pendingSend.value = null; await scrollChat();
  } catch (e) { if (alive) report(e, "新建对话失败"); }
  finally { if (alive) working.value = false; }
}
async function send() {
  if (busy.value || !detail.value || !draft.value.trim()) return;
  const id = detail.value.id;
  const content = retryingPrevious.value ? pendingSend.value!.content : draft.value.trim();
  if (content.length > 40000) { error.value = "单条消息最多 40000 字，请缩短后发送。"; return; }
  const attempt = pendingSend.value?.sessionId === id && pendingSend.value.content === content ? pendingSend.value : { sessionId: id, content, requestId: crypto.randomUUID() };
  pendingSend.value = attempt; working.value = true; error.value = "";
  try {
    const result = await api.sendMessage(id, { content, requestId: attempt.requestId });
    if (!alive || detail.value?.id !== id) return;
    const messages = new Map(detail.value.messages.map((m) => [m.id, m]));
    messages.set(result.userMessage.id, result.userMessage); messages.set(result.assistantMessage.id, result.assistantMessage);
    detail.value = { ...result.session, messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence) };
    upsertSession(result.session); draft.value = ""; pendingSend.value = null; await scrollChat();
  } catch (e) { if (alive) report(e, "发送失败，原文已保留，可重试"); }
  finally { if (alive) working.value = false; }
}
async function sessionAction(action: "compress" | "apply" | "rebuild") {
  if (busy.value || !detail.value) return;
  const id = detail.value.id;
  if (action === "apply") {
    try { await ElMessageBox.confirm("将当前人设应用到这份存档，聊天记录和摘要保留。确认更新？", "应用新人设", { type: "warning" }); } catch { return; }
    if (busy.value || detail.value?.id !== id) return;
  }
  if (action === "rebuild") {
    try { await ElMessageBox.confirm("忽略旧摘要，从完整聊天原文重新整理。会调用扮演模型，原文保留；失败时旧摘要也保留。", "重建历史摘要", { type: "warning" }); } catch { return; }
    if (busy.value || detail.value?.id !== id) return;
  }
  working.value = true; error.value = "";
  try {
    const session = action === "apply" ? await api.applyPersona(id) : await api.compress(id, action === "rebuild");
    if (alive && detail.value?.id === id) { detail.value = { ...session, messages: detail.value.messages }; upsertSession(session); ElMessage.success(action === "apply" ? "已应用当前人设" : "摘要已更新"); }
  } catch (e) { if (alive) report(e, action === "apply" ? "应用人设失败" : "压缩失败，聊天原文保留"); }
  finally { if (alive) working.value = false; }
}
async function renameSession(session: RoleplaySession) {
  if (busy.value) return;
  let value: string;
  try { ({ value } = await ElMessageBox.prompt("输入存档名称", "重命名存档", { inputValue: session.title, inputValidator: (v) => !!v.trim() || "请填写名称" })); } catch { return; }
  if (busy.value) return;
  working.value = true;
  try { const updated = await api.renameSession(session.id, value.trim()); if (alive) { upsertSession(updated); if (detail.value?.id === updated.id) detail.value = { ...updated, messages: detail.value.messages }; } }
  catch (e) { if (alive) report(e, "重命名失败"); } finally { if (alive) working.value = false; }
}
async function removeSession(session: RoleplaySession) {
  if (busy.value) return;
  try { await ElMessageBox.confirm(`删除「${session.title}」及其聊天和摘要？`, "删除存档", { type: "warning" }); } catch { return; }
  if (busy.value) return;
  working.value = true;
  try { await api.deleteSession(session.id); if (alive) { sessions.value = sessions.value.filter((s) => s.id !== session.id); if (detail.value?.id === session.id) { ++detailVersion; detail.value = null; draft.value = ""; pendingSend.value = null; } } }
  catch (e) { if (alive) report(e, "删除存档失败"); } finally { if (alive) working.value = false; }
}
const personaDialog = ref(false);
const editingId = ref("");
const personaSaving = ref(false);
const personaForm = reactive<RoleplayPersonaInput>({ name: "", prompt: "", opening: "" });
function editPersona(persona?: RoleplayPersona) {
  editingId.value = persona?.id ?? "";
  Object.assign(personaForm, { name: persona?.name ?? "", prompt: persona?.prompt ?? "", opening: persona?.opening ?? "" }); personaDialog.value = true;
}
async function savePersona() {
  if (personaSaving.value || !personaForm.name.trim() || !personaForm.prompt.trim()) return;
  personaSaving.value = true;
  try {
    const data = { name: personaForm.name.trim(), prompt: personaForm.prompt.trim(), opening: personaForm.opening.trim() };
    const result = editingId.value ? await api.updatePersona(editingId.value, data) : await api.createPersona(data);
    if (!alive) return;
    personas.value = [result, ...personas.value.filter((p) => p.id !== result.id)]; personaDialog.value = false;
    if (!editingId.value && !selectedPersonaId.value) await selectPersona(result.id);
  } catch (e) { if (alive) report(e, "保存人设失败"); } finally { if (alive) personaSaving.value = false; }
}
async function removePersona(persona: RoleplayPersona) {
  if (busy.value) return;
  try { await ElMessageBox.confirm(`删除人设「${persona.name}」？已有存档和人设快照会保留，可在「全部存档」继续聊天；人设删除后无法再应用新版。`, "删除人设", { type: "warning" }); } catch { return; }
  if (busy.value) return;
  working.value = true;
  try { await api.deletePersona(persona.id); if (alive) { personas.value = personas.value.filter((p) => p.id !== persona.id); if (selectedPersonaId.value === persona.id) { ++listVersion; ++detailVersion; selectedPersonaId.value = ""; sessions.value = []; detail.value = null; } } }
  catch (e) { if (alive) report(e, "删除人设失败"); } finally { if (alive) working.value = false; }
}
const settingsDialog = ref(false);
const settingsLoading = ref(false);
const settingsLoaded = ref(false);
let settingsVersion = 0;
const settingsSaving = ref(false);
const settingsError = ref("");
const hasApiKey = ref(false);
const settingsForm = reactive<RoleplaySettingsInput>({ apiBaseUrl: "", model: "", thinking: false, temperature: 0.8, maxTokens: 4096, contextWindowTokens: 64000, contextBudgetTokens: 24000, recentMessageLimit: 40, apiKey: "", clearApiKey: false });
function assignSettings(settings: RoleplaySettings) { const { hasApiKey: present, ...fields } = settings; hasApiKey.value = present; Object.assign(settingsForm, fields, { apiKey: "", clearApiKey: false }); }
async function showSettings() {
  const version = ++settingsVersion;
  settingsDialog.value = true; settingsLoading.value = true; settingsLoaded.value = false; settingsError.value = ""; settingsForm.apiKey = "";
  try { const result = await api.getSettings(); if (alive && version === settingsVersion) { assignSettings(result); settingsLoaded.value = true; } }
  catch (e) { if (alive && version === settingsVersion) settingsError.value = readApiErrorMessage(e, "模型设置读取失败"); }
  finally { if (alive && version === settingsVersion) settingsLoading.value = false; }
}
async function saveSettings() {
  if (!settingsLoaded.value || settingsLoading.value || settingsSaving.value || !settingsForm.apiBaseUrl.trim() || !settingsForm.model.trim()) return;
  settingsSaving.value = true; settingsError.value = "";
  try { const result = await api.saveSettings({ ...settingsForm, apiKey: settingsForm.clearApiKey ? "" : settingsForm.apiKey }); if (alive) { assignSettings(result); settingsDialog.value = false; ElMessage.success("扮演模型设置已保存"); } }
  catch (e) { if (alive) settingsError.value = readApiErrorMessage(e, "模型设置保存失败"); }
  finally { if (alive) settingsSaving.value = false; }
}
onMounted(async () => { await loadPersonas(); if (alive && !error.value) await selectPersona(""); });
onBeforeUnmount(() => { alive = false; ++listVersion; ++detailVersion; });
</script>

<template>
  <section class="roleplay-page">
    <div class="page-toolbar">
      <p>独立人设、独立对话，不使用日常角色的记忆或成长资料。</p>
      <div class="actions">
        <el-popover
          placement="bottom-end"
          title="QQ 扮演切换命令（仅主人）"
          :width="340"
          trigger="click"
        >
          <p
            v-for="[command, meaning] in ROLEPLAY_QQ_COMMANDS"
            :key="command"
            class="command"
          >
            <code>{{ command }}</code><br>{{ meaning }}
          </p>
          <p class="muted">
            群里由主人切换，开启后群友需 @ 她参与。本群只可继续本群存档，私聊及其他群存档不会带入。
          </p>
          <template #reference>
            <el-button>QQ 切换帮助</el-button>
          </template>
        </el-popover>
        <el-button
          :disabled="working"
          @click="showSettings"
        >
          独立模型设置
        </el-button>
        <el-button
          type="primary"
          :disabled="working"
          @click="editPersona()"
        >
          新建人设
        </el-button>
      </div>
    </div>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="error-alert"
    />
    <div
      v-loading="loading"
      class="roleplay-layout"
    >
      <aside class="panel persona-panel">
        <div class="panel-heading">
          <h2>扮演人设</h2><el-button
            text
            :disabled="loading || working"
            @click="loadPersonas"
          >
            刷新
          </el-button>
        </div>
        <el-button
          :disabled="working"
          @click="selectPersona('')"
        >
          全部存档
        </el-button>
        <el-empty
          v-if="!loading && !personas.length"
          description="还没有人设，先创建一位聊天对象"
          :image-size="72"
        />
        <div
          v-for="persona in personas"
          :key="persona.id"
          class="persona-item"
          :class="{ selected: selectedPersonaId === persona.id }"
        >
          <el-button
            class="persona-select"
            text
            :disabled="working"
            @click="selectPersona(persona.id)"
          >
            {{ persona.name }}
          </el-button>
          <p class="persona-preview">
            {{ persona.prompt }}
          </p>
          <p class="muted">
            编号：{{ persona.id.slice(0, 8) }}
          </p>
          <div class="actions">
            <el-button
              size="small"
              :disabled="working"
              @click="editPersona(persona)"
            >
              编辑
            </el-button><el-button
              size="small"
              type="danger"
              text
              :disabled="busy"
              @click="removePersona(persona)"
            >
              删除
            </el-button>
          </div>
        </div>
      </aside>
      <aside
        v-loading="sessionsLoading"
        class="panel session-panel"
      >
        <div class="panel-heading">
          <h2>对话存档</h2><el-button
            type="primary"
            plain
            size="small"
            :disabled="!selectedPersonaId || busy"
            @click="newSession"
          >
            新对话
          </el-button>
        </div>
        <p
          v-if="selectedPersona"
          class="muted"
        >
          {{ selectedPersona.name }} · {{ sessions.length }} 份存档
        </p>
        <el-empty
          v-if="!sessionsLoading && !sessions.length"
          :description="selectedPersonaId ? '还没有存档，点击新对话开始' : '先选择左侧人设'"
          :image-size="60"
        />
        <div
          v-for="session in sessions"
          :key="session.id"
          class="session-item"
          :class="{ selected: detail?.id === session.id }"
        >
          <el-button
            text
            class="session-select"
            :disabled="working"
            @click="openSession(session.id)"
          >
            {{ session.title }}
          </el-button>
          <p class="muted">
            {{ session.messageCount }} 条消息 · {{ session.id.slice(0, 8) }}{{ session.groupBindingId ? ' · 群聊存档' : '' }}
          </p>
          <div class="actions">
            <el-button
              size="small"
              text
              :disabled="busy"
              @click="renameSession(session)"
            >
              改名
            </el-button><el-button
              size="small"
              type="danger"
              text
              :disabled="busy"
              @click="removeSession(session)"
            >
              删除
            </el-button>
          </div>
        </div>
      </aside>
      <main
        v-loading="detailLoading"
        class="panel chat-panel"
      >
        <template v-if="detail">
          <div class="panel-heading chat-heading">
            <div>
              <h2>{{ detail.title }}</h2><p class="muted">
                {{ detail.personaSnapshot.name }}
              </p>
            </div><el-button
              :disabled="busy"
              :loading="working"
              @click="sessionAction('compress')"
            >
              压缩历史
            </el-button>
          </div>
          <el-alert
            v-if="detail.groupBindingId"
            title="这是群聊存档，在这里发送的内容也会成为该群后续扮演的上下文。私人话题请另开对话。"
            type="warning"
            :closable="false"
          />
          <el-alert
            v-if="changedPersona"
            title="人设已修改，本存档仍使用原版本。"
            type="info"
            :closable="false"
          >
            <el-button
              size="small"
              :disabled="busy"
              @click="sessionAction('apply')"
            >
              应用新人设到此存档
            </el-button>
          </el-alert>
          <el-collapse class="summary-box">
            <el-collapse-item
              name="summary"
              title="历史摘要"
            >
              <p class="preserve">
                {{ detail.summary || '尚未生成摘要。' }}
              </p><p
                v-if="detail.summary"
                class="muted"
              >
                已覆盖至第 {{ detail.summaryThrough }} 条消息，完整原文仍保留。
              </p>
              <el-button
                v-if="detail.summary"
                :disabled="busy"
                @click="sessionAction('rebuild')"
              >
                从原文重建摘要
              </el-button>
            </el-collapse-item>
          </el-collapse>
          <div
            ref="chatBody"
            class="chat-messages"
            aria-live="polite"
          >
            <el-empty
              v-if="!detail.messages.length"
              description="发送第一句话，开始这份对话"
              :image-size="60"
            />
            <article
              v-for="message in detail.messages"
              :key="message.id"
              class="chat-message"
              :class="message.role"
            >
              <span class="message-speaker">{{ message.role === 'user' ? '你' : detail.personaSnapshot.name }}</span><p class="preserve">
                {{ message.content }}
              </p>
            </article>
            <p
              v-if="working"
              class="muted"
              role="status"
            >
              正在处理，请稍候…
            </p>
          </div>
          <form
            class="composer"
            @submit.prevent="send"
          >
            <p
              v-if="retryingPrevious"
              class="muted"
              role="status"
            >
              上一条消息尚未完成回复，请先重试。原文与请求编号已恢复。
            </p>
            <el-input
              v-model="draft"
              type="textarea"
              :rows="3"
              :maxlength="40000"
              show-word-limit
              :readonly="retryingPrevious"
              :disabled="busy"
              placeholder="输入消息，Ctrl / ⌘ + Enter 发送"
              @keydown.ctrl.enter.prevent="send"
              @keydown.meta.enter.prevent="send"
            />
            <div class="composer-footer">
              <span class="muted">本存档的聊天与摘要独立保存</span><el-button
                type="primary"
                native-type="submit"
                :loading="working"
                :disabled="busy || !draft.trim()"
              >
                {{ retryingPrevious ? '重试上一条' : '发送' }}
              </el-button>
            </div>
          </form>
        </template>
        <el-empty
          v-else
          :description="detailLoading ? '正在读取对话' : '打开存档，或创建一份新对话'"
        />
      </main>
    </div>
    <el-dialog
      v-model="personaDialog"
      :title="editingId ? '编辑人设' : '新建人设'"
      width="620px"
      :close-on-click-modal="!personaSaving"
      :close-on-press-escape="!personaSaving"
      :show-close="!personaSaving"
    >
      <el-form
        label-position="top"
        @submit.prevent="savePersona"
      >
        <el-form-item
          label="名字"
          required
        >
          <el-input
            v-model="personaForm.name"
            maxlength="100"
            show-word-limit
            :disabled="personaSaving"
          />
        </el-form-item>
        <el-form-item
          label="人设"
          required
        >
          <el-input
            v-model="personaForm.prompt"
            type="textarea"
            :rows="9"
            :disabled="personaSaving"
            placeholder="身份、性格、说话方式，以及你希望的相处方式"
          />
        </el-form-item>
        <el-form-item label="开场白（可选）">
          <el-input
            v-model="personaForm.opening"
            type="textarea"
            :rows="3"
            :disabled="personaSaving"
          />
        </el-form-item>
        <p class="muted">
          修改不会自动覆盖旧存档；打开旧存档后可显式应用新人设。
        </p>
      </el-form>
      <template #footer>
        <el-button
          :disabled="personaSaving"
          @click="personaDialog = false"
        >
          取消
        </el-button><el-button
          type="primary"
          :loading="personaSaving"
          :disabled="!personaForm.name.trim() || !personaForm.prompt.trim()"
          @click="savePersona"
        >
          保存人设
        </el-button>
      </template>
    </el-dialog>
    <el-dialog
      v-model="settingsDialog"
      title="角色扮演 · 独立模型设置"
      width="660px"
      :close-on-click-modal="!settingsSaving"
      :close-on-press-escape="!settingsSaving"
      :show-close="!settingsSaving"
      @closed="settingsForm.apiKey = ''"
    >
      <el-alert
        v-if="settingsError"
        :title="settingsError"
        type="error"
        :closable="false"
      />
      <el-form
        v-loading="settingsLoading"
        label-position="top"
        :disabled="settingsLoading || settingsSaving"
      >
        <p class="muted">
          仅用于扮演聊天与摘要压缩，不调用语境助手或记忆助手。
        </p>
        <el-form-item
          label="接口地址"
          required
        >
          <el-input
            v-model="settingsForm.apiBaseUrl"
            placeholder="https://api.example.com/v1"
          />
        </el-form-item>
        <el-form-item
          label="模型名称"
          required
        >
          <el-input v-model="settingsForm.model" />
        </el-form-item>
        <el-form-item :label="hasApiKey ? 'API Key（已保存，留空沿用）' : 'API Key（尚未保存）'">
          <el-input
            v-model="settingsForm.apiKey"
            type="password"
            show-password
            autocomplete="new-password"
            :disabled="settingsForm.clearApiKey"
          />
        </el-form-item>
        <el-checkbox v-model="settingsForm.clearApiKey">
          清除已保存的 API Key
        </el-checkbox>
        <div class="settings-grid">
          <el-form-item label="深度思考">
            <el-switch v-model="settingsForm.thinking" />
          </el-form-item>
          <el-form-item label="温度">
            <el-input-number
              v-model="settingsForm.temperature"
              :min="0"
              :max="2"
              :step="0.1"
            />
          </el-form-item>
          <el-form-item label="最大输出 tokens">
            <el-input-number
              v-model="settingsForm.maxTokens"
              :min="256"
              :max="32768"
              :step="1024"
            />
          </el-form-item>
          <el-form-item label="模型上下文容量">
            <el-input-number
              v-model="settingsForm.contextWindowTokens"
              :min="1"
              :step="1024"
            />
          </el-form-item>
          <el-form-item label="上下文发送预算">
            <el-input-number
              v-model="settingsForm.contextBudgetTokens"
              :min="1"
              :max="settingsForm.contextWindowTokens"
              :step="1024"
            />
          </el-form-item>
          <el-form-item label="最近消息条数">
            <el-input-number
              v-model="settingsForm.recentMessageLimit"
              :min="2"
              :max="500"
            />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button
          :disabled="settingsSaving"
          @click="settingsDialog = false"
        >
          取消
        </el-button><el-button
          type="primary"
          :loading="settingsSaving"
          :disabled="!settingsLoaded || settingsLoading || !settingsForm.apiBaseUrl.trim() || !settingsForm.model.trim()"
          @click="saveSettings"
        >
          保存设置
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.roleplay-page { padding: 20px; font-size: 14px; }
.page-toolbar, .panel-heading, .composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-toolbar { margin-bottom: 16px; flex-wrap: wrap; }
.page-toolbar > p { margin: 0; color: var(--el-text-color-secondary); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.actions :deep(.el-button + .el-button) { margin-left: 0; }
.error-alert { margin-bottom: 12px; }
.roleplay-layout { display: grid; grid-template-columns: 230px 240px minmax(320px, 1fr); gap: 14px; min-height: 640px; }
.panel { padding: 16px; background: var(--surface); border: 1px solid var(--el-border-color-light); border-radius: 12px; min-width: 0; }
.panel-heading { margin-bottom: 12px; }
h2 { font-size: 16px; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; margin: 6px 0; }
.persona-item, .session-item { border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.selected { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.persona-select, .session-select { width: 100%; justify-content: flex-start; font-weight: 600; height: auto; white-space: normal; text-align: left; overflow-wrap: anywhere; }
.persona-preview { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
.chat-panel { display: flex; flex-direction: column; height: min(780px, calc(100vh - 190px)); min-height: 580px; }
.chat-heading { flex-shrink: 0; }
.summary-box { margin: 8px 0; }
.summary-box :deep(.el-collapse-item__content) { max-height: 220px; overflow: auto; }
.chat-messages { flex: 1; min-height: 160px; overflow: auto; padding: 10px 2px; }
.chat-message { margin: 0 0 18px; padding: 12px 14px; border-radius: 10px; background: var(--surface-3); max-width: 90%; width: fit-content; }
.chat-message.user { margin-left: auto; background: var(--green-soft); }
.message-speaker { font-size: 12px; color: var(--el-text-color-secondary); }
.preserve { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin: 6px 0 0; }
.composer { border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; }
.composer-footer { margin-top: 8px; }
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; margin-top: 20px; }
.command { font-size: 12px; line-height: 1.7; margin: 8px 0; }
@media (max-width: 1200px) { .roleplay-layout { grid-template-columns: 190px 210px minmax(280px, 1fr); } }
@media (max-width: 960px) { .roleplay-layout { grid-template-columns: 1fr 1fr; } .chat-panel { grid-column: 1 / -1; height: 650px; } }
@media (max-width: 600px) { .roleplay-page { padding: 12px; } .roleplay-layout { grid-template-columns: 1fr; } .chat-panel { grid-column: auto; } .settings-grid { grid-template-columns: 1fr; } }
</style>
