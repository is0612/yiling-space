<script setup lang="ts">
/**
 * 用户管理。
 *
 * 内容排序：① 有几个账号、几个管理员、几个停用（统计带）② 账号清单（要动手的就是「重置密码 / 停用」）
 * ③ 最近登录活动（审计，排最后）。
 * 表格用 CSS grid 排：原来的「角色」「角色数」两列并进账号格（管理员徽章 + 「1 个角色」），
 * 7 列压到 5 列，一行不用横向滚。
 *
 * 两处列表都走后端分页：账号 20/页、审计 10/页。审计是全站唯一只增不减的表，
 * 之前一次拉 30 条还能忍，上服务器后不行，所以接口和页面一起改了。
 */
import { Clock, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type AdminUser = {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  characterCount: number;
  lastActiveAt: string | null;
};

type AdminUserPage = {
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  /** 全表统计，与当前页无关 —— 否则翻到第 3 页数字会缩水 */
  stats: { total: number; adminCount: number; disabledCount: number };
};

const loading = ref(true);
const users = ref<AdminUser[]>([]);
const USER_PAGE_SIZE = 20;
const userPage = ref(1);
const userTotal = ref(0);
const userTotalPages = ref(1);
const stats = ref({ total: 0, adminCount: 0, disabledCount: 0 });
const resetting = ref(false);
const dialogVisible = ref(false);
const resetTarget = ref<AdminUser | null>(null);
const resetPassword = ref("");

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function formatDateTime(value: string | null) {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "从未";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const adminCount = computed(() => stats.value.adminCount);
const disabledCount = computed(() => stats.value.disabledCount);

function labelOf(user: AdminUser) {
  return user.displayName || user.email || user.username;
}

/** 头像只放一个字，和身份卡一致 */
function initialOf(user: AdminUser) {
  return Array.from(labelOf(user))[0] ?? "?";
}

async function loadUsers(target = userPage.value) {
  loading.value = true;
  try {
    const response = await $fetch<AdminUserPage>("/api/admin/users", {
      query: { page: target, pageSize: USER_PAGE_SIZE },
    });
    users.value = response.items;
    userPage.value = response.page;
    userTotal.value = response.total;
    userTotalPages.value = response.totalPages;
    stats.value = response.stats;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取用户列表。"));
  } finally {
    loading.value = false;
  }
}

type AuditItem = { id: string; action: string; createdAt: string; actor: string | null; details: unknown };
type AuditPage = { items: AuditItem[]; total: number; page: number; totalPages: number };
const auditItems = ref<AuditItem[]>([]);
const AUDIT_PAGE_SIZE = 10;
const auditPage = ref(1);
const auditTotal = ref(0);
const auditTotalPages = ref(1);
const actionLabels: Record<string, string> = {
  "auth.login": "登录",
  "auth.login_failed": "登录失败",
  "auth.logout": "退出登录",
  "auth.register": "注册账号",
  "auth.password_changed": "修改密码",
  "auth.session_revoked": "撤销会话",
  "auth.sessions_revoked": "退出其他设备",
};

async function loadAudit(target = auditPage.value) {
  try {
    const response = await $fetch<AuditPage>("/api/admin/audit", {
      query: { page: target, pageSize: AUDIT_PAGE_SIZE },
    });
    auditItems.value = response.items;
    auditPage.value = response.page;
    auditTotal.value = response.total;
    auditTotalPages.value = response.totalPages;
  } catch {
    // 审计读取失败不影响用户管理主功能。
  }
}

async function toggleStatus(user: AdminUser) {
  const next = user.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  const confirmed = await ElMessageBox.confirm(
    next === "DISABLED" ? `停用后「${labelOf(user)}」会立即退出登录且无法再登录，确定？` : `重新启用「${labelOf(user)}」的账号？`,
    next === "DISABLED" ? "停用账号" : "启用账号",
    { confirmButtonText: next === "DISABLED" ? "停用" : "启用", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;

  try {
    await $fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: { status: next } });
    ElMessage.success(next === "DISABLED" ? "账号已停用。" : "账号已启用。");
    await loadUsers();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "操作失败，请稍后重试。"));
  }
}

