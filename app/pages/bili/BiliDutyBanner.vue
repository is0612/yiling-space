<script setup lang="ts">
import { WarningFilled, InfoFilled, VideoPlay } from "@element-plus/icons-vue";
import { computed } from "vue";
import { useBiliAdapter } from "./useBiliAdapter";
import { useBiliAccounts } from "./useBiliAccounts";
import { useBiliDashboard } from "./useBiliDashboard";

/**
 * 「值班开着，但没人在盯着窗口」的说明条。
 *
 * 只处理两件从 dashboard 里**看不出来**的事 —— 开关和数据都正常，却没有自动执行者：
 *   1. 适配器（`yarn bili:run`）没在跑：没有任何进程会判断「现在是不是谷时」，一轮都不会发生；
 *   2. 适配器在跑，但「峰谷时段自动刷」关着：它每分钟只会记一条「已关闭谷时调度」。
 *
 * 这两种都不报错、不写库，只看 KPI 和「今日轮次」永远查不出原因 ——
 * 2026-11-03 的「值班开着、三天没跑」就是这一格空白。放在工作区最上面，和 CLI 缺失条同级。
 */
const { adapter, loading, launching, launch, loadAdapter } = useBiliAdapter();
const { dashboard } = useBiliDashboard();
const { openDutyForFirstAccount } = useBiliAccounts();

/** 以第一个账号为准：值班设置本来就写在这条连接上，多账号也各说各的。 */
const account = computed(() => dashboard.value.accounts[0] ?? null);

const dutyOpen = computed(() => (account.value?.duty.perDay ?? 0) > 0);

/** 有账号、开着值班、但适配器不在：这才是真的「一轮都不会跑」。 */
const adapterDown = computed(() =>
  adapter.value !== null && !adapter.value.running && Boolean(account.value) && dutyOpen.value,
);

/** 适配器在，但自动调度关着：能跑，只是要人点「现在跑一轮」。 */
const autoOff = computed(() =>
  adapter.value?.running === true
  && Boolean(account.value)
  && dutyOpen.value
  && account.value?.duty.peakValley === false,
);
</script>

<template>
  <div
    v-if="adapterDown"
    class="bd-cli-warn"
  >
    <el-icon><WarningFilled /></el-icon>
    <div>
      <div class="t">
        值班适配器没在跑
      </div>
      <div class="d">
        「每天 {{ account?.duty.perDay }} 条」和谷时窗口都只是规则，真正判断「现在到窗口了吗」并触发那一轮的
        是另一个常驻进程。它不在，开关看着开着，也一轮都不会自动跑 —— 只能点右上角「现在跑一轮」。
      </div>
      <code>yarn bili:run</code>
      <div class="acts">
        <button
          type="button"
          class="bd-btn is-sm"
          :disabled="launching"
          @click="launch"
        >
          <el-icon><VideoPlay /></el-icon>{{ launching ? "正在启动…" : "启动适配器" }}
        </button>
        <button
          type="button"
          class="bd-btn is-sm"
          :disabled="loading"
          @click="loadAdapter"
        >
          已在别处启动，重新检测
        </button>
      </div>
    </div>
  </div>

  <div
    v-else-if="autoOff"
    class="bd-cli-warn is-dim"
  >
    <el-icon><InfoFilled /></el-icon>
    <div>
      <div class="t">
        「峰谷时段自动刷」关着
      </div>
      <div class="d">
        适配器在跑，但只会每分钟记一条「已关闭谷时调度」—— 到点不会自己刷，得手动点「现在跑一轮」。
        要让它在中午 12:00–14:00、夜间 18:00–09:00 自己刷，去值班设置里打开这个开关。
      </div>
      <div class="acts">
        <button
          type="button"
          class="bd-btn is-sm"
          @click="openDutyForFirstAccount"
        >
          打开值班设置
        </button>
      </div>
    </div>
  </div>
</template>
