<script setup lang="ts">
import { ElMessage } from "element-plus";
import { readApiErrorMessage } from "~/utils/api-error";

const props = defineProps<{ rootId: string; writable: boolean }>();
const visible = defineModel<boolean>({ required: true });
const emit = defineEmits<{ proposed: [] }>();
const request = useApiRequest();
const cwd = ref("");
const branch = ref("");
const reason = ref("");
const busy = ref(false);
const errorText = ref("");
type GitStatus = {
  branch: string | null;
  entries: { code: string; path: string; staged: boolean; unstaged: boolean; untracked: boolean }[];
  truncated: boolean;
};
type GitDiff = { path: string; staged: boolean; untracked: boolean; diff: string };
const status = ref<GitStatus | null>(null);
const diff = ref<GitDiff | null>(null);

async function perform(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  errorText.value = "";
  try { await action(); }
  catch (error) { errorText.value = readApiErrorMessage(error, "Git 操作未能完成。"); }
  finally { busy.value = false; }
}

function inspect() {
  return perform(async () => {
    status.value = null;
    diff.value = null;
    status.value = await request<GitStatus>({ url: "/local/observe/git", params: { rootId: props.rootId, cwd: cwd.value.trim() } });
  });
}

function inspectFile(file: string, staged = false) {
  return perform(async () => {
    diff.value = null;
    diff.value = await request<GitDiff>({
      url: "/local/observe/git",
      params: { rootId: props.rootId, cwd: cwd.value.trim(), file, staged: staged ? "1" : "0" },
    });
  });
}

function propose() {
  return perform(async () => {
    await request({ url: "/local/observe/git-branch", method: "post", data: { rootId: props.rootId, cwd: cwd.value.trim(), branch: branch.value.trim(), reason: reason.value.trim() } });
    branch.value = "";
    reason.value = "";
    ElMessage.success("已提交审批，尚未创建分支。");
    emit("proposed");
  });
}

watch(cwd, () => { status.value = null; diff.value = null; });
watch(visible, (open) => { if (open) void inspect(); });
</script>

<template>
  <el-dialog
    v-model="visible"
    title="Git 仓库"
    width="min(760px, 94vw)"
    append-to-body
  >
    <el-form
      label-position="top"
      :disabled="busy"
      @submit.prevent
    >
      <el-form-item label="仓库位置">
        <el-input
          v-model="cwd"
          maxlength="500"
          placeholder="授权目录内的相对路径；留空查看根目录"
          @keyup.enter="inspect"
        />
      </el-form-item>
      <el-button
        :loading="busy"
        @click="inspect"
      >
        刷新状态
      </el-button>
      <el-alert
        v-if="errorText"
        class="git-block"
        type="error"
        :title="errorText"
        :closable="false"
        show-icon
      />
      <div
        v-if="status"
        class="git-block"
      >
        <p>当前分支：{{ status.branch ?? "分离 HEAD" }} · 工作区与暂存区</p>
        <p v-if="status.truncated">
          仅显示前 100 项。
        </p>
        <el-empty
          v-if="!status.entries.length"
          description="没有未提交的改动"
          :image-size="60"
        />
        <ul
          v-else
          class="git-files"
        >
          <li
            v-for="entry in status.entries"
            :key="entry.path"
          >
            <span class="git-code">{{ entry.code }}</span>
            <span class="git-path">{{ entry.path }}</span>
            <el-button
              v-if="entry.unstaged || entry.untracked"
              text
              :disabled="busy"
              @click="inspectFile(entry.path, false)"
            >
              工作区
            </el-button>
            <el-button
              v-if="entry.staged"
              text
              :disabled="busy"
              @click="inspectFile(entry.path, true)"
            >
              暂存
            </el-button>
          </li>
        </ul>
        <template v-if="diff">
          <b>{{ diff.path }} · {{ diff.staged ? "暂存区" : diff.untracked ? "新文件" : "工作区" }}</b>
          <pre class="git-diff">{{ diff.diff || "没有可展示的文本差异。" }}</pre>
        </template>
      </div>
      <div
        v-if="writable && status"
        class="git-block"
      >
        <el-form-item label="新分支名称">
          <el-input
            v-model="branch"
            maxlength="100"
            placeholder="例如 work/notes"
          />
        </el-form-item>
        <el-form-item label="提议原因">
          <el-input
            v-model="reason"
            maxlength="500"
          />
        </el-form-item>
        <el-button
          type="primary"
          :disabled="!branch.trim() || !reason.trim()"
          @click="propose"
        >
          提交分支审批
        </el-button>
      </div>
    </el-form>
  </el-dialog>
</template>

<style scoped>
.git-block { margin-top: 16px; }
.git-files { padding: 0; list-style: none; max-height: 220px; overflow: auto; }
.git-files li { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.git-code { width: 28px; color: #8a94a6; font-family: Consolas, monospace; font-size: 12px; }
.git-path { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.git-diff { max-height: 240px; overflow: auto; padding: 12px; background: #f5f7fa; font-size: 12px; }
</style>