function openReset(user: AdminUser) {
  resetTarget.value = user;
  resetPassword.value = "";
  dialogVisible.value = true;
}

async function submitReset() {
  if (resetting.value || !resetTarget.value) return;
  const password = resetPassword.value;
  if (password.length < 10) {
    ElMessage.warning("新密码至少 10 个字符。");
    return;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    ElMessage.warning("新密码必须同时包含字母和数字。");
    return;
  }
  resetting.value = true;
  try {
    await $fetch(`/api/admin/users/${encodeURIComponent(resetTarget.value.id)}`, {
      method: "PATCH",
      body: { password },
    });
    ElMessage.success("密码已重置，请把新密码告知该用户。");
    resetTarget.value = null;
    resetPassword.value = "";
    dialogVisible.value = false;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "重置失败，请稍后重试。"));
  } finally {
    resetting.value = false;
  }
}

onMounted(() => {
  loadUsers();
  loadAudit();
});
</script>

<template>
  <div class="page-wrap users-a">
    <PageHeader
      eyebrow="系统管理 / 用户管理"
      title="用户管理"
      description="使用本系统的账号与活动统计。这里只有账号信息，不含任何人的对话或记忆内容。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadUsers()"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
      </template>
    </PageHeader>

    <div class="band">
      <div class="band-cell">
        <span class="band-k">全部账号</span>
        <span class="band-v">{{ stats.total }}<small>个</small></span>
        <span class="band-f">只显示账号信息，不含对话与记忆</span>
      </div>
      <div class="band-cell">
        <span class="band-k">管理员</span>
        <span class="band-v">{{ adminCount }}<small>个</small></span>
        <span class="band-f">可管理用户、渠道与系统设置</span>
      </div>
      <div class="band-cell">
        <span class="band-k">已停用</span>
        <span class="band-v">{{ disabledCount }}<small>个</small></span>
        <span class="band-f">停用后无法登录，数据保留</span>
      </div>
    </div>

    <div class="tbl">
      <div class="tbl-head">
        <span>账号</span>
        <span>状态</span>
        <span>注册时间</span>
        <span>最后活跃</span>
        <span />
      </div>

      <div
        v-if="loading && !users.length"
        class="tbl-body"
      >
        <div
          v-for="i in 3"
          :key="'sk-' + i"
          class="tbl-row is-skeleton"
        >
          <span class="sk" />
        </div>
      </div>

      <p
        v-else-if="!users.length"
        class="tbl-empty"
      >
        还没有账号。
      </p>

      <div
        v-else
        class="tbl-body"
      >
        <div
          v-for="user in users"
          :key="user.id"
          class="tbl-row"
        >
          <div class="cell-user">
            <span class="user-avatar">{{ initialOf(user) }}</span>
            <div class="user-copy">
              <div class="user-name">
                {{ labelOf(user) }}
                <span
                  v-if="user.role === 'ADMIN'"
                  class="role-badge"
                >管理员</span>
              </div>
              <div class="user-sub">
                {{ user.email || user.username }}<span class="sep">·</span>{{ user.characterCount }} 个角色
              </div>
            </div>
          </div>
          <span>
            <span
              class="pill"
              :class="user.status === 'ACTIVE' ? 'pill-green' : 'pill-rose'"
            >{{ user.status === "ACTIVE" ? "正常" : "已停用" }}</span>
          </span>
          <span class="time">{{ formatDateTime(user.createdAt) }}</span>
          <span class="time">{{ formatDateTime(user.lastActiveAt) }}</span>
          <span class="row-actions">
            <button
              type="button"
              class="tlink"
              @click="openReset(user)"
            >
              重置密码
            </button>
            <button
              v-if="user.status === 'ACTIVE'"
              type="button"
              class="tlink is-danger"
              @click="toggleStatus(user)"
            >
              停用
            </button>
            <button
              v-else
              type="button"
              class="tlink is-ok"
              @click="toggleStatus(user)"
            >
              启用
            </button>
          </span>
        </div>
      </div>

      <PagerBar
        :page="userPage"
        :total="userTotal"
        :total-pages="userTotalPages"
        :page-size="USER_PAGE_SIZE"
        unit="个账号"
        flush
        @update:page="loadUsers"
      />
    </div>

    <div class="sec-label">
      <h2>最近登录活动</h2>
      <span class="count">{{ auditTotal }}</span>
    </div>

    <div class="audit-panel">
      <div
        v-if="!auditItems.length"
        class="audit-empty"
      >
        <el-icon><Clock /></el-icon>
        <span>还没有登录记录 —— 账号登录、失败与登出都会留在这里</span>
      </div>
      <div
        v-for="item in auditItems"
        :key="item.id"
        class="audit-row"
      >
        <span
          class="audit-act"
          :class="{ 'is-fail': item.action === 'auth.login_failed' }"
        >{{ actionLabels[item.action] || item.action }}</span>
        <span class="audit-actor">{{ item.actor || "—" }}</span>
        <span class="audit-time">{{ formatDateTime(item.createdAt) }}</span>
      </div>

      <PagerBar
        :page="auditPage"
        :total="auditTotal"
        :total-pages="auditTotalPages"
        :page-size="AUDIT_PAGE_SIZE"
        unit="条记录"
        flush
        @update:page="loadAudit"
      />
    </div>

    <el-dialog
      v-model="dialogVisible"
      title="重置密码"
      width="420px"
    >
      <p class="dlg-lead">
        为「{{ resetTarget ? labelOf(resetTarget) : "" }}」设置新密码，对方登录后可自行修改。
      </p>
      <el-form
        label-position="top"
        class="dlg-form"
        @submit.prevent="submitReset"
      >
        <el-form-item label="新密码">
          <el-input
            v-model="resetPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="至少 10 位，含字母与数字"
          />
        </el-form-item>
      </el-form>
      <p class="dlg-hint">
        由字母和数字组成、长度不少于 10 位。重置后通过安全渠道把新密码告知对方。
      </p>
      <template #footer>
        <div class="dlg-foot">
          <span class="dlg-foot-note">重置不会退出对方已登录的设备</span>
          <span class="dlg-foot-actions">
            <el-button @click="dialogVisible = false">
              取消
            </el-button>
            <el-button
              type="primary"
              :loading="resetting"
              @click="submitReset"
            >
              确认重置
            </el-button>
          </span>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* A 套：白砖、零描边、零阴影。全部规则挂在 .users-a 下。 */
