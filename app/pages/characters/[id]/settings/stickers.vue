<script setup lang="ts">
import { Delete, EditPen, MagicStick, Picture } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

/**
 * 表情包：她自己的图。
 *
 * 与 QQ 内置表情的区别要写在页面上 —— 「为什么我传了图，她还是发那个官方笑脸」
 * 是第一眼就会有的疑问，答案在这里：内置表情是 QQ 自带的那几十张脸，表情包才是她的图，
 * 有素材库时优先用素材库；两边共用同一个「表情」开关和同一个额度（N 分钟最多 N 张）。
 */
type StickerItem = {
  id: string;
  name: string;
  usage: string;
  enabled: boolean;
  mimeType: string;
  sizeBytes: number;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  source: string;
  /** 对应的 QQ 收藏 id。有值 = 这张在 QQ 收藏夹里也有一份。 */
  qqEmojiId: string | null;
  deletedAt: string | null;
};

/** QQ 那边的附带结果：推上去 / 改备注 / 删掉，都可能「本地成功、QQ 没连上」。 */
type QqSideEffect = { ok: boolean; emojiId?: string; error?: string; skipped?: boolean };

type SyncReport = {
  ok: boolean;
  connectionId: string;
  qqTotal: number;
  localTotal: number;
  imported: number;
  adopted: number;
  importedFailed: number;
  rebound: number;
  restored: number;
  trashed: number;
  retriedDelete: number;
  retryDeleteFailed: number;
  pushed: number;
  pushFailed: number;
  pushMissingFile: number;
  namesSynced: number;
  nameSyncFailed: number;
  importOverflow: number;
  pushOverflow: number;
  warnings: string[];
};

type TrashItem = StickerItem & { deletedAt: string };

const route = useRoute();
const id = computed(() => String(route.params.id || ""));

const characterName = ref("");
const loading = ref(true);
const stickers = ref<StickerItem[]>([]);
const saving = ref(false);
/** 角色的「表情」开关。关着的时候传多少张她都不会贴——不写页面上就会有人白传一通。 */
const emojiEnabled = ref(false);
/** 表情额度（跟「表情」开关一起配的）：多少分钟内最多几张。 */
const emojiWindowMinutes = ref(10);
const emojiPerWindow = ref(3);

// ── 排序 + 分页 ────────────────────────────────────────
// 攒到几十张以后一屏放不下，翻到后面就找不到「哪张一直没用过」。
// stickers 始终是全量，页面只渲染 pagedStickers 这一窗。
type SortKey = "recent" | "oldest" | "mostUsed" | "lastUsed" | "fresh";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recent", label: "最近添加" },
  { value: "oldest", label: "最早添加" },
  { value: "mostUsed", label: "用过最多的" },
  { value: "lastUsed", label: "最近用过的" },
  { value: "fresh", label: "一直没用过的" },
];

const sortKey = ref<SortKey>("recent");
const page = ref(1);
const pageSize = ref(12);

/** null 的 lastUsedAt 当 0 处理，这样「最近用过的」自然把没用过的沉到最后。 */
const timeOf = (value: string | null) => (value ? new Date(value).getTime() : 0);

const sortedStickers = computed(() => {
  const rows = [...stickers.value];
  switch (sortKey.value) {
    case "oldest":
      return rows.sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
    case "mostUsed":
      return rows.sort((a, b) => b.useCount - a.useCount || timeOf(b.createdAt) - timeOf(a.createdAt));
    case "lastUsed":
      return rows.sort((a, b) => timeOf(b.lastUsedAt) - timeOf(a.lastUsedAt) || timeOf(b.createdAt) - timeOf(a.createdAt));
    case "fresh":
      // 一次都没用过的一律排前面 —— 这一档就是用来找「白占名额」的那几张。
      return rows.sort(
        (a, b) => Number(a.useCount > 0) - Number(b.useCount > 0) || timeOf(b.createdAt) - timeOf(a.createdAt),
      );
    default:
      return rows.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  }
});

const pagedStickers = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return sortedStickers.value.slice(start, start + pageSize.value);
});

const disabledCount = computed(() => stickers.value.filter((item) => !item.enabled).length);

/**
 * 没写「什么时候用」的张数。
 *
 * 从 QQ 收藏导进来的多半是空的（QQ 那边只有一张图，没有场景），而挑图时模型主要比对的就是这句。
 * 所以这个数要显眼：不补的话，它们会一直排在候选里但永远挑不中。
 */
const untaggedCount = computed(() => stickers.value.filter((item) => !item.usage.trim()).length);
const qqLinkedCount = computed(() => stickers.value.filter((item) => item.qqEmojiId).length);

/** 页码居中显示用：第 13–24 张，共 25 张。 */
const rangeLabel = computed(() => {
  if (!sortedStickers.value.length) return "";
  const start = (page.value - 1) * pageSize.value + 1;
  const end = Math.min(page.value * pageSize.value, sortedStickers.value.length);
  return `第 ${start}–${end} 张，共 ${sortedStickers.value.length} 张`;
});

