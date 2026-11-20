<script setup lang="ts">
import { readApiErrorMessage } from "~/utils/api-error";
const visible = defineModel<boolean>({ required: true });
const request = useApiRequest();
const url = ref("");
const busy = ref(false);
const errorText = ref("");
const result = ref<{ url: string; title: string; text: string; screenshot: string; limitation: string; blockedRequests: number } | null>(null);
async function observe() {
  if (busy.value || !url.value.trim()) return;
  result.value = null;
  errorText.value = "";
  busy.value = true;
  try { result.value = await request<NonNullable<typeof result.value>>({ url: "/local/browser/observe", method: "post", data: { url: url.value.trim() }, timeout: 30000 }); }
  catch (error) { errorText.value = readApiErrorMessage(error, "网页观察失败。"); }
  finally { busy.value = false; }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="浏览器只读观察"
    width="min(960px, 94vw)"
    append-to-body
  >
    <el-alert
      type="info"
      :closable="false"
      title="独立无登录会话，不接管你平时的浏览器"
      description="只观察指定网站；不登录、不点击、不填写、不提交、不下载。跨站资源会被阻止，部分网页可能显示不完整。"
    />
    <el-form
      label-position="top"
      class="browser-form"
      @submit.prevent="observe"
    >
      <el-form-item label="你要观察的网页">
        <el-input
          v-model="url"
          placeholder="https://example.com/"
          maxlength="2048"
          :disabled="busy"
          @keyup.enter="observe"
        />
      </el-form-item>
      <el-button
        type="primary"
        :loading="busy"
        :disabled="!url.trim()"
        @click="observe"
      >
        观察网页
      </el-button>
    </el-form>
    <el-alert
      v-if="errorText"
      type="error"
      :title="errorText"
      :closable="false"
      class="browser-form"
    />
    <section
      v-if="result"
      class="browser-form"
    >
      <h3>{{ result.title || '无标题网页' }}</h3>
      <p>{{ result.url }}</p>
      <p>{{ result.limitation }} · 已阻止 {{ result.blockedRequests }} 个请求</p>
      <img
        :src="result.screenshot"
        alt="本次独立浏览器观察的页面截图"
        class="browser-image"
      >
      <details><summary>渲染后的可见文字</summary><pre>{{ result.text }}</pre></details>
    </section>
  </el-dialog>
</template>

<style scoped>
.browser-form { margin-top: 16px; }
.browser-image { width: 100%; border: 1px solid #e4e9f2; border-radius: 8px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; font-size: 13px; }
p { overflow-wrap: anywhere; font-size: 13px; }
summary { cursor: pointer; }
</style>
