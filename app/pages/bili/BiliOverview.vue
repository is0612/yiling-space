<script setup lang="ts">
import {
  ArrowRight, Camera, ChatLineRound, Clock, Close, DataLine, Operation, Plus,
  Refresh, Setting, Star, TopRight, User, VideoPlay, View,
} from "@element-plus/icons-vue";
import { useBiliDesk } from "./useBiliDesk";
import { useBiliDashboard } from "./useBiliDashboard";
import { useBiliAccounts } from "./useBiliAccounts";
import { useBiliMe } from "./useBiliMe";
import { useBiliRunner } from "./useBiliRunner";
import {
  formatDateTime, formatTime, isPicked, parsePickedVideos, parseReportNotes, windowActiveLabel,
} from "./utils";

/**
 * 概览 —— 页头（谁登录了 / 刷新 / 跑一轮）+ KPI 四格 + 两栏（她今天看了什么·今日报告 / 快速开始·最近运行）+ 账号与角色。
 *
 * 所有数据都从页面级 store 里 inject，这个组件自己不持有状态：
 * 换视图再回来不会丢数据，也不会重复请求。
 */
const {
  goWorkbench, selectItem, pins, pinLabel, pinIcon, restorePins, refreshStatus,
} = useBiliDesk();

const {
  h1, subtitle, loading, dashboard, running, runRound,
  totalPickedToday, totalPerDay, totalSeenToday, skippedSeen, totalRounds,
  quotaPct, skipPct, lastRun, lastHint, latestRoundLabel,
  recentSeen, recentReports, coverCache, coverStyle, dropCover,
} = useBiliDashboard();

const {
  openAddAccount, openBind, openDutySettings, removeAccount, unbind,
} = useBiliAccounts();

const { loginVisible, meProfile, meLoading } = useBiliMe();
const { runLog } = useBiliRunner();
</script>

