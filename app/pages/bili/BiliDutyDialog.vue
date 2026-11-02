<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { BiliAccount, BiliOwner } from "./types";
import { readErrorMessage } from "./utils";

/**
 * 值班设置 —— 每天几条 / 谷时窗口 / 投递方式 / 对外动作 / 刷站口味。
 *
 * 两个「真值」在这里汇合，别搞混：
 *   · 表单里的东西属于我们自己库里连接 metadata 的 duty（保存时 PUT /duty）
 *   · 「主人」写在 bili CLI 自己的配置里（`bili owner set`），**当面生效、不随保存提交**，
 *     所以每次打开都现读一次，否则换号登录后还显示上一个人。
 */
const props = defineProps<{ modelValue: boolean; account: BiliAccount | null }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
}>();

const ZONES = ["all", "anime", "music", "dance", "game", "knowledge", "tech", "sports", "car", "life", "food", "animal", "kichiku", "fashion", "ent", "film", "original", "rookie"];

/** 口味文本上限，和服务器 parseDutyInput 的截断保持一致。 */
const TASTE_MAX = 2000;

/** 保存中 —— 请求归这个组件自己发，父页面只负责把 dashboard 重新拉一遍 */
const saving = ref(false);

const form = reactive({
  perDay: 5, peakValley: true, noon: true, night: true,
  keywordsText: "", zone: "all", frames: 0,
  reportLevel: "brief" as "full" | "brief" | "off",
  dmMode: "only" as "only" | "both" | "off",
  dmTargetMode: "owner" as "owner" | "uid",
  dmTargetUid: "",
  dmAllowNew: false,
  autoComment: false, commentPerRound: 1, mentionName: "",
  taste: "",
  favMinScore: 0, autoDynamic: false, dynamicMinScore: 15,
  ownerFirst: false,
  ownerWatch: false, ownerLike: true, ownerFav: true, ownerComment: true, ownerCoinMinScore: 12,
});

/**
 * 底部那条黄条：把这一份设置里所有「会真的写到 B站 上、撤不回来」的动作汇总成一句。
 *
 * 以前只判 autoComment / autoDynamic，主人互动加进来以后如果还硬编码两个字段，
 * 用户开着「对主人评论」也不会看到任何提醒。
 */
const writeWarning = computed(() => {
  const parts: string[] = [];
  if (form.autoComment) parts.push("公开评论");
  if (form.autoDynamic) parts.push("发动态");
  if (form.ownerWatch) {
    const ownerActs = [
      form.ownerLike ? "点赞" : "",
      form.ownerFav ? "收藏" : "",
      form.ownerComment ? "评论" : "",
      form.ownerCoinMinScore > 0 ? "投币" : "",
    ].filter(Boolean);
    if (ownerActs.length) parts.push(`对主人投稿的${ownerActs.join("/")}`);
  }
  return parts.length ? `${parts.join("、")}会以这个 B站 账号的身份真的发出去，发出去撤不回来。` : "";
});

function fill(account: BiliAccount) {
  const duty = account.duty;
  form.perDay = duty.perDay ?? 5;
  form.peakValley = duty.peakValley ?? true;
  form.noon = duty.noon ?? true;
  form.night = duty.night ?? true;
  form.keywordsText = (duty.keywords ?? []).join("\n");
  form.zone = duty.zone || "all";
  form.frames = duty.frames ?? 0;
  form.reportLevel = duty.reportLevel ?? "brief";
  form.dmMode = duty.dmMode ?? "only";
  form.dmTargetMode = duty.dmTargetUid ? "uid" : "owner";
  form.dmTargetUid = duty.dmTargetUid ?? "";
  form.dmAllowNew = duty.dmAllowNew ?? false;
  form.autoComment = duty.autoComment ?? false;
  form.commentPerRound = duty.commentPerRound ?? 1;
  form.mentionName = duty.mentionName ?? "";
  form.taste = duty.taste ?? "";
  form.favMinScore = duty.favMinScore ?? 0;
  form.autoDynamic = duty.autoDynamic ?? false;
  form.dynamicMinScore = duty.dynamicMinScore ?? 15;
  form.ownerFirst = duty.ownerFirst ?? false;
  form.ownerWatch = duty.ownerWatch ?? false;
  form.ownerLike = duty.ownerLike ?? true;
  form.ownerFav = duty.ownerFav ?? true;
  form.ownerComment = duty.ownerComment ?? true;
  form.ownerCoinMinScore = duty.ownerCoinMinScore ?? 12;
}

// ── 主人（bili CLI 的 owner） ──────────────────────────────
// 不在我们库里，只做「读」和「改」的转发：不缓存、不复制到 metadata，
// 两份真值迟早会打架。
const ownerInfo = ref<BiliOwner | null>(null);
const ownerLoading = ref(false);
const ownerSaving = ref(false);
const ownerError = ref("");
const ownerInput = ref("");

