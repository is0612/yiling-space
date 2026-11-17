<script setup lang="ts">
const open = defineModel<boolean>({ required: true });
const chatTemperature = defineModel<number>("chatTemperature", { required: true });
const chatMaxTokens = defineModel<number>("chatMaxTokens", { required: true });
const dailyTokenLimit = defineModel<number>("dailyTokenLimit", { required: true });
const recentMessageLimit = defineModel<number>("recentMessageLimit", { required: true });
const eventRecentDays = defineModel<number>("eventRecentDays", { required: true });
const memoryTokenBudget = defineModel<number>("memoryTokenBudget", { required: true });
const memoryItemLimit = defineModel<number>("memoryItemLimit", { required: true });
const snapshotTokenBudget = defineModel<number>("snapshotTokenBudget", { required: true });

const emit = defineEmits<{ reset: [] }>();
</script>

<template>
  <el-dialog
    v-model="open"
    title="生成参数"
    width="min(720px, calc(100vw - 32px))"
    class="ms-a generation-dialog"
    append-to-body
  >
    <div class="brick-head">
      <div class="brick-head-txt">
        <div class="brick-heading">
          <span class="brick-title">对话与记忆预算</span>
        </div>
        <p class="brick-desc">
          面向自然对话：适度保留表达变化，并为回复与思考预留输出空间。恢复推荐只改温度和输出上限，保存后生效。
        </p>
      </div>
      <el-button
        text
        class="head-act"
        @click="emit('reset')"
      >
        恢复对话推荐
      </el-button>
    </div>

    <div class="knob-group">
      <div class="knob-group-head">
        <h3 class="knob-group-title">
          回复表现
        </h3>
        <span class="knob-group-note">从日常陪伴推荐方案开始，再按实际效果微调</span>
      </div>

      <div class="knob">
        <div class="knob-label">
          温度
        </div>
        <p class="field-help">
          推荐 0.7：为自然交流保留表达变化。需要更稳时可降低；不同模型对温度的支持与效果不同。
        </p>
        <div class="knob-ctl">
          <el-slider
            v-model="chatTemperature"
            class="knob-slider"
            :min="0"
            :max="2"
            :step="0.1"
            :aria-label="'温度'"
          />
          <el-input-number
            v-model="chatTemperature"
            class="knob-number narrow"
            :min="0"
            :max="2"
            :step="0.1"
            :precision="1"
            :controls="false"
            aria-label="温度数值"
          />
        </div>
      </div>

      <div class="knob">
        <div class="knob-label">
          最大输出 Token
        </div>
        <p class="field-help">
          推荐 4096：思考 token 也算在这个上限里，给窄了会出现「思考完没正文」。这是单次输出上限，不代表每次都会用满，用多少算多少。
        </p>
        <div class="knob-ctl">
          <el-input-number
            v-model="chatMaxTokens"
            class="knob-number"
            :min="256"
            :max="8192"
            :step="256"
            aria-label="最大输出 Token"
          />
        </div>
      </div>
    </div>

    <div class="knob-group">
      <div class="knob-group-head">
        <h3 class="knob-group-title">
          用量与记忆
        </h3>
        <span class="knob-group-note">预算越高，上下文越多，用量也可能增加</span>
      </div>

      <div class="knob">
        <div class="knob-label">
          每日 token 额度
        </div>
        <p class="field-help">
          默认不限（0）。想设上限时再填：按东八区统计所有调用，达到额度后会暂停相关调用；这不是金额上限，建议先观察几天「用量与花费」再决定。
        </p>
        <div class="knob-ctl">
          <el-input-number
            v-model="dailyTokenLimit"
            class="knob-number"
            :min="0"
            :max="10000000"
            :step="10000"
            aria-label="每日 token 额度"
          />
        </div>
      </div>

      <div class="knob">
        <div class="knob-label">
          最近对话保留（条）
        </div>
        <p class="field-help">
          推荐 40 条（网页对话约 20 轮）。群里一轮就有好几条，同样的条数覆盖的轮次会少一些，可以调大；范围 20–200。调得太大不只是费 token，真正相关的几句反而会被稀释。
        </p>
        <div class="knob-ctl">
          <el-input-number
            v-model="recentMessageLimit"
            class="knob-number"
            :min="20"
            :max="200"
            :step="10"
            aria-label="最近对话保留条数"
          />
        </div>
      </div>

      <div class="knob">
        <div class="knob-label">
          近期忆泡（天）
        </div>
        <p class="field-help">
          0 = 不带。填 2 表示把最近两天发生的事无条件带进每一轮，和问不问无关——群里没人会问日期，不这么带，她对昨天就是一片空白。代价是每轮多几百 token；提示词里已经写明「只当背景、不主动提」，但调大后仍可能翻旧账。范围 0–14。
        </p>
        <div class="knob-ctl">
          <el-input-number
            v-model="eventRecentDays"
            class="knob-number"
            :min="0"
            :max="14"
            :step="1"
            aria-label="近期忆泡天数"
          />
        </div>
      </div>

      <div class="knob">
        <div class="knob-label">
          记忆注入预算（token）
        </div>
        <p class="field-help">
          推荐 1800：约 20 条长期记忆的量，适合持续陪伴。预算并非严格硬上限，首条记忆始终放行；0 回退到系统默认 1800。
        </p>
        <div class="knob-ctl">
          <el-input-number
            v-model="memoryTokenBudget"
            class="knob-number"
            :min="0"
            :max="20000"
            :step="200"
            aria-label="记忆注入预算"
          />
        </div>
      </div>

      <div class="knob">
        <div class="knob-label">
          记忆注入条数
        </div>
        <p class="field-help">
          推荐 20 条。它比预算更早卡住：记忆平均 74 字，12 条才 888 token，1800 的预算有一半用不上。上限 50，再多每条的注意力会被摊薄。
        </p>
        <div class="knob-ctl">
          <el-input-number
            v-model="memoryItemLimit"
            class="knob-number"
            :min="1"
            :max="50"
            :step="1"
            aria-label="记忆注入条数"
          />
        </div>
      </div>

      <div class="knob">
        <div class="knob-label">
          阶段总结注入预算（token）
        </div>
        <p class="field-help">
          推荐 2500：约 1.5 份周期总结，与长期记忆预算独立。首条总结始终放行，可能超出预算；0 回退到系统默认 2500。
        </p>
        <div class="knob-ctl">
          <el-input-number
            v-model="snapshotTokenBudget"
            class="knob-number"
            :min="0"
            :max="20000"
            :step="200"
            aria-label="阶段总结注入预算"
          />
        </div>
      </div>
    </div>
    <template #footer>
      <span class="parameter-save-note">修改保留在草稿中，点击页面「保存设置」后生效。</span>
      <el-button @click="open = false">
        完成
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.generation-dialog :deep(.el-dialog__body) { max-height: 65vh; overflow-y: auto; }
.brick-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-4); }
.brick-head-txt { min-width: 0; flex: 1; }
.brick-heading { display: flex; align-items: center; gap: var(--sp-2); }
.brick-title { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; letter-spacing: -.01em; line-height: 1.4; }
.brick-desc { max-width: 44em; margin: var(--sp-1) 0 0; color: var(--dim); font-size: 12px; line-height: 1.65; }
.head-act { flex: none; }
.field-help { max-width: 44em; margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.parameter-save-note { margin-right: 12px; color: var(--dim); font-size: 12px; line-height: 1.7; }

.knob-group { margin-top: var(--sp-4); border-top: 1px solid var(--surface-3); padding-top: var(--sp-4); }
.knob-group + .knob-group { margin-top: var(--sp-5); }
.knob-group-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-3); }
.knob-group-title { margin: 0; color: var(--text); font-size: 14px; font-weight: 700; }
.knob-group-note { color: var(--dim); font-size: 12px; }
.knob {
  display: grid;
  grid-template-areas:
    "label ctl"
    "help  help";
  grid-template-columns: minmax(0, 1fr) 268px;
  align-items: start;
  gap: var(--sp-2) var(--sp-5);
  padding: var(--sp-3) 0;
}
.knob-label { grid-area: label; color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; }
.knob-ctl { display: flex; grid-area: ctl; align-items: center; gap: var(--sp-2); }
.knob .field-help { grid-area: help; }
.knob + .knob { border-top: 1px solid var(--surface-3); }
.knob-slider { min-width: 88px; flex: 1; }
.knob-number { width: 100%; }
.knob-number.narrow { width: 84px; flex: none; }
.knob-ctl :deep(.el-input-number .el-input__inner) { text-align: left; font-variant-numeric: tabular-nums; }
.ms-a :deep(.el-slider) { --el-slider-height: 4px; }
.ms-a :deep(.el-slider__button) { width: 14px; height: 14px; border-width: 2px; }
.ms-a :deep(.el-button) {
  height: var(--ctl-h);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-4);
  font-size: 14px;
  font-weight: 600;
}
.ms-a :deep(.el-button.is-text) { padding: 0 6px; color: var(--brand-strong); }
.ms-a :deep(.el-button.is-text:hover) { background: var(--brand-soft); color: var(--brand-btn-h); }

@media (max-width: 720px) {
  .knob {
    grid-template-areas: "label" "ctl" "help";
    grid-template-columns: minmax(0, 1fr);
  }
  .knob-ctl { justify-content: flex-start; }
  .knob-number { max-width: 200px; }
}
</style>
