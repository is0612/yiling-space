<script setup lang="ts">
import { InfoFilled, WarningFilled } from "@element-plus/icons-vue";
import { BILI_SOURCE_LABEL } from "./types";
import { useBiliEnv } from "./useBiliEnv";

/**
 * 工作区顶部那条「环境没装好」的说明。
 *
 * 只在两种状态下出现，正常时组件渲染为空 —— 所以可以无条件挂在工作区最上面：
 *   · 缺 CLI：给安装命令 + 复制，这是唯一会阻塞整页的情况
 *   · 装了但版本读不出来：多半是 PATH 里有别的同名程序，提醒一句
 *
 * 不在这里判断登录态 —— 「没登录」是正常状态，由 me 和登录弹窗负责。
 */
const { env, loading, cliMissing, unknownVersion, copyInstall, loadEnv } = useBiliEnv();
</script>

<template>
  <div
    v-if="cliMissing"
    class="bd-cli-warn"
  >
    <el-icon><WarningFilled /></el-icon>
    <div>
      <div class="t">
        没找到 bili CLI
      </div>
      <div class="d">
        B站值班台靠一个独立的命令行工具干活，没装它这里只会是空数据 ——
        聊天、记忆、QQ 都不受影响，只有这一页需要它。要用的话在项目根执行：
      </div>
      <code>{{ env?.installCommand }}</code>
      <div class="acts">
        <button
          type="button"
          class="bd-btn is-sm"
          @click="copyInstall"
        >
          复制命令
        </button>
        <button
          type="button"
          class="bd-btn is-sm"
          :disabled="loading"
          @click="loadEnv"
        >
          重新检测
        </button>
      </div>
    </div>
  </div>

  <div
    v-else-if="unknownVersion"
    class="bd-cli-warn is-dim"
  >
    <el-icon><InfoFilled /></el-icon>
    <div>
      <div class="t">
        bili CLI 已找到，但读不出版本号
      </div>
      <div class="d">
        {{ env?.bin }}（来自{{ env ? BILI_SOURCE_LABEL[env.source] : "未知位置" }}）——
        可能指向了别的同名程序，执行命令会得到看不懂的输出。
      </div>
      <div class="acts">
        <button
          type="button"
          class="bd-btn is-sm"
          :disabled="loading"
          @click="loadEnv"
        >
          重新检测
        </button>
      </div>
    </div>
  </div>
</template>
