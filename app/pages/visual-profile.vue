<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Check, Delete, Edit, Minus, Plus, Upload } from "@element-plus/icons-vue";

definePageMeta({
  topbar: {
    title: "形象档案",
    crumbs: [{ label: "工作空间" }],
  },
});

type VersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
type VisualVersion = {
  id: string;
  revision: number;
  status: VersionStatus;
  note: string;
  createdAt: string;
  publishedAt: string | null;
  snapshot?: Record<string, unknown> | null;
};
type VisualAsset = {
  id: string;
  kind: string;
  label: string;
  relativePath: string;
  mime: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  createdAt?: string;
};
type VisualOutfit = { id: string; name: string; prompt: string; isDefault: boolean };
type VisualProfile = {
  id: string;
  coreAppearance: string;
  corePrompt: string;
  negativePrompt: string;
  currentPublishedRevision: number;
  assets: VisualAsset[];
  outfits: VisualOutfit[];
  versions: VisualVersion[];
};

type SectionKey = "overview" | "core" | "outfit" | "assets" | "versions";

/** 用途枚举 → 中文名 + 归档分组。后端只认枚举值，中文名只在这一层出现。 */
const ASSET_KINDS = [
  { value: "STANDARD", group: "标准形象", label: "标准形象" },
  { value: "FRONT_VIEW", group: "三视图", label: "正面视图" },
  { value: "SIDE_VIEW", group: "三视图", label: "侧面视图" },
  { value: "BACK_VIEW", group: "三视图", label: "背面视图" },
  { value: "EXPRESSION", group: "表情参考", label: "表情参考" },
  { value: "OUTFIT", group: "服装与配饰", label: "服装参考" },
  { value: "ACCESSORY", group: "服装与配饰", label: "配饰参考" },
  { value: "SUPPLEMENT", group: "补充素材", label: "补充素材" },
] as const;
const ASSET_GROUPS = ["标准形象", "三视图", "表情参考", "服装与配饰", "补充素材"];
const VIEW_KINDS = [
  { kind: "FRONT_VIEW", label: "正面视图" },
  { kind: "SIDE_VIEW", label: "侧面视图" },
  { kind: "BACK_VIEW", label: "背面视图" },
];
const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "core", label: "核心形象" },
  { key: "outfit", label: "服装造型" },
  { key: "assets", label: "参考素材" },
  { key: "versions", label: "版本历史" },
];
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const api = useApiRequest();

const profile = ref<VisualProfile | null>(null);
const coreAppearance = ref("");
const corePrompt = ref("");
const negativePrompt = ref("");
const versionNote = ref("");
const activeSection = ref<SectionKey>("overview");
const versionFilter = ref<"all" | "published" | "draft">("all");

const uploadFile = ref<File | null>(null);
const referenceFileInput = ref<HTMLInputElement | null>(null);
const uploadLabel = ref("");
const uploadKind = ref<string>("STANDARD");
const uploading = ref(false);
const dragging = ref(false);

const loading = ref(false);
const saving = ref(false);
const publishing = ref(false);
const restoringVersionId = ref<string | null>(null);
const loadError = ref("");
const draftRevision = ref<number | null>(null);

const outfitName = ref("");
const outfitPrompt = ref("");
const outfitIsDefault = ref(false);
const editingOutfitId = ref<string | null>(null);
const outfitSaving = ref(false);

let requestVersion = 0;
let disposed = false;

const versions = computed(() => profile.value?.versions ?? []);
const outfits = computed(() => profile.value?.outfits ?? []);
const assets = computed(() => profile.value?.assets ?? []);
const publishedVersion = computed(() => versions.value.find(
  item => item.revision === profile.value?.currentPublishedRevision,
) ?? null);
const draftVersion = computed(() => versions.value.find(item => item.status === "DRAFT") ?? null);
const defaultOutfit = computed(() => outfits.value.find(item => item.isDefault) ?? null);
const standardAsset = computed(() => assets.value.find(asset => asset.kind === "STANDARD") ?? null);
/** 会作为参考图发出去的素材：标准形象 + 三视图，与后端 REFERENCE_KINDS 对齐。 */
const REFERENCE_KINDS = ["STANDARD", "FRONT_VIEW", "SIDE_VIEW", "BACK_VIEW"];
const referenceAssetCount = computed(() => assets.value.filter(asset => REFERENCE_KINDS.includes(asset.kind)).length);

const personLength = computed(() => coreAppearance.value.trim().length);
const promptLength = computed(() => corePrompt.value.trim().length);

const hasUncommittedEdits = computed(() => {
  const coreChanged = coreAppearance.value !== (profile.value?.coreAppearance ?? "")
    || corePrompt.value !== (profile.value?.corePrompt ?? "")
    || negativePrompt.value !== (profile.value?.negativePrompt ?? "");
  return coreChanged || Boolean(outfitName.value.trim() || outfitPrompt.value.trim());
});

const publishedSnapshot = computed<Record<string, unknown>>(() => {
  const snapshot = publishedVersion.value?.snapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
});
const textOf = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * 当前正式版本正在引用的素材。
 *
 * 服务端对这类素材直接 409：删了会让版本快照指向已失效的文件。既然按钮点不出结果，
 * 就别让人点完才知道 —— 悬停有说明，点了也直接说清要先发布新版本。
 */
const lockedAssetIds = computed(() => {
  const assets = publishedSnapshot.value.assets;
  if (!Array.isArray(assets)) return new Set<string>();
  return new Set(assets
    .map(item => (item && typeof item === "object" ? (item as Record<string, unknown>).id : null))
    .filter((id): id is string => typeof id === "string"));
});
const isLockedAsset = (assetId: string) => lockedAssetIds.value.has(assetId);
const LOCKED_ASSET_HINT = "这张图正被当前正式版本使用。先上传替代图、保存并发布新版本，它才能删。";

/** 与正式版本逐项比较，概览和核心形象右栏都用这份结果。 */
const draftChanges = computed(() => {
  if (!profile.value?.currentPublishedRevision) {
    return [{ title: "还没有正式版本", detail: "发布后这套设定才会进入绘图" }];
  }
  const base = publishedSnapshot.value;
  const rows: Array<{ title: string; detail: string }> = [];
  if (coreAppearance.value.trim() !== textOf(base.coreAppearance).trim()) {
    rows.push({ title: "外貌设定", detail: `已修改，当前 ${personLength.value} 字` });
  }
  if (corePrompt.value.trim() !== textOf(base.corePrompt).trim()) {
    rows.push({ title: "核心提示词", detail: `已修改，当前 ${promptLength.value} 字` });
  }
  if (negativePrompt.value.trim() !== textOf(base.negativePrompt).trim()) {
    rows.push({ title: "负面提示词", detail: "已修改" });
  }
  const baseOutfit = Array.isArray(base.outfits)
    ? (base.outfits.find(item => item && typeof item === "object"
      && (item as Record<string, unknown>).isDefault === true) as Record<string, unknown> | undefined)
    : undefined;
  if (textOf(baseOutfit?.prompt).trim() !== (defaultOutfit.value?.prompt ?? "").trim()) {
    rows.push({ title: "默认造型", detail: defaultOutfit.value ? `当前「${defaultOutfit.value.name}」` : "已清空" });
  }
  return rows;
});

/** 提示词按逗号切分做集合差，够用且不引依赖。 */
function diffTokens(next: string, base: string) {
  const split = (value: string) => value.split(/[,，;；\n]/u).map(item => item.trim()).filter(Boolean);
  const baseSet = new Set(split(base));
  const nextSet = new Set(split(next));
  return {
    added: split(next).filter(token => !baseSet.has(token)),
    removed: split(base).filter(token => !nextSet.has(token)),
  };
}
const publishedPromptDiff = computed(() => diffTokens(corePrompt.value, textOf(publishedSnapshot.value.corePrompt)));
const diffTitle = computed(() => (profile.value?.currentPublishedRevision
  ? `与正式版 v${profile.value.currentPublishedRevision} 的差异`
  : "待发布的改动"));

