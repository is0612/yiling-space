<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({
  topbar: {
    title: "形象档案",
    crumbs: [{ label: "工作空间" }],
  },
});

type VisualVersion = {
  id: string;
  revision: number;
  status: "DRAFT" | "PUBLISHED";
  note: string;
  createdAt: string;
  publishedAt: string | null;
};
type VisualAsset = {
  id: string;
  kind: string;
  label: string;
  relativePath: string;
  mime: string;
  sizeBytes: number;
};
type VisualProfile = {
  id: string;
  coreAppearance: string;
  corePrompt: string;
  negativePrompt: string;
  currentPublishedRevision: number;
  assets: VisualAsset[];
  outfits: Array<{ id: string; name: string; prompt: string; isDefault: boolean }>;
  versions: VisualVersion[];
};
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const api = useApiRequest();
const profile = ref<VisualProfile | null>(null);
const coreAppearance = ref("");
const corePrompt = ref("");
const negativePrompt = ref("");
const versionNote = ref("");
const uploadFile = ref<File | null>(null);
const uploadLabel = ref("");
const uploadKind = ref("STANDARD");
const uploading = ref(false);
const loading = ref(false);
const saving = ref(false);
const publishing = ref(false);
const restoringVersionId = ref<string | null>(null);
const outfitName = ref("");
const outfitPrompt = ref("");
const outfitIsDefault = ref(false);
const editingOutfitId = ref<string | null>(null);
const outfitSaving = ref(false);
const loadError = ref("");
const draftRevision = ref<number | null>(null);
let requestVersion = 0;
let disposed = false;

const publishedVersion = computed(() => profile.value?.versions.find(
  item => item.revision === profile.value?.currentPublishedRevision,
) ?? null);

async function loadProfile() {
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
    coreAppearance.value = result.profile?.coreAppearance ?? "";
    corePrompt.value = result.profile?.corePrompt ?? "";
    negativePrompt.value = result.profile?.negativePrompt ?? "";
  } catch {
    if (current()) loadError.value = "读取形象档案失败，请检查网络后重试。";
  } finally {
    if (current()) loading.value = false;
  }
}

const assetUrl = (assetId: string) =>
  `/api/characters/${encodeURIComponent(characterId.value)}/visual-profile/assets/${encodeURIComponent(assetId)}`;

function onReferenceFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  uploadFile.value = file;
  if (file && !uploadLabel.value.trim()) uploadLabel.value = file.name.replace(/\\.[^.]+$/u, "").slice(0, 120);
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
    uploadFile.value = null;
    uploadLabel.value = "";
    ElMessage.success("参考图片已保存。");
    await loadProfile();
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "参考图片上传失败。");
  } finally {
    uploading.value = false;
  }
}

async function deleteReference(assetId: string) {
  const target = characterId.value;
  if (!target) return;
  try {
    await api({ url: `/characters/${encodeURIComponent(target)}/visual-profile/assets/${encodeURIComponent(assetId)}`, method: "delete" });
    if (characterId.value !== target) return;
    ElMessage.success("参考图片已删除。");
    await loadProfile();
  } catch {
    ElMessage.error("删除失败，参考图片仍保留在档案中。");
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
    ElMessage.success(`草稿 v${result.draftVersion.revision} 已保存，尚未成为正式形象。`);
    await loadProfile();
    draftRevision.value = result.draftVersion.revision;
  } catch {
    ElMessage.error("保存失败，内容没有被确认写入。");
  } finally {
    saving.value = false;
  }
}