// 删到最后一页只剩一两张时页码会越界，落回最后一页。
watch([() => sortedStickers.value.length, pageSize], () => {
  const maxPage = Math.max(1, Math.ceil(sortedStickers.value.length / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

const pageDescription = computed(
  () =>
    `她自己的表情图：QQ 内置表情是客户端自带的那几十张脸，谁发都一样；这里传的图会作为图片单独发一条。有表情包时优先用表情包，两者共用同一个「表情」开关，额度是每 ${emojiWindowMinutes.value} 分钟最多 ${emojiPerWindow.value} 张。`,
);

/** 待上传的图（浏览器里的原始文件，还没进表单）。 */
const pendingFile = ref<File | null>(null);
const draftName = ref("");
const draftUsage = ref("");

const MAX_BYTES = 2 * 1024 * 1024;

const imageUrl = (stickerId: string) =>
  `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(stickerId)}/image`;

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** 回收站里显示「什么时候删的」。精确到分钟就够，秒数没人看。 */
const timeLabel = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const canSubmit = computed(() => Boolean(pendingFile.value) && draftName.value.trim().length > 0);

function onFileChange(file: { raw?: File } | null) {
  const raw = file?.raw ?? null;
  if (!raw) {
    pendingFile.value = null;
    return;
  }
  if (raw.size > MAX_BYTES) {
    ElMessage.error(`图片不能超过 ${MAX_BYTES / 1024 / 1024}MB，这张有 ${sizeLabel(raw.size)}。`);
    pendingFile.value = null;
    return;
  }
  pendingFile.value = raw;
  // 换了图，之前那句「按画面生成」就不作数了（场景本身还留着，用户可能就想复用）。
  draftUsageSource.value = "";
  // 没填名字时用文件名（去掉扩展名）兜底：十张图全叫「表情」，页面上根本分不清谁是谁。
  if (!draftName.value.trim()) {
    draftName.value = raw.name.replace(/\.[^.]+$/, "").slice(0, 60);
  }
}

// ── 添加框里的「AI 生成」：图还没入库，浏览器自己缩一张带过去 ──────────
// 这一刻贴纸没有 id，服务端查不到图，所以得由前端把图发过去。
// 但**不能发原图**：QQ 存的图动辄 1~3MB，只为一句场景传几 MB base64 不值当，
// 视觉模型也是图越大越贵 —— 服务端入口那边缩图的道理在这里同样成立。
// 缩不了（HEIC、超大尺寸解码失败）就退回「只看名字」，按钮不该因此失败。
async function previewDataUrl(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 200 / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // 动图只会取到第一帧 —— 视觉模型本来也只能看一帧，和「重新识别」的取舍一致。
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

const generatingDraftUsage = ref(false);
const draftUsageSource = ref<"" | "vision" | "name">("");

async function generateDraftUsage() {
  if (generatingDraftUsage.value) return;
  const name = draftName.value.trim();
  if (!name) {
    ElMessage.error("先在「名字」里写个词，AI 才知道该按什么写场景。");
    return;
  }
  generatingDraftUsage.value = true;
  try {
    const image = pendingFile.value ? await previewDataUrl(pendingFile.value) : null;
    const result = await $fetch<{ usage: string; source: "vision" | "name" }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/usage-suggestion`,
      { method: "POST", body: image ? { name, image } : { name } },
    );
    draftUsage.value = result.usage;
    draftUsageSource.value = result.source;
    ElMessage.success(result.source === "vision" ? "按「名字 + 画面」生成了一句，可以再改。" : "按名字生成了一句，可以再改。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "生成失败。");
  } finally {
    generatingDraftUsage.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    const [character, rows] = await Promise.all([
      $fetch<{ name: string; emojiEnabled?: boolean; emojiWindowMinutes?: number; emojiPerWindow?: number }>(
        `/api/characters/${encodeURIComponent(id.value)}`,
      ),
      $fetch<StickerItem[]>(`/api/characters/${encodeURIComponent(id.value)}/stickers`),
    ]);
    characterName.value = character.name;
    emojiEnabled.value = character.emojiEnabled === true;
    if (typeof character.emojiWindowMinutes === "number") emojiWindowMinutes.value = character.emojiWindowMinutes;
    if (typeof character.emojiPerWindow === "number") emojiPerWindow.value = character.emojiPerWindow;
    stickers.value = rows;
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "读取表情包失败。");
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!pendingFile.value || !canSubmit.value) return;
  saving.value = true;
  try {
    const form = new FormData();
    form.append("file", pendingFile.value);
    form.append("filename", pendingFile.value.name);
    form.append("name", draftName.value.trim().slice(0, 60));
    form.append("usage", draftUsage.value.trim().slice(0, 200));
    const created = await $fetch<StickerItem & { qq?: QqSideEffect }>(`/api/characters/${encodeURIComponent(id.value)}/stickers`, {
      method: "POST",
      body: form,
    });
    stickers.value = [...stickers.value, created];
    // 新加的这张在任何排序下都不一定落在第一页，直接翻到它那一页，省得人以为没传上。
    const index = sortedStickers.value.findIndex((item) => item.id === created.id);
    if (index >= 0) page.value = Math.floor(index / pageSize.value) + 1;
    pendingFile.value = null;
    draftName.value = "";
    draftUsage.value = "";
    draftUsageSource.value = "";
    if (created.qq && !created.qq.ok && !created.qq.skipped) {
      // 本地已经加好了，只是没进 QQ 收藏。不用重传，下次同步会补推。
      ElMessage.warning(`已加到本地，但没能收藏到 QQ：${created.qq.error || "未知原因"}。下次「与 QQ 同步」会补上。`);
    } else {
      ElMessage.success(created.qq?.ok ? "已添加，也收藏到 QQ 了。她下一轮就有这张图。" : "已添加。她下一轮就有这张图了。");
    }
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "上传失败。");
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row: StickerItem, enabled: boolean) {
  try {
    const updated = await $fetch<StickerItem>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(row.id)}`,
      { method: "PATCH", body: { enabled } },
    );
    row.enabled = updated.enabled;
  } catch (error) {
    row.enabled = !enabled;
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "更新失败。");
  }
}

// ── 重新识别：让模型再看一次这张图 ──────────────────────
// 第一次打标常常不准（动图只看到一帧、抽象梗图、带字的图），用户宁可让她再看一次，
// 也不想手打一遍。识别结果直接写库并就地更新这一行 —— 不满意还有「编辑」兜底。
const relabelingId = ref("");

async function relabel(row: StickerItem) {
  if (relabelingId.value) return;
  relabelingId.value = row.id;
  try {
    const result = await $fetch<{ skipped: boolean; message?: string; sticker?: StickerItem }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(row.id)}/relabel`,
      { method: "POST" },
    );
    if (result.skipped) {
      ElMessage.warning(result.message || "模型判断这张不像表情包，名字没有改。");
      return;
    }
    if (!result.sticker) return;
    row.name = result.sticker.name;
    row.usage = result.sticker.usage;
    ElMessage.success(
      result.sticker.usage
        ? `重新识别完成：${result.sticker.name} · ${result.sticker.usage}`
        : `重新识别完成：${result.sticker.name}`,
    );
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "重新识别失败。");
  } finally {
    relabelingId.value = "";
  }
}

// ── 编辑：名字 + 使用场景 ───────────────────────────────
// 自动打标（尤其「偷」来的图）经常判断不准，这里让她自己改回来。
// 只改这两个字段：图本身不换（换图等于换一张表情，应该删了重传）。
const editing = ref<StickerItem | null>(null);
const editName = ref("");
const editUsage = ref("");
const savingEdit = ref(false);

function openEdit(row: StickerItem) {
  editing.value = row;
  editName.value = row.name;
  editUsage.value = row.usage;
  generatedFrom.value = "";
}

// ── 弹窗里的「AI 生成」：只补「什么时候用」这一栏 ──────────────
// 用户常常知道这张图是什么（名字起得出来），但写不出「什么时候用」那句话；
// 而挑图的模型真正比对的是那一句，空着等于这张图永远轮不上。
// 只把建议填进输入框、不进库 —— 用户可能还要改，落库仍走「保存」。
const generatingUsage = ref(false);
const generatedFrom = ref<"" | "vision" | "name">("");

async function generateUsage() {
  const target = editing.value;
  if (!target || generatingUsage.value) return;
  // 传的是**输入框里当前的名字**：用户往往先改了名字才想起来点这个按钮。
  const name = editName.value.trim();
  if (!name) {
    ElMessage.error("先在「名字」里写个词，AI 才知道该按什么写场景。");
    return;
  }
  generatingUsage.value = true;
  try {
    const result = await $fetch<{ usage: string; source: "vision" | "name" }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(target.id)}/usage-suggestion`,
      { method: "POST", body: { name } },
    );
    editUsage.value = result.usage;
    generatedFrom.value = result.source;
    ElMessage.success(result.source === "vision" ? "按「名字 + 画面」生成了一句，可以再改。" : "按名字生成了一句，可以再改。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "生成失败。");
  } finally {
    generatingUsage.value = false;
  }
}

async function saveEdit() {
  const target = editing.value;
  if (!target) return;
  const name = editName.value.trim();
  if (!name) {
    ElMessage.error("名字不能为空。");
    return;
  }
  savingEdit.value = true;
  try {
    const updated = await $fetch<StickerItem & { qqDesc?: QqSideEffect | null }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(target.id)}`,
      { method: "PATCH", body: { name, usage: editUsage.value.trim() } },
    );
    // 就地更新这一行，不整页重拉：列表滚动位置和展开状态都还在。
    target.name = updated.name;
    target.usage = updated.usage;
    editing.value = null;
    if (updated.qqDesc && !updated.qqDesc.ok && !updated.qqDesc.skipped) {
      ElMessage.warning(`本地已改名，但 QQ 里的备注没改上：${updated.qqDesc.error || "未知原因"}。下次同步会再写一次。`);
    } else {
      ElMessage.success(updated.qqDesc?.ok ? "已保存，QQ 里的备注也一起改了。" : "已保存。她下一轮就按新的名字和场景来挑。");
    }
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "保存失败。");
  } finally {
    savingEdit.value = false;
  }
}

async function remove(row: StickerItem) {
  const qqHint = row.qqEmojiId ? "QQ 收藏里的那张会一起删掉，" : "";
  try {
    await ElMessageBox.confirm(
      `删除「${row.name}」？${qqHint}本地会进回收站 30 天，期间还能恢复。`,
      "删除表情包",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  try {
    const result = await $fetch<{ ok: boolean; qq?: QqSideEffect }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(row.id)}`,
      { method: "DELETE" },
    );
    stickers.value = stickers.value.filter((item) => item.id !== row.id);
    if (result.qq && !result.qq.ok && !result.qq.skipped) {
      // 本地已经删掉了，QQ 那边没删掉 —— 下次同步会给「本地删了、QQ 还在」的补删一次。
      ElMessage.warning(`本地已删除，但 QQ 那边没删掉：${result.qq.error || "未知原因"}。下次「与 QQ 同步」会再试。`);
      return;
    }
    ElMessage.success(row.qqEmojiId ? "已删除，QQ 收藏里那张也一起删了。" : "已删除，可以在回收站里恢复。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "删除失败。");
  }
}

// ── 与 QQ 收藏夹同步 ───────────────────────────────────
// 一次点清楚：缺的导下来、多的推上去、QQ 删了的进回收站、名字不一致的写回备注。
// 结果用弹窗逐项列出来 —— 只回一句「同步完成」的话，「QQ 里明明有 5 张怎么只进来 3 张」
// 就无从解释，而原因通常是下载失败或条数上限。
const syncing = ref(false);
const syncReport = ref<SyncReport | null>(null);

async function syncWithQq() {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const report = await $fetch<SyncReport>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/qq-sync`,
      { method: "POST" },
    );
    syncReport.value = report;
    await load();
    if (!report.ok) ElMessage.warning("这次没有同步：QQ 收藏夹看起来不正常，为避免误删本地表情，什么都没动。");
    else if (report.warnings.length) ElMessage.warning("同步完成，但有几处需要看一眼。");
    else ElMessage.success("两边已经一致了。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "同步失败。");
  } finally {
    syncing.value = false;
  }
}

/** 弹窗里的逐项文字。0 的不列，免得一堆「新增 0 张」挡着真正发生的事。 */
const syncLines = computed(() => {
  const report = syncReport.value;
  if (!report) return [];
  const lines: Array<{ label: string; value: string; tone: "up" | "down" | "flat" }> = [];
  // tone 是给 CSS 上色的；符号（↑/↓）独立于颜色，灰度或色弱下方向也读得出来
  const add = (count: number, label: string, tone: "up" | "down" | "flat" = "flat", suffix = "张") => {
    const mark = tone === "up" ? "↑ " : tone === "down" ? "↓ " : "";
    if (count > 0) lines.push({ label, value: `${mark}${count} ${suffix}`, tone });
  };
  add(report.imported, "从 QQ 导进来");
  add(report.adopted, "认出本地已有同图，绑上了 QQ 收藏");
  add(report.pushed, "从本地推到 QQ");
  add(report.rebound, "QQ 里换了 id，重新对上");
  add(report.restored, "QQ 里又出现了，从回收站恢复");
  add(report.trashed, "QQ 里没了，进了回收站", "down");
  add(report.retriedDelete, "补删了 QQ 上该删的");
  add(report.namesSynced, "把名字写进了 QQ 备注");
  add(report.importedFailed, "没能导进来（下次再试）", "down");
  add(report.pushFailed, "没能推到 QQ", "down");
  add(report.pushMissingFile, "本地没有原文件，推不了", "down");
  add(report.importOverflow, "还没导完，再点一次继续", "flat");
  add(report.pushOverflow, "还没推完，再点一次继续", "flat");
  return lines;
});

// ── 回收站 ─────────────────────────────────────────────
// 删掉的表情只是软删：QQ 那边一删本地就没了的话，标签全白打，重收回来还得再打一遍。
const trashOpen = ref(false);
const trashLoading = ref(false);
const trashItems = ref<TrashItem[]>([]);
const trashRetention = ref(30);

async function openTrash() {
  trashOpen.value = true;
  trashLoading.value = true;
  try {
    const result = await $fetch<{ items: TrashItem[]; purged: number; retentionDays: number }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/trash`,
    );
    trashItems.value = result.items;
    trashRetention.value = result.retentionDays;
    if (result.purged) ElMessage.info(`顺手清掉了 ${result.purged} 张超过 ${result.retentionDays} 天没人管的。`);
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "读取回收站失败。");
  } finally {
    trashLoading.value = false;
  }
}

