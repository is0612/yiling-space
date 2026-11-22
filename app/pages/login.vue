<script setup lang="ts">
import { Lock, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { createAuthApi } from "~/api/auth";
import { readApiErrorMessage } from "~/utils/api-error";

definePageMeta({ layout: false });

/**
 * 默认管理员凭据，与 .env 的 DEV_OWNER_USERNAME / DEV_OWNER_PASSWORD、以及
 * scripts/seed-dev-user.ts 写入的账号保持一致。
 */
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin123";

/**
 * 只在开发模式预填并显示提示：生产构建里把管理员密码印在登录页上等于公开后门。
 * 桌面免登录走受保护安装绑定与主进程 Cookie 注入，不能靠显示或预填默认密码实现。
 */
const showDefaultAdmin = Boolean(import.meta.dev);

const { refresh } = useAuthSession();
const { enabled: desktopIdentityEnabled, state: desktopIdentityState, bindCurrentAccount } = useDesktopIdentity();
const authApi = createAuthApi(useApiRequest());
const username = ref(showDefaultAdmin ? DEFAULT_ADMIN_USERNAME : "");
const password = ref(showDefaultAdmin ? DEFAULT_ADMIN_PASSWORD : "");
const submitting = ref(false);
const binding = ref(false);
const errorMessage = ref("");

/** 只有安装版私有桥可用且尚未绑定（含已解绑）时才提供"登录并绑定"。 */
const canBindCurrentDevice = computed(
  () => desktopIdentityEnabled.value && (desktopIdentityState.value === "unbound" || desktopIdentityState.value === "revoked"),
);

const readErrorMessage = readApiErrorMessage;

async function submit() {
  if (submitting.value) return;
  errorMessage.value = "";
  if (!username.value.trim() || !password.value) {
    errorMessage.value = "请填写用户名和密码。";
    return;
  }
  submitting.value = true;
  try {
    await authApi.login({ username: username.value.trim(), password: password.value });
    password.value = "";
    await refresh();
    ElMessage.success("已登录。");
    await navigateTo("/");
  } catch (error) {
    errorMessage.value = readErrorMessage(error, "登录失败，请检查用户名和密码后重试。");
  } finally {
    submitting.value = false;
  }
}

/**
 * 先走普通 HTTP 登录，再让本机主进程用已登录的 HttpOnly Cookie 作证明完成绑定。
 * 绑定失败不等于密码错误：仍然已是登录状态，只是没完成本机免登录。
 */
async function submitAndBind() {
  if (submitting.value || binding.value) return;
  errorMessage.value = "";
  if (!username.value.trim() || !password.value) {
    errorMessage.value = "请填写用户名和密码。";
    return;
  }
  submitting.value = true;
  try {
    await authApi.login({ username: username.value.trim(), password: password.value });
    password.value = "";
    await refresh();
  } catch (error) {
    errorMessage.value = readErrorMessage(error, "登录失败，请检查用户名和密码后重试。");
    return;
  } finally {
    submitting.value = false;
  }

  binding.value = true;
  try {
    const result = await bindCurrentAccount();
    if (result.ok) {
      ElMessage.success("已登录并绑定本机。");
    } else if (result.cancelled) {
      ElMessage.success("已登录。");
    } else {
      ElMessage.warning("已登录，但未完成本机绑定。");
    }
  } catch (error) {
    ElMessage.warning(readErrorMessage(error, "已登录，但未完成本机绑定。"));
  } finally {
    binding.value = false;
  }
  await navigateTo("/");
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <div class="login-mark">
          忆
        </div>
        <div>
          <div class="login-title">
            忆灵空间 Yiling Space
          </div>
          <div class="login-subtitle">
            多角色 AI 养成 · 管理员登录
          </div>
        </div>
      </div>

      <el-alert
        v-if="errorMessage"
        :title="errorMessage"
        type="error"
        :closable="false"
        show-icon
        class="login-alert"
      />

      <div
        v-if="showDefaultAdmin"
        class="login-hint"
      >
        <span class="login-hint-dot" />
        <span>
          管理员默认账号 <code>{{ DEFAULT_ADMIN_USERNAME }}</code>，密码 <code>{{ DEFAULT_ADMIN_PASSWORD }}</code>
        </span>
      </div>

      <el-form
        label-position="top"
        @submit.prevent="submit"
      >
        <el-form-item label="邮箱或用户名">
          <el-input
            v-model="username"
            size="large"
            autocomplete="username"
            placeholder="请输入邮箱或用户名"
            :prefix-icon="User"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            size="large"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入密码"
            :prefix-icon="Lock"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button
          type="primary"
          size="large"
          class="login-submit"
          :loading="submitting"
          @click="submit"
        >
          登录
        </el-button>
        <el-button
          v-if="canBindCurrentDevice"
          type="primary"
          plain
          size="large"
          class="login-submit login-bind"
          :loading="binding"
          :disabled="submitting"
          @click="submitAndBind"
        >
          登录并绑定本机
        </el-button>
        <p
          v-if="canBindCurrentDevice"
          class="login-bind-note"
        >
          绑定后，这台电脑下次启动可直接进入，无需重复输入密码。绑定由桌面程序确认，不会把密码交给页面外的地方。
        </p>
      </el-form>

      <p class="login-note">
        登录会话保存在服务端，浏览器只持有 HttpOnly、SameSite=Strict 的会话 Cookie。连续输错会被临时限流。
      </p>
      <p class="login-note is-centered">
        还没有账号？<NuxtLink
          to="/register"
          class="register-link"
        >
          用邮箱注册
        </NuxtLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex; min-height: 100vh; align-items: center; justify-content: center;
  background: radial-gradient(circle at 18% 12%, var(--accent-soft) 0%, transparent 42%),
    radial-gradient(circle at 82% 88%, var(--brand-soft) 0%, transparent 46%), var(--surface-2);
  padding: 32px 18px;
}
.login-card {
  width: min(420px, 100%); border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--surface); box-shadow: none; padding: 30px 28px 24px;
}
.login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.login-mark {
  display: flex; width: 44px; height: 44px; align-items: center; justify-content: center;
  border-radius: var(--radius); background: var(--grad-brand); box-shadow: 0 14px 30px -16px rgba(217, 74, 118, .75); color: var(--surface);
  font-size: 20px; font-weight: 700;
}
.login-title { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.login-subtitle { margin-top: 3px; color: var(--dim); font-size: 12px; }
.login-alert { margin-bottom: 16px; }
.login-hint {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 16px; padding: 9px 12px;
  border: 1px dashed var(--line); border-radius: var(--radius);
  background: var(--surface-2); color: var(--dim); font-size: 12px; line-height: 1.5;
}
.login-hint-dot {
  flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--brand-strong);
}
.login-hint code {
  padding: 1px 5px; border-radius: 4px; background: var(--surface); color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 600;
}
.login-submit { width: 100%; margin-top: 4px; }
.login-bind { margin-top: 8px; }
.login-bind-note { margin: 8px 0 0; color: var(--dim); font-size: 12px; line-height: 1.6; }
.login-note { margin: 18px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.login-note.is-centered { text-align: center; margin-top: 10px; }
.register-link { color: var(--brand-strong); font-weight: 600; }
</style>
