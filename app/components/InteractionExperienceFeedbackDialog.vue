<script setup lang="ts">
import { createMemoryApi } from "~/api/memory";

const props = defineProps<{ characterId: string }>();
const emit = defineEmits<{ proposed: [] }>();
const api = createMemoryApi(useApiRequest());
const visible = ref(false);
const rooms = ref<Awaited<ReturnType<typeof api.listInteractionExperienceConversations>>["conversations"]>([]);
const messages = ref<Awaited<ReturnType<typeof api.listInteractionExperienceMessages>>["messages"]>([]);
const roomId = ref("");
const feedbackId = ref("");
const loading = ref(false);
const submitting = ref(false);
const error = ref("");
const notice = ref("");
let request = 0;
const feedbackOptions = computed(() => {
  let precedingReply: (typeof messages.value)[number] | undefined;
  return [...messages.value].reverse().flatMap(message => {
    if (message.role === "ASSISTANT") { precedingReply = message; return []; }
    return precedingReply && new Date(message.occurredAt) > new Date(precedingReply.occurredAt)
      ? [{ feedback: message, reply: precedingReply }] : [];
  }).reverse();
});
const selected = computed(() => feedbackOptions.value.find(option => option.feedback.id === feedbackId.value));

function errorMessage(cause: unknown) {
  const response = cause as { data?: { statusMessage?: string; message?: string } };
  return response?.data?.statusMessage ?? response?.data?.message ?? "暂时无法完成，请重试。";
}
function invalidate() { request++; loading.value = false; submitting.value = false; }
watch(() => props.characterId, () => { invalidate(); visible.value = false; });
onBeforeUnmount(invalidate);

async function open() {
  visible.value = true;
  const current = ++request;
  rooms.value = []; messages.value = []; roomId.value = ""; feedbackId.value = "";
  error.value = ""; notice.value = ""; loading.value = true;
  try {
    const result = await api.listInteractionExperienceConversations(props.characterId);
    if (current === request) rooms.value = result.conversations;
  } catch (cause) { if (current === request) error.value = errorMessage(cause); }
  finally { if (current === request) loading.value = false; }
}
async function selectRoom(id: string) {
  const current = ++request;
  messages.value = []; feedbackId.value = ""; notice.value = ""; error.value = "";
  loading.value = Boolean(id);
  if (!id) return;
  try {
    const result = await api.listInteractionExperienceMessages(props.characterId, id);
    if (current === request) messages.value = result.messages;
  } catch (cause) { if (current === request) error.value = errorMessage(cause); }
  finally { if (current === request) loading.value = false; }
}
async function submit() {
  if (submitting.value || !selected.value) return;
  const current = ++request;
  const { reply, feedback } = selected.value;
  submitting.value = true; error.value = ""; notice.value = "";
  try {
    const result = await api.proposeInteractionExperience(props.characterId, reply.id, feedback.id);
    if (current !== request) return;
    if (result.item) { visible.value = false; emit("proposed"); }
    else notice.value = result.notice;
  } catch (cause) { if (current === request) error.value = errorMessage(cause); }
  finally { if (current === request) submitting.value = false; }
}
function roomLabel(room: (typeof rooms.value)[number]) {
  const kind = { GROUP: "群聊", PRIVATE: "QQ 私聊", WEB: "网页对话" }[room.scene];
  return `${kind} · ${room.title || "未命名会话"}`;
}
function feedbackLabel(message: (typeof messages.value)[number]) {
  return `${new Date(message.occurredAt).toLocaleString("zh-CN", { hour12: false })} · ${message.content.slice(0, 72)}`;
}
</script>

<template>
  <el-button
    :disabled="!characterId"
    @click="open"
  >
    从反馈学习
  </el-button>
  <el-dialog
    v-model="visible"
    title="从反馈学习"
    width="min(600px, 94vw)"
    @close="invalidate"
  >
    <p>选一条明确的纠正或反馈，核对她当时回的哪一句。提炼会调用角色模型，采纳后只在原会话的类似情境使用。</p>
    <el-form label-position="top">
      <el-form-item label="会话">
        <el-select
          v-model="roomId"
          filterable
          :disabled="submitting"
          :loading="loading && !roomId"
          placeholder="选择最近的会话"
          @change="selectRoom"
        >
          <el-option
            v-for="room in rooms"
            :key="room.id"
            :label="roomLabel(room)"
            :value="room.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="反馈原文">
        <el-select
          v-model="feedbackId"
          filterable
          :disabled="!roomId || loading || submitting"
          placeholder="选择该回复之后的明确反馈"
          no-data-text="最近消息中没有可选的回复与反馈"
        >
          <el-option
            v-for="option in feedbackOptions"
            :key="option.feedback.id"
            :label="feedbackLabel(option.feedback)"
            :value="option.feedback.id"
          />
        </el-select>
      </el-form-item>
    </el-form>
    <dl
      v-if="selected"
      class="feedback-preview"
    >
      <dt>她当时的回复</dt><dd>{{ selected.reply.content }}</dd>
      <dt>反馈原文</dt><dd>{{ selected.feedback.content }}</dd>
    </dl>
    <el-alert
      v-if="error || notice"
      :title="error || notice"
      :type="error ? 'error' : 'info'"
      :closable="false"
      show-icon
    />
    <template #footer>
      <el-button @click="visible = false">
        关闭
      </el-button>
      <el-button
        type="primary"
        :disabled="!selected || loading"
        :loading="submitting"
        @click="submit"
      >
        提炼经验
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.feedback-preview { max-height: 240px; overflow: auto; }
.feedback-preview dt { font-weight: 600; }
.feedback-preview dd { margin: 4px 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