async function restoreFromTrash(item: TrashItem) {
  try {
    const restored = await $fetch<StickerItem>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/trash/${encodeURIComponent(item.id)}/restore`,
      { method: "POST" },
    );
    trashItems.value = trashItems.value.filter((row) => row.id !== item.id);
    stickers.value = [...stickers.value, restored];
    ElMessage.success("已恢复。她下一轮就能用它了。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "恢复失败。");
  }
}

async function purgeOne(item: TrashItem) {
  try {
    await ElMessageBox.confirm(`彻底删除「${item.name}」？图和名字都会没，找不回来。`, "彻底删除", {
      type: "warning",
      confirmButtonText: "彻底删除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/trash/${encodeURIComponent(item.id)}/purge`,
      { method: "DELETE" },
    );
    trashItems.value = trashItems.value.filter((row) => row.id !== item.id);
    ElMessage.success("已彻底删除。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "删除失败。");
  }
}

/**
 * 给没写场景的那些逐张「重新识别」。
 *
 * 从 QQ 导进来的表情带着图但没带场景，而模型挑图时看的就是那句 —— 空着等于白占名额。
 * 逐张调模型是花钱的，所以只在用户主动点的时候跑，并且按顺序一张一张来：
 * 并发打标会一起撞上每日额度，还会把日志刷成一片。
 */
