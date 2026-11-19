<script setup lang="ts">
import { createMemoryApi, type GroupChatMessage, type GroupChatGroup } from "~/api/memory";
import { createGrowthApi, type LanguageHabit } from "~/api/growth";

const props = defineProps<{ characterId: string }>();
const emit = defineEmits<{ proposed: [habit: LanguageHabit] }>();
const request = useApiRequest();
const memory = createMemoryApi(request);
const growth = createGrowthApi(request);
const visible = ref(false);
const groups = ref<GroupChatGroup[]>([]);
const messages = ref<GroupChatMessage[]>([]);
const conversationId = ref("");
const openingId = ref("");
const responseId = ref("");
const outcomeId = ref("");
const loading = ref(false);
const submitting = ref(false);
const setting = ref(false);
const selectedGroup = computed(() => groups.value.find(group => group.conversationId === conversationId.value));
const automaticEnabled = computed(() => selectedGroup.value?.automaticObservation?.enabled === true);
const automaticError = computed(() => ({ QUOTA_EXCEEDED: "模型额度用完，后台会再检查。", MODEL_UNAVAILABLE: "模型暂不可用，请检查角色模型。", ANALYSIS_FAILED: "最近一次片段分析未完成。", SCAN_FAILED: "暂时无法读取片段，后台会重试。" } as Record<string, string>)[selectedGroup.value?.automaticObservation?.lastError ?? ""]);
const failed = ref(false);
const notice = ref("");
let sequence = 0;
const participants = computed(() => messages.value.filter(row => row.role === "USER" && row.content.trim()));
const indexOf = (id: string) => messages.value.findIndex(row => row.id === id);
const responses = computed(() => participants.value.filter(row => indexOf(row.id) > indexOf(openingId.value)));
const outcomes = computed(() => participants.value.filter(row => indexOf(row.id) > indexOf(responseId.value)));
const windowRows = computed(() => openingId.value && outcomeId.value ? messages.value.slice(indexOf(openingId.value), indexOf(outcomeId.value) + 1) : []);
const invalid = computed(() => {
  const first = windowRows.value[0]; const last = windowRows.value.at(-1);
  if (!first || !last) return "";
  if (windowRows.value.length > 12 || Date.parse(last.occurredAt) - Date.parse(first.occurredAt) > 15 * 60_000) return "请选择 15 分钟内、最多 12 条消息的片段。";
  if (windowRows.value.some(row => row.role === "ASSISTANT")) return "请选择她没有参加的一段对话。";
  return "";
});
function close() { sequence++; loading.value = false; submitting.value = false; setting.value = false; visible.value = false; }
watch(() => props.characterId, close);
onBeforeUnmount(close);
function resetLines() { openingId.value = ""; responseId.value = ""; outcomeId.value = ""; notice.value = ""; }
function afterOpening() { responseId.value = ""; afterResponse(); }
function afterResponse() { outcomeId.value = ""; notice.value = ""; }
function errorText(error: unknown) {
  return (error as { data?: { statusMessage?: string; message?: string } })?.data?.statusMessage ?? "暂时无法完成，请稍后重试。";
}
async function load(id?: string) {
  const current = ++sequence;
  loading.value = true; failed.value = false; messages.value = []; resetLines();
  try {
    const result = await memory.listGroupChats({ characterId: props.characterId, ...(id ? { conversationId: id } : {}) });
    if (current !== sequence) return;
    groups.value = result.groups; messages.value = result.messages;
    conversationId.value = result.selectedConversationId ?? "";
  } catch (error) {
    if (current === sequence) { failed.value = true; notice.value = errorText(error); }
  } finally { if (current === sequence) loading.value = false; }
}
function open() { visible.value = true; conversationId.value = ""; groups.value = []; void load(); }
function label(row: GroupChatMessage) { return `${new Date(row.occurredAt).toLocaleTimeString("zh-CN", { hour12: false })} · ${row.author || row.member || "群友"} · ${row.content.slice(0, 84)}`; }
async function changeAutomation(value: boolean | string | number) {
  if (setting.value || loading.value || submitting.value || typeof value !== "boolean" || !selectedGroup.value) return;
  const current = ++sequence;
  const roomId = conversationId.value;
  setting.value = true; notice.value = ""; failed.value = false;
  try {
    const result = await growth.setAutomaticGroupLanguage(props.characterId, roomId, value);
    if (current !== sequence) return;
    groups.value = groups.value.map(group => group.conversationId === roomId ? { ...group, automaticObservation: { enabled: result.enabled, lastError: null } } : group);
    notice.value = result.enabled ? "已开启：后台只看从现在起有记录的新消息。" : "已关闭：不会再从这个群自动提炼，现有候选仍保留。";
  } catch (error) { if (current === sequence) { failed.value = true; notice.value = errorText(error); } }
  finally { if (current === sequence) setting.value = false; }
}
async function submit() {
  if (submitting.value || invalid.value || !openingId.value || !responseId.value || !outcomeId.value) return;
  const current = ++sequence;
  submitting.value = true; notice.value = "";
  try {
    const result = await growth.observeGroupLanguage(props.characterId, { conversationId: conversationId.value, openingId: openingId.value, responseId: responseId.value, outcomeId: outcomeId.value });
    if (current !== sequence) return;
    if (result.habit) { close(); emit("proposed", result.habit); }
    else { failed.value = false; notice.value = "这段对话没有足够明确的后续来支持一条表达习惯。可以换一段再试。"; }
  } catch (error) { if (current === sequence) { failed.value = true; notice.value = errorText(error); } }
  finally { if (current === sequence) submitting.value = false; }
}
</script>