.users-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.users-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }

/* 统计带 */
.band {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 24px;
  margin-bottom: var(--sp-4);
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 20px 17px;
}
.band-cell { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.band-k { color: var(--dim); font-size: 12px; }
.band-v { color: var(--text); font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1.25; }
.band-v small { margin-left: 3px; color: var(--dim); font-size: 12px; font-weight: 500; letter-spacing: 0; }
.band-f { overflow: hidden; color: var(--dim); font-size: 12px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }

/* ── 表格（CSS grid，5 列） ───────────────────────── */
.tbl { border-radius: 10px; background: var(--surface); padding: 4px 8px 8px; }
.tbl-head,
.tbl-row {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) 76px 132px 132px 148px;
  gap: 12px;
  align-items: center;
}
.tbl-head {
  border-bottom: 1px solid var(--surface-3);
  padding: 12px 10px 9px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
}
.tbl-body { display: flex; flex-direction: column; }
.tbl-row { padding: 10px; border-radius: 8px; transition: background .13s var(--ease); }
.tbl-row:hover { background: var(--surface-2); }
.tbl-row.is-skeleton { display: block; padding: 16px 10px; }
.tbl-row.is-skeleton .sk { display: block; height: 16px; border-radius: 5px; }
.tbl-empty { padding: 32px 10px; color: var(--dim); font-size: 14px; text-align: center; }