const labelingAll = ref(false);
const labelProgress = ref({ done: 0, total: 0 });

async function labelUntagged() {
  const targets = stickers.value.filter((item) => !item.usage.trim());
  if (!targets.length || labelingAll.value) return;
  try {
    await ElMessageBox.confirm(
      `给 ${targets.length} 张没写场景的表情逐张识别？每张都会调一次模型，可能要一会儿。`,
      "补使用场景",
      { confirmButtonText: "开始", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  labelingAll.value = true;
  labelProgress.value = { done: 0, total: targets.length };
  let ok = 0;
  for (const row of targets) {
    try {
      const result = await $fetch<{ skipped: boolean; message?: string; sticker?: StickerItem }>(
        `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(row.id)}/relabel`,
        { method: "POST" },
      );
      if (result.sticker) {
        row.name = result.sticker.name;
        row.usage = result.sticker.usage;
        ok += 1;
      }
    } catch {
      // 单张失败不影响后面的：可能是额度用完，也可能是这张解不开。最后统一报个数。
    }
    labelProgress.value.done += 1;
  }
  labelingAll.value = false;
  ElMessage.success(`补好了 ${ok} / ${targets.length} 张，没补上的可以手动写或再点一次。`);
}

onMounted(load);
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :eyebrow="'角色管理 / ' + (characterName || '角色') + ' / 表情包'"
      title="表情包"
      :description="pageDescription"
      :back-to="'/characters?c=' + id"
      back-label="返回角色列表"
    />

    <div
      v-if="!loading && !emojiEnabled"
      class="sticker-warn"
    >
      角色的「表情」开关现在是关的 —— 开了她才会贴图（在「模型设置 → 表情」里打开）。
    </div>

    <section
      v-loading="loading"
      class="sticker-add"
    >
      <div class="sec-h">
        <h2>添加一张</h2>
        <span class="sec-sub">名字写情绪词，场景帮她在十几张里挑对</span>
      </div>

      <div class="sticker-form">
        <el-upload
          accept="image/png,image/jpeg,image/gif,image/webp"
          :auto-upload="false"
          :show-file-list="false"
          :limit="1"
          @change="onFileChange($event as unknown as { raw?: File })"
        >
          <template #trigger>
            <el-button>
              <el-icon><Picture /></el-icon>选择图片
            </el-button>
          </template>
        </el-upload>
        <span class="form-help">
          {{ pendingFile ? `已选：${pendingFile.name}（${sizeLabel(pendingFile.size)}）` : "PNG / JPG / GIF / WebP，最大 2MB" }}
        </span>
      </div>
      <p class="sticker-hint">
        宽于 200px 的图会自动等比缩小（高度跟着变），比 200 窄的原样保留 ——
        QQ 按图片原始像素显示，不缩的话一张 1500px 的图在聊天窗里会占满一屏。
      </p>

      <div class="sticker-form-fields">
        <label class="sticker-field">
          <span class="sticker-label">名字</span>
          <el-input
            v-model="draftName"
            maxlength="60"
            placeholder="委屈 / 得意 / 拍桌笑"
          />
        </label>
        <div class="sticker-field sticker-field-wide">
          <div class="sticker-label-row">
            <span class="sticker-label">什么时候用</span>
            <el-button
              link
              type="primary"
              size="small"
              :loading="generatingDraftUsage"
              title="按名字生成一句使用场景；已选图的话会顺带参考画面"
              @click="generateDraftUsage"
            >
              <el-icon><MagicStick /></el-icon>AI 生成
            </el-button>
          </div>
          <el-input
            v-model="draftUsage"
            maxlength="200"
            placeholder="被冤枉、想撒娇的时候用"
          />
        </div>
      </div>
      <p
        v-if="draftUsageSource"
        class="sticker-hint"
      >
        {{ draftUsageSource === "vision" ? "这句是按「名字 + 画面」生成的。" : "这句只按名字生成，她没看到图。" }}不满意可以直接改，再点「添加」就存这个。
      </p>

      <div class="sticker-add-foot">
        <el-button
          type="primary"
          :disabled="!canSubmit"
          :loading="saving"
          @click="submit"
        >
          添加
        </el-button>
      </div>
    </section>

    <section class="sticker-shelf">
      <div class="sec-h">
        <h2>
          已有 {{ stickers.length }} 张
          <span
            v-if="disabledCount"
            class="title-aside"
          >停用 {{ disabledCount }} 张</span>
        </h2>
        <span class="sec-sub">停用的图不会被用到；用过几次、最近什么时候用都记在这里</span>
        <div class="sticker-head-ops">
          <el-button
            :loading="syncing"
            title="和 QQ 收藏夹双向对账：QQ 多的导进来、本地多的推上去、QQ 删了的进回收站"
            @click="syncWithQq"
          >
            与 QQ 同步
          </el-button>
          <el-button @click="openTrash">
            回收站
          </el-button>
        </div>
      </div>

      <p
        v-if="qqLinkedCount"
        class="sticker-hint"
      >
        其中 {{ qqLinkedCount }} 张和 QQ 收藏夹是同一份：在这里改名会写进 QQ 备注，在这里删除 QQ 那张也会一起删。
      </p>
      <p
        v-else
        class="sticker-hint"
      >
        还没和 QQ 收藏夹对上。点「与 QQ 同步」是双向的：QQ 里多出来的导进来，本地多出来的推上去，QQ 那边删了的进回收站。
      </p>

      <div
        v-if="untaggedCount"
        class="sticker-warn sticker-warn-inline"
      >
        <span>{{ untaggedCount }} 张还没写「什么时候用」—— 挑图时她主要看这句，空着基本轮不上。</span>
        <el-button
          link
          type="primary"
          size="small"
          :loading="labelingAll"
          @click="labelUntagged"
        >
          {{ labelingAll ? `识别中 ${labelProgress.done}/${labelProgress.total}` : "逐张识别补上" }}
        </el-button>
      </div>

      <div
        v-if="stickers.length"
        class="sticker-toolbar"
      >
        <span class="sticker-label">排序</span>
        <el-select
          v-model="sortKey"
          style="width: 150px"
        >
          <el-option
            v-for="option in SORT_OPTIONS"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <span class="sticker-range">{{ rangeLabel }}</span>
      </div>

      <div
        v-if="stickers.length"
        class="sticker-list"
      >
        <div
          v-for="sticker in pagedStickers"
          :key="sticker.id"
          class="sticker-card"
          :class="{ 'is-off': !sticker.enabled }"
        >
          <img
            class="sticker-thumb"
            :src="imageUrl(sticker.id)"
            :alt="sticker.name"
          >
          <div class="sticker-body">
            <div class="sticker-name">
              {{ sticker.name }}
              <span class="sticker-count">用过 {{ sticker.useCount }} 次</span>
              <span
                v-if="sticker.source === 'collected'"
                class="sticker-source"
              >从群里收的</span>
              <span
                v-if="sticker.qqEmojiId"
                class="sticker-source sticker-source-qq"
              >QQ 收藏</span>
            </div>
            <p
              class="sticker-usage"
              :class="{ 'is-empty': !sticker.usage }"
            >
              {{ sticker.usage || "还没写什么时候用，她只能凭名字猜" }}
            </p>
          </div>
          <div class="sticker-ops">
            <el-switch
              :model-value="sticker.enabled"
              @update:model-value="(value) => toggleEnabled(sticker, Boolean(value))"
            />
            <el-button
              link
              type="primary"
              :loading="relabelingId === sticker.id"
              :disabled="Boolean(relabelingId) && relabelingId !== sticker.id"
              title="让 AI 重新看一次这张图，重写名字和使用场景"
              @click="relabel(sticker)"
            >
              <el-icon><MagicStick /></el-icon>重新识别
            </el-button>
            <el-button
              link
              type="primary"
              @click="openEdit(sticker)"
            >
              <el-icon><EditPen /></el-icon>编辑
            </el-button>
            <el-button
              link
              type="danger"
              @click="remove(sticker)"
            >
              <el-icon><Delete /></el-icon>删除
            </el-button>
          </div>
        </div>
      </div>

      <div
        v-if="sortedStickers.length > pageSize"
        class="sticker-pager"
      >
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="sortedStickers.length"
          :page-sizes="[12, 24, 48]"
          :pager-count="5"
          layout="sizes, prev, pager, next"
          size="small"
          background
        />
      </div>

      <p
        v-else-if="!stickers.length"
        class="sticker-empty"
      >
        还没有表情包。传一张，她回复时就能贴自己的图了。
      </p>
    </section>

    <el-dialog
      :model-value="Boolean(editing)"
      title="编辑表情包"
      width="440px"
      @update:model-value="(value: boolean) => { if (!value) editing = null; }"
    >
      <div
        v-if="editing"
        class="edit-body"
      >
        <img
          class="edit-thumb"
          :src="imageUrl(editing.id)"
          :alt="editing.name"
        >
        <label class="sticker-field">
          <span class="sticker-label">名字</span>
          <el-input
            v-model="editName"
            maxlength="60"
            placeholder="委屈 / 得意 / 拍桌笑"
          />
        </label>
        <div class="sticker-field">
          <div class="sticker-label-row">
            <span class="sticker-label">什么时候用</span>
            <el-button
              link
              type="primary"
              size="small"
              :loading="generatingUsage"
              title="按名字生成一句使用场景；开了「看图」会顺带参考画面"
              @click="generateUsage"
            >
              <el-icon><MagicStick /></el-icon>AI 生成
            </el-button>
          </div>
          <el-input
            v-model="editUsage"
            maxlength="200"
            placeholder="被冤枉、想撒娇的时候用"
          />
        </div>
        <p
          v-if="generatedFrom"
          class="edit-hint"
        >
          {{ generatedFrom === "vision" ? "这句是按「名字 + 画面」生成的。" : "这句只按名字生成，她没看到图。" }}不满意可以直接改。
        </p>
        <p class="edit-hint">
          她挑图时看的就是这两项。名字写情绪词、场景写具体一点，比「表情1」「好笑的图」好挑得多。
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

    <el-dialog
      :model-value="Boolean(syncReport)"
      title="与 QQ 收藏夹同步"
      width="480px"
      @update:model-value="(value: boolean) => { if (!value) syncReport = null; }"
    >
      <div
        v-if="syncReport"
        class="sync-body"
      >
        <p class="sync-summary">
          QQ 收藏夹 {{ syncReport.qqTotal }} 条 · 本地 {{ syncReport.localTotal }} 张（含回收站）
        </p>

        <div
          v-if="!syncReport.ok"
          class="sticker-warn sticker-warn-inline"
        >
          这次什么都没动 —— 结果太可疑了，宁可不同步也不能误删。
        </div>

        <ul
          v-else-if="syncLines.length"
          class="sync-lines"
        >
          <li
            v-for="line in syncLines"
            :key="line.label"
            :class="'is-' + line.tone"
          >
            <span>{{ line.label }}</span>
            <strong>{{ line.value }}</strong>
          </li>
        </ul>
        <p
          v-else
          class="sync-summary"
        >
          两边已经一致，没有要改的。
        </p>

        <ul
          v-if="syncReport.warnings.length"
          class="sync-warnings"
        >
          <li
            v-for="(warning, index) in syncReport.warnings"
            :key="index"
          >
            {{ warning }}
          </li>
        </ul>
      </div>
      <template #footer>
        <el-button
          type="primary"
          @click="syncReport = null"
        >
          知道了
        </el-button>
      </template>
    </el-dialog>

    <el-drawer
      v-model="trashOpen"
      title="回收站"
      size="420px"
    >
      <div
        v-loading="trashLoading"
        class="trash-body"
      >
        <p class="sync-summary">
          删掉的表情会先放在这里 {{ trashRetention }} 天，期间随时能恢复；超过就自动清掉。
        </p>

        <div
          v-for="item in trashItems"
          :key="item.id"
          class="trash-item"
        >
          <img
            class="trash-thumb"
            :src="imageUrl(item.id)"
            :alt="item.name"
          >
          <div class="trash-info">
            <div class="trash-name">
              {{ item.name }}
            </div>
            <div class="trash-time">
              删除于 {{ timeLabel(item.deletedAt) }}<template v-if="item.qqEmojiId">
                · 曾在 QQ 收藏里
              </template>
            </div>
          </div>
          <div class="trash-ops">
            <el-button
              link
              type="primary"
              size="small"
              @click="restoreFromTrash(item)"
            >
              恢复
            </el-button>
            <el-button
              link
              type="danger"
              size="small"
              @click="purgeOne(item)"
            >
              彻底删除
            </el-button>
          </div>
        </div>

        <p
          v-if="!trashLoading && !trashItems.length"
          class="section-description"
        >
          回收站是空的。
        </p>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   表情包页 —— 单列，套用总览页 C 套「柔光轨道」的语言：
   白卡柔光、去描边、行内 3px 轨道说状态、语义色只用一套变量。
   层次只落在明度 / 字号 / 形状，不靠 1px 描边补层次。
   字号 12 / 14 / 16，间距走 --sp-*，信息文字用 --dim（--faint 只给装饰）。
   ══════════════════════════════════════════════════════════════ */

/* 区块标题：与总览 C 套同构，一块「加图」一块「已有」 */
.sec-h {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-3);
}
.sec-h h2 {
  margin: 0;
  color: var(--text);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -.01em;
}
.sec-sub {
  color: var(--dim);
  font-size: 12px;
}
.sec-h .sticker-head-ops {
  margin-left: auto;
}

/* 加图块 / 已有块：白卡 + 柔光，零描边 */
.sticker-add,
.sticker-shelf {
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--sp-4) var(--sp-5);
  box-shadow: var(--sh-1);
}
.sticker-shelf {
  margin-top: var(--sp-5);
}

/* 开关没开的提醒条：琥珀软底 + 左侧实色轨道，不描边 */
.sticker-warn {
  margin-bottom: var(--sp-4);
  border-radius: var(--radius);
  background: var(--amber-soft);
  box-shadow: inset 3px 0 0 var(--amber);
  padding: var(--sp-3) var(--sp-4);
  color: var(--amber);
  font-size: 12px;
  line-height: 1.7;
}

.sticker-form {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

/* 说明文字：12px + --dim。原来用 #8a90a6（约 3.4:1）承载信息，不达 AA */
.sticker-hint {
  margin: var(--sp-2) 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}

.sticker-form-fields {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
  flex-wrap: wrap;
}

.sticker-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 180px;
}

.sticker-field-wide {
  flex: 1;
  min-width: 240px;
}

/* 两栏的标签行必须同高：右边挂了「AI 生成」的那一格会比纯文字高一点，
   高度不定死，并排时两个输入框就错开半个字（实测错 6px，看着像没对齐）。 */
.sticker-label,
.sticker-label-row {
  display: flex;
  align-items: center;
  min-height: 20px;
  line-height: 20px;
}

/* 字段标签：12px/600，色用 --text-2。原来的 --ink-2 变量不存在，一直吃 fallback */
.sticker-label {
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}

/* 标签右侧挂一个「AI 生成」：贴着它服务的那一栏，比放到弹窗底部更不容易找错。 */
.sticker-label-row {
  justify-content: space-between;
  gap: var(--sp-2);
}

.sticker-label-row .el-button {
  font-size: 12px;
  padding: 0;
  height: auto;
}

.sticker-add-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--sp-4);
}