async function loadOwner(connectionId: string) {
  ownerLoading.value = true;
  ownerError.value = "";
  try {
    const result = await $fetch<{ ok: boolean; owner: BiliOwner | null; error?: string }>(
      "/api/admin/bili/owner",
      { query: { connectionId } },
    );
    ownerInfo.value = result.owner ?? null;
    if (!result.ok) ownerError.value = result.error || "读不到主人信息。";
  } catch (error) {
    ownerInfo.value = null;
    ownerError.value = readErrorMessage(error, "读不到主人信息。");
  } finally {
    ownerLoading.value = false;
  }
}

async function saveOwner() {
  if (!props.account) return;
  const uid = ownerInput.value.trim();
  if (!uid) {
    ElMessage.warning("填个 UID 或昵称。");
    return;
  }
  ownerSaving.value = true;
  try {
    const result = await $fetch<{ ok: boolean; owner: BiliOwner | null; error?: string }>("/api/admin/bili/owner", {
      method: "PUT",
      body: { connectionId: props.account.connectionId, uid },
    });
    if (!result.ok) {
      ownerError.value = result.error || "设置主人失败。";
      ElMessage.warning(ownerError.value);
      return;
    }
    ownerInfo.value = result.owner ?? null;
    ownerError.value = "";
    ownerInput.value = "";
    ElMessage.success(`主人已设为 ${result.owner?.name ?? uid}。`);
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "设置主人失败。"));
  } finally {
    ownerSaving.value = false;
  }
}

function refreshOwner() {
  if (props.account) void loadOwner(props.account.connectionId);
}

function close() {
  emit("update:modelValue", false);
}

async function saveDuty() {
  if (!props.account) return;
  const dmTargetUid = form.dmTargetMode === "uid" ? form.dmTargetUid.replace(/\D/g, "") : "";
  if (form.dmTargetMode === "uid" && !dmTargetUid) {
    ElMessage.warning("选了「指定 UID」就要把收件人 UID 填上（只填数字）。");
    return;
  }
  saving.value = true;
  try {
    await $fetch("/api/admin/bili/duty", {
      method: "PUT",
      body: {
        connectionId: props.account.connectionId,
        duty: {
          perDay: form.perDay,
          peakValley: form.peakValley,
          noon: form.noon,
          night: form.night,
          keywords: form.keywordsText.split(/[,，\n]/).map((k) => k.trim()).filter(Boolean),
          zone: form.zone,
          frames: form.frames,
          reportLevel: form.reportLevel,
          dmMode: form.dmMode,
          dmTargetUid,
          dmAllowNew: form.dmAllowNew,
          autoComment: form.autoComment,
          commentPerRound: form.commentPerRound,
          mentionName: form.mentionName.trim(),
          taste: form.taste.trim().slice(0, TASTE_MAX),
          favMinScore: form.favMinScore,
          autoDynamic: form.autoDynamic,
          dynamicMinScore: form.dynamicMinScore,
          ownerFirst: form.ownerFirst,
          ownerWatch: form.ownerWatch,
          ownerLike: form.ownerLike,
          ownerFav: form.ownerFav,
          ownerComment: form.ownerComment,
          ownerCoinMinScore: form.ownerCoinMinScore,
        },
      },
    });
    ElMessage.success("已保存，下一轮按新设置跑。");
    close();
    emit("saved");
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "保存值班设置失败。"));
  } finally {
    saving.value = false;
  }
}

const resetting = ref(false);

/** 只重置今天已挑条数；报告和判重都保留，历史还能查。 */
async function resetQuota() {
  if (!props.account || resetting.value) return;
  const confirmed = await ElMessageBox.confirm(
    "只把「今天已挑几条」清零，不删除报告和判重记录。今天的剩余额度会按 0 重新算。",
    "重置今日额度",
    { confirmButtonText: "重置", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;

  resetting.value = true;
  try {
    await $fetch("/api/admin/bili/duty/reset", {
      method: "POST",
      body: { connectionId: props.account.connectionId },
    });
    ElMessage.success("今日额度已重置，报告和判重都还在。");
    close();
    emit("saved");
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "重置额度失败。"));
  } finally {
    resetting.value = false;
  }
}