const assetGroups = computed(() => ASSET_GROUPS
  .map(group => ({
    group,
    items: assets.value.filter(asset => (ASSET_KINDS.find(kind => kind.value === asset.kind)?.group ?? "补充素材") === group),
  }))
  .filter(group => group.items.length > 0));

const viewGaps = computed(() => {
  const have = new Set(assets.value.map(asset => asset.kind));
  return VIEW_KINDS.filter(item => !have.has(item.kind));
});

const readiness = computed(() => {
  const hasCore = Boolean(coreAppearance.value.trim() || profile.value?.coreAppearance.trim());
  const hasPrompt = Boolean(corePrompt.value.trim() || profile.value?.corePrompt.trim());
  const hasDefault = Boolean(defaultOutfit.value);
  const hasStandard = Boolean(standardAsset.value);
  const viewsComplete = viewGaps.value.length === 0;
  return [
    { key: "appearance", title: "核心外貌", done: hasCore, detail: hasCore ? "发色、瞳色、体型与标志性特征已确定" : "还没写外貌设定", action: hasCore ? "" : "去填写" },
    { key: "prompt", title: "核心绘图提示词", done: hasPrompt, detail: hasPrompt ? `当前 ${promptLength.value} 字` : "没有提示词时只会按本轮画面画", action: hasPrompt ? "" : "去填写" },
    { key: "outfit", title: "默认造型", done: hasDefault, detail: hasDefault ? `「${defaultOutfit.value?.name}」` : "没有默认造型，未指定服装时不会加着装描述", action: hasDefault ? "" : "去新建" },
    { key: "standard", title: "标准形象图", done: hasStandard, detail: hasStandard ? "已上传，会作为参考图随生成一起发出" : "建议补一张", action: hasStandard ? "" : "去上传" },
    { key: "views", title: "三视图完整", done: viewsComplete, detail: viewsComplete ? "正面、侧面、背面齐全" : `缺 ${viewGaps.value.map(item => item.label).join("、")}`, action: viewsComplete ? "" : "去补齐" },
  ];
});
const readyCount = computed(() => readiness.value.filter(item => item.done).length);

const filteredVersions = computed(() => {
  if (versionFilter.value === "published") {
    return versions.value.filter(item => item.revision === profile.value?.currentPublishedRevision);
  }
  if (versionFilter.value === "draft") return versions.value.filter(item => item.status === "DRAFT");
  return versions.value;
});
const publishedCount = computed(() => (profile.value?.currentPublishedRevision ? 1 : 0));
const draftCount = computed(() => versions.value.filter(item => item.status === "DRAFT").length);
const negativeCount = computed(() => negativePrompt.value.trim()
  ? negativePrompt.value.split(/[,，;；]/u).filter(item => item.trim()).length
  : 0);