.sticker-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.sticker-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.sticker-range {
  margin-left: auto;
  color: var(--dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.sticker-pager {
  display: flex;
  justify-content: center;
  margin-top: var(--sp-4);
}

.title-aside {
  margin-left: var(--sp-2);
  color: var(--dim);
  font-size: 12px;
  font-weight: 400;
}

/* 卡片：柔光行，去描边。状态轨道长在左侧，hover 才上浅底 */
.sticker-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  border-radius: var(--radius-sm);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface-2);
  transition: background .14s var(--ease);
}
.sticker-card::before {
  position: absolute;
  left: 0;
  top: 50%;
  height: 24px;
  margin-top: -12px;
  width: 3px;
  border-radius: 2px;
  background: transparent;
  content: "";
}
.sticker-card:hover,
.sticker-card:focus-within {
  background: var(--surface-3);
}

/* 停用：降色不降透明度。原来的 opacity:.55 会把 12px 灰字一起压到 2:1 以下 */
.sticker-card.is-off {
  background: var(--surface-2);
}
.sticker-card.is-off .sticker-name,
.sticker-card.is-off .sticker-usage {
  color: var(--dim);
}
.sticker-card.is-off .sticker-thumb {
  filter: grayscale(1);
  opacity: .7;
}

.sticker-body {
  flex: 1;
  min-width: 0;
}