<template>
  <el-button
    :disabled="!characterId"
    @click="open"
  >
    从群聊学说话
  </el-button>
  <el-dialog
    v-model="visible"
    title="从群聊学说话"
    width="min(680px, 94vw)"
    @close="close"
  >
    <p>选她没有参加的一段对话：先发生了什么、别人怎么接、之后对方有什么可见回应。分析会把所选片段的文字交给角色模型。只有你确认后，她才会在同一角色的相关聊天中使用提炼出的表达习惯。</p>
    <el-form
      label-position="top"
      :disabled="loading || submitting || setting"
    >
      <el-form-item label="群聊">
        <el-select
          v-model="conversationId"
          :loading="loading"
          filterable
          placeholder="选择群聊"
          no-data-text="没有已记录的群聊"
          @change="load"
        >
          <el-option
            v-for="group in groups"
            :key="group.conversationId"
            :label="group.label"
            :value="group.conversationId"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="selectedGroup"
        label="自动观察这个群"
      >
        <el-switch
          :model-value="automaticEnabled"
          :loading="setting"
          aria-label="自动观察这个群"
          @change="changeAutomation"
        />
        <p class="automation-note">
          开启后后台自行挑选已记录的新片段，把候选放到「待确认」。不会自动采纳，也不会额外记录群消息。
        </p>
        <p
          v-if="automaticError"
          class="automation-note"
          role="status"
        >
          {{ automaticError }}
        </p>
      </el-form-item>
      <el-form-item label="手动选开场 · 当时发生了什么">
        <el-select
          v-model="openingId"
          :disabled="!messages.length"
          filterable
          placeholder="选一条群友消息"
          @change="afterOpening"
        >
          <el-option
            v-for="row in participants"
            :key="row.id"
            :label="label(row)"
            :value="row.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="接话 · 你想让她观察的回应">
        <el-select
          v-model="responseId"
          :disabled="!openingId"
          filterable
          placeholder="选之后的接话"
          @change="afterResponse"
        >
          <el-option
            v-for="row in responses"
            :key="row.id"
            :label="label(row)"
            :value="row.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="后续 · 对方实际怎么回应">
        <el-select
          v-model="outcomeId"
          :disabled="!responseId"
          filterable
          placeholder="选能看出后续变化的消息"
          @change="notice = ''"
        >
          <el-option
            v-for="row in outcomes"
            :key="row.id"
            :label="label(row)"
            :value="row.id"
          />
        </el-select>
      </el-form-item>
    </el-form>
    <ol
      v-if="windowRows.length && !invalid"
      class="observation-window"
      aria-label="即将分析的群聊片段"
    >
      <li
        v-for="row in windowRows"
        :key="row.id"
      >
        {{ label(row) }} <strong v-if="row.id === responseId">（接话）</strong>
      </li>
    </ol>
    <el-alert
      v-if="invalid || notice"
      :title="invalid || notice"
      :type="invalid || failed ? 'warning' : 'info'"
      :closable="false"
      show-icon
    />
    <template #footer>
      <el-button @click="close">
        关闭
      </el-button>
      <el-button
        type="primary"
        :disabled="loading || setting || !outcomeId || !!invalid"
        :loading="submitting"
        @click="submit"
      >
        分析并保存候选
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.observation-window { max-height: 180px; overflow: auto; overflow-wrap: anywhere; padding-inline-start: 24px; }
.observation-window li { padding-block: 3px; }
.automation-note { flex-basis: 100%; margin: 0; line-height: 1.5; color: var(--el-text-color-secondary); }
</style>
