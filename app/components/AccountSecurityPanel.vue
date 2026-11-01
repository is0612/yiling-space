<script setup lang="ts">
/**
 * 账户与安全：改密码 + 登录设备。
 *
 * 版式：一张白砖里两个 block（改密码 / 设备），block 之间用 1px `--surface-3` 起头，
 * 不再用 el-divider（Element 的分割线自带上下留白，和 A 套的紧间距打架）。
 * 设备行去掉描边横线：条目少的时候线比内容还抢眼。
 */
import { Monitor, Refresh, SwitchButton, Unlock } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";

type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

type AuthSessionRow = {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  device: { label: string; kind: DeviceKind };
};

const sessions = ref<AuthSessionRow[]>([]);
const sessionMode = ref<"session" | "local-dev">("session");
const loadingSessions = ref(false);
const revokingId = ref("");
const revokingOthers = ref(false);

const formRef = ref<FormInstance>();
const changingPassword = ref(false);
const passwordForm = reactive({ current: "", next: "", confirm: "" });

const passwordRules: FormRules = {
  current: [{ required: true, message: "请输入当前密码", trigger: "blur" }],
  next: [
    { required: true, message: "请输入新密码", trigger: "blur" },
    { min: 10, max: 128, message: "新密码长度需为 10 至 128 个字符", trigger: "blur" },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        if (!value) return callback();
        if (!/[A-Za-z]/.test(value)) return callback(new Error("新密码必须包含至少一个字母"));
        if (!/[0-9]/.test(value)) return callback(new Error("新密码必须包含至少一个数字"));
        return callback();
      },
      trigger: "blur",
    },
  ],
  confirm: [
    { required: true, message: "请再次输入新密码", trigger: "blur" },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        if (value !== passwordForm.next) return callback(new Error("两次输入的新密码不一致"));
        return callback();
      },
      trigger: "blur",
    },
  ],
};

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const otherSessionCount = computed(() => sessions.value.filter((session) => !session.current).length);

async function loadSessions() {
  loadingSessions.value = true;
  try {
    const response = await $fetch<{ mode: "session" | "local-dev"; sessions: AuthSessionRow[] }>("/api/auth/sessions");
    sessions.value = response.sessions;
    sessionMode.value = response.mode;
  } catch (error) {
    sessions.value = [];
    ElMessage.error(readErrorMessage(error, "无法读取登录设备列表。"));
  } finally {
    loadingSessions.value = false;
  }
}

async function submitPasswordChange() {
  if (changingPassword.value) return;
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  changingPassword.value = true;
  try {
    const result = await $fetch<{ changed: boolean; revokedSessions: number }>("/api/auth/password", {
      method: "POST",
      body: { currentPassword: passwordForm.current, newPassword: passwordForm.next },
    });
    passwordForm.current = "";
    passwordForm.next = "";
    passwordForm.confirm = "";
    formRef.value?.clearValidate();
    ElMessage.success(
      result.revokedSessions > 0
        ? `密码已更新，同时退出了另外 ${result.revokedSessions} 个登录设备。`
        : "密码已更新。",
    );
    await loadSessions();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "密码修改失败，请稍后重试。"));
  } finally {
    changingPassword.value = false;
  }
}

async function revokeSession(session: AuthSessionRow) {
  if (revokingId.value) return;
  const confirmed = await ElMessageBox.confirm(
    session.current ? "撤销当前会话会立即退出登录，确定继续？" : `确定要让「${session.device.label}」退出登录吗？`,
    "撤销登录设备",
    { confirmButtonText: "撤销", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;

  revokingId.value = session.id;
  try {
    const result = await $fetch<{ revoked: boolean; currentRevoked: boolean }>(
      `/api/auth/sessions/${encodeURIComponent(session.id)}`,
      { method: "DELETE" },
    );
    if (result.currentRevoked) {
      await navigateTo("/login");
      return;
    }
    ElMessage.success("该设备已退出登录。");
    await loadSessions();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "撤销失败，请稍后重试。"));
  } finally {
    revokingId.value = "";
  }
}

async function revokeOtherSessions() {
  if (revokingOthers.value) return;
  const confirmed = await ElMessageBox.confirm(
    "除当前设备外，所有已登录设备都会立即退出，确定继续？",
    "退出其他设备",
    { confirmButtonText: "全部退出", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;

  revokingOthers.value = true;
  try {
    const result = await $fetch<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" });
    ElMessage.success(result.revoked > 0 ? `已退出 ${result.revoked} 个设备。` : "没有其他在线设备。");
    await loadSessions();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "操作失败，请稍后重试。"));
  } finally {
    revokingOthers.value = false;
  }
}

onMounted(loadSessions);
</script>