/* 名字 + 次数 + 来源 + QQ 标签：标签多了掉第二行，名字本身不断字 */
.sticker-name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: var(--sp-2);
  row-gap: 2px;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.sticker-count {
  color: var(--dim);
  font-size: 12px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

/* 来源药丸统一中性色：只是标注，不抢名字的视觉重量。
   原来的 #7c5cd6 是全站唯一紫，另造一套只会让药丸长得比名字还响 */
.sticker-source {
  color: var(--dim);
  background: var(--surface-3);
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
}

.sticker-usage {
  margin: 2px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}

/* 没写场景的单独标出来：她挑图时看的就是名字 + 场景，缺一项就容易挑错。 */
.sticker-usage.is-empty {
  color: var(--amber);
}

.sticker-ops {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: none;
}

.sticker-thumb {
  width: 48px;
  height: 48px;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  flex: none;
}

/* 编辑弹窗 */
.edit-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.edit-thumb {
  width: 96px;
  height: 96px;
  object-fit: contain;
  border-radius: var(--radius);
  background: var(--surface-3);
  align-self: flex-start;
}

.edit-hint {
  margin: 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}

/* ── QQ 同步 / 回收站 ─────────────────────────────── */

.sticker-head-ops {
  display: flex;
  gap: var(--sp-2);
  flex: none;
}

/* 提示条放进列表里时不要外上边距，否则会把它和排序栏顶开一行。 */
.sticker-warn-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  flex-wrap: wrap;
}

