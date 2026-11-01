<script setup lang="ts">
import {
  ArrowRight, CopyDocument, Operation, Promotion, Setting, VideoPlay,
} from "@element-plus/icons-vue";
import { useBiliDesk } from "./useBiliDesk";
import { useBiliRunner } from "./useBiliRunner";

/**
 * 命令台 —— 参数表单 + 运行条 + 最新结果。
 *
 * 参数表单的状态（values / dryRun / argv / busy / lastResult）都在 useBiliRunner 里：
 * 切命令时要自动清空，这个 watch 挂在 store 上比挂在视图里可靠 ——
 * 视图是 v-if 切换的，组件一销毁就没人负责重置了。
 */
const { activeCmd, goWorkbench } = useBiliDesk();
const {
  values, dryRun, busy, lastResult, lastLabel,
  params, inputs, toggles, isSelfCheck, preview, missing, SELF_CHECK,
  runCommand, runSelfCheck, copyCmd, resultSummary, formatResult,
} = useBiliRunner();
</script>

<template>
  <div
    v-if="activeCmd"
    class="bd-crumb"
  >
    <span>{{ activeCmd.kind ? "面板" : "命令" }}</span>
    <span>/</span>
    <b>{{ activeCmd.label }}</b>
  </div>

  <template v-if="activeCmd">
    <div class="bd-cmd-h">
      <div class="cmd-ic">
        <el-icon>
          <Promotion v-if="activeCmd.write" />
          <Operation v-else-if="isSelfCheck" />
          <Setting v-else />
        </el-icon>
      </div>
      <div class="hm">
        <h2 class="cmd-title">
          {{ activeCmd.label }}
          <span
            v-if="activeCmd.write"
            class="bd-tag-w"
          >写操作</span>
        </h2>
        <div class="cmd-sub">
          <code v-if="activeCmd.argv.length">bili {{ activeCmd.argv.join(" ") }}</code>
          <span v-if="isSelfCheck">本地 CLI 自检：跑下面三条确认环境</span>
        </div>
      </div>
      <div class="ph-r">
        <button
          class="bd-btn"
          type="button"
          @click="goWorkbench('overview')"
        >
          回概览
        </button>
      </div>
    </div>

    <!-- 升级自检：三条真实命令 -->
    <div
      v-if="isSelfCheck"
      class="bd-card"
    >
      <div class="bd-qlist">
        <button
          v-for="entry in SELF_CHECK"
          :key="entry.itemId"
          class="bd-qirow"
          type="button"
          :disabled="busy"
          @click="runSelfCheck(entry)"
        >
          <span class="qic"><el-icon><Operation /></el-icon></span>
          <span class="qn">
            {{ entry.label }}
            <em class="bd-qdesc">{{ entry.desc }}</em>
          </span>
          <code class="qc">bili {{ entry.argv.join(" ") }}</code>
          <el-icon class="arw">
            <ArrowRight />
          </el-icon>
        </button>
      </div>
    </div>

    <!-- 普通命令：参数 + 运行条 -->
    <template v-else>
      <div class="bd-panel">
        <div class="bd-panel-body">
          <div
            v-if="params.length"
            class="bd-fields"
          >
            <div
              v-for="p in inputs"
              :key="p.key"
              class="bd-fld"
              :class="{ wide: p.pos }"
            >
              <label class="fl">{{ p.label }}<i v-if="p.pos">*</i></label>
              <el-select
                v-if="p.type === 'select'"
                v-model="values[p.key]"
              >
                <el-option
                  v-for="c in p.choices"
                  :key="c"
                  :label="c"
                  :value="c"
                />
              </el-select>
              <el-input
                v-else
                v-model="values[p.key]"
                :type="p.type === 'int' ? 'number' : 'text'"
                :placeholder="p.ph"
                clearable
              />
            </div>
            <div
              v-for="p in toggles"
              :key="p.key"
              class="bd-fld"
            >
              <label class="fl">{{ p.label }}</label>
              <el-switch v-model="values[p.key]" />
            </div>
          </div>
          <p
            v-else
            class="bd-muted"
            style="margin:0"
          >
            这条命令没有参数，直接运行。
          </p>
        </div>

        <div class="bd-runbar">
          <el-icon class="ri">
            <Promotion />
          </el-icon>
          <code :title="preview">{{ preview }}</code>
          <span
            v-if="activeCmd.write && dryRun"
            class="dry"
          >已加 --dry-run</span>
          <button
            class="bd-icon-btn"
            type="button"
            title="复制命令"
            @click="copyCmd"
          >
            <el-icon><CopyDocument /></el-icon>
          </button>
          <el-checkbox
            v-if="activeCmd.write"
            v-model="dryRun"
            size="small"
          >
            安全预览
          </el-checkbox>
          <button
            class="bd-btn primary"
            type="button"
            :disabled="busy || missing.length > 0"
            @click="runCommand"
          >
            <el-icon><VideoPlay /></el-icon>{{ busy ? "执行中" : "运行" }}
          </button>
        </div>
      </div>
      <p
        v-if="missing.length"
        class="bd-muted"
        style="margin:8px 0 0"
      >
        还差：{{ missing.join("、") }}
      </p>
    </template>

    <!-- 最新结果 -->
    <template v-if="lastResult">
      <div class="bd-sec-h">
        <h2>最新结果</h2>
        <span class="sub">{{ lastLabel }}</span>
        <span
          class="bd-result-tag"
          :class="lastResult.code === 0 ? 'ok' : 'err'"
        >{{ lastResult.code === 0 ? "成功" : lastResult.code === null ? "无退出码" : `退出码 ${lastResult.code}` }} · {{ lastResult.elapsed }}s</span>
      </div>
      <div class="bd-card">
        <div class="bd-result-head">
          <code>bili {{ lastResult.argv.join(" ") }}</code>
          <span class="bd-muted">{{ resultSummary(lastResult) }}</span>
        </div>
        <pre class="bd-code">{{ formatResult() }}</pre>
      </div>
    </template>
  </template>

  <div
    v-else
    class="bd-empty-block"
  >
    <div class="halo">
      <el-icon :size="22">
        <Operation />
      </el-icon>
    </div>
    <h4>从左边挑一条命令</h4>
    <p>日常操作在侧栏「常用」里；想知道今天怎么样，回概览看。</p>
    <button
      class="bd-btn"
      type="button"
      @click="goWorkbench('overview')"
    >
      回概览
    </button>
  </div>
</template>
