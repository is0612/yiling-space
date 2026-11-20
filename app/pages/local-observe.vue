<script setup lang="ts">
/**
 * 本地观察（阶段三第一块）。
 *
 * 只读：列目录、读文本、按文件名/内容搜索。根目录、敏感文件过滤和审计都在服务端，
 * 页面不提供任何写操作；不要把这里做成文件管理器。
 */
import { Document, Folder, Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
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

type LocalObserveRoot = {
  id: string;
  label: string;
  path: string;
  mode: "READ_ONLY" | "READ_WRITE";
  enabled: boolean;
  builtin: boolean;
};

type LocalWriteRequest = {
  id: string;
  taskId?: string | null;
  readback?: { path: string; matches: boolean; preview?: string; truncated?: boolean };
  relativePath: string;
  content: string;
  reason: string;
  status: "PENDING" | "APPROVING" | "APPLIED" | "REJECTED" | "FAILED";
  createdAt: string;
  error: string | null;
  root: { id: string; label: string; path: string; mode: "READ_ONLY" | "READ_WRITE" };
};

type LocalTaskStatus = "PLANNED" | "WAITING_APPROVAL" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

type LocalTask = {
  id: string;
  title: string;
  goal: string;
  plan: string;
  status: LocalTaskStatus;
  resultNote: string | null;
  createdAt: string;
  completedAt: string | null;
  _count?: { writeRequests: number; evidence: number };
};

type LocalTaskDetail = LocalTask & {
  steps: Array<{ title: string; status: string; note?: string; verifyWriteId?: string; request?: { kind: "write" | "command"; id: string } }>;
  commandRequests: Array<{ id: string; command: string; status: string; cwd: string; root: { label: string } }>;
  writeRequests: Array<{
    id: string;
    relativePath: string;
    status: string;
    reason: string;
    createdAt: string;
    root: { id: string; label: string; path: string; mode: string };
  }>;
  evidence: Array<{
    id: string;
    kind: string;
    outcome: "PASS" | "FAIL" | "INFO";
    note: string;
    createdAt: string;
  }>;
};

type LocalCommandRequest = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  reason: string;
  status: "PENDING" | "APPROVING" | "SUCCEEDED" | "FAILED" | "REJECTED";
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  durationMs: number | null;
  createdAt: string;
  error: string | null;
  root: { id: string; label: string; path: string };
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
  root: LocalObserveRoot;
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
const roots = ref<LocalObserveRoot[]>([]);
const selectedRootId = ref("project");
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
const manageVisible = ref(false);
const manageRoots = ref<LocalObserveRoot[]>([]);
const manageLoading = ref(false);
const newRootPath = ref("");
const newRootLabel = ref("");
const savingRoot = ref(false);
const writeVisible = ref(false);
const writeLoading = ref(false);
const writeRequests = ref<LocalWriteRequest[]>([]);
const selectedWrite = ref<LocalWriteRequest | null>(null);
const writeBusy = ref(false);
const pendingWriteCount = computed(() => writeRequests.value.filter((request) => request.status === "PENDING").length);
const tasksVisible = ref(false);
const tasksLoading = ref(false);
const tasks = ref<LocalTask[]>([]);
const selectedTask = ref<LocalTask | null>(null);
const taskDetail = ref<LocalTaskDetail | null>(null);
const taskDetailLoading = ref(false);
const taskBusy = ref(false);
const taskIsClosed = computed(() => ["CANCELLED", "SUCCEEDED", "FAILED"].includes(taskDetail.value?.status ?? ""));
const commandVisible = ref(false);
const gitVisible = ref(false);
const commandLoading = ref(false);
const commandRequests = ref<LocalCommandRequest[]>([]);
const selectedCommand = ref<LocalCommandRequest | null>(null);
const commandBusy = ref(false);
const pendingCommandCount = computed(() => commandRequests.value.filter((request) => request.status === "PENDING").length);

const selectedRoot = computed(() =>
  roots.value.find((root) => root.id === selectedRootId.value) ?? roots.value[0] ?? null,
);

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
    const result = await request<ListResult>({
      url: "/local/observe/list",
      params: { rootId: selectedRootId.value, path },
    });
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
    preview.value = await request<ReadResult>({
      url: "/local/observe/read",
      params: { rootId: selectedRootId.value, path },
    });
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
      params: { rootId: selectedRootId.value, q: query, path: currentPath.value },
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

async function loadRoots() {
  const result = await request<{ roots: LocalObserveRoot[] }>({ url: "/local/observe/roots" });
  roots.value = result.roots;
  if (!roots.value.some((root) => root.id === selectedRootId.value)) {
    selectedRootId.value = roots.value[0]?.id ?? "project";
  }
}

async function changeRoot() {
  currentPath.value = "";
  preview.value = null;
  searchPerformed.value = false;
  searchResult.value = null;
  await list("");
}

async function openManage() {
  manageVisible.value = true;
  manageLoading.value = true;
  try {
    const result = await request<{ roots: LocalObserveRoot[] }>({ url: "/local/roots" });
    manageRoots.value = result.roots;
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "读取授权目录失败。"));
  } finally {
    manageLoading.value = false;
  }
}