/* QQ 收藏角标：复用绿色语义变量，不再另造 #e6f6ee / #1a7f56 */
.sticker-source-qq {
  color: var(--green);
  background: var(--green-soft);
}

/* ── 同步弹窗 ── */

.sync-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.sync-summary {
  margin: 0;
  color: var(--text-2);
  font-size: 14px;
}

.sync-lines {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.sync-lines li {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: var(--sp-2) var(--sp-3);
  color: var(--text-2);
  font-size: 13px;
}

/* 状态不只靠颜色一个通道：方向上/下用「入/出」符号一起说，色弱和灰度下也分得清 */
.sync-lines li.is-up strong {
  color: var(--green);
}
.sync-lines li.is-down strong {
  color: var(--red);
}

.sync-warnings {
  margin: 0;
  padding: var(--sp-3) var(--sp-3) var(--sp-3) 26px;
  border-radius: var(--radius);
  background: var(--amber-soft);
  box-shadow: inset 3px 0 0 var(--amber);
  color: var(--amber);
  font-size: 12px;
  line-height: 1.7;
}

/* ── 回收站抽屉 ── */

.trash-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 120px;
}

.trash-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: var(--sp-2);
}

.trash-thumb {
  width: 48px;
  height: 48px;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  flex: none;
}

.trash-info {
  flex: 1;
  min-width: 0;
}

.trash-name {
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-time {
  margin-top: 2px;
  color: var(--dim);
  font-size: 12px;
}

.trash-ops {
  display: flex;
  gap: var(--sp-1);
  flex-shrink: 0;
}

.sticker-empty {
  margin: 0;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: var(--sp-5) var(--sp-4);
  color: var(--dim);
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}

/* 窄屏：加图字段从横排折成上下，卡片名字与操作堆叠 */
@media (max-width: 720px) {
  .sticker-form-fields {
    flex-direction: column;
  }
  .sticker-field,
  .sticker-field-wide {
    min-width: 0;
  }
  .sticker-card {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .sticker-ops {
    justify-content: flex-start;
  }
}
</style>
