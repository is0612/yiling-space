<script setup lang="ts">
/**
 * 角色资料的五个字段：名称 / 简介 / 对你的称呼 / 基础人设 / 对话示例。
 * 「编辑角色资料」和「创建角色」两个弹窗共用这一份，别各写一套 —— 版式一改就得改两处。
 *
 * 版式（沿用早期原型稿的方案 A）：
 *   ① 身份条     —— 名称 + 简介 + 称呼并排装进一张 --surface-2 浅色卡，和下面的长文分开
 *   ② 主次两栏   —— 人设 1.25 列（唯一主体）、对话示例 1 列，并排而不是竖着堆
 *   ③ 说明一行 + 字数上列头 —— 说明是三级信息，不该和正文抢；计数原来贴在框内右下角，
 *      既压住最后一行、又逼着全局补 26px 的 padding-bottom
 *
 * ⚠️ 编辑框是**固定高度 + 框内自滚**，不是跟着内容长高。
 *   之前那版反过来（autosize，整表滚），是因为双滚动条会并排挤在弹窗右边缘、像套了双层边框。
 *   两栏之后这两条滚动条相距 380px、各自长在一个框上，读起来是「这个框还有内容」，
 *   不再是噪音；于是换回固定高度 —— 弹窗本体不用滚，一屏能看全五个字段。
 *   改回 autosize 前先想清楚这点，别只看「有没有滚动条」。
 */
const name = defineModel<string>("name", { required: true });
const description = defineModel<string>("description", { required: true });
const userAddress = defineModel<string>("userAddress", { required: true });
const personality = defineModel<string>("personality", { required: true });
const examples = defineModel<string>("examples", { required: true });

/**
 * 窄窗口下两栏会退回竖排，固定高度的框 + 还在滚的弹窗会并排出现两条灰条 ——
 * 正是这个版式当初要解决的问题。所以窄屏时把高度还给内容（autosize），
 * 只留弹窗一个滚动容器；宽屏才用固定高度 + 框内滚。
 */
const isNarrow = ref(false);
let narrowQuery: MediaQueryList | undefined;
const syncNarrow = () => {
  isNarrow.value = narrowQuery?.matches ?? false;
};
onMounted(() => {
  narrowQuery = window.matchMedia("(max-width: 1040px)");
  syncNarrow();
  narrowQuery.addEventListener("change", syncNarrow);
});
onBeforeUnmount(() => {
  narrowQuery?.removeEventListener("change", syncNarrow);
});
</script>

<template>
  <div class="cp-fields">
    <div class="cp-idcard">
      <el-form-item
        label="角色名称"
        required
      >
        <el-input
          v-model="name"
          maxlength="40"
          placeholder="给这个角色起个名字"
        />
      </el-form-item>
      <el-form-item label="角色简介">
        <el-input
          v-model="description"
          maxlength="2000"
          placeholder="用一句话描述角色的个性或定位。"
        />
      </el-form-item>
      <el-form-item label="她对你的称呼">
        <el-input
          v-model="userAddress"
          maxlength="40"
          clearable
          placeholder="主人 / 老板 / 你的名字"
        />
      </el-form-item>
    </div>

    <div class="cp-cols">
      <el-form-item>
        <template #label>
          <span class="cp-head">
            <span class="cp-head-name">基础人设</span>
            <span class="cp-count">{{ personality.length }} / 12000</span>
          </span>
        </template>
        <el-input
          v-model="personality"
          type="textarea"
          :autosize="isNarrow ? { minRows: 8 } : false"
          maxlength="12000"
          placeholder="角色的性格、说话方式、行为规则……&#10;&#10;写成「你是谁 + 怎么说话 + 什么不做」最省事，具体例子比形容词管用。"
        />
        <p class="cp-tip">
          三端共用这一份。B站 刷站口味（爱看什么、一律跳过什么）请去值班设置，别写在这里。
        </p>
      </el-form-item>

      <el-form-item>
        <template #label>
          <span class="cp-head">
            <span class="cp-head-name is-sub">对话示例</span>
            <span class="cp-count">{{ examples.length }} / 8000</span>
          </span>
        </template>
        <el-input
          v-model="examples"
          type="textarea"
          :autosize="isNarrow ? { minRows: 8 } : false"
          maxlength="8000"
          placeholder="写几组「用户：…／她：…」，让她学语气和用词，例如：&#10;&#10;用户：今天好累啊&#10;她：欸，你怎么又累了？本鱼都还没开始努力呢。"
        />
        <p class="cp-tip">
          只影响回复语气，B站 值班判断不读这段。别把没设定过的事写进去，她会当真。
        </p>
      </el-form-item>
    </div>
  </div>
