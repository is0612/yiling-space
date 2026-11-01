<script setup lang="ts">
import { ChatLineRound, Clock, Refresh, View } from "@element-plus/icons-vue";
import { useBiliDesk } from "./useBiliDesk";
import { useBiliDashboard } from "./useBiliDashboard";
import {
  formatDateTime, formatTime, isPicked, parsePickedVideos, parseReportNotes,
} from "./utils";

/**
 * 运行记录 —— 今日报告 + 今天看过的视频，可按「全部 / 报告 / 看过的」筛。
 *
 * 筛选状态放在 useBiliDashboard 而不是这里：视图是 v-if 切换的，
 * 放组件内每次离开就会丢，回来又跳回「全部」。
 */
const { goWorkbench, refreshStatus } = useBiliDesk();
const {
  loading, allReports, allSeen, historyFilter,
  coverCache, coverStyle, dropCover,
} = useBiliDashboard();
</script>

<template>
  <div class="bd-crumb">
    工作台 <span>/</span> <b>运行记录</b>
  </div>
  <div class="bd-pageh">
    <div>
      <h1>今天的值班记录</h1>
      <p>{{ allReports.length }} 轮报告 · {{ allSeen.length }} 条看过的视频 · 最新的在最前</p>
    </div>
    <div class="ph-r">
      <button
        class="bd-btn"
        type="button"
        :disabled="loading"
        @click="refreshStatus"
      >
        <el-icon><Refresh /></el-icon>刷新状态
      </button>
    </div>
  </div>

  <!-- 一条记录都没有时，筛选条无事可做，跟着空态一起藏起来 -->
  <div
    v-if="allReports.length || allSeen.length"
    class="bd-filters"
  >
    <button
      class="bd-chip"
      :class="{ on: historyFilter === 'all' }"
      type="button"
      @click="historyFilter = 'all'"
    >
      全部<span class="n">{{ allReports.length + allSeen.length }}</span>
    </button>
    <button
      class="bd-chip"
      :class="{ on: historyFilter === 'report' }"
      type="button"
      @click="historyFilter = 'report'"
    >
      今日报告<span class="n">{{ allReports.length }}</span>
    </button>
    <button
      class="bd-chip"
      :class="{ on: historyFilter === 'seen' }"
      type="button"
      @click="historyFilter = 'seen'"
    >
      看过的视频<span class="n">{{ allSeen.length }}</span>
    </button>
  </div>

  <div
    v-if="!allReports.length && !allSeen.length"
    class="bd-empty-block"
  >
    <div class="halo">
      <el-icon :size="22">
        <Clock />
      </el-icon>
    </div>
    <h4>今天还没有记录</h4>
    <p>回概览点「现在跑一轮」，或等谷时窗口到了自动跑，这里就会有报告和看过的视频。</p>
    <button
      class="bd-btn primary"
      type="button"
      @click="goWorkbench('overview')"
    >
      回概览跑一轮
    </button>
  </div>

  <template v-else>
    <template v-if="historyFilter !== 'seen'">
      <div
        v-if="allReports.length"
        class="bd-sec-h"
      >
        <h2>今日报告</h2>
      </div>
      <div
        v-if="allReports.length"
        class="bd-card"
      >
        <article
          v-for="report in allReports"
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
      </div>
    </template>

    <template v-if="historyFilter !== 'report'">
      <div
        v-if="allSeen.length"
        class="bd-sec-h"
      >
        <h2>今天看过的视频</h2>
        <span class="sub">{{ allSeen.length }} 条</span>
      </div>
      <div
        v-if="allSeen.length"
        class="bd-card"
      >
        <div
          v-for="(video, idx) in allSeen"
          :key="video.bvid"
          class="bd-wrow"
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
              <i class="sep" />
              <span class="bd-mono">{{ video.bvid }}</span>
              <span
                v-if="video.score !== null"
                class="bd-score"
              >{{ video.score }} 分</span>
              <span
                v-if="video.reason"
                class="bd-reason"
              >{{ video.reason }}</span>
            </div>
          </div>
          <span
            class="bd-badge"
            :class="isPicked(video.result) ? 'ok' : 'mute'"
          >{{ isPicked(video.result) ? "挑中" : "跳过" }}</span>
          <span class="bd-seen-time">{{ formatTime(video.seenAt) }}</span>
        </div>
      </div>
    </template>

    <div
      v-if="historyFilter === 'report' && !allReports.length"
      class="bd-empty-block is-compact"
    >
      <div class="halo">
        <el-icon :size="22">
          <ChatLineRound />
        </el-icon>
      </div>
      <h4>今天还没有报告</h4>
      <p>跑一轮值班之后，这里会是她写的当日小结。切回「全部」还能看到今天看过的视频。</p>
      <button
        class="bd-btn"
        type="button"
        @click="historyFilter = 'all'"
      >
        看全部记录
      </button>
    </div>
    <div
      v-if="historyFilter === 'seen' && !allSeen.length"
      class="bd-empty-block is-compact"
    >
      <div class="halo">
        <el-icon :size="22">
          <View />
        </el-icon>
      </div>
      <h4>判重表里还没有今天的记录</h4>
      <p>跑一轮值班，她看过什么就会记在这里，跳过和挑中都算。</p>
      <button
        class="bd-btn"
        type="button"
        @click="historyFilter = 'all'"
      >
        看全部记录
      </button>
    </div>
  </template>
</template>
