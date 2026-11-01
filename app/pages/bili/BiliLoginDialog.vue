<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { CircleCheck, TopRight } from "@element-plus/icons-vue";
import type { BiliMe } from "./types";
import { readErrorMessage } from "./utils";

/**
 * 扫码登录 —— 二维码、轮询、成功后的账号卡都在这里。
 *
 * `me`（当前登录的账号）由父页面持有：页头的头像药丸也用同一份，
 * 不在这里再拉一次，避免两处状态打架。扫码成功后 emit `logged-in`，
 * 父页面重算 me + dashboard。
 *
 * ⚠️ 轮询 2s 一次，关弹窗必须停 —— 不然关了还在后台打 auth status。
 */
const props = defineProps<{ modelValue: boolean; me: BiliMe | null }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  "logged-in": [];
}>();

type AuthStatus = {
  ok: boolean;
  user: unknown;
  error: { code?: string; message?: string; hint?: string } | null;
};

const loading = ref(false);
const qrDataUrl = ref("");
const status = ref<"idle" | "waiting" | "done" | "error" | "expired">("idle");
const user = ref<unknown>(null);
let timer: ReturnType<typeof setInterval> | null = null;

function stopTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function startLogin() {
  loading.value = true;
  status.value = "idle";
  qrDataUrl.value = "";
  user.value = null;
  try {
    const result = await $fetch<{ ok: boolean; code: number | null; stderr: string }>(
      "/api/admin/bili/auth/login",
      { method: "POST" },
    );
    if (!result.ok) {
      ElMessage.error(result.stderr || "发起登录失败，请确认 bili CLI 已安装。");
      status.value = "error";
      return;
    }
    const qr = await $fetch<{ dataUrl: string }>("/api/admin/bili/auth/qr");
    qrDataUrl.value = qr.dataUrl;
    status.value = "waiting";
    timer = setInterval(pollStatus, 2000);
  } catch (error) {
    status.value = "error";
    ElMessage.error(readErrorMessage(error, "发起登录失败。"));
  } finally {
    loading.value = false;
  }
}

async function pollStatus() {
  try {
    const result = await $fetch<AuthStatus>("/api/admin/bili/auth/status");
    if (result.ok) {
      status.value = "done";
      user.value = result.user;
      stopTimer();
      ElMessage.success("B站 登录成功。");
      // auth/status 只给 mid/name/level，头像和主页地址要 me show 才有
      emit("logged-in");
      return;
    }
    if (result.error?.code === "login_expired") {
      status.value = "expired";
      stopTimer();
      ElMessage.warning("二维码已过期，请重新生成。");
    }
  } catch {
    // 轮询失败忽略，等下一轮
  }
}

function closeLogin() {
  stopTimer();
  emit("update:modelValue", false);
}

/** auth/status 的 user 是 B站 原始结构，字段名不固定，按几个别名兜底。 */
function userDisplay(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = record.name ?? record.uname ?? record.nickname;
    if (typeof name === "string" && name) return name;
    const mid = record.mid ?? record.uid;
    if (mid !== undefined && mid !== null) return String(mid);
  }
  return "已登录";
}

// 父页面从外面关掉弹窗（例如点遮罩）时也要停轮询
watch(
  () => props.modelValue,
  (open) => {
    if (!open) stopTimer();
  },
);

onBeforeUnmount(stopTimer);
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="登录 B站"
    width="420px"
    :close-on-click-modal="false"
    @close="closeLogin"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="bd-login">
      <template v-if="status === 'done'">
        <div class="bd-login-done">
          <span class="bd-me-ok">
            <el-icon><CircleCheck /></el-icon>扫码登录成功
          </span>

          <!-- 整块就是入口：点开是她的 B站 主页 -->
          <a
            v-if="me"
            class="bd-me-card"
            :href="me.homeUrl"
            target="_blank"
            rel="noopener noreferrer"
            :title="`打开 ${me.name} 的 B站 主页`"
          >
            <img
              v-if="me.face"
              :src="me.face"
              alt=""
              class="bd-me-face"
              referrerpolicy="no-referrer"
            >
            <span
              v-else
              class="bd-me-face is-text"
            >{{ me.name.slice(0, 1) }}</span>
            <span class="bd-me-body">
              <span class="bd-me-name">{{ me.name }}</span>
              <span class="bd-me-meta">UID {{ me.mid }}<template v-if="me.level"> · Lv{{ me.level }}</template></span>
            </span>
            <span class="bd-me-go">打开主页<el-icon><TopRight /></el-icon></span>
          </a>
          <p
            v-else
            class="bd-muted"
          >
            已登录：{{ userDisplay(user) }}
          </p>

          <p
            v-if="me?.sign"
            class="bd-me-sign"
          >
            {{ me.sign }}
          </p>

          <el-button
            type="primary"
            @click="emit('update:modelValue', false)"
          >
            完成
          </el-button>
        </div>
      </template>

      <template v-else-if="status === 'error'">
        <div class="bd-login-done">
          <p>登录失败，请确认 bili CLI 已安装并能访问网络。</p>
          <el-button @click="startLogin">
            重试
          </el-button>
        </div>
      </template>

      <template v-else>
        <div
          v-loading="loading"
          class="bd-login-qr"
        >
          <img
            v-if="qrDataUrl"
            :src="qrDataUrl"
            alt="B站登录二维码"
            class="bd-login-qrimg"
            :class="{ expired: status === 'expired' }"
          >
          <div
            v-else
            class="bd-login-empty"
          >
            点击「生成二维码」开始登录
          </div>
          <p class="bd-muted">
            {{ status === 'expired' ? '二维码已过期，请重新生成' : status === 'waiting' ? '请用 B站 App 扫码登录' : '扫码登录后即可使用 B站 全部功能' }}
          </p>
          <el-button
            v-if="status !== 'waiting'"
            type="primary"
            :loading="loading"
            @click="startLogin"
          >
            {{ status === 'expired' ? '重新生成二维码' : '生成二维码' }}
          </el-button>
        </div>
      </template>
    </div>
  </el-dialog>
</template>