<template>
  <div class="bd-crumb">
    工作台 <span>/</span> <b>概览</b>
  </div>

  <div class="bd-pageh">
    <div>
      <h1>{{ h1 }}</h1>
      <p>{{ subtitle }}</p>
    </div>
    <div class="ph-r">
      <!-- 读账号资料要起一次 bili 子进程（约 1.5s），先占个等宽的位，
           否则页头会空一格、加载完再蹦出用户或登录按钮，看着像闪了一下 -->
      <span
        v-if="meLoading"
        class="bd-sk bd-user-skel"
        aria-hidden="true"
      />
      <!-- 已登录：头像 + 昵称，点开就是她自己的 B站 主页（对齐 bili-desk） -->
      <a
        v-else-if="meProfile"
        class="bd-user"
        :href="meProfile.homeUrl"
        target="_blank"
        rel="noopener noreferrer"
        :title="`${meProfile.name}（UID ${meProfile.mid}）· 打开 B站 主页`"
      >
        <img
          v-if="meProfile.face"
          :src="meProfile.face"
          alt=""
          class="bd-user-face"
          referrerpolicy="no-referrer"
        >
        <span
          v-else
          class="bd-user-face is-text"
        >{{ meProfile.name.slice(0, 1) }}</span>
        <span class="bd-user-name">{{ meProfile.name }}</span>
        <el-icon class="bd-user-out">
          <TopRight />
        </el-icon>
      </a>
      <button
        v-else
        class="bd-btn"
        type="button"
        @click="loginVisible = true"
      >
        <el-icon><Camera /></el-icon>登录 B站
      </button>
      <!-- 已登录时扫码入口不消失：换号不用先登出。和「刷新状态」同级，
           所以走同一档按钮尺寸（36px / 14px），别用 is-sm 缩成 12px -->
      <button
        v-if="meProfile"
        class="bd-btn"
        type="button"
        title="重新扫码，换一个 B站 账号"
        @click="loginVisible = true"
      >
        换账号
      </button>
      <button
        class="bd-btn"
        type="button"
        :disabled="loading"
        @click="refreshStatus"
      >
        <el-icon><Refresh /></el-icon>刷新状态
      </button>
      <button
        class="bd-btn primary lg"
        type="button"
        :disabled="running !== null"
        @click="runRound"
      >
        <el-icon><VideoPlay /></el-icon>{{ running ? "正在跑…" : "现在跑一轮" }}
      </button>
    </div>
  </div>

  <!-- 还没接入渠道 -->
  <div
    v-if="!loading && !dashboard.accounts.length"
    class="bd-empty-block"
  >
    <div class="halo">
      <el-icon :size="22">
        <VideoPlay />
      </el-icon>
    </div>
    <h4>还没有 B站 账号</h4>
    <p>点下方「添加账号」接入一个 B站 账号并绑定角色，值班跑一轮后这里就会有数据。</p>
    <button
      class="bd-btn primary"
      type="button"
      @click="openAddAccount"
    >
      添加账号
    </button>
  </div>

  <template v-else>
    <!-- KPI 四格 -->
    <div
      v-if="loading"
      class="bd-kpi-row"
    >
      <div
        v-for="i in 4"
        :key="i"
        class="bd-kpi"
      >
        <div
          class="bd-sk"
          style="height:12px;width:46%;margin-bottom:10px"
        />
        <div
          class="bd-sk"
          style="height:26px;width:58%;margin-bottom:10px"
        />
        <div
          class="bd-sk"
          style="height:10px;width:74%"
        />
      </div>
    </div>
    <div
      v-else
      class="bd-kpi-row"
    >
      <div class="bd-kpi">
        <div class="k">
          <el-icon><Clock /></el-icon>今日进度
        </div>
        <div class="v">
          {{ totalPickedToday }}<small>/ {{ totalPerDay || "—" }} 条</small>
        </div>
        <div class="bar">
          <i :style="{ width: quotaPct + '%' }" />
        </div>
        <div class="foot">
          {{ totalPerDay ? `已用 ${quotaPct}% 配额` : "还没设置每日条数" }}
        </div>
      </div>

      <div class="bd-kpi">
        <div class="k">
          <el-icon><View /></el-icon>判重跳过
        </div>
        <div class="v">
          {{ skippedSeen }}<small>条</small>
        </div>
        <!-- 进度位占位：只有第一格有进度条，其余三格留同样高的一条空位，
             否则四个卡片的说明文字会差一行，横着看不齐 -->
        <div
          class="bar is-blank"
          aria-hidden="true"
        />
        <div class="foot">
          {{ totalSeenToday ? `重复率 ${skipPct}% · 今天看过 ${totalSeenToday} 条` : "今天还没看过视频" }}
        </div>
      </div>

      <div class="bd-kpi">
        <div class="k">
          <el-icon><ChatLineRound /></el-icon>今日轮次
        </div>
        <div class="v">
          {{ totalRounds }}<small>轮</small>
        </div>
        <div
          class="bar is-blank"
          aria-hidden="true"
        />
        <div class="foot">
          {{ latestRoundLabel }}
        </div>
      </div>

      <div class="bd-kpi">
        <div class="k">
          <el-icon><DataLine /></el-icon>本轮耗时
        </div>
        <div class="v">
          <span
            v-if="lastRun.v === '—'"
            class="na"
          >—</span>
          <template v-else>
            {{ lastRun.v }}<small>{{ lastRun.u }}</small>
          </template>
        </div>
        <div
          class="bar is-blank"
          aria-hidden="true"
        />
        <div class="foot">
          {{ lastHint }}
        </div>
      </div>
    </div>

    <!-- 左：她今天看了什么 + 今日报告 / 右：快速开始 + 最近运行 -->
    <div class="bd-home-cols">
      <div>
        <div class="bd-sec-h">
          <h2>她今天看了什么</h2>
          <span
            v-if="totalSeenToday"
            class="sub"
          >{{ totalPickedToday }} 条采纳 · {{ skippedSeen }} 条跳过</span>
          <button
            class="more"
            type="button"
            @click="goWorkbench('history')"
          >
            全部记录<el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div class="bd-card">
          <div
            v-for="(video, idx) in recentSeen"
            :key="video.bvid"
            class="bd-wrow"
            @click="goWorkbench('history')"
          >
            <div
              class="bd-mcover"
              :style="coverStyle(video.bvid, idx)"
            >
              <img
                v-if="coverCache[video.bvid]"
                :src="coverCache[video.bvid]"
                alt=""
                loading="lazy"
                referrerpolicy="no-referrer"
                @error="dropCover(video.bvid)"
              >
              <span v-else>{{ (video.title || video.bvid).slice(0, 3) }}</span>
            </div>
            <div class="bd-wb">
              <div class="wt">
                {{ video.title || "（无标题）" }}
              </div>
              <div class="wm">
                <span>{{ video.author || "未知 UP" }}</span>
                <i class="sep" />
                <span>{{ video.characterName }}</span>
                <span
                  class="bd-badge"
                  :class="isPicked(video.result) ? 'ok' : 'mute'"
                >{{ isPicked(video.result) ? "挑中" : "跳过" }}</span>
              </div>
            </div>
            <el-icon class="arw">
              <ArrowRight />
            </el-icon>
          </div>
          <div
            v-if="!recentSeen.length"
            class="bd-empty-mini"
          >
            <el-icon><View /></el-icon>
            <span>判重表里还没有今天的记录</span>
            <span>跑一轮值班，她看过什么就会记在这里</span>
          </div>
        </div>

        <div class="bd-sec-h">
          <h2>今日报告</h2>
          <span class="sub">{{ totalRounds ? `${totalRounds} 轮` : "" }}</span>
          <button
            class="more"
            type="button"
            @click="goWorkbench('history')"
          >
            看全部记录<el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div class="bd-card">
          <article
            v-for="report in recentReports.slice(0, 2)"
            :key="report.id"
            class="bd-report"
          >
            <div class="bd-rm is-head">
              <span>第 {{ report.roundIndex }} 轮</span>
              <span>{{ report.characterName }}</span>
              <span>{{ formatDateTime(report.createdAt) }}</span>
              <span>挑中 <b>{{ report.pickedCount }} 条</b></span>
            </div>
            <div
              v-if="parsePickedVideos(report.content).length"
              class="bd-picks"
            >
              <div
                v-for="video in parsePickedVideos(report.content)"
                :key="video.bvid"
                class="bd-pick"
              >
                <code>{{ video.bvid }}</code>
                <span>{{ video.text || "（无标题）" }}</span>
              </div>
            </div>
            <p
              v-else
              class="bd-muted"
            >
              这一轮没有挑中的视频。
            </p>
            <ul
              v-if="parseReportNotes(report.content).length"
              class="bd-report-notes"
            >
              <li
                v-for="(note, index) in parseReportNotes(report.content)"
                :key="index"
              >
                {{ note }}
              </li>
            </ul>
          </article>
          <div
            v-if="!recentReports.length"
            class="bd-empty-mini"
          >
            <el-icon><ChatLineRound /></el-icon>
            <span>今天还没有报告</span>
            <span>跑一轮之后，这里会是她写的当日小结</span>
          </div>
        </div>
      </div>

      <div>
        <div class="bd-sec-h">
          <h2>快速开始</h2>
        </div>
        <div class="bd-card">
          <div class="bd-qlist">
            <button
              v-for="link in pins"
              :key="link.key"
              class="bd-qirow"
              type="button"
              @click="selectItem(link.item)"
            >
              <span class="qic"><el-icon><component :is="pinIcon(link.item)" /></el-icon></span>
              <span class="qn">{{ pinLabel(link.item) }}</span>
              <code class="qc">{{ link.item.id }}</code>
              <el-icon class="arw">
                <ArrowRight />
              </el-icon>
            </button>
            <!-- 常用被清空时别留一块空白砖（这张卡有最小高度，空着会很难看），
                 和侧栏「常用栏空了 / 恢复默认 4 条」一个路数 -->
            <div
              v-if="!pins.length"
              class="bd-empty-mini"
            >
              <el-icon><Star /></el-icon>
              <span>常用还是空的</span>
              <span>侧栏「常用」里的命令会出现在这里</span>
              <button
                class="lnk"
                type="button"
                @click="restorePins"
              >
                恢复默认 4 条
              </button>
            </div>
          </div>
        </div>

        <div class="bd-sec-h">
          <h2>最近运行</h2>
          <button
            class="more"
            type="button"
            @click="goWorkbench('history')"
          >
            全部记录<el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div class="bd-card">
          <div
            v-for="entry in runLog.slice(0, 4)"
            :key="entry.id"
            class="bd-rrow"
            @click="goWorkbench('history')"
          >
            <span
              class="rdot"
              :class="entry.ok ? 'ok' : 'err'"
            />
            <div class="rmain">
              <div class="rc">
                bili {{ entry.argv.join(" ") }}
              </div>
              <div class="rs">
                {{ entry.label }}
              </div>
            </div>
            <span class="rt">{{ entry.seconds }}s · {{ formatTime(entry.at) }}</span>
          </div>
          <div
            v-if="!runLog.length"
            class="bd-empty-mini"
          >
            <el-icon><Operation /></el-icon>
            <span>这次启动还没跑过命令</span>
            <span>上面「快速开始」挑一条试试</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 账号与角色：多账号/绑定关系只在这里能看全 -->
    <div class="bd-sec-h">
      <h2>账号与角色</h2>
      <span class="sub">{{ dashboard.today }}</span>
      <button
        class="more"
        type="button"
        @click="openAddAccount"
      >
        添加账号<el-icon><Plus /></el-icon>
      </button>
    </div>
    <div class="bd-card bd-accounts">
      <div
        v-for="account in dashboard.accounts"
        :key="account.connectionId"
        class="bd-account"
      >
        <div class="bd-account-row">
          <span class="bd-account-name">{{ account.displayName }}</span>
          <span class="bd-badge mute">{{ windowActiveLabel(account) }}</span>
          <span
            class="bd-badge"
            :class="account.duty.taste ? 'ok' : 'mute'"
            :title="account.duty.taste ? '刷站口味已设置，点「值班设置」可改' : '还没写刷站口味，她会按通用尺度挑'"
          >口味{{ account.duty.taste ? "已设" : "未设" }}</span>
          <span class="bd-account-meta">
            配置目录 {{ account.dataHome || "（默认）" }} · 每天上限 {{ account.duty.perDay }} 条
          </span>
          <button
            class="bd-btn is-sm"
            type="button"
            @click="openBind(account)"
          >
            <el-icon><User /></el-icon>绑定角色
          </button>
          <button
            class="bd-btn is-sm"
            type="button"
            @click="openDutySettings(account)"
          >
            <el-icon><Setting /></el-icon>值班设置
          </button>
          <button
            class="bd-btn is-sm is-danger"
            type="button"
            @click="removeAccount(account)"
          >
            <el-icon><Close /></el-icon>删除
          </button>
        </div>
        <div
          v-if="!account.bindings.length"
          class="bd-account-empty"
        >
          这个账号还没绑定角色，值班不会产生对话。点上面「绑定角色」选一个。
        </div>
        <div
          v-for="binding in account.bindings"
          :key="binding.bindingId"
          class="bd-binding"
        >
          <span class="bd-binding-role">{{ binding.characterName }}</span>
          <span class="bd-binding-stat">今日 {{ binding.pickedToday }} / {{ binding.perDay }} 条</span>
          <span class="bd-binding-stat">剩余 {{ binding.remaining }} 条</span>
          <span class="bd-binding-stat">{{ binding.reports.length }} 轮报告</span>
          <span class="bd-binding-stat">{{ binding.seenToday.length }} 条看过</span>
          <button
            class="bd-btn is-sm is-danger"
            type="button"
            @click="unbind(account, binding)"
          >
            <el-icon><Close /></el-icon>解绑
          </button>
        </div>
      </div>
    </div>
  </template>
</template>