async function refreshManage() {
  const result = await request<{ roots: LocalObserveRoot[] }>({ url: "/local/roots" });
  manageRoots.value = result.roots;
  await loadRoots();
}

async function addRoot() {
  const path = newRootPath.value.trim();
  if (!path) {
    ElMessage.info("请填写要授权的绝对目录。");
    return;
  }
  savingRoot.value = true;
  try {
    const result = await request<{ root: LocalObserveRoot }>({
      url: "/local/roots",
      method: "post",
      data: { path, label: newRootLabel.value.trim() || undefined },
    });
    ElMessage.success(`已授权：${result.root.label}`);
    newRootPath.value = "";
    newRootLabel.value = "";
    selectedRootId.value = result.root.id;
    await refreshManage();
    await list("");
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "添加授权目录失败。"));
  } finally {
    savingRoot.value = false;
  }
}

function asLocalRoot(row: unknown): LocalObserveRoot {
  return row as LocalObserveRoot;
}

function asWriteRequest(row: unknown): LocalWriteRequest {
  return row as LocalWriteRequest;
}

function changeRootMode(row: unknown, mode: unknown) {
  if (mode !== "READ_ONLY" && mode !== "READ_WRITE") return;
  void setRootMode(asLocalRoot(row), mode);
}

async function toggleRoot(root: LocalObserveRoot) {
  try {
    await request({
      url: `/local/roots/${root.id}`,
      method: "patch",
      data: { enabled: !root.enabled },
    });
    await refreshManage();
    if (selectedRootId.value === root.id && root.enabled) {
      selectedRootId.value = "project";
      await list("");
    }
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "更新授权目录失败。"));
  }
}

async function removeRoot(root: LocalObserveRoot) {
  try {
    await ElMessageBox.confirm(
      `从白名单移除「${root.label}」？不会删除磁盘上的文件。`,
      "移除授权目录",
      { type: "warning", confirmButtonText: "移除", cancelButtonText: "取消" },
    );
    await request({ url: `/local/roots/${root.id}`, method: "delete" });
    ElMessage.success("已移除授权目录。");
    if (selectedRootId.value === root.id) selectedRootId.value = "project";
    await refreshManage();
    await list("");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(readApiErrorMessage(error, "移除授权目录失败。"));
  }
}

async function setRootMode(root: LocalObserveRoot, mode: "READ_ONLY" | "READ_WRITE") {
  try {
    await request({
      url: `/local/roots/${root.id}`,
      method: "patch",
      data: { mode },
    });
    await refreshManage();
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "更新目录权限失败。"));
  }
}

async function loadWriteRequests(showDialog = false) {
  if (showDialog) writeVisible.value = true;
  writeLoading.value = true;
  try {
    const result = await request<{ requests: LocalWriteRequest[] }>({
      url: "/local/write-requests",
      params: { status: "PENDING" },
    });
    writeRequests.value = result.requests;
    if (!selectedWrite.value || !writeRequests.value.some((request) => request.id === selectedWrite.value?.id)) {
      selectedWrite.value = writeRequests.value[0] ?? null;
    }
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "读取写文件审批失败。"));
  } finally {
    writeLoading.value = false;
  }
}

async function openWrites() {
  await loadWriteRequests(true);
}

async function approveWrite(write: LocalWriteRequest) {
  try {
    await ElMessageBox.confirm(
      `批准写入「${write.root.label}/${write.relativePath}」？这会覆盖目标文件。`,
      "批准写文件",
      { type: "warning", confirmButtonText: "批准写入", cancelButtonText: "取消" },
    );
    writeBusy.value = true;
    const { request: applied } = await request<{ request: LocalWriteRequest }>({ url: `/local/write-requests/${write.id}/approve`, method: "post" });
    if (applied.readback && !applied.readback.matches) ElMessage.warning("已写入，但读回核对未通过。请查看任务档案。");
    else ElMessage.success(applied.readback ? "已写入并读回核对，请查看任务结果。" : "已写入。");
    await loadWriteRequests();
    if (applied.taskId && applied.readback) {
      writeVisible.value = false;
      await openTasks(applied.taskId);
    } else if (tasksVisible.value) await openTasks();
    await refreshManage();
    await list(currentPath.value);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(readApiErrorMessage(error, "写入失败。"));
  } finally {
    writeBusy.value = false;
  }
}

