<script setup lang="ts">
/**
 * 本地观察（阶段三第一块）。
 *
 * 只读：列目录、读文本、按文件名/内容搜索。根目录、敏感文件过滤和审计都在服务端，
 * 页面不提供任何写操作；不要把这里做成文件管理器。
 */
import { Document, Folder, Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { readApiErrorMessage } from "~/utils/api-error";

definePageMeta({
  topbar: {
    title: "本地观察",
    crumbs: [{ label: "系统管理" }],
  },
});

type RootInfo = {
  root: string;
  name: string;
  readOnly: boolean;
  maxFileBytes: number;
  maxSearchResults: number;
};

type Entry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number | null;
  modifiedAt: string | null;
  readable: boolean;
};

type ListResult = {
  path: string;
  entries: Entry[];
  truncated: boolean;
};

type ReadResult = {
  path: string;
  size: number;
  modifiedAt: string;
  content: string;
  lines: number;
};

type SearchMatch = {
  path: string;
  kind: "name" | "content";
  line: number | null;
  preview: string;
};

type SearchResult = {
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
  scanned: number;
};

const request = useApiRequest();
const loading = ref(true);
const listing = ref(false);
const rootInfo = ref<RootInfo | null>(null);
const currentPath = ref("");
const entries = ref<Entry[]>([]);
const listTruncated = ref(false);
const pathInput = ref("");
const preview = ref<ReadResult | null>(null);
const previewLoading = ref(false);
const searchQuery = ref("");
const searching = ref(false);
const searchPerformed = ref(false);
const searchResult = ref<SearchResult | null>(null);

const breadcrumbs = computed(() => {
  const parts = currentPath.value.split("/").filter(Boolean);
  return parts.map((part, index) => ({
    label: part,
    path: parts.slice(0, index + 1).join("/"),
  }));
});

const parentPath = computed(() => currentPath.value.split("/").slice(0, -1).join("/"));
const isRoot = computed(() => currentPath.value === "");

function formatSize(size: number | null) {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function kindLabel(kind: Entry["kind"]) {
  return { directory: "目录", file: "文件", symlink: "链接", other: "其它" }[kind];
}

async function list(path: string) {
  listing.value = true;
  try {
    const result = await request<ListResult>({ url: "/local/observe/list", params: { path } });
    currentPath.value = result.path;
    pathInput.value = result.path;
    entries.value = result.entries;
    listTruncated.value = result.truncated;
    preview.value = null;
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "读取目录失败。"));
  } finally {
    listing.value = false;
  }
}

async function read(path: string) {
  previewLoading.value = true;
  try {
    preview.value = await request<ReadResult>({ url: "/local/observe/read", params: { path } });
  } catch (error) {
    preview.value = null;
    ElMessage.error(readApiErrorMessage(error, "读取文件失败。"));
  } finally {
    previewLoading.value = false;
  }
}

async function openEntry(entry: Entry) {
  if (entry.kind === "directory") {
    await list(entry.path);
    return;
  }
  if (entry.kind === "symlink") {
    ElMessage.info("符号链接只显示，不跟随。");
    return;
  }
  if (!entry.readable) {
    ElMessage.info("这个条目不是普通文件。");
    return;
  }
  await read(entry.path);
}

async function goPath(path: string) {
  await list(path);
}

async function openPathInput() {
  const path = pathInput.value.trim();
  if (path === currentPath.value) return;
  await list(path);
}

async function search() {
  const query = searchQuery.value.trim();
  if (query.length < 2) {
    ElMessage.info("搜索词至少 2 个字符。");
    return;
  }
  searching.value = true;
  searchPerformed.value = true;
  try {
    searchResult.value = await request<SearchResult>({
      url: "/local/observe/search",
      params: { q: query, path: currentPath.value },
    });
  } catch (error) {
    searchResult.value = null;
    ElMessage.error(readApiErrorMessage(error, "搜索失败。"));
  } finally {
    searching.value = false;
  }
}

async function openSearchMatch(match: SearchMatch) {
  await read(match.path);
}

function refresh() {
  if (searchPerformed.value) {
    void search();
  } else {
    void list(currentPath.value);
  }
}

