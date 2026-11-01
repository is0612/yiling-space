<script setup lang="ts">
import { Delete, EditPen, MagicStick } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

/**
 * 梗语录：她会**原样说出来**的那几句口头禅（「xxx 不烧心吗」）。
 *
 * 这一页要回答三个第一眼就会有的疑问，都写进页面文案里：
 *   ① 「为什么不写在对话示例里」—— 示例是学语气、明令不许照抄；梗要的恰好是原样说。
 *   ② 「为什么我加了但她不说」—— 靠 usage 判断时机，时机不对就不说，这是设计不是故障。
 *   ③ 「为什么刚加就标了不可用」—— 冷却两小时，说过的先歇一会。
 *
 * 版式上不用 stickers.vue 那套两栏。两栏契约现在是 main.css 里的 `.settings-grid`
 * （左主内容 + 右 320 侧栏，那是给「右栏只读辅助板」用的形状；
 *   更早它只写在 memory.vue 的 scoped 里，表情包页引用它一直没生效）。
 * 梗这一页没有辅助板，一条梗也就一两行，通着排比切成两半更好读。
 */
type CatchphraseEvidence = {
  groupLabel?: string;
  count?: number;
  speakers?: number;
  samples?: string[];
};

type CatchphraseItem = {
  id: string;
  phrase: string;
  usage: string;
  enabled: boolean;
  /** ACTIVE = 在用；PENDING = 从群里捡的、等确认；REJECTED 不会出现在页面上。 */
  status: string;
  evidence: CatchphraseEvidence | null;
  useCount: number;
  lastUsedAt: string | null;
  source: string;
  /** 后端算好的「还在冷却里」。页面不自己算，省得和提示词那边两套口径。 */
  cooling: boolean;
  createdAt: string;
};

const route = useRoute();
const id = computed(() => String(route.params.id || ""));

const characterName = ref("");
const loading = ref(true);
const items = ref<CatchphraseItem[]>([]);
const saving = ref(false);

/** 从群里捡回来的、等用户点头的那批。只在弹窗里出现。 */
const pendingItems = ref<CatchphraseItem[]>([]);
const reviewOpen = ref(false);
const scanning = ref(false);
const deciding = ref<Set<string>>(new Set());

const draftPhrase = ref("");
const draftUsage = ref("");

/** 一行一句：梗是人攒着回来记的，贴十条不该开十个对话框。 */
const draftPhrases = computed(() =>
  draftPhrase.value.split("\n").map((line) => line.trim()).filter(Boolean),
);

const canSubmit = computed(() => draftPhrases.value.length > 0);
const disabledCount = computed(() => items.value.filter((item) => !item.enabled).length);

const listUrl = computed(() => `/api/characters/${encodeURIComponent(id.value)}/catchphrases`);
const itemUrl = (catchphraseId: string) => `${listUrl.value}/${encodeURIComponent(catchphraseId)}`;

async function load() {
  loading.value = true;
  try {
    const [character, rows, pending] = await Promise.all([
      $fetch<{ name: string }>(`/api/characters/${encodeURIComponent(id.value)}`),
      $fetch<CatchphraseItem[]>(listUrl.value),
      $fetch<CatchphraseItem[]>(listUrl.value, { query: { status: "pending" } }),
    ]);
    characterName.value = character.name;
    items.value = rows;
    pendingItems.value = pending;
    // 有待确认的就直接弹出来：这批东西不点掉，用户根本不知道它们存在。
    if (pending.length) reviewOpen.value = true;
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "读取梗语录失败。");
  } finally {
    loading.value = false;
  }
}

/** 扫一遍最近的群聊。会花一次模型调用，所以只在用户点按钮时跑。 */
async function scan() {
  scanning.value = true;
  try {
    const result = await $fetch<{ scanned: number; candidates: number; created: number; skipped: number }>(
      `${listUrl.value}/mine`,
      { method: "POST" },
    );
    if (result.created > 0) {
      pendingItems.value = await $fetch<CatchphraseItem[]>(listUrl.value, { query: { status: "pending" } });
      reviewOpen.value = true;
      ElMessage.success(`捡到 ${result.created} 句，看看要不要收。`);
    } else if (!result.scanned) {
      ElMessage.info("最近两周没扫到群消息 —— 得先让 QQ 适配器跑起来、群里聊过天，才有东西可扫。");
    } else if (!result.candidates) {
      ElMessage.info(`扫了 ${result.scanned} 条消息，还没发现反复出现的说法。梗要有人重复用才算梗。`);
    } else {
      ElMessage.info(
        `扫到 ${result.candidates} 句反复出现的说法，但没一句适合当口头禅（多半是系统提示、指令，或者已经在列表里）。真梗要多被用几次才会浮出来。`,
      );
    }
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "扫描失败。");
  } finally {
    scanning.value = false;
  }
}