async function rejectWrite(write: LocalWriteRequest) {
  try {
    const result = await ElMessageBox.prompt("拒绝原因（可留空）", "拒绝写文件", {
      confirmButtonText: "拒绝",
      cancelButtonText: "取消",
      inputPlaceholder: "例如：这次不需要改这个文件",
    });
    writeBusy.value = true;
    await request({
      url: `/local/write-requests/${write.id}/reject`,
      method: "post",
      data: { reason: result.value ?? "" },
    });
    ElMessage.success("已拒绝。");
    await loadWriteRequests();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(readApiErrorMessage(error, "拒绝写请求失败。"));
  } finally {
    writeBusy.value = false;
  }
}

function taskStatusLabel(status: string) {
  return {
    PLANNED: "已计划",
    WAITING_APPROVAL: "待审批",
    RUNNING: "进行中",
    SUCCEEDED: "已验收",
    FAILED: "验收失败",
    CANCELLED: "已取消",
  }[status as LocalTaskStatus] ?? status;
}

function taskStatusType(status: string) {
  return ({
    PLANNED: "info",
    WAITING_APPROVAL: "warning",
    RUNNING: "primary",
    SUCCEEDED: "success",
    FAILED: "danger",
    CANCELLED: "info",
  } as Record<string, "info" | "warning" | "primary" | "success" | "danger">)[status] ?? "info";
}

let taskDetailRequest = 0;
async function loadTaskDetail(id: string) {
  const version = ++taskDetailRequest;
  stepRequestChoice.value = "";
  taskDetailLoading.value = true;
  try {
    const result = await request<{ task: LocalTaskDetail }>({ url: `/local/tasks/${id}` });
    if (version === taskDetailRequest && selectedTask.value?.id === id) taskDetail.value = result.task;
  } catch (error) {
    if (version !== taskDetailRequest) return;
    taskDetail.value = null;
    ElMessage.error(readApiErrorMessage(error, "读取任务详情失败。"));
  } finally {
    if (version === taskDetailRequest) taskDetailLoading.value = false;
  }
}

async function openTasks(taskId?: string) {
  tasksVisible.value = true;
  tasksLoading.value = true;
  try {
    const result = await request<{ tasks: LocalTask[] }>({ url: "/local/tasks" });
    tasks.value = result.tasks;
    if (taskId) {
      selectedTask.value = tasks.value.find(task => task.id === taskId)
        ?? (await request<{ task: LocalTaskDetail }>({ url: `/local/tasks/${taskId}` })).task;
    } else if (!selectedTask.value || !tasks.value.some((task) => task.id === selectedTask.value?.id)) {
      selectedTask.value = tasks.value[0] ?? null;
    }
    if (selectedTask.value) await loadTaskDetail(selectedTask.value.id);
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "读取任务档案失败。"));
  } finally {
    tasksLoading.value = false;
  }
}

async function selectTask(row: unknown) {
  const task = row as LocalTask;
  selectedTask.value = task;
  await loadTaskDetail(task.id);
}

async function recordTask(outcome: "PASS" | "FAIL") {
  const task = selectedTask.value;
  if (!task) return;
  try {
    const result = await ElMessageBox.prompt(
      outcome === "PASS" ? "验收通过的依据（例如：跑过测试、检查了输出）" : "验收失败的原因",
      outcome === "PASS" ? "验收通过" : "验收失败",
      {
        confirmButtonText: outcome === "PASS" ? "通过" : "失败",
        cancelButtonText: "取消",
        inputPlaceholder: outcome === "PASS" ? "例如：test:local-write 通过，文件内容符合预期" : "例如：写入后测试仍然失败",
      },
    );
    if (!result.value?.trim()) {
      ElMessage.info("请写一句验收依据。");
      return;
    }
    taskBusy.value = true;
    await request({
      url: `/local/tasks/${task.id}/evidence`,
      method: "post",
      data: { outcome, note: result.value.trim() },
    });
    ElMessage.success(outcome === "PASS" ? "已记录验收通过。" : "已记录验收失败。");
    await openTasks();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(readApiErrorMessage(error, "记录验收失败。"));
  } finally {
    taskBusy.value = false;
  }
}