function editOutfit(outfit: VisualProfile["outfits"][number]) {
  editingOutfitId.value = outfit.id;
  outfitName.value = outfit.name;
  outfitPrompt.value = outfit.prompt;
  outfitIsDefault.value = outfit.isDefault;
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
    await loadProfile();
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
    await loadProfile();
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

watch(characterId, () => { void loadProfile(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; requestVersion += 1; });
</script>

<template>
  <div class="page-container visual-profile-page">
    <section class="page-intro">
      <div class="page-eyebrow">CHARACTER VISUAL IDENTITY</div>
      <h2>让她每次画自己，都还是她自己。</h2>
      <p>这里保存角色稳定的视觉身份。核心外貌、服装造型和参考素材分开管理；修改先保存为草稿，只有你明确发布后才成为正式形象。</p>
    </section>

    <el-empty v-if="!activeCharacter" description="请先从左下角选择一个角色。" />
    <template v-else>
      <el-alert
        v-if="loadError"
        :title="loadError"
        type="error"
        :closable="false"
        show-icon
      >
        <template #default><el-button size="small" @click="loadProfile">重新读取</el-button></template>
      </el-alert>

      <el-skeleton v-if="loading" :rows="7" animated />

      <template v-else>
        <section class="profile-status">
          <div>
            <div class="status-label">当前角色</div>
            <strong>{{ activeCharacter.name }}</strong>
            <p>正式版本：{{ profile?.currentPublishedRevision ? `v${profile.currentPublishedRevision}` : "尚未发布" }}</p>
          </div>
          <div class="status-version">
            <el-tag v-if="publishedVersion" type="success">已发布</el-tag>
            <el-tag v-else type="info">尚无正式版本</el-tag>
            <span v-if="publishedVersion">发布于 {{ new Date(publishedVersion.publishedAt || publishedVersion.createdAt).toLocaleString() }}</span>
          </div>
        </section>

        <el-card shadow="never">
          <template #header><div class="card-heading"><strong>核心形象</strong><span>稳定外貌，不包含特定服装</span></div></template>
          <el-form label-position="top">
            <el-form-item label="外貌设定">
              <el-input v-model="coreAppearance" type="textarea" :rows="4" maxlength="12000" show-word-limit placeholder="例如：蓝紫色长发、蓝色眼睛、鲸鱼耳与尾巴；少女形态，中间体型比例……" />
            </el-form-item>
            <el-form-item label="核心绘图提示词">
              <el-input v-model="corePrompt" type="textarea" :rows="5" maxlength="12000" show-word-limit placeholder="写下每次绘图都应保持的角色视觉特征。" />
            </el-form-item>
            <el-form-item label="负面提示词">
              <el-input v-model="negativePrompt" type="textarea" :rows="3" maxlength="6000" show-word-limit placeholder="写下希望避免的外观偏差或画面问题。" />
            </el-form-item>
            <el-form-item label="本次修改说明">
              <el-input v-model="versionNote" maxlength="300" placeholder="例如：确定发色和体型比例" />
            </el-form-item>
          </el-form>
          <div class="form-actions">
            <el-button type="primary" :loading="saving" @click="saveDraft">保存为草稿</el-button>
            <el-button type="success" :disabled="!draftRevision || saving" :loading="publishing" @click="publishDraft">
              发布草稿 v{{ draftRevision ?? "—" }}
            </el-button>
          </div>
          <p class="form-hint">保存草稿不会改变正式形象。发布操作会明确推进当前正式版本；历史版本仍会保留。</p>
        </el-card>

        <div class="visual-profile-grid">
          <el-card shadow="never" class="visual-profile-card">
            <h3>三视图与参考素材</h3>
            <p>正面、侧面、背面、表情和服装素材会按用途归档。当前已建立资料结构，图片上传与预览还在下一阶段。</p>
            <div class="upload-row">
              <el-select v-model="uploadKind" aria-label="参考图片用途" style="width: 150px">
                <el-option label="标准形象" value="STANDARD" />
                <el-option label="正面三视图" value="FRONT_VIEW" />
                <el-option label="侧面三视图" value="SIDE_VIEW" />
                <el-option label="背面三视图" value="BACK_VIEW" />
                <el-option label="表情参考" value="EXPRESSION" />
                <el-option label="服装参考" value="OUTFIT" />
                <el-option label="配饰参考" value="ACCESSORY" />
                <el-option label="补充素材" value="SUPPLEMENT" />
              </el-select>
              <input type="file" accept="image/png,image/jpeg,image/webp" @change="onReferenceFileChange">
            </div>
            <el-input v-model="uploadLabel" maxlength="120" placeholder="给这张参考图起个名字" />
            <el-button type="primary" :disabled="!uploadFile || !uploadLabel.trim()" :loading="uploading" @click="uploadReference">上传参考图片</el-button>
            <el-empty v-if="!profile?.assets.length" description="还没有参考图片" :image-size="64" />
            <div v-else class="reference-grid">
              <article v-for="asset in profile.assets" :key="asset.id" class="reference-item">
                <img :src="assetUrl(asset.id)" :alt="asset.label">
                <div class="reference-meta"><strong>{{ asset.label }}</strong><span>{{ asset.kind }}</span></div>
                <el-button link type="danger" @click="deleteReference(asset.id)">删除</el-button>
              </article>
            </div>
          </el-card>
          <el-card shadow="never" class="visual-profile-card">
            <h3>服装造型</h3>
            <p>服装与配饰独立于核心外貌。设置一个默认造型后，绘图会优先使用它；其他造型不会混合进同一张图。</p>
            <div v-for="outfit in profile?.outfits || []" :key="outfit.id" class="outfit-row">
              <div><strong>{{ outfit.name }}</strong><el-tag v-if="outfit.isDefault" size="small" type="success">默认</el-tag><p>{{ outfit.prompt }}</p></div>
              <div class="outfit-actions"><el-button link @click="editOutfit(outfit)">编辑</el-button><el-button link type="danger" @click="deleteOutfit(outfit.id)">删除</el-button></div>
            </div>
            <el-divider />
            <el-form label-position="top">
              <el-form-item label="造型名称"><el-input v-model="outfitName" maxlength="100" placeholder="例如：日常服、深蓝女仆装" /></el-form-item>
              <el-form-item label="造型提示词"><el-input v-model="outfitPrompt" type="textarea" :rows="3" maxlength="6000" placeholder="只描述服装、配饰和造型，不要重复核心外貌。" /></el-form-item>
              <el-checkbox v-model="outfitIsDefault">设为默认造型</el-checkbox>
            </el-form>
            <div class="form-actions">
              <el-button type="primary" :loading="outfitSaving" :disabled="!outfitName.trim() || !outfitPrompt.trim()" @click="saveOutfit">{{ editingOutfitId ? "保存修改" : "新增造型" }}</el-button>
              <el-button v-if="editingOutfitId" @click="resetOutfitForm">取消编辑</el-button>
            </div>
          </el-card>
        </div>

        <el-card shadow="never">
          <template #header><strong>版本历史</strong></template>
          <el-empty v-if="!profile?.versions.length" description="保存第一份草稿后，版本记录会显示在这里。" :image-size="64" />
          <el-timeline v-else>
            <el-timeline-item v-for="item in profile.versions" :key="item.id" :timestamp="new Date(item.createdAt).toLocaleString()">
              <strong>版本 v{{ item.revision }}</strong>
              <el-tag size="small" :type="item.revision === profile.currentPublishedRevision ? 'success' : item.status === 'DRAFT' ? 'warning' : 'info'">
                {{ item.revision === profile.currentPublishedRevision ? "当前正式版本" : item.status === "DRAFT" ? "草稿" : "历史正式版本" }}
              </el-tag>
              <p>{{ item.note || "未填写版本说明" }}</p>
              <el-button v-if="item.revision !== profile.currentPublishedRevision" size="small" link type="primary" :loading="restoringVersionId === item.id" @click="restoreVersion(item.id)">恢复为草稿</el-button>
            </el-timeline-item>
          </el-timeline>
        </el-card>
      </template>
    </template>
  </div>
</template>

<style scoped>
.visual-profile-page { display: grid; gap: 20px; }
.page-intro { padding: 8px 2px 4px; }
.page-eyebrow { color: var(--el-color-primary); font-size: 11px; font-weight: 700; letter-spacing: .14em; }
.page-intro h2 { margin: 10px 0; font-size: 25px; color: var(--el-text-color-primary); }
.page-intro p { max-width: 760px; margin: 0; color: var(--el-text-color-secondary); line-height: 1.8; }
.profile-status { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 20px; border: 1px solid var(--el-border-color); border-radius: 10px; }
.status-label, .card-heading span, .form-hint { color: var(--el-text-color-secondary); font-size: 12px; }
.profile-status strong { display: block; margin-top: 4px; font-size: 20px; }
.profile-status p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.status-version { display: grid; justify-items: end; gap: 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.form-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.form-hint { margin: 12px 0 0; line-height: 1.7; }
.visual-profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.visual-profile-card { min-height: 190px; }
.visual-profile-card h3 { margin: 0 0 10px; font-size: 16px; }
.visual-profile-card p { color: var(--el-text-color-secondary); line-height: 1.7; }
.asset-list { padding-left: 20px; color: var(--el-text-color-secondary); line-height: 1.9; }
.upload-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0; }
.reference-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; margin-top: 14px; }
.reference-item { min-width: 0; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.reference-item img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background: var(--el-fill-color-lighter); border-radius: 5px; }
.reference-meta { display: grid; gap: 3px; margin: 7px 0; }
.reference-meta strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.reference-meta span { color: var(--el-text-color-secondary); font-size: 11px; }
.outfit-row { display: flex; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.outfit-row > div:first-child { min-width: 0; }
.outfit-row strong { margin-right: 8px; }
.outfit-row p { margin: 5px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.outfit-actions { flex: 0 0 auto; display: flex; align-items: flex-start; }
@media (max-width: 720px) { .visual-profile-grid { grid-template-columns: 1fr; } .profile-status { align-items: flex-start; } .status-version { text-align: right; } }
</style>