onMounted(async () => {
  try {
    rootInfo.value = await request<RootInfo>({ url: "/local/observe/root" });
    await list("");
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "本地观察初始化失败。"));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="local-observe">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="只读观察"
      :description="rootInfo ? `根目录：${rootInfo.root} · 仅管理员 · 不写文件、不执行终端命令` : '只读观察项目目录；仅管理员可用。'"
    />

    <el-card
      v-loading="loading"
      shadow="never"
      class="observe-card"
    >
      <div class="toolbar">
        <div class="toolbar-main">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item>
              <button
                type="button"
                class="crumb-link"
                @click="goPath('')"
              >
                {{ rootInfo?.name || "项目根目录" }}
              </button>
            </el-breadcrumb-item>
            <el-breadcrumb-item
              v-for="crumb in breadcrumbs"
              :key="crumb.path"
            >
              <button
                type="button"
                class="crumb-link"
                @click="goPath(crumb.path)"
              >
                {{ crumb.label }}
              </button>
            </el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="toolbar-actions">
          <el-button
            :disabled="isRoot || listing"
            :icon="Folder"
            @click="goPath(parentPath)"
          >
            上一级
          </el-button>
          <el-button
            :loading="listing"
            :icon="Refresh"
            @click="refresh"
          >
            刷新
          </el-button>
        </div>
      </div>

      <div class="path-row">
        <el-input
          v-model="pathInput"
          placeholder="项目内相对路径，例如 server/utils"
          clearable
          @keyup.enter="openPathInput"
        />
        <el-button
          type="primary"
          :disabled="listing"
          @click="openPathInput"
        >
          打开
        </el-button>
      </div>

      <div class="search-row">
        <el-input
          v-model="searchQuery"
          placeholder="搜索文件名或内容（至少 2 个字符）"
          clearable
          :prefix-icon="Search"
          @keyup.enter="search"
        />
        <el-button
          type="primary"
          plain
          :loading="searching"
          @click="search"
        >
          搜索
        </el-button>
        <el-button
          v-if="searchPerformed"
          text
          @click="searchPerformed = false; searchResult = null"
        >
          返回浏览
        </el-button>
      </div>

      <el-alert
        v-if="listTruncated"
        type="warning"
        :closable="false"
        show-icon
        title="目录条目太多，只显示前 300 个。"
        class="compact-alert"
      />

      <div
        v-if="searchPerformed"
        class="result-block"
      >
        <div class="result-head">
          <span>搜索结果</span>
          <span
            v-if="searchResult"
            class="result-meta"
          >{{ searchResult.matches.length }} 条 · 扫描 {{ searchResult.scanned }} 个文件<template v-if="searchResult.truncated"> · 已截断</template></span>
        </div>
        <el-table
          v-if="searchResult?.matches.length"
          :data="searchResult.matches"
          row-key="path"
          size="small"
          class="result-table"
          @row-click="openSearchMatch"
        >
          <el-table-column
            label="类型"
            width="70"
          >
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="row.kind === 'name' ? 'success' : 'info'"
              >
                {{ row.kind === "name" ? "文件名" : "内容" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="path"
            label="路径"
            min-width="220"
          />
          <el-table-column
            label="行"
            width="60"
          >
            <template #default="{ row }">{{ row.line ?? "" }}</template>
          </el-table-column>
          <el-table-column
            prop="preview"
            label="匹配"
            min-width="260"
            show-overflow-tooltip
          />
        </el-table>
        <el-empty
          v-else
          :description="searching ? '正在搜索…' : '没有匹配结果。'"
          :image-size="72"
        />
      </div>

      <div
        v-else
        class="browse-grid"
      >
        <el-table
          v-loading="listing"
          :data="entries"
          row-key="path"
          size="small"
          class="entry-table"
          @row-click="openEntry"
        >
          <el-table-column
            label="名称"
            min-width="240"
          >
            <template #default="{ row }">
              <span class="entry-name">
                <el-icon class="entry-icon">
                  <Folder v-if="row.kind === 'directory'" />
                  <Document v-else />
                </el-icon>
                {{ row.name }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="类型"
            width="72"
          >
            <template #default="{ row }">
              <span class="muted">{{ kindLabel(row.kind) }}</span>
            </template>
          </el-table-column>
          <el-table-column
            label="大小"
            width="86"
          >
            <template #default="{ row }">{{ formatSize(row.size) }}</template>
          </el-table-column>
          <el-table-column
            label="修改时间"
            width="150"
          >
            <template #default="{ row }">{{ formatDate(row.modifiedAt) }}</template>
          </el-table-column>
        </el-table>

        <div class="preview-panel">
          <div class="preview-head">
            <span>预览</span>
            <span
              v-if="preview"
              class="result-meta"
            >{{ preview.path }} · {{ preview.lines }} 行 · {{ formatSize(preview.size) }}</span>
          </div>
          <div
            v-if="previewLoading"
            class="preview-placeholder"
          >
            正在读取…
          </div>
          <pre
            v-else-if="preview"
            class="preview-body"
          >{{ preview.content }}</pre>
          <div
            v-else
            class="preview-placeholder"
          >
            点左侧文本文件查看内容；这里不会显示二进制或超过 256 KB 的文件。
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.local-observe {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.observe-card {
  border-radius: 14px;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.toolbar-main {
  min-width: 0;
  flex: 1;
}
.toolbar-actions {
  display: flex;
  gap: 8px;
}
.crumb-link {
  border: 0;
  background: transparent;
  padding: 0;
  color: #4c6ef5;
  font: inherit;
  cursor: pointer;
}
.path-row,
.search-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.path-row .el-input,
.search-row .el-input {
  max-width: 520px;
}
.compact-alert {
  margin-top: 12px;
}
.browse-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr);
  gap: 14px;
  margin-top: 12px;
}
.entry-table,
.result-table {
  cursor: pointer;
}
.entry-name {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.entry-icon {
  color: #4c6ef5;
}
.muted {
  color: #8a94a6;
}
.result-block {
  margin-top: 12px;
}
.result-head,
.preview-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  font-weight: 600;
}
.result-meta {
  color: #8a94a6;
  font-size: 12px;
  font-weight: 400;
  word-break: break-all;
}
.preview-panel {
  min-width: 0;
  border: 1px solid #e4e9f2;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafbfe;
}
.preview-body {
  margin: 0;
  max-height: 520px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12px/1.65 "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
  color: #38414d;
}
.preview-placeholder {
  color: #98a2b3;
  font-size: 13px;
  padding: 18px 4px;
}
@media (max-width: 900px) {
  .browse-grid {
    grid-template-columns: 1fr;
  }
  .path-row .el-input,
  .search-row .el-input {
    max-width: none;
  }
}
</style>