const stepRequestChoice = ref("");
const currentTaskStep = computed(() => taskDetail.value?.steps.findIndex(step => step.status !== "DONE") ?? -1);
const availableStepRequests = computed(() => {
  const task = taskDetail.value;
  if (!task) return [];
  const linked = new Set(task.steps.flatMap(step => step.request ? [`${step.request.kind}:${step.request.id}`] : []));
  return [
    ...task.writeRequests.map(row => ({ value: `write:${row.id}`, label: `写文件 · ${row.root.label}/${row.relativePath} · ${row.status}` })),
    ...task.commandRequests.map(row => ({ value: `command:${row.id}`, label: `命令 · ${row.root.label} / ${row.command} · ${row.status}` })),
  ].filter(entry => !linked.has(entry.value));
});
const stepLabels: Record<string, string> = {
  TODO: "待处理", DONE: "已完成", FAILED: "失败", CANCELLED: "已取消",
  RUNNING: "执行中", WAITING_APPROVAL: "待审批", BLOCKED: "等前一步",
};

async function saveTaskStep(taskId: string, data: Record<string, unknown>) {
  if (taskBusy.value || taskDetail.value?.id !== taskId) return;
  taskBusy.value = true;
  try {
    await request({ url: `/local/tasks/${taskId}/steps`, method: "post", data });
    stepRequestChoice.value = "";
    if (selectedTask.value?.id === taskId) await loadTaskDetail(taskId);
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "保存步骤失败。"));
  } finally {
    taskBusy.value = false;
  }
}

async function promptTaskStep(action: "plan" | "done" | "fail", index?: number) {
  const task = taskDetail.value;
  if (!task) return;
  try {
    const { value } = await ElMessageBox.prompt(action === "plan" ? "每行一个步骤，按执行顺序填写。" : "请记录这一步的实际结果。", action === "plan" ? "建立步骤" : action === "done" ? "完成步骤" : "标记步骤失败", {
      inputType: "textarea", confirmButtonText: "保存", cancelButtonText: "取消",
      inputValidator: text => Boolean(text?.trim()) || "请填写内容。",
    });
    await saveTaskStep(task.id, action === "plan"
      ? { action, titles: value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) }
      : { action, index, note: value });
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error("未能记录步骤。");
  }
}

function linkTaskStep(index: number) {
  const task = taskDetail.value;
  if (!task || !stepRequestChoice.value) return;
  const [kind, requestId] = stepRequestChoice.value.split(":");
  void saveTaskStep(task.id, { action: "link", index, kind, requestId });
}

async function cancelTask() {
  const task = selectedTask.value;
  if (!task) return;
  try {
    await ElMessageBox.confirm(`取消任务「${task.title}」？关联的待审批请求会一并撤销，已经执行的操作不会回滚。`, "取消任务", {
      type: "warning",
      confirmButtonText: "取消任务",
      cancelButtonText: "返回",
    });
    taskBusy.value = true;
    await request({ url: `/local/tasks/${task.id}/cancel`, method: "post" });
    ElMessage.success("任务已取消。");
    await openTasks();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(readApiErrorMessage(error, "取消任务失败。"));
  } finally {
    taskBusy.value = false;
  }
}

function asCommand(row: unknown): LocalCommandRequest {
  return row as LocalCommandRequest;
}

async function loadCommandRequests(showDialog = false) {
  if (showDialog) commandVisible.value = true;
  commandLoading.value = true;
  try {
    const result = await request<{ requests: LocalCommandRequest[] }>({
      url: "/local/command-requests",
      params: { status: "PENDING" },
    });
    commandRequests.value = result.requests;
    if (!selectedCommand.value || !commandRequests.value.some((request) => request.id === selectedCommand.value?.id)) {
      selectedCommand.value = commandRequests.value[0] ?? null;
    }
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "读取命令审批失败。"));
  } finally {
    commandLoading.value = false;
  }
}

async function openCommands() {
  await loadCommandRequests(true);
}

async function approveCommand(command: LocalCommandRequest) {
  try {
    await ElMessageBox.confirm(
      `批准执行「${command.command} ${command.args.join(" ")}」？`,
      "批准执行命令",
      { type: "warning", confirmButtonText: "批准执行", cancelButtonText: "取消" },
    );
    commandBusy.value = true;
    const result = await request<{ request: LocalCommandRequest }>({
      url: `/local/command-requests/${command.id}/approve`,
      method: "post",
    });
    selectedCommand.value = result.request;
    commandRequests.value = commandRequests.value.filter((item) => item.id !== command.id);
    ElMessage.success(result.request.status === "SUCCEEDED" ? "命令执行成功。" : "命令已执行，但退出状态不是 0。");
    if (tasksVisible.value) await openTasks();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(readApiErrorMessage(error, "执行命令失败。"));
  } finally {
    commandBusy.value = false;
  }
}