// 每次打开都按当前账号重填 + 现读主人
watch(
  () => props.modelValue,
  (open) => {
    if (!open || !props.account) return;
    fill(props.account);
    ownerInfo.value = null;
    ownerError.value = "";
    ownerInput.value = "";
    void loadOwner(props.account.connectionId);
  },
);
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="值班设置"
    width="660px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="bd-dialog-body">
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="每天最多挑几条（0-50）">
              <el-input-number
                v-model="form.perDay"
                :min="0"
                :max="50"
                controls-position="right"
                style="width:100%"
              />
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="峰谷时段自动刷">
              <el-switch v-model="form.peakValley" />
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="中午窗口 12:00–14:00">
              <el-switch
                v-model="form.noon"
                :disabled="!form.peakValley"
              />
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="夜间窗口 18:00–09:00">
              <el-switch
                v-model="form.night"
                :disabled="!form.peakValley"
              />
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="热门分区">
              <el-select
                v-model="form.zone"
                style="width:100%"
                filterable
                allow-create
              >
                <el-option
                  v-for="zone in ZONES"
                  :key="zone"
                  :label="zone === 'all' ? '全站' : zone"
                  :value="zone"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="每条视频抽几帧（0 = 不抽）">
              <el-input-number
                v-model="form.frames"
                :min="0"
                :max="30"
                controls-position="right"
                style="width:100%"
              />
              <p class="bd-form-tip">
                抽帧会生成拼图文件；角色模型若是纯文本模型（如 deepseek-flash），不会读取画面，只能依据字幕 / AI 总结判断。要看画面需换成支持图像输入的模型。
              </p>
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="日报写多细">
              <el-select
                v-model="form.reportLevel"
                style="width:100%"
              >
                <el-option
                  label="完整（挑中 + 跳过 + 过程）"
                  value="full"
                />
                <el-option
                  label="薄版（只写挑中）"
                  value="brief"
                />
                <el-option
                  label="不写详细日报"
                  value="off"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <div class="bd-form-sec">
              <h3>主人</h3>
              <span>私信和 @ 都挂在 bili CLI 的「主人」上</span>
            </div>
          </el-col>
          <el-col :span="24">
            <div class="bd-owner">
              <div class="bd-owner-line">
                <span class="k">当前主人</span>
                <span
                  v-if="ownerLoading"
                  class="v is-empty"
                >读取中…</span>
                <span
                  v-else-if="ownerInfo"
                  class="v"
                >{{ ownerInfo.name }}<em>UID {{ ownerInfo.mid }}</em></span>
                <span
                  v-else
                  class="v is-empty"
                >{{ ownerError || "还没设置主人" }}</span>
              </div>
              <div class="bd-owner-ops">
                <el-input
                  v-model="ownerInput"
                  size="small"
                  placeholder="UID / 昵称"
                  @keyup.enter="saveOwner"
                />
                <el-button
                  size="small"
                  :loading="ownerSaving"
                  @click="saveOwner"
                >
                  设为主人
                </el-button>
                <el-button
                  size="small"
                  text
                  @click="refreshOwner"
                >
                  重新读取
                </el-button>
              </div>
            </div>
            <p class="bd-form-tip">
              主人写进 bili CLI 自己的配置（<code>bili owner set</code>），当面生效，不随下面的「保存」提交。
              换号登录后要重设一次，否则私信还认上一个人。
            </p>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="投递方式">
              <el-radio-group v-model="form.dmMode">
                <el-radio-button value="only">
                  只私信
                </el-radio-button>
                <el-radio-button value="both">
                  私信 + 评论
                </el-radio-button>
                <el-radio-button value="off">
                  都不发
                </el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="私信发给谁">
              <el-radio-group v-model="form.dmTargetMode">
                <el-radio-button value="owner">
                  主人
                </el-radio-button>
                <el-radio-button value="uid">
                  指定 UID
                </el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.dmTargetMode === 'uid'"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="收件人 UID（只填数字）">
              <el-input
                v-model="form.dmTargetUid"
                placeholder="例如：10000007"
              />
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="允许给陌生人发第一条私信">
              <el-switch v-model="form.dmAllowNew" />
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="自动公开评论">
              <el-switch v-model="form.autoComment" />
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.autoComment"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="@ 谁（留空 = 不 @ 任何人）">
              <el-input
                v-model="form.mentionName"
                placeholder="owner（= 主人），或完整昵称"
              />
              <p class="bd-form-tip">
                @ 后面跟的称呼来自角色资料的「她对你的称呼」，改称呼去那边改。
              </p>
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.autoComment"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="每轮最多几条评论">
              <el-input-number
                v-model="form.commentPerRound"
                :min="0"
                :max="20"
                controls-position="right"
                style="width:100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <div class="bd-form-sec">
              <h3>对外动作</h3>
              <span>会以这个账号的身份写出去，默认全关</span>
            </div>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="收藏阈分（0 = 不收藏）">
              <el-input-number
                v-model="form.favMinScore"
                :min="0"
                :max="20"
                controls-position="right"
                style="width:100%"
              />
              <p class="bd-form-tip">
                分数到这个数才收进收藏夹；每天最多 2 条，理由少于 6 个字不收 ——
                理由太短说明她自己也没想清楚为什么要留着。
              </p>
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="把当天最好的一条发成动态">
              <el-switch v-model="form.autoDynamic" />
              <p class="bd-form-tip">
                所有人可见。每天最多 1 条，两条之间至少隔 30 分钟。
              </p>
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.autoDynamic"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="发动态的最低分">
              <el-input-number
                v-model="form.dynamicMinScore"
                :min="0"
                :max="20"
                controls-position="right"
                style="width:100%"
              />
              <p class="bd-form-tip">
                当天最高分没到这个数就这一天不发。理由里带「主人」「私信」这类话的会被拦下来。
              </p>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <div class="bd-form-sec">
              <h3>主人内容</h3>
              <span>「看到」和「动手」是两件事，可以只开一个</span>
            </div>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="刷B站时优先看主人的投稿">
              <el-switch v-model="form.ownerFirst" />
              <p class="bd-form-tip">
                主人的投稿排在候选最前面，每轮最多强制看 2 条 —— 她会像刷别的视频一样认真看完、
                写理由，挑中了照样私信告诉你。这条只管「看到」，不点赞不评论。
              </p>
            </el-form-item>
          </el-col>
          <el-col
            :xs="24"
            :sm="12"
          >
            <el-form-item label="自动看主人发的并互动">
              <el-switch v-model="form.ownerWatch" />
              <p class="bd-form-tip">
                打开后她才去看主人新发的投稿。只对<strong>打开这个开关之后</strong>主人新发的动手，
                不会回头给几十条历史投稿补三连 —— 那样最容易被判成机器行为，也会把主人的通知栏刷满。
              </p>
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.ownerWatch"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="点赞">
              <el-switch v-model="form.ownerLike" />
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.ownerWatch"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="收藏">
              <el-switch v-model="form.ownerFav" />
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.ownerWatch"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="评论">
              <el-switch v-model="form.ownerComment" />
              <p class="bd-form-tip">
                评论是公开的，主人视频底下别的观众也看得见。正文会先过脱敏闸（去掉 @、长数字和私下关系的词）。
              </p>
            </el-form-item>
          </el-col>
          <el-col
            v-if="form.ownerWatch"
            :xs="24"
            :sm="12"
          >
            <el-form-item label="投币最低分（0 = 不投币）">
              <el-input-number
                v-model="form.ownerCoinMinScore"
                :min="0"
                :max="20"
                controls-position="right"
                style="width:100%"
              />
              <p class="bd-form-tip">
                硬币不可退，而且账号余额可能只有两三个 —— 所以每天最多投 1 个，
                分数到这个数才投。设成 0 就完全不投。
              </p>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <div class="bd-form-sec">
              <h3>刷站口味</h3>
              <span>只作用于这个账号的值班，不会影响聊天和 QQ 渠道</span>
            </div>
          </el-col>
          <el-col :span="24">
            <el-form-item label="关注关键词（每行一个，可留空；留空则只看热榜和推荐流）">
              <el-input
                v-model="form.keywordsText"
                type="textarea"
                :rows="3"
                placeholder="例如：DeepSeek&#10;AI 绘画"
              />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="刷站口味（自由发挥，可留空）">
              <el-input
                v-model="form.taste"
                type="textarea"
                :autosize="{ minRows: 5, maxRows: 12 }"
                :maxlength="TASTE_MAX"
                show-word-limit
                placeholder="写清「爱看什么 / 一律跳过什么 / 跳过理由怎么写」。例如：&#10;- 只看米哈游相关：原神、星穹铁道、绝区零&#10;- 标题或标签里有「争议 / 退坑 / 互撕 / 剧透」，标题就判，不点进去&#10;- 跳过理由统一写两个字：负面。"
              />
              <p class="bd-form-tip">
                人设（她是谁、什么性格）在角色设置里，聊天 / QQ / B站 三端共用一份；
                这里只写「在这台 B站 账号上怎么刷」。命中的规则在粗筛阶段就会生效，不用白看一遍视频。
              </p>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <el-alert
        v-if="writeWarning"
        type="warning"
        :closable="false"
        show-icon
        :title="writeWarning"
      />
    </div>
    <template #footer>
      <el-button
        :loading="resetting"
        @click="resetQuota"
      >
        重置今日额度
      </el-button>
      <el-button @click="close">
        取消
      </el-button>
      <el-button
        type="primary"
        :loading="saving"
        @click="saveDuty"
      >
        保存
      </el-button>
    </template>
  </el-dialog>
</template>