<template>
  <section class="sec-panel">
    <div class="panel-h">
      <span class="panel-icon"><el-icon><Unlock /></el-icon></span>
      <h2>账户与安全</h2>
      <span class="panel-sub">密码与登录设备</span>
    </div>

    <div class="block">
      <div class="block-h">
        <h3>修改密码</h3>
      </div>
      <el-form
        ref="formRef"
        :model="passwordForm"
        :rules="passwordRules"
        label-position="top"
        class="pwd-form"
        @submit.prevent="submitPasswordChange"
      >
        <div class="pwd-grid">
          <el-form-item
            label="当前密码"
            prop="current"
          >
            <el-input
              v-model="passwordForm.current"
              type="password"
              show-password
              autocomplete="current-password"
              placeholder="请输入当前密码"
            />
          </el-form-item>
          <el-form-item
            label="新密码"
            prop="next"
          >
            <el-input
              v-model="passwordForm.next"
              type="password"
              show-password
              autocomplete="new-password"
              placeholder="至少 10 位，含字母与数字"
            />
          </el-form-item>
          <el-form-item
            label="确认新密码"
            prop="confirm"
          >
            <el-input
              v-model="passwordForm.confirm"
              type="password"
              show-password
              autocomplete="new-password"
              placeholder="再次输入新密码"
              @keyup.enter="submitPasswordChange"
            />
          </el-form-item>
        </div>
        <div class="pwd-foot">
          <p class="hint">
            改完密码，其他设备会被立即注销，当前设备保持登录。
          </p>
          <el-button
            type="primary"
            :loading="changingPassword"
            @click="submitPasswordChange"
          >
            更新密码
          </el-button>
        </div>
      </el-form>
    </div>

    <div class="block">
      <div class="block-h">
        <h3>登录设备<span class="count">{{ sessions.length }}</span></h3>
        <div class="block-actions">
          <button
            type="button"
            class="abtn"
            :disabled="loadingSessions"
            @click="loadSessions"
          >
            <el-icon><Refresh /></el-icon>刷新
          </button>
          <button
            type="button"
            class="abtn"
            :disabled="otherSessionCount === 0 || revokingOthers"
            @click="revokeOtherSessions"
          >
            <el-icon><SwitchButton /></el-icon>退出其他设备
          </button>
        </div>
      </div>
      <p class="hint">
        {{ sessionMode === "local-dev"
          ? "当前是本地开发身份，这里只列出真实登录产生的会话。"
          : "只显示仍然有效的会话；撤销后该设备需要重新登录。" }}
      </p>

      <div
        v-loading="loadingSessions"
        class="device-list"
      >
        <p
          v-if="!sessions.length"
          class="device-empty"
        >
          暂无有效的登录设备。
        </p>
        <div
          v-for="session in sessions"
          :key="session.id"
          class="device-row"
        >
          <span
            class="device-symbol"
            :class="{ 'is-current': session.current }"
          >
            <el-icon><Monitor /></el-icon>
          </span>
          <div class="device-copy">
            <div class="device-name">
              {{ session.device.label }}
              <span
                v-if="session.current"
                class="current-badge"
              >当前设备</span>
            </div>
            <div class="device-meta">
              最近活动 {{ formatDateTime(session.lastUsedAt) }} · 登录于 {{ formatDateTime(session.createdAt) }} · 到期 {{ formatDateTime(session.expiresAt) }}
            </div>
          </div>
          <button
            type="button"
            class="tlink is-danger"
            :disabled="revokingId === session.id"
            @click="revokeSession(session)"
          >
            撤销
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* A 套：一张白砖装两个 block，组间靠 1px --surface-3 + 20px 留白分块 */
.sec-panel {
  border-radius: 10px;
  background: var(--surface);
  padding: 18px 20px 16px;
}

.panel-h { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; }
.panel-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 15px;
}
.panel-h h2 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.panel-sub { color: var(--dim); font-size: 12px; }

.block + .block { margin-top: 20px; border-top: 1px solid var(--surface-3); padding-top: 18px; }
.block-h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.block-h h3 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.block-h .count { margin-left: 6px; color: var(--dim); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.block-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }

/* 三列只有在宽屏成立；750 以下一列，别把密码框压成 200px */
.pwd-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 14px; }
.pwd-form :deep(.el-form-item) { margin-bottom: 0; }
.pwd-form :deep(.el-form-item__content) { min-width: 0; }
.pwd-foot { display: flex; align-items: center; gap: 16px; margin-top: 14px; }
.pwd-foot .hint { flex: 1; margin: 0; }

.hint { margin: 0 0 10px; color: var(--dim); font-size: 12px; line-height: 1.7; }

.abtn {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 8px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.abtn .el-icon { color: var(--faint); font-size: 13px; }
.abtn:hover:not(:disabled) { background: var(--surface-2); color: var(--brand-strong); }
.abtn:hover:not(:disabled) .el-icon { color: var(--brand); }
.abtn:disabled { opacity: .45; cursor: not-allowed; }

.device-list { min-height: 40px; }
.device-empty { margin: 0; padding: 14px 0 6px; color: var(--dim); font-size: 12px; }
.device-row { display: flex; align-items: center; gap: 11px; padding: 9px 0; }
.device-symbol {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--text-2);
  font-size: 15px;
}
/* 只有当前设备上色：一排彩色图标会把「哪个是我」这件事埋掉 */
.device-symbol.is-current { background: var(--brand-soft); color: var(--brand); }
.device-copy { min-width: 0; flex: 1; }
.device-name { display: flex; align-items: center; gap: 7px; color: var(--text-2); font-size: 14px; font-weight: 600; }
.current-badge { border-radius: 999px; background: var(--brand-soft); padding: 2px 7px; color: var(--brand-strong); font-size: 12px; font-weight: 600; }
.device-meta { margin-top: 3px; color: var(--dim); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }

.tlink {
  display: inline-flex;
  height: 28px;
  align-items: center;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 8px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.tlink.is-danger:hover:not(:disabled) { background: var(--red-soft); color: var(--red); }
.tlink:disabled { opacity: .45; cursor: not-allowed; }

@media (max-width: 760px) {
  .pwd-grid { grid-template-columns: minmax(0, 1fr); gap: 14px 0; }
  .pwd-foot { flex-direction: column; align-items: stretch; gap: 12px; }
  .pwd-foot :deep(.el-button) { width: 100%; }
}
</style>