</template>

<style scoped>
/* ── 身份条：两个短字段并排装进浅色卡，和下面的长文分开（组间 > 组内） ── */
.cp-idcard {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) 176px;
  gap: 0 20px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--surface-2);
}
.cp-idcard :deep(.el-form-item) {
  margin-bottom: 0;
}
/* 必填星号让它挂在标签左边外面：不占布局，标签文字才能和输入框、和下面的「基础人设」对齐 */
.cp-idcard :deep(.el-form-item__label) {
  position: relative;
}
.cp-idcard :deep(.el-form-item.is-required .el-form-item__label)::before {
  position: absolute;
  left: -10px;
  margin-right: 0;
}

/* ── 主次两栏：人设 1.25 列，示例 1 列。等宽会让本来就长的那段更高，反而更矮不了 ── */
.cp-cols {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 0 28px;
  margin-top: 28px;
}
.cp-cols :deep(.el-form-item) {
  margin-bottom: 0;
}
/* 自定义 label 槽里是 space-between 的一行 —— 标签元素本身必须撑满整列，
   否则它只有文字那么宽，右侧的字数会挤在名字旁边而不是贴到列尾 */
.cp-cols :deep(.el-form-item__label) {
  display: flex;
  width: 100%;
  margin-bottom: 8px;
}
/* grid 子项默认 min-width:auto，长文本会把列撑破 */
.cp-cols :deep(.el-form-item__content),
.cp-idcard :deep(.el-form-item__content) {
  min-width: 0;
}

/* ── 列头：名字在左、字数在右，靠一条 12px 的基线对齐 ── */
.cp-head {
  display: flex;
  gap: 12px;
  align-items: baseline;
  justify-content: space-between;
  width: 100%;
}
.cp-head-name {
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .04em;
}
/* 示例是次级：靠字色降一档，不靠字号（字号最小只能到 12） */
.cp-head-name.is-sub {
  color: var(--dim);
}
.cp-count {
  color: var(--faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* ── 编辑框：固定高度、框内自滚。24px 行高 = 14 × 1.714，正好落在 24px 基线网格上 ──
   ⚠️ 高度必须满足「H − 上内边距」是 24 的整数倍（这里 612 − 12 = 25 × 24）。
   textarea 的溢出是裁在 padding box 上的，底部留的 12px 也会被下一行文字画进去 ——
   取 600 时刚好露半行字，看着像渲染坏了；612 才裁在行边界上。 */
.cp-cols :deep(.el-textarea__inner) {
  height: 612px;
  padding: 12px 14px;
  caret-color: var(--brand);
  font-size: 14px;
  line-height: 24px;
  resize: none;
}
/* 矮屏先压框高，别让弹窗自己滚（84vh 兜不住 612px 的框）。
   每一档都满足「H − 12 ≡ 0 (mod 24)」，也满足「H + 312 ≤ 84vh」——
   312 是弹窗外壳（头 60 + 上下留白 28 + 身份条 70 + 列头 26 + 说明 36 + 页脚 64）的实测高度。
   改这里的高度记得两个条件一起验，只改一个就会漏出第二条滚动条。 */
@media (max-height: 1100px) {
  .cp-cols :deep(.el-textarea__inner) { height: 516px; }
}
@media (max-height: 1000px) {
  .cp-cols :deep(.el-textarea__inner) { height: 420px; }
}
@media (max-height: 880px) {
  .cp-cols :deep(.el-textarea__inner) { height: 324px; }
}
@media (max-height: 760px) {
  .cp-cols :deep(.el-textarea__inner) { height: 228px; }
}

/* 12px 是硬下限（别再小）；说明文字用 --dim，--faint 只够给图标和分隔符 */
.cp-tip {
  margin: 8px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}

/* 窄窗口（弹窗跟着 96vw 缩）一列塞不下两个框，退回竖排 */
@media (max-width: 1040px) {
  .cp-idcard,
  .cp-cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .cp-idcard :deep(.el-form-item) {
    margin-bottom: 14px;
  }
  .cp-idcard :deep(.el-form-item:last-child) {
    margin-bottom: 0;
  }
  .cp-cols {
    gap: 24px 0;
  }
  /* 高度这一档不用写：窄屏时 autosize 已经接管（Element 会把高度写成行内样式，
     行内压过样式表），框跟内容长高，只剩弹窗一条滚动条 */
}
</style>