async function rejectCommand(command: LocalCommandRequest) {
  try {
    const result = await ElMessageBox.prompt("拒绝原因（可留空）", "拒绝执行命令", {
      confirmButtonText: "拒绝",
      cancelButtonText: "取消",
      inputPlaceholder: "例如：这个命令会改太多文件",
    });
    commandBusy.value = true;
    await request({
      url: `/local/command-requests/${command.id}/reject`,
      method: "post",
      data: { reason: result.value ?? "" },
    });
    ElMessage.success("已拒绝。");
    await loadCommandRequests();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(readApiErrorMessage(error, "拒绝命令失败。"));
  } finally {
    commandBusy.value = false;
  }
}

onMounted(async () => {
  try {
    rootInfo.value = await request<RootInfo>({ url: "/local/observe/root" });
    await loadRoots();
    await list("");
    await loadWriteRequests();
    await loadCommandRequests();
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
      :description="selectedRoot ? `根目录：${selectedRoot.path} · 仅管理员 · 不写文件、不执行终端命令` : '只读观察授权目录；仅管理员可用。'"
    />

    <el-card
      v-loading="loading"
      shadow="never"
      class="observe-card"
    >
      <div class="toolbar">
        <div class="toolbar-main">
          <div class="root-row">
            <el-select
              v-model="selectedRootId"
              class="root-select"
              :disabled="listing"
              @change="changeRoot"
            >
              <el-option
                v-for="root in roots"
                :key="root.id"
                :label="root.label"
                :value="root.id"
              >
                <span>{{ root.label }}</span>
                <span class="option-path">{{ root.path }}</span>
              </el-option>
            </el-select>
            <el-button
              :icon="Folder"
              @click="openManage"
            >
              管理目录
            </el-button>
            <el-button
              :type="pendingWriteCount ? 'warning' : 'default'"
              @click="openWrites"
            >
              写审批{{ pendingWriteCount ? ` (${pendingWriteCount})` : "" }}
            </el-button>
            <el-button
              :type="pendingCommandCount ? 'warning' : 'default'"
              @click="openCommands"
            >
              命令审批{{ pendingCommandCount ? ` (${pendingCommandCount})` : "" }}
            </el-button>
            <el-button
              :disabled="!selectedRoot"
              @click="gitVisible = true"
            >
              Git
            </el-button>
            <el-button @click="openTasks()">
              任务档案
            </el-button>
          </div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item>
              <button
                type="button"
                class="crumb-link"
                @click="goPath('')"
              >
                {{ selectedRoot?.label || rootInfo?.name || "项目根目录" }}
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

    <el-dialog
      v-model="manageVisible"
      title="授权目录"
      width="760px"
      append-to-body
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="她只能读取这里列出的目录"
        description="移除只影响白名单，不会删除磁盘文件。写权限只对开启「可写」的目录生效，且每次写入仍需在「写审批」里确认。"
      />
      <div class="manage-add">
        <el-input
          v-model="newRootPath"
          placeholder="绝对路径，例如 D:\Projects"
          clearable
          @keyup.enter="addRoot"
        />
        <el-input
          v-model="newRootLabel"
          placeholder="显示名称（可选）"
          clearable
        />
        <el-button
          type="primary"
          :loading="savingRoot"
          @click="addRoot"
        >
          添加
        </el-button>
      </div>
      <el-table
        v-loading="manageLoading"
        :data="manageRoots"
        row-key="id"
        size="small"
        class="manage-table"
      >
        <el-table-column
          label="名称"
          min-width="150"
        >
          <template #default="{ row }">
            <span>{{ row.label }}</span>
            <el-tag
              v-if="row.builtin"
              size="small"
              type="info"
              class="builtin-tag"
            >
              内置
            </el-tag>
            <el-tag
              v-else
              size="small"
              :type="row.enabled ? 'success' : 'info'"
              class="builtin-tag"
            >
              {{ row.enabled ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column
          prop="path"
          label="路径"
          min-width="260"
          show-overflow-tooltip
        />
        <el-table-column
          label="权限"
          width="130"
        >
          <template #default="{ row }">
            <el-select
              v-if="!row.builtin"
              :model-value="row.mode"
              size="small"
              @change="changeRootMode(row, $event)"
            >
              <el-option
                label="只读"
                value="READ_ONLY"
              />
              <el-option
                label="可写"
                value="READ_WRITE"
              />
            </el-select>
            <span
              v-else
              class="muted"
            >只读</span>
          </template>
        </el-table-column>
        <el-table-column
          label="操作"
          width="150"
        >
          <template #default="{ row }">
            <template v-if="!row.builtin">
              <el-switch
                :model-value="row.enabled"
                size="small"
                @change="toggleRoot(asLocalRoot(row))"
              />
              <el-button
                text
                type="danger"
                size="small"
                @click="removeRoot(asLocalRoot(row))"
              >
                移除
              </el-button>
            </template>
            <span
              v-else
              class="muted"
            >不可移除</span>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="manageVisible = false">
          关闭
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="writeVisible"
      title="写文件审批"
      width="860px"
      append-to-body
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="批准之前不会写盘"
        description="模型只能提交写文件请求；这里批准后才会覆盖目标文件。请先看路径和内容。"
      />
      <div
        v-if="!writeLoading && !writeRequests.length"
        class="write-empty"
      >
        没有待审批的写文件请求。
      </div>
      <div
        v-else
        class="write-grid"
      >
        <el-table
          v-loading="writeLoading"
          :data="writeRequests"
          row-key="id"
          size="small"
          highlight-current-row
          class="write-table"
          @row-click="(row) => selectedWrite = asWriteRequest(row)"
        >
          <el-table-column
            label="目录"
            width="110"
          >
            <template #default="{ row }">
              {{ row.root.label }}
            </template>
          </el-table-column>
          <el-table-column
            prop="relativePath"
            label="路径"
            min-width="180"
            show-overflow-tooltip
          />
          <el-table-column
            prop="reason"
            label="原因"
            min-width="160"
            show-overflow-tooltip
          />
          <el-table-column
            label="时间"
            width="145"
          >
            <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
          </el-table-column>
        </el-table>
        <div
          v-if="selectedWrite"
          class="write-preview"
        >
          <div class="preview-head">
            <span>{{ selectedWrite.root.label }} / {{ selectedWrite.relativePath }}</span>
          </div>
          <div class="write-reason">
            {{ selectedWrite.reason }}
          </div>
          <pre class="preview-body write-content">{{ selectedWrite.content }}</pre>
          <div class="write-actions">
            <el-button
              type="danger"
              plain
              :disabled="writeBusy"
              @click="rejectWrite(selectedWrite)"
            >
              拒绝
            </el-button>
            <el-button
              type="primary"
              :loading="writeBusy"
              @click="approveWrite(selectedWrite)"
            >
              批准写入
            </el-button>
          </div>
        </div>
        <div
          v-else
          class="preview-placeholder"
        >
          选一条请求查看要写入的内容。
        </div>
      </div>
      <template #footer>
        <el-button @click="writeVisible = false">
          关闭
        </el-button>
      </template>
    </el-dialog>

    <LocalGitDialog
      v-if="selectedRoot"
      :key="selectedRoot.id"
      v-model="gitVisible"
      :root-id="selectedRoot.id"
      :writable="selectedRoot.mode === 'READ_WRITE' && !selectedRoot.builtin"
      @proposed="loadCommandRequests()"
    />

    <el-dialog
      v-model="commandVisible"
      title="命令审批"
      width="900px"
      append-to-body
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="批准之前不会执行"
        description="终端命令和 Git 新建分支都在这里审批。Git 请求只新建分支，不切换当前分支。"
      />
      <div
        v-if="!commandLoading && !commandRequests.length && !selectedCommand"
        class="write-empty"
      >
        没有待审批的命令。
      </div>
      <div
        v-else
        class="task-grid"
      >
        <el-table
          v-loading="commandLoading"
          :data="commandRequests"
          row-key="id"
          size="small"
          highlight-current-row
          class="task-table"
          @row-click="(row) => selectedCommand = asCommand(row)"
        >
          <el-table-column
            label="目录"
            width="100"
          >
            <template #default="{ row }">{{ row.root.label }}</template>
          </el-table-column>
          <el-table-column
            label="命令"
            min-width="220"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              {{ row.command }} {{ (row.args || []).join(" ") }}
            </template>
          </el-table-column>
          <el-table-column
            prop="cwd"
            label="cwd"
            width="120"
            show-overflow-tooltip
          />
        </el-table>
        <div
          v-if="selectedCommand"
          class="write-preview"
        >
          <div class="preview-head">
            <span>{{ selectedCommand.root.label }}</span>
            <span class="result-meta">{{ selectedCommand.cwd || "." }}</span>
          </div>
          <pre class="command-line">{{ selectedCommand.command }} {{ selectedCommand.args.join(" ") }}</pre>
          <div class="write-reason">{{ selectedCommand.reason }}</div>
          <el-alert
            v-if="selectedCommand.status === 'SUCCEEDED' || selectedCommand.status === 'FAILED'"
            :type="selectedCommand.status === 'SUCCEEDED' ? 'success' : 'error'"
            :closable="false"
            :title="`退出码 ${selectedCommand.exitCode ?? 'unknown'} · ${selectedCommand.durationMs ?? 0} ms`"
          />
          <pre
            v-if="selectedCommand.stdout || selectedCommand.stderr"
            class="preview-body command-output"
          >{{ selectedCommand.stdout || "" }}{{ selectedCommand.stderr ? `\n[stderr]\n${selectedCommand.stderr}` : "" }}</pre>
          <div class="write-actions">
            <el-button
              type="danger"
              plain
              :disabled="commandBusy || selectedCommand.status !== 'PENDING'"
              @click="rejectCommand(selectedCommand)"
            >
              拒绝
            </el-button>
            <el-button
              type="primary"
              :loading="commandBusy"
              :disabled="selectedCommand.status !== 'PENDING'"
              @click="approveCommand(selectedCommand)"
            >
              批准执行
            </el-button>
          </div>
        </div>
        <div
          v-else
          class="preview-placeholder"
        >
          选一条命令查看参数和原因。
        </div>
      </div>
      <template #footer>
        <el-button @click="commandVisible = false">
          关闭
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="tasksVisible"
      title="任务档案"
      width="900px"
      append-to-body
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="目标 → 计划 → 写请求 → 验收证据"
        description="她可以用 create_local_task 建档案；写文件仍需单独审批。验收由你记录，不把执行者自己的说法当成功。"
      />
      <div class="task-grid">
        <el-table
          v-loading="tasksLoading"
          :data="tasks"
          row-key="id"
          size="small"
          highlight-current-row
          class="task-table"
          @row-click="selectTask"
        >
          <el-table-column
            prop="title"
            label="任务"
            min-width="180"
            show-overflow-tooltip
          />
          <el-table-column
            label="状态"
            width="96"
          >
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="taskStatusType(row.status)"
              >
                {{ taskStatusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="写请求/证据"
            width="110"
          >
            <template #default="{ row }">
              {{ row._count?.writeRequests ?? 0 }} / {{ row._count?.evidence ?? 0 }}
            </template>
          </el-table-column>
        </el-table>

        <div
          v-if="taskDetail"
          v-loading="taskDetailLoading"
          class="task-detail"
        >
          <h3>{{ taskDetail.title }}</h3>
          <div class="task-status-line">
            <el-tag :type="taskStatusType(taskDetail.status)">
              {{ taskStatusLabel(taskDetail.status) }}
            </el-tag>
            <span class="muted">{{ formatDate(taskDetail.createdAt) }}</span>
          </div>
          <div class="task-section">
            <b>目标</b>
            <p>{{ taskDetail.goal }}</p>
          </div>
          <div class="task-section">
            <b>计划</b>
            <pre class="task-plan">{{ taskDetail.plan }}</pre>
          </div>
          <div class="task-section">
            <b>执行步骤</b>
            <el-button
              v-if="!taskDetail.steps.length && !taskIsClosed"
              text
              :disabled="taskBusy || taskDetailLoading"
              @click="promptTaskStep('plan')"
            >
              建立步骤
            </el-button>
            <ol v-if="taskDetail.steps.length">
              <li
                v-for="(step, index) in taskDetail.steps"
                :key="index"
              >
                {{ step.title }} · {{ stepLabels[step.status] ?? step.status }}
                <p v-if="step.note">{{ step.note }}</p>
                <div v-if="step.status === 'TODO' && !step.verifyWriteId && index === currentTaskStep && !taskIsClosed">
                  <el-button text :disabled="taskBusy || taskDetailLoading" @click="promptTaskStep('done', index)">记录完成</el-button>
                  <el-button text :disabled="taskBusy || taskDetailLoading" @click="promptTaskStep('fail', index)">记录失败</el-button>
                  <template v-if="availableStepRequests.length">
                    <el-select v-model="stepRequestChoice" placeholder="选择本任务的审批请求" :disabled="taskBusy || taskDetailLoading">
                      <el-option v-for="item in availableStepRequests" :key="item.value" :value="item.value" :label="item.label" />
                    </el-select>
                    <el-button text :disabled="!stepRequestChoice || taskBusy || taskDetailLoading" @click="linkTaskStep(index)">关联审批</el-button>
                  </template>
                </div>
              </li>
            </ol>
            <p v-else class="muted">还没有执行步骤。</p>
          </div>
          <div class="task-section">
            <b>写请求</b>
            <div
              v-if="!taskDetail.writeRequests.length"
              class="muted"
            >
              还没有写请求。
            </div>
            <div
              v-for="write in taskDetail.writeRequests"
              :key="write.id"
              class="task-write"
            >
              <span>{{ write.root.label }} / {{ write.relativePath }}</span>
              <el-tag
                size="small"
                :type="write.status === 'APPLIED' ? 'success' : write.status === 'REJECTED' ? 'info' : 'warning'"
              >
                {{ write.status }}
              </el-tag>
            </div>
          </div>
          <div class="task-section">
            <b>验收证据</b>
            <div
              v-if="!taskDetail.evidence.length"
              class="muted"
            >
              还没有验收记录。
            </div>
            <div
              v-for="item in taskDetail.evidence"
              :key="item.id"
              class="task-evidence"
            >
              <el-tag
                size="small"
                :type="item.outcome === 'PASS' ? 'success' : item.outcome === 'FAIL' ? 'danger' : 'info'"
              >
                {{ item.outcome }}
              </el-tag>
              <span v-if="item.kind === 'WRITE_READBACK'" class="task-readback">{{ item.note }}</span>
              <span v-else>{{ item.note }}</span>
            </div>
          </div>
          <div
            v-if="taskDetail.resultNote"
            class="task-section"
          >
            <b>结果</b>
            <p>{{ taskDetail.resultNote }}</p>
          </div>
          <div class="task-actions">
            <el-button
              :disabled="taskBusy || taskDetailLoading || taskIsClosed"
              @click="cancelTask"
            >
              取消任务
            </el-button>
            <el-button
              type="danger"
              plain
              :disabled="taskBusy || taskDetailLoading || taskIsClosed"
              @click="recordTask('FAIL')"
            >
              验收失败
            </el-button>
            <el-button
              type="primary"
              :loading="taskBusy"
              :disabled="taskBusy || taskDetailLoading || taskIsClosed"
              @click="recordTask('PASS')"
            >
              验收通过
            </el-button>
          </div>
        </div>
        <div
          v-else
          class="preview-placeholder"
        >
          选一个任务查看计划和验收记录。
        </div>
      </div>
      <template #footer>
        <el-button @click="tasksVisible = false">
          关闭
        </el-button>
      </template>
    </el-dialog>
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
.root-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.root-select {
  width: 230px;
}
.option-path {
  margin-left: 10px;
  color: #98a2b3;
  font-size: 12px;
}
.manage-add {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 0.8fr) auto;
  gap: 8px;
  margin: 14px 0;
}
.manage-table {
  margin-top: 4px;
}
.builtin-tag {
  margin-left: 6px;
}
.write-empty {
  padding: 28px 0;
  text-align: center;
  color: #98a2b3;
}
.write-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  gap: 14px;
  margin-top: 14px;
}
.write-table {
  cursor: pointer;
}
.write-preview {
  min-width: 0;
  border: 1px solid #e4e9f2;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafbfe;
}
.write-reason {
  margin-bottom: 8px;
  color: #68717f;
  font-size: 13px;
}
.write-content {
  max-height: 360px;
}
.command-line {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #eef3ff;
  color: #2f4f8f;
  white-space: pre-wrap;
  word-break: break-all;
  font: 12px/1.6 "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
}
.command-output {
  max-height: 260px;
  margin-top: 10px;
}
.write-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.task-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: 14px;
  margin-top: 14px;
}
.task-table {
  cursor: pointer;
}
.task-detail {
  min-width: 0;
  max-height: 560px;
  overflow: auto;
  border: 1px solid #e4e9f2;
  border-radius: 10px;
  padding: 12px 14px;
  background: #fafbfe;
}
.task-detail h3 {
  margin: 0 0 8px;
  font-size: 16px;
}
.task-status-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.task-section {
  margin-top: 12px;
}
.task-section p {
  margin: 4px 0 0;
  color: #4f5b6d;
  white-space: pre-wrap;
}
.task-plan {
  margin: 4px 0 0;
  max-height: 150px;
  overflow: auto;
  white-space: pre-wrap;
  font: 12px/1.6 "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
  color: #4f5b6d;
}
.task-readback { white-space: pre-wrap; overflow-wrap: anywhere; }
.task-write,
.task-evidence {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
  font-size: 13px;
  color: #4f5b6d;
}
.task-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
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
