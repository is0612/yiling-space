<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
const props = defineProps<{ characterId: string; dayKey: string }>();
const emit = defineEmits<{ changed: [] }>();
type Entry = { id: string; title: string; detail: string; sourceMessageIds: string[] };
type Pair = { keep: Entry; candidate: Entry; reason: string; token: string };
const open = ref(false);
const loading = ref(false);
const saving = ref(false);
const pairs = ref<Pair[]>([]);
const checked = ref(0);
const limited = ref(false);
const error = ref("");
let sequence = 0;
watch(() => [props.characterId, props.dayKey], () => { sequence++; open.value = false; loading.value = false; pairs.value = []; error.value = ""; });
onBeforeUnmount(() => { sequence++; });
async function preview() {
  const seq = ++sequence;
  const characterId = props.characterId, dayKey = props.dayKey;
  open.value = true; loading.value = true; error.value = ""; pairs.value = [];
  try {
    const result = await $fetch<{ pairs: Pair[]; checkedCount: number; pairsLimited: boolean }>(`/api/characters/${encodeURIComponent(characterId)}/memory-events/duplicates`, { query: { dayKey } });
    if (seq !== sequence) return;
    pairs.value = result.pairs; checked.value = result.checkedCount; limited.value = result.pairsLimited;
  } catch { if (seq === sequence) error.value = "预览失败，请重试；每天最多支持 500 条可访问忆泡。"; }
  finally { if (seq === sequence) loading.value = false; }
}
async function archive(pair: Pair) {
  const seq = sequence, characterId = props.characterId;
  try {
    await ElMessageBox.confirm(`保留「${pair.keep.title}」，隐藏「${pair.candidate.title}」？共享来源不代表重复，请先核对两条内容。隐藏后可在当天「已隐藏」中恢复。`, "确认隐藏候选", { confirmButtonText: "隐藏这一条", cancelButtonText: "取消", type: "warning", appendTo: document.body, modalClass: "memory-duplicate-confirm-overlay" });
    if (seq !== sequence || saving.value) return;
    saving.value = true;
    await $fetch(`/api/characters/${encodeURIComponent(characterId)}/memory-events/duplicates`, { method: "POST", body: { keepId: pair.keep.id, candidateId: pair.candidate.id, token: pair.token } });
    if (seq !== sequence) return;
    ElMessage.success("已隐藏，原文和来源保留，可在当天已隐藏列表恢复。");
    emit("changed");
    await preview();
  } catch (cause) {
    if (seq === sequence && cause !== "cancel" && cause !== "close") { error.value = "操作未完成，候选可能已变化，请重新预览。"; pairs.value = []; }
  } finally { saving.value = false; }
}
</script>

<template>
  <el-button
    :disabled="!characterId || !dayKey || saving"
    @click="preview"
  >
    检查当天重复候选
  </el-button>
  <el-dialog
    v-model="open"
    append-to-body
    title="当天忆泡重复候选"
    width="min(900px, 94vw)"
    :close-on-click-modal="!saving"
    :show-close="!saving"
  >
    <p>仅比较你可访问的同一范围、同一会话和同一天的忆泡；旧记录会话未知时，无法确认是否来自同一会话。共享来源只代表值得核对，不代表重复。</p>
    <p>建议保留项按详情长度排列，你仍需判断新增进展。隐藏不合并正文、不删除来源，也不撤销已经形成的其他成长结论。</p>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <p v-if="loading">
      正在检查…
    </p>
    <template v-else-if="!error">
      <p>已检查 {{ checked }} 条。{{ limited ? '当前最多展示 100 对，处理后可重新检查。' : '' }}</p>
      <el-empty
        v-if="!pairs.length"
        description="未发现词面完全相同或共享来源的候选；这不排除其他语义重复。"
      />
      <section
        v-for="pair in pairs"
        :key="pair.token"
        class="duplicate-pair"
      >
        <el-tag>{{ pair.reason === 'EXACT_CONTENT' ? '标题与详情归一后相同' : '共享来源，请人工核对' }}</el-tag>
        <div class="duplicate-columns">
          <article>
            <strong>建议保留：{{ pair.keep.title }}</strong><p>{{ pair.keep.detail }}</p><details>
              <summary>来源消息 {{ pair.keep.sourceMessageIds.length }} 条</summary><p
                v-for="source in pair.keep.sourceMessageIds"
                :key="source"
              >
                {{ source }}
              </p>
            </details>
          </article>
          <article>
            <strong>待核对：{{ pair.candidate.title }}</strong><p>{{ pair.candidate.detail }}</p><details>
              <summary>来源消息 {{ pair.candidate.sourceMessageIds.length }} 条</summary><p
                v-for="source in pair.candidate.sourceMessageIds"
                :key="source"
              >
                {{ source }}
              </p>
            </details>
          </article>
        </div>
        <el-button
          type="warning"
          :disabled="saving"
          @click="archive(pair)"
        >
          选择隐藏待核对项
        </el-button>
      </section>
    </template>
    <template #footer>
      <el-button
        :disabled="saving"
        @click="preview"
      >
        重新检查
      </el-button><el-button
        :disabled="saving"
        @click="open = false"
      >
        关闭
      </el-button>
    </template>
  </el-dialog>
</template>

<style>
/* Confirmation belongs above the candidate dialog, including nested dialog contexts. */
.memory-duplicate-confirm-overlay { z-index: 3000 !important; }
</style>

<style scoped>
.duplicate-pair { border-top: 1px solid var(--el-border-color); padding: 20px 0; }
.duplicate-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin: 16px 0; }
article { min-width: 0; overflow-wrap: anywhere; }
p { white-space: pre-wrap; line-height: 1.7; font-size: 14px; }
summary { cursor: pointer; font-size: 12px; }
@media (max-width: 640px) { .duplicate-columns { grid-template-columns: 1fr; } }
</style>