function markDeciding(catchphraseId: string, busy: boolean) {
  const next = new Set(deciding.value);
  if (busy) next.add(catchphraseId);
  else next.delete(catchphraseId);
  deciding.value = next;
}

/** 入库：转 ACTIVE，直接进主列表（她下一轮就能说）。 */
async function accept(item: CatchphraseItem) {
  markDeciding(item.id, true);
  try {
    const updated = await $fetch<CatchphraseItem>(itemUrl(item.id), {
      method: "PATCH",
      body: { status: "ACTIVE" },
    });
    pendingItems.value = pendingItems.value.filter((row) => row.id !== item.id);
    items.value = [...items.value, updated];
    if (!pendingItems.value.length) reviewOpen.value = false;
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "入库失败。");
  } finally {
    markDeciding(item.id, false);
  }
}

/**
 * 不要：转 REJECTED。
 *
 * **不删行** —— 删了下一轮扫描会把它重新捡回来，弹窗就一直重弹，用户永远否不掉它。
 */
async function dismiss(item: CatchphraseItem) {
  markDeciding(item.id, true);
  try {
    await $fetch(itemUrl(item.id), { method: "PATCH", body: { status: "REJECTED" } });
    pendingItems.value = pendingItems.value.filter((row) => row.id !== item.id);
    if (!pendingItems.value.length) reviewOpen.value = false;
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "操作失败。");
  } finally {
    markDeciding(item.id, false);
  }
}

async function acceptAll() {
  const targets = [...pendingItems.value];
  if (!targets.length) return;
  const accepted: CatchphraseItem[] = [];
  for (const item of targets) {
    markDeciding(item.id, true);
    try {
      accepted.push(await $fetch<CatchphraseItem>(itemUrl(item.id), {
        method: "PATCH",
        body: { status: "ACTIVE" },
      }));
      pendingItems.value = pendingItems.value.filter((row) => row.id !== item.id);
    } catch {
      // 单条失败不该让整批停下；失败的那条留在弹窗里，用户能再点一次。
    } finally {
      markDeciding(item.id, false);
    }
  }
  items.value = [...items.value, ...accepted];
  if (!pendingItems.value.length) reviewOpen.value = false;
  if (accepted.length) ElMessage.success(`已入库 ${accepted.length} 句。`);
  if (pendingItems.value.length) ElMessage.warning(`还有 ${pendingItems.value.length} 句没进去，可以再点一次。`);
}

async function submit() {
  const phrases = draftPhrases.value;
  if (!phrases.length) return;
  saving.value = true;
  try {
    const result = await $fetch<{ created: CatchphraseItem[]; skipped: string[] }>(listUrl.value, {
      method: "POST",
      body: { phrases, usage: draftUsage.value.trim() },
    });
    items.value = [...items.value, ...result.created];
    draftPhrase.value = "";
    draftUsage.value = "";
    if (result.created.length && !result.skipped.length) {
      ElMessage.success(
        result.created.length === 1
          ? "已添加。她下一轮就知道这句了。"
          : `已添加 ${result.created.length} 句。`,
      );
    } else if (result.created.length) {
      ElMessage.warning(`加了 ${result.created.length} 句，另外 ${result.skipped.length} 句已经在列表里了。`);
    } else {
      ElMessage.info("这些都已经在列表里了。");
    }
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "添加失败。");
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row: CatchphraseItem, enabled: boolean) {
  try {
    const updated = await $fetch<CatchphraseItem>(
      `/api/characters/${encodeURIComponent(id.value)}/catchphrases/${encodeURIComponent(row.id)}`,
      { method: "PATCH", body: { enabled } },
    );
    row.enabled = updated.enabled;
  } catch (error) {
    row.enabled = !enabled;
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "更新失败。");
  }
}