.cell-user { display: flex; min-width: 0; align-items: center; gap: 10px; }
/* 首字头像：和身份页、QQ 卡片同一套 */
.user-avatar {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 14px;
  font-weight: 700;
}
.user-copy { min-width: 0; }
.user-name { display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.4; }
/* 角色徽章贴在名字后面：比单开一列「角色」省 110px，且一眼看出谁是管理员 */
.role-badge { border-radius: 4px; background: var(--brand-soft); padding: 1px 5px; color: var(--brand-strong); font-size: 12px; font-weight: 600; line-height: 1.5; }
.user-sub { margin-top: 2px; color: var(--dim); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.user-sub .sep { margin: 0 5px; color: var(--faint); }
.time { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.row-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }

/* 文字按钮：常态静音，hover 才上色；危险动作不给常驻红色 */
.tlink {
  display: inline-flex;
  height: 28px;
  align-items: center;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 8px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.tlink:hover { background: var(--surface-3); color: var(--brand-strong); }
.tlink.is-danger:hover { background: var(--red-soft); color: var(--red); }
.tlink.is-ok:hover { background: var(--green-soft); color: #0b7a54; }

/* ── 登录活动 ─────────────────────────────────────── */
.sec-label { display: flex; align-items: baseline; gap: 8px; margin: var(--sp-5) 0 var(--sp-3); }
.sec-label h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.sec-label .count { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }

.audit-panel { border-radius: 10px; background: var(--surface); padding: 4px 18px 6px; }
.audit-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 128px;
  gap: 16px;
  align-items: baseline;
  border-top: 1px solid var(--surface-3);
  padding: 9px 0;
  font-size: 14px;
}
.audit-row:first-child { border-top: 0; }
.audit-act { color: var(--text-2); font-weight: 600; }
.audit-act.is-fail { color: var(--red); }
.audit-actor { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-time { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.audit-empty { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 26px 8px; color: var(--dim); font-size: 12px; }
.audit-empty .el-icon { color: var(--faint); font-size: 14px; }

/* ── 重置密码弹窗 ─────────────────────────────────── */
.dlg-lead { margin: 0 0 14px; color: var(--dim); font-size: 12px; line-height: 1.75; }
.dlg-form :deep(.el-form-item) { margin-bottom: 0; }
.dlg-hint { margin: 10px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.dlg-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dlg-foot-note { color: var(--dim); font-size: 12px; text-align: left; }
.dlg-foot-actions { display: flex; }

/* ── 自适应 ───────────────────────────────────────── */
@media (max-width: 1080px) {
  /* 先砍「注册时间」，剩下的还用得上 */
  .tbl-head,
  .tbl-row { grid-template-columns: minmax(0, 1.6fr) 76px 132px 148px; }
  .tbl-head span:nth-child(3),
  .tbl-row > .time:first-of-type { display: none; }
}
@media (max-width: 820px) {
  .tbl-head { display: none; }
  /* 窄屏两行：账号 + 状态在上，操作在下 */
  .tbl-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 10px;
    padding: 12px 10px;
  }
  .cell-user { grid-column: 1; }
  .tbl-row > span:nth-child(2) { grid-column: 2; justify-self: end; }
  .tbl-row > .time { display: none; }
  .row-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .audit-row { grid-template-columns: 76px minmax(0, 1fr); }
  .audit-time { display: none; }
}
@media (max-width: 560px) {
  /* 三个数字仍排一行，脚注直接收掉 —— 竖着堆三层要占掉半屏 */
  .band { gap: 0 12px; padding: 14px 16px 15px; }
  .band-f { display: none; }
  .dlg-foot { flex-direction: column-reverse; align-items: stretch; }
  .dlg-foot-actions { justify-content: flex-end; }
  .dlg-foot-note { text-align: center; }
}
</style>