const formatBytes = (bytes: number) => (bytes >= 1048576
  ? `${(bytes / 1048576).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const formatTime = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "");
const kindLabel = (kind: string) => ASSET_KINDS.find(item => item.value === kind)?.label ?? "补充素材";
/** 快照里的素材引用；旧版本没有这个字段，返回 null 表示「当时没记录」。 */
const versionAssetCount = (item: VisualVersion) => {
  const snapshot = item.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const assets = (snapshot as Record<string, unknown>).assets;
  return Array.isArray(assets) ? assets.length : null;
};
const assetUrl = (assetId: string) =>
  `/api/characters/${encodeURIComponent(characterId.value)}/visual-profile/assets/${encodeURIComponent(assetId)}`;

function goToSection(section: SectionKey) {
  activeSection.value = section;
}
function goFix(action: string) {
  if (action === "去补齐") {
    uploadKind.value = viewGaps.value[0]?.kind ?? "FRONT_VIEW";
    activeSection.value = "assets";
    return;
  }
  if (action === "去上传") {
    uploadKind.value = "STANDARD";
    activeSection.value = "assets";
    return;
  }
  activeSection.value = action === "去新建" ? "outfit" : "core";
}
function pickGapUpload() {
  uploadKind.value = viewGaps.value[0]?.kind ?? "FRONT_VIEW";
  referenceFileInput.value?.click();
}

async function loadProfile(options: { preserveEditor?: boolean } = {}) {
  const preservedEditor = options.preserveEditor ? {
    coreAppearance: coreAppearance.value,
    corePrompt: corePrompt.value,
    negativePrompt: negativePrompt.value,
  } : null;
  const target = characterId.value;
  const version = ++requestVersion;
  profile.value = null;
  draftRevision.value = null;
  loadError.value = "";
  if (!target) return;
  loading.value = true;
  const current = () => !disposed && requestVersion === version && characterId.value === target;
  try {
    const result = await api<{ characterId: string; profile: VisualProfile | null }>({
      url: `/characters/${encodeURIComponent(target)}/visual-profile`,
    });
    if (!current()) return;
    if (result.characterId !== target) throw new Error("角色数据不匹配");
    profile.value = result.profile;
    draftRevision.value = result.profile?.versions.find(item => item.status === "DRAFT")?.revision ?? null;
    coreAppearance.value = preservedEditor?.coreAppearance ?? result.profile?.coreAppearance ?? "";
    corePrompt.value = preservedEditor?.corePrompt ?? result.profile?.corePrompt ?? "";
    negativePrompt.value = preservedEditor?.negativePrompt ?? result.profile?.negativePrompt ?? "";
  } catch {
    if (current()) loadError.value = "读取形象档案失败，请检查网络后重试。";
  } finally {
    if (current()) loading.value = false;
  }
}

function acceptFile(file: File) {
  if (!file.type.startsWith("image/")) {
    ElMessage.error("只支持 PNG / JPG / WebP 图片。");
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    ElMessage.error("参考图片不能超过 12MB。");
    return;
  }
  uploadFile.value = file;
  if (!uploadLabel.value.trim()) uploadLabel.value = file.name.replace(/\.[^.]+$/u, "").slice(0, 120);
}

function onReferenceFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  if (!file) return;
  acceptFile(file);
  if (!uploadFile.value) input.value = "";
}

function onDragOver() {
  dragging.value = true;
}
function onDragLeave() {
  dragging.value = false;
}
function onDrop(event: DragEvent) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0] ?? null;
  if (file) acceptFile(file);
}
function clearUploadFile() {
  uploadFile.value = null;
  uploadLabel.value = "";
  if (referenceFileInput.value) referenceFileInput.value.value = "";
}

async function uploadReference() {
  const target = characterId.value;
  if (!target || !uploadFile.value || !uploadLabel.value.trim() || uploading.value) return;
  uploading.value = true;
  try {
    const form = new FormData();
    form.append("file", uploadFile.value, uploadFile.value.name);
    form.append("kind", uploadKind.value);
    form.append("label", uploadLabel.value.trim().slice(0, 120));
    await api({ url: `/characters/${encodeURIComponent(target)}/visual-profile/assets`, method: "post", data: form });
    if (characterId.value !== target) return;
    clearUploadFile();
    ElMessage.success("参考图片已保存。");
    await loadProfile({ preserveEditor: true });
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "参考图片上传失败。");
  } finally {
    uploading.value = false;
  }
}

async function deleteReference(assetId: string) {
  const target = characterId.value;
  if (!target) return;
  if (isLockedAsset(assetId)) {
    ElMessage.warning(LOCKED_ASSET_HINT);
    return;
  }
  try {
    await api({ url: `/characters/${encodeURIComponent(target)}/visual-profile/assets/${encodeURIComponent(assetId)}`, method: "delete" });
    if (characterId.value !== target) return;
    ElMessage.success("参考图片已删除。");
    await loadProfile({ preserveEditor: true });
  } catch (error) {
    // 409 的原文是「仍被当前正式版本引用，请先发布一个不再引用它的新版本」——
    // 这才是用户需要知道的那句。吞掉它只留「删除失败」，等于把人卡在原地看着图删不掉。
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "删除失败，参考图片仍保留在档案中。");
  }
}

async function saveDraft() {
  const target = characterId.value;
  if (!target || saving.value) return;
  saving.value = true;
  try {
    const result = await api<{ profile: VisualProfile; draftVersion: VisualVersion }>({
      url: `/characters/${encodeURIComponent(target)}/visual-profile`,
      method: "put",
      data: {
        coreAppearance: coreAppearance.value,
        corePrompt: corePrompt.value,
        negativePrompt: negativePrompt.value,
        note: versionNote.value,
      },
    });
    if (characterId.value !== target) return;
    draftRevision.value = result.draftVersion.revision;
    versionNote.value = "";
    ElMessage.success(`草稿 v${result.draftVersion.revision} 已保存，尚未成为正式形象。`);
    await loadProfile();
    draftRevision.value = result.draftVersion.revision;
  } catch {
    ElMessage.error("保存失败，内容没有被确认写入。");
  } finally {
    saving.value = false;
  }
}

function editOutfit(outfit: VisualOutfit) {
  editingOutfitId.value = outfit.id;
  outfitName.value = outfit.name;
  outfitPrompt.value = outfit.prompt;
  outfitIsDefault.value = outfit.isDefault;
  activeSection.value = "outfit";
}

function resetOutfitForm() {
  editingOutfitId.value = null;
  outfitName.value = "";
  outfitPrompt.value = "";
  outfitIsDefault.value = false;
}

async function saveOutfit() {
  const target = characterId.value;
  if (!target || !outfitName.value.trim() || !outfitPrompt.value.trim() || outfitSaving.value) return;
  outfitSaving.value = true;
  try {
    const editingId = editingOutfitId.value;
    const result = await api<{ draftRevision: number }>({
      url: editingId
        ? `/characters/${encodeURIComponent(target)}/visual-profile/outfits/${encodeURIComponent(editingId)}`
        : `/characters/${encodeURIComponent(target)}/visual-profile/outfits`,
      method: editingId ? "put" : "post",
      data: { name: outfitName.value, prompt: outfitPrompt.value, isDefault: outfitIsDefault.value },
    });
    if (characterId.value !== target) return;
    resetOutfitForm();
    await loadProfile({ preserveEditor: true });
    draftRevision.value = result.draftRevision;
    ElMessage.success("服装造型已保存为草稿变更。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "服装造型保存失败。");
  } finally {
    outfitSaving.value = false;
  }
}

async function deleteOutfit(outfitId: string) {
  const target = characterId.value;
  if (!target || outfitSaving.value) return;
  outfitSaving.value = true;
  try {
    const result = await api<{ draftRevision: number }>({
      url: `/characters/${encodeURIComponent(target)}/visual-profile/outfits/${encodeURIComponent(outfitId)}`,
      method: "delete",
    });
    if (characterId.value !== target) return;
    if (editingOutfitId.value === outfitId) resetOutfitForm();
    await loadProfile({ preserveEditor: true });
    draftRevision.value = result.draftRevision;
    ElMessage.success("造型已删除，变更保存在草稿中。");
  } catch {
    ElMessage.error("删除失败，造型仍然保留。");
  } finally {
    outfitSaving.value = false;
  }
}

async function restoreVersion(versionId: string) {
  const target = characterId.value;
  if (!target || restoringVersionId.value) return;
  restoringVersionId.value = versionId;
  try {
    const result = await api<{ draftVersion: VisualVersion }>({
      url: `/characters/${encodeURIComponent(target)}/visual-profile/versions/${encodeURIComponent(versionId)}/restore`,
      method: "post",
      data: {},
    });
    if (characterId.value !== target) return;
    resetOutfitForm();
    await loadProfile();
    draftRevision.value = result.draftVersion.revision;
    ElMessage.success(`历史版本已恢复为新草稿 v${result.draftVersion.revision}，不会覆盖当前正式版本。`);
  } catch {
    ElMessage.error("历史版本恢复失败。");
  } finally {
    restoringVersionId.value = null;
  }
}

async function publishDraft() {
  const target = characterId.value;
  const revision = draftRevision.value;
  if (!target || !revision || publishing.value) return;
  publishing.value = true;
  try {
    await api({
      url: `/characters/${encodeURIComponent(target)}/visual-profile/publish`,
      method: "post",
      data: { revision },
    });
    if (characterId.value !== target) return;
    ElMessage.success(`形象版本 v${revision} 已正式发布。`);
    draftRevision.value = null;
    await loadProfile();
  } catch {
    ElMessage.error("发布失败，当前正式形象没有改变。");
  } finally {
    publishing.value = false;
  }
}

watch(characterId, () => {
  coreAppearance.value = "";
  corePrompt.value = "";
  negativePrompt.value = "";
  versionNote.value = "";
  activeSection.value = "overview";
  versionFilter.value = "all";
  clearUploadFile();
  resetOutfitForm();
  void loadProfile();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; requestVersion += 1; });
</script>

<template>
  <div class="page-wrap visual-profile-page">
    <el-empty
      v-if="!activeCharacter"
      description="请先从左下角选择一个角色。"
    />
    <template v-else>
      <header class="vp-head">
        <div class="vp-identity">
          <span class="vp-avatar">{{ activeCharacter.avatar || activeCharacter.name.slice(0, 1) }}</span>
          <div class="vp-identity-copy">
            <div class="vp-name">
              {{ activeCharacter.name }}
              <span
                v-if="profile?.currentPublishedRevision"
                class="vp-tag is-ok"
              >正式 v{{ profile.currentPublishedRevision }}</span>
              <span
                v-else
                class="vp-tag"
              >尚无正式版本</span>
            </div>
            <div class="vp-sub">
              <template v-if="publishedVersion">
                发布于 {{ formatTime(publishedVersion.publishedAt || publishedVersion.createdAt) }}
              </template>
              <template v-else>
                保存草稿并发布后，绘图才会用上这套形象
              </template>
            </div>
          </div>
        </div>
        <div class="vp-actions">
          <span
            v-if="draftVersion"
            class="vp-draft"
          ><i />草稿 v{{ draftVersion.revision }} 待发布</span>
          <span
            v-else
            class="vp-sub"
          >没有待发布草稿</span>
          <button
            class="btn sm"
            type="button"
            :disabled="!draftVersion"
            @click="goToSection('versions')"
          >
            对照改动
          </button>
          <button
            class="btn primary sm"
            type="button"
            :disabled="!draftRevision || saving || hasUncommittedEdits || publishing"
            @click="publishDraft"
          >
            {{ publishing ? "发布中…" : `发布 v${draftVersion?.revision ?? "—"}` }}
          </button>
        </div>
      </header>

      <nav
        class="vp-nav"
        aria-label="形象档案分区"
      >
        <button
          v-for="section in SECTIONS"
          :key="section.key"
          type="button"
          class="vp-tab"
          :class="{ 'is-on': activeSection === section.key }"
          :aria-current="activeSection === section.key ? 'page' : undefined"
          @click="goToSection(section.key)"
        >
          {{ section.label }}
          <span
            v-if="section.key === 'outfit' && outfits.length"
            class="vp-count"
          >{{ outfits.length }}</span>
          <span
            v-else-if="section.key === 'assets' && assets.length"
            class="vp-count"
          >{{ assets.length }}</span>
          <span
            v-else-if="section.key === 'versions' && versions.length"
            class="vp-count"
          >{{ versions.length }}</span>
        </button>
      </nav>

      <el-alert
        v-if="loadError"
        :title="loadError"
        type="error"
        :closable="false"
        show-icon
      >
        <template #default>
          <el-button
            size="small"
            @click="loadProfile()"
          >
            重新读取
          </el-button>
        </template>
      </el-alert>
      <el-skeleton
        v-if="loading"
        :rows="7"
        animated
      />

      <template v-else>
        <!-- 概览 -->
        <div
          v-if="activeSection === 'overview'"
          class="vp-grid"
        >
          <div class="vp-col">
            <section class="card vp-hero">
              <div class="vp-hero-figure">
                <img
                  v-if="standardAsset"
                  :src="assetUrl(standardAsset.id)"
                  alt="标准形象"
                >
                <span
                  v-else
                  class="vp-hero-empty"
                >无标准图</span>
              </div>
              <div class="vp-hero-copy">
                <div class="vp-name">
                  {{ activeCharacter.name }}
                  <span
                    v-if="profile?.currentPublishedRevision"
                    class="vp-tag is-ok"
                  >已发布 v{{ profile.currentPublishedRevision }}</span>
                </div>
                <p class="vp-hero-text">
                  {{ coreAppearance.trim() || "还没有写外貌设定。核心形象决定她长得像谁，造型只决定这一次穿什么。" }}
                </p>
                <div class="vp-facts">
                  <span>核心提示词 <b>{{ promptLength }}</b> 字</span>
                  <span>默认造型 <b>{{ defaultOutfit?.name || "未设置" }}</b></span>
                  <span>负面词 <b>{{ negativeCount }}</b> 条</span>
                </div>
              </div>
              <div class="vp-hero-stats">
                <div class="vp-stat">
                  <span>造型</span><b>{{ outfits.length }}<small>套</small></b>
                </div>
                <div class="vp-stat">
                  <span>参考素材</span><b>{{ assets.length }}<small>张</small></b>
                </div>
                <div class="vp-stat">
                  <span>版本</span><b>{{ versions.length }}<small>次</small></b>
                </div>
              </div>
            </section>

            <section class="card vp-fill">
              <div class="card-head">
                <h3>档案完成度</h3>
                <span class="muted">{{ readyCount }} / {{ readiness.length }} 项就绪</span>
              </div>
              <div class="vp-checks">
                <div
                  v-for="item in readiness"
                  :key="item.key"
                  class="vp-check"
                >
                  <span
                    class="vp-check-mark"
                    :class="item.done ? 'is-on' : 'is-off'"
                  >
                    <el-icon :size="11"><Check v-if="item.done" /><Minus v-else /></el-icon>
                  </span>
                  <div class="vp-check-copy">
                    <strong>{{ item.title }}</strong>
                    <span>{{ item.detail }}</span>
                  </div>
                  <button
                    v-if="item.action"
                    class="btn-link"
                    type="button"
                    @click="goFix(item.action)"
                  >
                    {{ item.action }}
                  </button>
                </div>
              </div>
            </section>

            <section class="card">
              <div class="card-head">
                <h3>绘图时怎么拼</h3>
                <span class="muted">只读取已发布的正式版本</span>
              </div>
              <div class="vp-flow">
                <span class="vp-step">人物 · {{ promptLength }} 字</span>
                <span class="vp-arrow">→</span>
                <span class="vp-step">造型 · {{ defaultOutfit?.name || "未设置" }}</span>
                <span class="vp-arrow">→</span>
                <span class="vp-step">参考图 · {{ referenceAssetCount }} 张</span>
                <span class="vp-arrow">→</span>
                <span class="vp-step">本轮画面</span>
                <span class="vp-arrow">→</span>
                <span class="vp-step is-quiet">避免</span>
              </div>
              <p class="muted vp-flow-note">
                画面里已经写了服装时，整段造型不会被拼进去；负面词以「避免」追加在最后。标准形象和三视图会作为参考图一起发出，只用来定长相，姿势和表情仍按画面重新安排。
              </p>
            </section>
          </div>

          <div class="vp-col vp-side">
            <section class="card">
              <div class="card-head">
                <h3>本次草稿改了什么</h3>
                <span class="muted">{{ draftVersion ? `v${draftVersion.revision}` : "无草稿" }}</span>
              </div>
              <div
                v-if="draftChanges.length"
                class="vp-diffs"
              >
                <div
                  v-for="row in draftChanges"
                  :key="row.title"
                  class="vp-diff"
                >
                  <span class="vp-diff-dot" />
                  <div><strong>{{ row.title }}</strong><span>{{ row.detail }}</span></div>
                </div>
              </div>
              <p
                v-else
                class="muted vp-pad"
              >
                草稿内容和正式版一致。
              </p>
              <div class="card-foot">
                <span class="muted">发布后才会进入绘图</span>
                <button
                  class="btn primary sm"
                  type="button"
                  :disabled="!draftRevision || publishing"
                  @click="publishDraft"
                >
                  发布
                </button>
              </div>
            </section>

            <section class="card vp-fill">
              <div class="card-head">
                <h3>最近版本</h3>
                <button
                  class="btn-link"
                  type="button"
                  @click="goToSection('versions')"
                >
                  全部
                </button>
              </div>
              <div
                v-if="versions.length"
                class="vp-diffs"
              >
                <div
                  v-for="item in versions.slice(0, 4)"
                  :key="item.id"
                  class="vp-diff"
                >
                  <span
                    class="vp-rev"
                    :class="item.revision === profile?.currentPublishedRevision ? 'is-ok' : item.status === 'DRAFT' ? 'is-draft' : ''"
                  >v{{ item.revision }}</span>
                  <div>
                    <strong>{{ item.revision === profile?.currentPublishedRevision ? "正式版本 · 当前" : item.status === "DRAFT" ? "草稿 · 待发布" : item.status === "ARCHIVED" ? "已归档草稿" : "历史正式版本" }}</strong>
                    <span>{{ item.note || "未填写版本说明" }}</span>
                    <span class="vp-time">{{ formatTime(item.createdAt) }}</span>
                  </div>
                </div>
              </div>
              <div
                v-else
                class="card-empty"
              >
                <span>保存第一份草稿后</span>
                <span>版本记录会显示在这里</span>
              </div>
            </section>
          </div>
        </div>

        <!-- 核心形象 -->
        <div
          v-else-if="activeSection === 'core'"
          class="vp-grid"
        >
          <div class="vp-col">
            <section class="card">
              <div class="card-head">
                <h3>外貌设定</h3>
                <span class="muted">稳定外貌，不包含服装</span>
              </div>
              <div class="vp-pad">
                <el-input
                  v-model="coreAppearance"
                  type="textarea"
                  :rows="4"
                  maxlength="12000"
                  show-word-limit
                  placeholder="例如：蓝紫色长发、蓝色眼睛、鲸鱼耳与尾巴；少女形态，中间体型比例……"
                />
              </div>
            </section>

            <section class="card">
              <div class="card-head">
                <h3>核心绘图提示词</h3>
                <span class="muted">每次绘图都会前置</span>
              </div>
              <div class="vp-pad">
                <el-input
                  v-model="corePrompt"
                  type="textarea"
                  :rows="5"
                  maxlength="12000"
                  show-word-limit
                  placeholder="写下每次绘图都应保持的角色视觉特征。"
                />
              </div>
            </section>

            <section class="card">
              <div class="card-head">
                <h3>负面提示词</h3>
                <span class="muted">以「避免」追加在末尾</span>
              </div>
              <div class="vp-pad">
                <el-input
                  v-model="negativePrompt"
                  type="textarea"
                  :rows="3"
                  maxlength="6000"
                  show-word-limit
                  placeholder="写下希望避免的外观偏差或画面问题。"
                />
              </div>
            </section>

            <div class="vp-actionbar">
              <el-input
                v-model="versionNote"
                maxlength="300"
                placeholder="本次修改说明，例如：确定发尾渐变"
                class="vp-note"
              />
              <span class="muted vp-hint">保存只形成草稿，发布才生效</span>
              <button
                class="btn"
                type="button"
                :disabled="saving"
                @click="saveDraft"
              >
                {{ saving ? "保存中…" : "保存为草稿" }}
              </button>
              <button
                class="btn primary"
                type="button"
                :disabled="!draftRevision || saving || hasUncommittedEdits || publishing"
                @click="publishDraft"
              >
                发布 v{{ draftVersion?.revision ?? "—" }}
              </button>
            </div>
            <p
              v-if="hasUncommittedEdits"
              class="muted vp-hint"
            >
              还有未保存的核心形象或造型编辑，请先保存，避免发布旧草稿。
            </p>
          </div>

          <div class="vp-col vp-side">
            <section class="card">
              <div class="card-head">
                <h3>{{ diffTitle }}</h3>
                <span class="muted">草稿</span>
              </div>
              <div
                v-if="draftChanges.length"
                class="vp-diffs vp-pad"
              >
                <div
                  v-for="row in draftChanges"
                  :key="row.title"
                  class="vp-diff"
                >
                  <span class="vp-diff-dot" />
                  <div><strong>{{ row.title }}</strong><span>{{ row.detail }}</span></div>
                </div>
              </div>
              <p
                v-else
                class="muted vp-pad"
              >
                和正式版一致，没有待生效的改动。
              </p>
              <div class="card-foot">
                <span class="muted">尚未生效，绘图仍用正式版</span>
              </div>
            </section>

            <section
              v-if="publishedVersion"
              class="card"
            >
              <div class="card-head">
                <h3>正式版 v{{ publishedVersion.revision }}</h3>
                <span class="muted">{{ formatTime(publishedVersion.publishedAt || publishedVersion.createdAt) }}</span>
              </div>
              <div class="vp-pad vp-pv-stack">
                <div class="vp-pv">
                  <span>核心提示词</span>
                  <p>{{ textOf(publishedSnapshot.corePrompt) || "（空）" }}</p>
                </div>
                <div class="vp-pv">
                  <span>负面提示词</span>
                  <p>{{ textOf(publishedSnapshot.negativePrompt) || "（空）" }}</p>
                </div>
                <div
                  v-if="publishedVersion.note"
                  class="vp-pv"
                >
                  <span>版本说明</span>
                  <p>{{ publishedVersion.note }}</p>
                </div>
              </div>
              <div class="card-foot">
                <span class="muted">只读，供对照</span>
                <button
                  class="btn sm"
                  type="button"
                  :disabled="restoringVersionId === publishedVersion.id"
                  @click="restoreVersion(publishedVersion.id)"
                >
                  恢复为草稿
                </button>
              </div>
            </section>
          </div>
        </div>

        <!-- 服装造型 -->
        <div
          v-else-if="activeSection === 'outfit'"
          class="vp-grid"
        >
          <div class="vp-col">
            <article
              v-for="outfit in outfits"
              :key="outfit.id"
              class="card vp-outfit"
              :class="{ 'is-default': outfit.isDefault, 'is-editing': editingOutfitId === outfit.id }"
            >
              <div class="vp-outfit-head">
                <h3>{{ outfit.name }}</h3>
                <span
                  v-if="outfit.isDefault"
                  class="vp-tag is-ok"
                >默认</span>
                <span
                  v-else
                  class="muted"
                >不是默认造型</span>
              </div>
              <p class="vp-outfit-prompt">
                {{ outfit.prompt }}
              </p>
              <div class="vp-outfit-foot">
                <button
                  class="btn sm"
                  type="button"
                  @click="editOutfit(outfit)"
                >
                  <el-icon><Edit /></el-icon>编辑
                </button>
                <button
                  class="btn sm quiet is-danger"
                  type="button"
                  :disabled="outfitSaving"
                  @click="deleteOutfit(outfit.id)"
                >
                  <el-icon><Delete /></el-icon>删除
                </button>
              </div>
            </article>

            <section class="vp-outfit-empty">
              <span class="vp-outfit-plus"><el-icon :size="16"><Plus /></el-icon></span>
              <strong>{{ editingOutfitId ? "正在编辑右侧造型" : "新增一套造型" }}</strong>
              <span>只描述服装与配饰，不要重复核心外貌</span>
              <ul class="vp-outfit-tips">
                <li>同一角色可以有多套造型，换装不会覆盖核心形象</li>
                <li>设为默认后，没有指定服装的画面会自动拼上它</li>
                <li>本轮画面里明确写了别的衣服时，以画面为准</li>
              </ul>
            </section>
          </div>

          <div class="vp-col vp-side">
            <section class="card">
              <div class="card-head">
                <h3>{{ editingOutfitId ? "编辑造型" : "新增造型" }}</h3>
                <span class="muted">{{ editingOutfitId ? outfitName : "未保存" }}</span>
              </div>
              <div class="vp-pad vp-form">
                <label class="vp-field">
                  <span>造型名称</span>
                  <el-input
                    v-model="outfitName"
                    maxlength="100"
                    placeholder="例如：日常服、深蓝女仆装"
                  />
                </label>
                <label class="vp-field">
                  <span>造型提示词</span>
                  <el-input
                    v-model="outfitPrompt"
                    type="textarea"
                    :rows="5"
                    maxlength="6000"
                    show-word-limit
                    placeholder="只描述服装、配饰和造型，不要重复核心外貌。"
                  />
                </label>
                <el-checkbox v-model="outfitIsDefault">
                  设为默认造型
                </el-checkbox>
              </div>
              <div class="card-foot">
                <button
                  class="btn"
                  type="button"
                  :disabled="!editingOutfitId"
                  @click="resetOutfitForm"
                >
                  取消
                </button>
                <button
                  class="btn primary"
                  type="button"
                  :disabled="!outfitName.trim() || !outfitPrompt.trim() || outfitSaving"
                  @click="saveOutfit"
                >
                  {{ outfitSaving ? "保存中…" : editingOutfitId ? "保存修改" : "新增造型" }}
                </button>
              </div>
            </section>

            <section class="card">
              <div class="vp-pad">
                <p class="muted">
                  造型变更会形成新草稿。发布后，未指定服装的画面会拼入默认造型；本轮画面明确写了别的衣服时，以画面为准。
                </p>
              </div>
            </section>
          </div>
        </div>

        <!-- 参考素材 -->
        <div
          v-else-if="activeSection === 'assets'"
          class="vp-col"
        >
          <section
            class="vp-dropzone"
            :class="{ 'is-dragging': dragging }"
            @dragover.prevent="onDragOver"
            @dragleave.prevent="onDragLeave"
            @drop.prevent="onDrop"
          >
            <span class="vp-dropzone-icon"><el-icon :size="20"><Upload /></el-icon></span>
            <div class="vp-dropzone-copy">
              <strong>
                把图片拖到这里，或
                <button
                  class="btn-link"
                  type="button"
                  @click="referenceFileInput?.click()"
                >点击选择文件</button>
              </strong>
              <span>PNG / JPG / WebP，单张不超过 12MB；保存时自动压到最长边 1600</span>
            </div>
            <div class="vp-dropzone-actions">
              <el-select
                v-model="uploadKind"
                aria-label="参考图片用途"
                class="vp-kind-select"
              >
                <el-option
                  v-for="kind in ASSET_KINDS"
                  :key="kind.value"
                  :label="kind.label"
                  :value="kind.value"
                />
              </el-select>
              <input
                ref="referenceFileInput"
                class="vp-file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                @change="onReferenceFileChange"
              >
            </div>
          </section>

          <section
            v-if="uploadFile"
            class="card vp-pending"
          >
            <div class="vp-pending-copy">
              <strong>{{ uploadFile.name }}</strong>
              <span class="muted">{{ formatBytes(uploadFile.size) }} · 用途：{{ kindLabel(uploadKind) }}</span>
            </div>
            <el-input
              v-model="uploadLabel"
              maxlength="120"
              placeholder="给这张参考图起个名字"
              class="vp-pending-label"
            />
            <button
              class="btn"
              type="button"
              @click="clearUploadFile"
            >
              取消
            </button>
            <button
              class="btn primary"
              type="button"
              :disabled="!uploadLabel.trim() || uploading"
              @click="uploadReference"
            >
              {{ uploading ? "上传中…" : "上传参考图片" }}
            </button>
          </section>

          <section
            v-for="group in assetGroups"
            :key="group.group"
            class="vp-asset-group"
          >
            <div class="vp-group-head">
              <h3>{{ group.group }}</h3>
              <span class="muted">{{ group.items.length }} 张</span>
              <span class="vp-group-rule" />
            </div>
            <div class="vp-asset-row">
              <article
                v-for="asset in group.items"
                :key="asset.id"
                class="vp-asset"
              >
                <div class="vp-asset-img">
                  <img
                    :src="assetUrl(asset.id)"
                    :alt="asset.label"
                  >
                  <button
                    class="vp-asset-delete"
                    :class="{ 'is-locked': isLockedAsset(asset.id) }"
                    type="button"
                    :aria-label="isLockedAsset(asset.id) ? `删除 ${asset.label}（当前正式版本正在使用）` : `删除 ${asset.label}`"
                    :title="isLockedAsset(asset.id) ? LOCKED_ASSET_HINT : `删除 ${asset.label}`"
                    @click="deleteReference(asset.id)"
                  >
                    <el-icon :size="12">
                      <Delete />
                    </el-icon>
                  </button>
                </div>
                <div class="vp-asset-meta">
                  <strong>{{ asset.label }}</strong>
                  <span>{{ kindLabel(asset.kind) }}<template v-if="asset.width && asset.height"> · {{ asset.width }}×{{ asset.height }}</template></span>
                </div>
              </article>
              <button
                v-if="group.group === '三视图' && viewGaps.length"
                class="vp-asset vp-asset-add"
                type="button"
                @click="pickGapUpload"
              >
                <span class="vp-asset-img"><el-icon :size="18"><Plus /></el-icon></span>
                <span class="vp-asset-meta">
                  <strong>添加</strong>
                  <span>补 {{ viewGaps.map(item => item.label).join("、") }}</span>
                </span>
              </button>
            </div>
          </section>

          <section
            v-if="!assetGroups.length"
            class="empty-block"
          >
            <span class="halo"><el-icon :size="22"><Upload /></el-icon></span>
            <h4>还没有参考图片</h4>
            <p>先上传一张标准形象图，再补正面、侧面、背面三视图。标准形象和三视图会作为参考图随生成一起发出，只用来定长相。</p>
          </section>
        </div>

        <!-- 版本历史 -->
        <div
          v-else-if="activeSection === 'versions'"
          class="vp-grid"
        >
          <div class="vp-col">
            <div class="filters">
              <button
                class="chip"
                :class="{ on: versionFilter === 'all' }"
                type="button"
                @click="versionFilter = 'all'"
              >
                全部<span class="n">{{ versions.length }}</span>
              </button>
              <button
                class="chip"
                :class="{ on: versionFilter === 'published' }"
                type="button"
                @click="versionFilter = 'published'"
              >
                正式版本<span class="n">{{ publishedCount }}</span>
              </button>
              <button
                class="chip"
                :class="{ on: versionFilter === 'draft' }"
                type="button"
                @click="versionFilter = 'draft'"
              >
                草稿<span class="n">{{ draftCount }}</span>
              </button>
              <span class="muted vp-filter-note">恢复历史版本不会删除记录，只会生成新草稿</span>
            </div>

            <article
              v-for="item in filteredVersions"
              :key="item.id"
              class="card vp-version"
              :class="{ 'is-current': item.revision === profile?.currentPublishedRevision, 'is-draft': item.status === 'DRAFT' }"
            >
              <span
                class="vp-rev"
                :class="item.revision === profile?.currentPublishedRevision ? 'is-ok' : item.status === 'DRAFT' ? 'is-draft' : ''"
              >v{{ item.revision }}</span>
              <div class="vp-version-copy">
                <div class="vp-version-head">
                  <strong>{{ item.revision === profile?.currentPublishedRevision ? "正式版本" : item.status === "DRAFT" ? "草稿" : item.status === "ARCHIVED" ? "已归档草稿" : "历史正式版本" }}</strong>
                  <span
                    v-if="item.revision === profile?.currentPublishedRevision"
                    class="vp-tag is-ok"
                  >当前生效</span>
                  <span
                    v-else-if="item.status === 'DRAFT'"
                    class="vp-tag is-draft"
                  >待发布</span>
                  <span
                    v-else
                    class="vp-tag"
                  >已被取代</span>
                </div>
                <p>{{ item.note || "未填写版本说明" }}</p>
                <div class="vp-version-meta">
                  <span>{{ formatTime(item.createdAt) }}</span>
                  <span v-if="item.publishedAt">发布于 {{ formatTime(item.publishedAt) }}</span>
                  <span v-if="versionAssetCount(item) !== null">引用 {{ versionAssetCount(item) }} 张素材</span>
                  <span v-else>素材数未记录</span>
                </div>
              </div>
              <div class="vp-version-actions">
                <button
                  v-if="item.status === 'DRAFT' && item.revision === draftRevision"
                  class="btn primary sm"
                  type="button"
                  :disabled="publishing"
                  @click="publishDraft"
                >
                  发布
                </button>
                <button
                  v-if="item.revision !== profile?.currentPublishedRevision"
                  class="btn sm"
                  type="button"
                  :disabled="restoringVersionId === item.id"
                  @click="restoreVersion(item.id)"
                >
                  {{ restoringVersionId === item.id ? "恢复中…" : "恢复为草稿" }}
                </button>
                <span
                  v-else
                  class="muted"
                >不可恢复自身</span>
              </div>
            </article>

            <section
              v-if="!filteredVersions.length"
              class="empty-block"
            >
              <h4>没有符合条件的版本</h4>
              <p>换个筛选条件看看，或者先保存一份草稿。</p>
            </section>

            <section class="card">
              <div class="card-head">
                <h3>版本是怎么产生的</h3>
              </div>
              <div class="vp-pad vp-rules">
                <p>保存核心提示词、增删改造型、恢复历史版本，都会生成一份新草稿。</p>
                <p>只有点「发布」才推进正式版本；发布后其他未发布草稿自动归档。</p>
                <p>绘图永远读当前正式版本，草稿不参与任何一次生成。</p>
                <p>恢复历史版本只还原文字和造型；参考素材不随版本回滚，换过的图保持当前状态。</p>
              </div>
            </section>
          </div>

          <div class="vp-col vp-side">
            <section class="card">
              <div class="card-head">
                <h3>提示词差异</h3>
                <span class="muted">草稿 vs 正式版</span>
              </div>
              <div class="vp-pad vp-pv-stack">
                <div
                  v-if="publishedPromptDiff.added.length"
                  class="vp-diff-lines"
                >
                  <span class="vp-diff-label">新增</span>
                  <p
                    v-for="token in publishedPromptDiff.added"
                    :key="`add-${token}`"
                    class="is-add"
                  >
                    + {{ token }}
                  </p>
                </div>
                <div
                  v-if="publishedPromptDiff.removed.length"
                  class="vp-diff-lines"
                >
                  <span class="vp-diff-label">移除</span>
                  <p
                    v-for="token in publishedPromptDiff.removed"
                    :key="`del-${token}`"
                    class="is-del"
                  >
                    − {{ token }}
                  </p>
                </div>
                <p
                  v-if="!publishedPromptDiff.added.length && !publishedPromptDiff.removed.length"
                  class="muted"
                >
                  核心提示词和正式版一致。
                </p>
              </div>
              <div class="card-foot">
                <span class="muted">仅比较文字，不含参考素材</span>
              </div>
            </section>
            <section class="card">
              <div class="vp-pad">
                <p class="muted">
                  绘图只读取当前正式版本{{ profile?.currentPublishedRevision ? `（v${profile.currentPublishedRevision}）` : "" }}。草稿在发布之前不会进入任何一次生成。
                </p>
              </div>
            </section>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.visual-profile-page { display: flex; flex-direction: column; gap: 16px; }

/* 页头：角色 + 状态 + 操作 */
.vp-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; }
.vp-identity { display: flex; min-width: 0; align-items: center; gap: 11px; }
.vp-avatar {
  display: grid; width: 40px; height: 40px; flex: none; place-items: center;
  border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: linear-gradient(135deg, var(--blue-soft), var(--brand-soft));
  color: var(--brand-strong); font-size: 16px; font-weight: 700;
}
.vp-identity-copy { min-width: 0; }
.vp-name { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--text); font-size: 16px; font-weight: 700; line-height: 1.35; }
.vp-sub { color: var(--dim); font-size: 12px; line-height: 1.5; }
.vp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.vp-draft {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--amber-line);
  border-radius: 999px; background: var(--amber-soft); padding: 4px 10px;
  color: var(--amber); font-size: 12px; font-weight: 600;
}
.vp-draft i { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); }

/* 标签 */
.vp-tag {
  display: inline-flex; align-items: center; border-radius: var(--radius-xs);
  background: var(--surface-3); padding: 2px 7px; color: var(--dim);
  font-size: 12px; font-weight: 600; line-height: 1.5;
}
.vp-tag.is-ok { background: var(--green-soft); color: var(--green); }
.vp-tag.is-draft { background: var(--amber-soft); color: var(--amber); }

/* 分区导航 */
.vp-nav { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--line); padding-bottom: 7px; overflow-x: auto; }
.vp-tab {
  display: inline-flex; flex: none; height: 34px; align-items: center; gap: 6px;
  border: 0; border-radius: var(--radius-sm); background: none; padding: 0 13px;
  color: var(--dim); font-size: 14px; font-weight: 500; cursor: pointer;
  transition: background .15s var(--ease), color .15s var(--ease);
}
.vp-tab:hover { background: var(--surface-2); color: var(--text-2); }
.vp-tab.is-on { background: var(--brand-soft); color: var(--brand-strong); font-weight: 600; }
.vp-tab:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.vp-count { color: var(--faint); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.vp-tab.is-on .vp-count { color: var(--brand); }

/* 两栏 */
.vp-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: start; }
.vp-col { display: flex; min-width: 0; flex-direction: column; gap: 14px; }
.vp-fill { display: flex; flex-direction: column; }
.vp-fill .vp-checks { flex: 1; }
.vp-pad { padding: 0 16px 16px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px 10px; }
.card-head h3 { color: var(--text); font-size: 14px; font-weight: 700; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); padding: 10px 16px; }

/* 概览 hero */
.vp-hero { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 16px 18px; }
.vp-hero-figure {
  display: grid; width: 88px; height: 88px; flex: none; place-items: center;
  overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: linear-gradient(135deg, var(--blue-soft), var(--brand-soft));
}
.vp-hero-figure img { width: 100%; height: 100%; object-fit: cover; }
.vp-hero-empty { color: var(--faint); font-size: 12px; }
.vp-hero-copy { min-width: 0; }
.vp-hero-text {
  display: -webkit-box; margin-top: 6px; overflow: hidden;
  color: var(--text-2); font-size: 12px; line-height: 1.7;
  -webkit-box-orient: vertical; -webkit-line-clamp: 2;
}
.vp-facts { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; color: var(--dim); font-size: 12px; }
.vp-facts b { color: var(--text-2); font-weight: 600; }
.vp-hero-stats { display: flex; flex: none; }
.vp-stat { padding: 0 16px; border-left: 1px solid var(--line); text-align: left; }
.vp-stat:first-child { border-left: 0; padding-left: 0; }
.vp-stat span { color: var(--dim); font-size: 12px; }
.vp-stat b { display: block; margin-top: 2px; color: var(--text); font-size: 22px; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.vp-stat small { margin-left: 3px; color: var(--dim); font-size: 12px; font-weight: 500; letter-spacing: 0; }

/* 完成度清单 */
.vp-checks { display: flex; flex-direction: column; padding: 0 16px 16px; }
.vp-check { display: flex; align-items: flex-start; gap: 9px; border-bottom: 1px dashed var(--line); padding: 10px 0; }
.vp-check:last-child { border-bottom: 0; padding-bottom: 0; }
.vp-check-mark { display: grid; width: 17px; height: 17px; flex: none; place-items: center; margin-top: 2px; border-radius: 50%; }
.vp-check-mark.is-on { background: var(--green-soft); color: var(--green); }
.vp-check-mark.is-off { background: var(--surface-3); color: var(--faint); }
.vp-check-copy { min-width: 0; flex: 1; }
.vp-check-copy strong { display: block; color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.5; }
.vp-check-copy span { display: block; color: var(--dim); font-size: 12px; line-height: 1.5; }
.vp-check .btn-link { flex: none; font-size: 12px; }

/* 拼装流程 */
.vp-flow { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 0 16px; }
.vp-step { border: 1px solid var(--line); border-radius: var(--radius-xs); background: var(--surface-2); padding: 5px 9px; color: var(--text-2); font-size: 12px; font-weight: 600; }
.vp-step.is-quiet { color: var(--dim); }
.vp-arrow { color: var(--faint); font-size: 12px; }
.vp-flow-note { padding: 9px 16px 16px; }

/* 差异列表 */
.vp-diffs { display: flex; flex-direction: column; padding: 0 16px 4px; }
.vp-diff { display: flex; align-items: flex-start; gap: 8px; border-bottom: 1px dashed var(--line); padding: 9px 0; }
.vp-diff:first-child { padding-top: 4px; }
.vp-diff:last-child { border-bottom: 0; }
.vp-diff-dot { width: 5px; height: 5px; flex: none; margin-top: 7px; border-radius: 50%; background: var(--brand); }
.vp-diff strong { display: block; color: var(--text); font-size: 12px; font-weight: 600; line-height: 1.5; }
.vp-diff span { display: block; color: var(--dim); font-size: 12px; line-height: 1.5; }
.vp-time { margin-top: 2px; color: var(--faint); }
.vp-rev {
  display: grid; width: 30px; height: 30px; flex: none; place-items: center;
  border-radius: var(--radius-xs); background: var(--surface-3); color: var(--text-2);
  font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.vp-rev.is-ok { background: var(--green-soft); color: var(--green); }
.vp-rev.is-draft { background: var(--amber-soft); color: var(--amber); }

/* 核心形象 */
.vp-actionbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.vp-note { max-width: 360px; }
.vp-hint { font-size: 12px; }
.vp-pv-stack { display: flex; flex-direction: column; gap: 9px; }
.vp-pv { border: 1px solid var(--line); border-radius: var(--radius-xs); background: var(--surface-2); padding: 9px 11px; }
.vp-pv > span { display: block; margin-bottom: 3px; color: var(--dim); font-size: 12px; font-weight: 600; }
.vp-pv p { color: var(--text-2); font-size: 12px; line-height: 1.75; overflow-wrap: anywhere; }

/* 造型 */
.vp-outfit { padding: 13px 15px 12px; }
.vp-outfit.is-default { border-color: var(--brand-line); box-shadow: 0 0 0 2px var(--brand-soft); }
.vp-outfit.is-editing { border-color: var(--brand); }
.vp-outfit-head { display: flex; align-items: center; gap: 8px; }
.vp-outfit-head h3 { color: var(--text); font-size: 14px; font-weight: 700; }
.vp-outfit-head .muted { margin-left: auto; }
.vp-outfit-prompt { margin-top: 7px; color: var(--text-2); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.vp-outfit-foot { display: flex; align-items: center; gap: 4px; margin-top: 9px; border-top: 1px solid var(--line); padding-top: 9px; }
.vp-outfit-empty {
  display: grid; place-content: center; justify-items: center; gap: 6px;
  border: 1px dashed var(--line-strong); border-radius: var(--radius);
  background: var(--surface-2); padding: 24px 16px; text-align: center;
}
.vp-outfit-plus {
  display: grid; width: 36px; height: 36px; place-items: center;
  border: 1px solid var(--brand-line); border-radius: 50%; background: var(--surface);
  color: var(--brand-strong); box-shadow: var(--sh-1);
}
.vp-outfit-empty strong { color: var(--text); font-size: 14px; font-weight: 700; }
.vp-outfit-empty > span { color: var(--dim); font-size: 12px; }
.vp-outfit-tips { display: grid; gap: 5px; margin-top: 6px; padding: 0; list-style: none; text-align: left; }
.vp-outfit-tips li { position: relative; padding-left: 12px; color: var(--dim); font-size: 12px; line-height: 1.6; }
.vp-outfit-tips li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 3px; height: 3px; border-radius: 50%; background: var(--faint); }
.vp-form { display: flex; flex-direction: column; gap: 12px; }
.vp-field { display: flex; flex-direction: column; gap: 6px; }
.vp-field > span { color: var(--text-2); font-size: 12px; font-weight: 600; }

/* 参考素材 */
.vp-dropzone {
  display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
  border: 1.5px dashed var(--line-strong); border-radius: var(--radius);
  background: var(--surface); padding: 16px 18px;
  transition: border-color .15s var(--ease), background .15s var(--ease);
}
.vp-dropzone.is-dragging { border-color: var(--brand); background: var(--brand-soft); }
.vp-dropzone-icon {
  display: grid; width: 42px; height: 42px; flex: none; place-items: center;
  border-radius: var(--radius-sm); background: var(--brand-soft); color: var(--brand-strong);
}
.vp-dropzone-copy { min-width: 0; flex: 1; }
.vp-dropzone-copy strong { display: block; color: var(--text); font-size: 14px; font-weight: 600; }
.vp-dropzone-copy span { display: block; margin-top: 3px; color: var(--dim); font-size: 12px; }
.vp-dropzone-actions { display: flex; flex: none; align-items: center; gap: 8px; }
.vp-kind-select { width: 140px; }
.vp-file-input { display: none; }
.vp-pending { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; border-color: var(--brand-line); padding: 12px 16px; }
.vp-pending-copy { min-width: 0; flex: 1; }
.vp-pending-copy strong { display: block; color: var(--text); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.vp-pending-label { max-width: 280px; }

.vp-asset-group { display: flex; flex-direction: column; gap: 8px; }
.vp-group-head { display: flex; align-items: center; gap: 8px; }
.vp-group-head h3 { color: var(--text); font-size: 14px; font-weight: 700; }
.vp-group-rule { flex: 1; height: 1px; background: var(--line); }
.vp-asset-row { display: flex; flex-wrap: wrap; gap: 10px; }
.vp-asset {
  display: block; width: 150px; overflow: hidden; padding: 0; text-align: left;
  border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface);
}
.vp-asset-img {
  position: relative; display: grid; width: 100%; height: 104px; place-items: center;
  overflow: hidden; background: linear-gradient(135deg, var(--blue-soft), var(--brand-soft));
}
.vp-asset-img img { width: 100%; height: 100%; object-fit: cover; }
.vp-asset-delete {
  position: absolute; top: 5px; right: 5px; display: grid; width: 22px; height: 22px;
  place-items: center; border: 0; border-radius: var(--radius-xs);
  background: rgba(255, 255, 255, .94); color: var(--red); box-shadow: var(--sh-1); cursor: pointer;
}
.vp-asset-delete:hover { background: var(--red-soft); }
/* 正式版本在用的图点不掉，降权比藏起来诚实：还在那儿，但一眼能看出不是现在能删的。 */
.vp-asset-delete.is-locked { color: var(--dim); cursor: help; }
.vp-asset-delete.is-locked:hover { background: rgba(255, 255, 255, .94); }
.vp-asset-meta { display: block; padding: 6px 8px 7px; }
.vp-asset-meta strong { display: block; overflow: hidden; color: var(--text); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.vp-asset-meta span { display: block; margin-top: 1px; color: var(--dim); font-size: 12px; line-height: 1.45; }
.vp-asset-add { display: grid; place-items: center; border-style: dashed; background: var(--surface-2); color: var(--dim); cursor: pointer; }
.vp-asset-add:hover { border-color: var(--brand-line); color: var(--brand-strong); }
.vp-asset-add .vp-asset-img { background: none; color: var(--faint); }
.vp-asset-add .vp-asset-meta { text-align: center; }

/* 版本历史 */
.vp-filter-note { margin-left: auto; font-size: 12px; }
.vp-version { display: flex; align-items: flex-start; gap: 12px; padding: 12px 15px; }
.vp-version.is-current { border-color: var(--green); }
.vp-version.is-draft { border-color: var(--amber-line); }
.vp-version-copy { min-width: 0; flex: 1; }
.vp-version-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.vp-version-head strong { color: var(--text); font-size: 14px; font-weight: 700; }
.vp-version-copy p { margin-top: 4px; color: var(--text-2); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.vp-version-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; color: var(--dim); font-size: 12px; }
.vp-version-actions { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 4px; }
.vp-version-actions .muted { font-size: 12px; }

/* 提示词差异 */
.vp-diff-lines { display: flex; flex-direction: column; gap: 2px; }
.vp-diff-label { color: var(--dim); font-size: 12px; font-weight: 600; }
.vp-diff-lines p { border-radius: var(--radius-xs); padding: 3px 8px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.vp-diff-lines p.is-add { background: var(--green-soft); color: var(--green); }
.vp-diff-lines p.is-del { background: var(--red-soft); color: var(--red); }

.vp-rules { display: grid; gap: 7px; }
.vp-rules p { color: var(--dim); font-size: 12px; line-height: 1.7; }

@media (max-width: 1080px) {
  .vp-grid { grid-template-columns: minmax(0, 1fr); }
  .vp-side { order: 2; }
  .vp-hero { grid-template-columns: auto minmax(0, 1fr); }
  .vp-hero-stats { grid-column: 1 / -1; border-top: 1px solid var(--line); padding-top: 10px; }
  .vp-stat:first-child { padding-left: 16px; border-left: 1px solid var(--line); }
  .vp-filter-note { margin-left: 0; }
}
</style>