// ── 编辑：台词 + 什么时候说 ─────────────────────────────
const editing = ref<CatchphraseItem | null>(null);
const editPhrase = ref("");
const editUsage = ref("");
const savingEdit = ref(false);

function openEdit(row: CatchphraseItem) {
  editing.value = row;
  editPhrase.value = row.phrase;
  editUsage.value = row.usage;
}

async function saveEdit() {
  const target = editing.value;
  if (!target) return;
  const phrase = editPhrase.value.trim();
  if (!phrase) {
    ElMessage.error("台词不能为空。");
    return;
  }
  savingEdit.value = true;
  try {
    const updated = await $fetch<CatchphraseItem>(
      `/api/characters/${encodeURIComponent(id.value)}/catchphrases/${encodeURIComponent(target.id)}`,
      { method: "PATCH", body: { phrase, usage: editUsage.value.trim() } },
    );
    // 就地更新：整页重拉会丢掉下面「刚说过」的标记变化，用户会以为点错了。
    target.phrase = updated.phrase;
    target.usage = updated.usage;
    editing.value = null;
    ElMessage.success("已保存。她下一轮就按新的说法来。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "保存失败。");
  } finally {
    savingEdit.value = false;
  }
}

async function remove(row: CatchphraseItem) {
  try {
    await ElMessageBox.confirm(`删除「${row.phrase}」？删掉就找不回来了。`, "删除梗", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    await $fetch(`/api/characters/${encodeURIComponent(id.value)}/catchphrases/${encodeURIComponent(row.id)}`, {
      method: "DELETE",
    });
    items.value = items.value.filter((item) => item.id !== row.id);
    ElMessage.success("已删除。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "删除失败。");
  }
}

onMounted(load);
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :eyebrow="'角色管理 / ' + (characterName || '角色') + ' / 梗语录'"
      title="梗语录"
      description="她会原样说出来的几句口头禅。时机对上了就说，对不上就不说 —— 所以有时候几轮不出现是正常的。"
      :back-to="'/characters?c=' + id"
      back-label="返回角色列表"
    >
      <template #actions>
        <el-button
          :loading="scanning"
          @click="scan"
        >
          <el-icon><MagicStick /></el-icon>扫群里的梗
        </el-button>
      </template>
    </PageHeader>

    <section class="surface form-section">
      <div class="form-title">
        加几句
        <span
          v-if="draftPhrases.length > 1"
          class="cp-aside"
        >这次 {{ draftPhrases.length }} 句</span>
      </div>
      <p class="section-description">
        一行一句，可以一次贴好几条 —— 在外面刷到就攒着，回来一起贴。台词会一个字不改地出现在回复里，别写「（可以换个说法）」这类批注。
      </p>

      <div class="cp-field">
        <label class="cp-label">台词</label>
        <el-input
          v-model="draftPhrase"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 8 }"
          maxlength="4000"
          placeholder="xxx 不烧心吗&#10;你这算盘打得我在隔壁都听见了"
        />
      </div>

      <div class="cp-field">
        <label class="cp-label">什么时候说<span class="cp-label-sub">可选，多句时作为它们共同的场景</span></label>
        <el-input
          v-model="draftUsage"
          maxlength="300"
          placeholder="看到有人熬夜硬撑、或者嘴上说没事的时候"
        />
      </div>
      <p class="cp-tip">
        这一栏决定她挑不挑得准时机。留空也能用（她只凭台词判断），但写具体一点会明显更准 —— 「看情况用」等于没写。
      </p>

      <div class="form-actions">
        <el-button
          type="primary"
          :disabled="!canSubmit"
          :loading="saving"
          @click="submit"
        >
          {{ draftPhrases.length > 1 ? `添加 ${draftPhrases.length} 句` : "添加" }}
        </el-button>
      </div>
    </section>

    <section
      v-loading="loading"
      class="surface form-section cp-list-section"
    >
      <div class="form-title">
        已有 {{ items.length }} 条
        <span
          v-if="disabledCount"
          class="cp-aside"
        >停用 {{ disabledCount }} 条</span>
      </div>
      <p class="section-description">
        说过一次之后冷却两小时 —— 同一句连着刷是最快毁掉角色感的做法。冷却不会显示成不可用，只是排到候选的最后。
      </p>

      <div
        v-if="items.length"
        class="cp-list"
      >
        <div
          v-for="item in items"
          :key="item.id"
          class="cp-card"
          :class="{ 'is-off': !item.enabled }"
        >
          <div class="cp-body">
            <div class="cp-phrase">
              {{ item.phrase }}
              <span
                v-if="item.cooling && item.enabled"
                class="cp-badge"
              >刚说过，先歇一会</span>
            </div>
            <p
              class="cp-usage"
              :class="{ 'is-empty': !item.usage }"
            >
              {{ item.usage || "还没写什么时候说，她只能凭台词猜" }}
            </p>
          </div>
          <div class="cp-ops">
            <span
              v-if="item.source === 'collected'"
              class="cp-source"
            >从群里捡的</span>
            <span class="cp-count">说过 {{ item.useCount }} 次</span>
            <el-switch
              :model-value="item.enabled"
              @update:model-value="(value) => toggleEnabled(item, Boolean(value))"
            />
            <el-button
              link
              type="primary"
              @click="openEdit(item)"
            >
              <el-icon><EditPen /></el-icon>编辑
            </el-button>
            <el-button
              link
              type="danger"
              @click="remove(item)"
            >
              <el-icon><Delete /></el-icon>删除
            </el-button>
          </div>
        </div>
      </div>

      <p
        v-else-if="!loading"
        class="section-description"
      >
        还没有梗。加一句她常说的口头禅，比在基础人设里写「爱吐槽」有用得多 —— 前者她真的会说出口。
      </p>
    </section>

    <el-dialog
      :model-value="Boolean(editing)"
      title="编辑梗"
      width="460px"
      @update:model-value="(value: boolean) => { if (!value) editing = null; }"
    >
      <div
        v-if="editing"
        class="cp-edit-body"
      >
        <label class="cp-field">
          <span class="cp-label">台词</span>
          <el-input
            v-model="editPhrase"
            maxlength="200"
            show-word-limit
          />
        </label>
        <label class="cp-field">
          <span class="cp-label">什么时候说</span>
          <el-input
            v-model="editUsage"
            maxlength="300"
            placeholder="看到有人熬夜硬撑、或者嘴上说没事的时候"
          />
        </label>
        <p class="cp-tip">
          改台词等于换一个梗：历史里已经说过的那些不会跟着变。
        </p>
      </div>
      <template #footer>
        <el-button @click="editing = null">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="savingEdit"
          @click="saveEdit"
        >
          保存
        </el-button>
      </template>
    </el-dialog>

    <!--
      待确认弹窗：从群里捡回来的梗。
      每条都要给出「凭什么觉得这是梗」—— 群、出现次数、几个人说过、原话。
      只给台词的话，用户只能凭感觉点，而这批东西本来就是要他判断的。
    -->
    <el-dialog
      v-model="reviewOpen"
      :title="`从群里捡到 ${pendingItems.length} 句，要收进来吗`"
      width="640px"
    >
      <p class="cp-review-intro">
        这几句是最近两周在群里被反复用到的说法。收进来之后，她会在合适的时机原样说出来。
        拿不准的就点「不要」——不收比收错安全。
      </p>

      <div
        v-if="pendingItems.length"
        class="cp-review-list"
      >
        <div
          v-for="item in pendingItems"
          :key="item.id"
          class="cp-review-card"
        >
          <div class="cp-review-main">
            <div class="cp-review-phrase">
              {{ item.phrase }}
            </div>
            <p
              v-if="item.usage"
              class="cp-review-usage"
            >
              {{ item.usage }}
            </p>
            <div
              v-if="item.evidence"
              class="cp-review-evidence"
            >
              <span v-if="item.evidence.groupLabel">{{ item.evidence.groupLabel }}</span>
              <span v-if="item.evidence.count">出现 {{ item.evidence.count }} 次</span>
              <span v-if="item.evidence.speakers">{{ item.evidence.speakers }} 个人说过</span>
            </div>
            <p
              v-if="item.evidence?.samples?.length"
              class="cp-review-samples"
            >
              群里原话：{{ item.evidence.samples.join(" / ") }}
            </p>
          </div>
          <div class="cp-review-ops">
            <el-button
              type="primary"
              size="small"
              :loading="deciding.has(item.id)"
              @click="accept(item)"
            >
              入库
            </el-button>
            <el-button
              size="small"
              :disabled="deciding.has(item.id)"
              @click="dismiss(item)"
            >
              不要
            </el-button>
          </div>
        </div>
      </div>

      <p
        v-else
        class="section-description"
      >
        都处理完了。
      </p>

      <template #footer>
        <el-button @click="reviewOpen = false">
          稍后再说
        </el-button>
        <el-button
          type="primary"
          :disabled="!pendingItems.length"
          @click="acceptAll"
        >
          全部入库
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 与表情包页同一套语言：单列、白卡柔光、去描边、语义色走变量。
   间距走 --sp-*，字号 12/14，信息文字 --dim（--faint 只给装饰）。 */

/* 两个 section 复用全局 surface/form-section 的版式，但去掉 1px 描边，
   与表情包页的白卡柔光对齐 —— 层次交给背景明度和阴影，不靠描边 */
:deep(.surface.form-section) {
  border: 0;
  box-shadow: var(--sh-1);
}

.cp-list-section {
  margin-top: var(--sp-4);
}

.cp-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}

.cp-field:first-of-type {
  margin-top: var(--sp-4);
}

.cp-label {
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .04em;
}

/* 标签里的补充说明：不占一行，但必须可读（--faint 承载不了信息） */
.cp-label-sub {
  margin-left: var(--sp-2);
  color: var(--dim);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
}

/* 12px 是硬下限；说明文字用 --dim，--faint 只够给图标和分隔符 */
.cp-tip {
  margin: var(--sp-2) 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}

.cp-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}

/* 卡片：柔光行，去描边（和表情包页卡片同构） */
.cp-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  transition: background .14s var(--ease);
}
.cp-card:hover,
.cp-card:focus-within {
  background: var(--surface-3);
}

/* 停用：降色不降透明度。原 opacity:.55 会把 12px 灰字一起压到 2:1 以下 */
.cp-card.is-off .cp-phrase,
.cp-card.is-off .cp-usage {
  color: var(--dim);
}

.cp-body {
  flex: 1;
  min-width: 0;
}

.cp-phrase {
  display: flex;
  gap: var(--sp-2);
  align-items: baseline;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  word-break: break-word;
}

.cp-badge {
  flex: none;
  padding: 1px var(--sp-2);
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--dim);
  font-size: 12px;
  font-weight: 400;
}

.cp-usage {
  margin: 3px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}

/* 没写场景的单独标出来：她挑梗时主要看这一栏，缺了就只能猜 */
.cp-usage.is-empty {
  color: var(--amber);
}

.cp-ops {
  display: flex;
  flex: none;
  gap: var(--sp-2);
  align-items: center;
}

/* 「说过 N 次」是信息不是装饰，用 --dim 不用 --faint */
.cp-count {
  color: var(--dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 「从群里捡的」用中性药丸，不抢台词的视觉重量 —— 它只是个来源标注 */
.cp-source {
  padding: 1px var(--sp-2);
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--dim);
  font-size: 12px;
  font-weight: 400;
}

/* ── 待确认弹窗 ── */
.cp-review-intro {
  margin: 0 0 var(--sp-4);
  color: var(--dim);
  font-size: 12px;
  line-height: 1.7;
}

.cp-review-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  /* 候选可能有七八条，弹窗本身不该长到屏幕外面去 */
  max-height: 52vh;
  overflow-y: auto;
}

.cp-review-card {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.cp-review-main {
  flex: 1;
  min-width: 0;
}

.cp-review-phrase {
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  word-break: break-word;
}

.cp-review-usage {
  margin: 3px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}

/* 依据用 --dim 不用 --faint：「出现 5 次」是判断材料，不是装饰 */
.cp-review-evidence {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  color: var(--dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.cp-review-samples {
  margin: var(--sp-2) 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.cp-review-ops {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--sp-2);
}

/* el-button 在纵向 flex 里会被拉满宽，两个按钮宽度还不一致 —— 统一一下 */
.cp-review-ops :deep(.el-button) {
  width: 64px;
  margin-left: 0;
}

.cp-aside {
  margin-left: var(--sp-2);
  color: var(--dim);
  font-size: 12px;
  font-weight: 400;
}

.cp-edit-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

/* 窄窗口下把「说过几次 + 开关 + 编辑 + 删除」挪到台词下面一行，不然台词被挤成一列字 */
@media (max-width: 720px) {
  .cp-card {
    align-items: flex-start;
    flex-direction: column;
  }

  .cp-ops {
    flex-wrap: wrap;
  }
}
</style>
