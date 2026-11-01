/**
 * B站 (bili-cli) 命令目录 —— 从 bili-desk 的 `backend/app/catalog.py` 迁移而来。
 *
 * 一条 = 一次 `bili` 调用；params 决定前端表单长什么样：
 *   pos=true      → 位置参数（直接跟值）
 *   flag='--x'    → 选项（值跟在 flag 后面）
 *   type='bool'   → 勾选框（勾上才出现 flag）
 *   type='select' → 下拉
 *   write=true    → 默认带 --dry-run，要真发得手动取消。
 */

export type BiliCatalogParam = {
  key: string;
  label: string;
  pos?: boolean;
  flag?: string;
  type?: "text" | "int" | "bool" | "select";
  default?: string;
  choices?: string[];
  ph?: string;
};

export type BiliCatalogItem = {
  id: string;
  label: string;
  argv: string[];
  write?: boolean;
  kind?: "duty" | "dynamic" | "seen" | "journal" | "selfcheck";
  params?: BiliCatalogParam[];
  /**
   * 常用命令。侧栏默认只显示带这个标记的，其余收进「菜单管理」里手动打开。
   * 46 条命令全铺在侧栏上，常用的那 6 条要往下翻才找得到。
   */
  common?: boolean;
};

export type BiliCatalogGroup = {
  group: string;
  items: BiliCatalogItem[];
};

export const BILI_ZONES = [
  "all", "anime", "music", "dance", "game", "knowledge", "tech", "sports",
  "car", "life", "food", "animal", "kichiku", "fashion", "ent", "film",
  "original", "rookie",
];

function p(
  key: string,
  label: string,
  opts: Partial<BiliCatalogParam> = {},
): BiliCatalogParam {
  return { key, label, ...opts };
}

const VIDEO = p("video_id", "BV号 / 链接", { pos: true, ph: "BV181Hh6bE27" });

export const BILI_CATALOG: BiliCatalogGroup[] = [
  {
    group: "刷B站",
    items: [
      { id: "duty.settings", common: true, label: "值班设置", argv: [], kind: "duty" },
      { id: "duty.dynamic", common: true, label: "发动态", argv: [], kind: "dynamic" },
      { id: "duty.seen", common: true, label: "她看过什么", argv: [], kind: "seen" },
      { id: "duty.journal", common: true, label: "她的札记", argv: [], kind: "journal" },
    ],
  },
  {
    group: "账号",
    items: [
      { id: "auth.status", common: true, label: "登录状态", argv: ["auth", "status"] },
      { id: "me.show", label: "我的资料", argv: ["me", "show"] },
      { id: "me.stats", label: "创作数据", argv: ["me", "stats"] },
      { id: "owner.show", label: "当前主人", argv: ["owner", "show"] },
      { id: "owner.set", label: "设置主人", argv: ["owner", "set"], params: [p("uid", "UID / 昵称", { pos: true, ph: "12345678" })] },
      { id: "me.favs", label: "我的收藏夹", argv: ["me", "favs"] },
    ],
  },
  {
    group: "收件箱",
    items: [
      { id: "feed.inbox", common: true, label: "全部新消息", argv: ["feed", "inbox"] },
      { id: "feed.replies", label: "回复我的", argv: ["feed", "replies"] },
      { id: "feed.mentions", label: "@ 我的", argv: ["feed", "mentions"] },
      { id: "feed.likes", label: "收到的赞", argv: ["feed", "likes"] },
      { id: "feed.notifications", label: "未读数", argv: ["feed", "notifications"] },
    ],
  },
  {
    group: "发现",
    items: [
      { id: "feed.recommend", common: true, label: "首页推荐", argv: ["feed", "recommend"], params: [p("n", "条数", { flag: "-n", type: "int", default: "6" })] },
      { id: "hot.popular", common: true, label: "综合热门", argv: ["hot", "popular"], params: [p("n", "条数", { flag: "-n", type: "int", default: "10" })] },
      { id: "hot.rank", common: true, label: "分区排行", argv: ["hot", "rank"], params: [p("zone", "分区", { flag: "--zone", type: "select", default: "tech", choices: BILI_ZONES }), p("limit", "条数", { flag: "--limit", type: "int", default: "20" }), p("unseen", "只看没看过的", { flag: "--unseen", type: "bool" })] },
      { id: "hot.search", label: "热搜", argv: ["hot", "search"] },
      { id: "hot.weekly", label: "每周必看", argv: ["hot", "weekly"] },
      { id: "search.video", common: true, label: "搜视频", argv: ["search", "video"], params: [p("keyword", "关键词", { pos: true, ph: "DeepSeek" }), p("order", "排序", { flag: "--order", type: "select", default: "views", choices: ["default", "views", "new", "danmaku", "favorites", "comments"] }), p("size", "每页", { flag: "--size", type: "int", default: "20" })] },
      { id: "search.user", label: "搜用户", argv: ["search", "user"], params: [p("keyword", "关键词", { pos: true, ph: "老番茄" })] },
    ],
  },
  {
    group: "视频",
    items: [
      { id: "video.watch", common: true, label: "看懂视频", argv: ["video", "watch"], params: [{ ...VIDEO }, p("maxchars", "正文截断", { flag: "--max-chars", type: "int", default: "2000" })] },
      { id: "video.info", common: true, label: "视频信息", argv: ["video", "info"], params: [{ ...VIDEO }] },
      { id: "video.subtitle", label: "字幕全文", argv: ["video", "subtitle"], params: [{ ...VIDEO }, p("text", "纯文本输出", { flag: "--text", type: "bool" })] },
      { id: "video.summary", common: true, label: "AI 总结", argv: ["video", "summary"], params: [{ ...VIDEO }] },
      { id: "video.stats", label: "单稿数据", argv: ["video", "stats"], params: [{ ...VIDEO }] },
      { id: "video.frames", label: "抽帧总览", argv: ["video", "frames"], params: [{ ...VIDEO }, p("quality", "画质", { flag: "-q", type: "select", default: "preview", choices: ["preview", "hd"] }), p("count", "帧数", { flag: "-n", type: "int", default: "9" })] },
      { id: "video.relation", label: "我与视频", argv: ["video", "relation"], params: [{ ...VIDEO }] },
      { id: "video.like", label: "点赞", argv: ["video", "like"], write: true, params: [{ ...VIDEO }] },
      { id: "video.fav", label: "收藏", argv: ["video", "fav"], write: true, params: [{ ...VIDEO }] },
      { id: "video.coin", label: "投币", argv: ["video", "coin"], write: true, params: [{ ...VIDEO }, p("coins", "币数", { flag: "--coins", type: "select", default: "1", choices: ["1", "2"] })] },
      { id: "video.triple", label: "一键三连", argv: ["video", "triple"], write: true, params: [{ ...VIDEO }] },
    ],
  },
  {
    group: "互动",
    items: [
      { id: "comment.list", common: true, label: "看评论", argv: ["comment", "list"], params: [p("target", "BV号 / 链接", { pos: true, ph: "BV181Hh6bE27" }), p("sort", "排序", { flag: "--sort", type: "select", default: "hot", choices: ["hot", "time"] }), p("unreplied", "只看没回的", { flag: "--unreplied", type: "bool" })] },
      { id: "comment.post", common: true, label: "发评论", argv: ["comment", "post"], write: true, params: [p("target", "BV号 / 链接", { pos: true }), p("text", "正文", { pos: true, ph: "谢谢！教程下周更新～" })] },
      { id: "dm.list", common: true, label: "私信列表", argv: ["dm", "list"], params: [p("unread", "只看未读", { flag: "--unread", type: "bool" })] },
      { id: "dm.send", common: true, label: "发私信", argv: ["dm", "send"], write: true, params: [p("uid", "UID / owner", { pos: true, ph: "owner" }), p("text", "正文", { pos: true })] },
    ],
  },
  {
    group: "动态",
    items: [
      { id: "dynamic.list", label: "动态列表", argv: ["dynamic", "list"] },
      { id: "dynamic.post", common: true, label: "发动态", argv: ["dynamic", "post"], write: true, params: [p("text", "正文", { pos: true })] },
    ],
  },
  {
    group: "数据",
    items: [
      { id: "user.info", label: "UP 资料", argv: ["user", "info"], params: [p("uid", "UID / 昵称", { pos: true })] },
      { id: "user.videos", label: "UP 投稿", argv: ["user", "videos"], params: [p("uid", "UID / 昵称", { pos: true }), p("order", "排序", { flag: "--order", type: "select", default: "views", choices: ["views", "favorites", "new"] })] },
    ],
  },
  {
    group: "系统",
    items: [
      { id: "selfcheck", label: "升级自检", argv: [], kind: "selfcheck" },
      { id: "schema", label: "全量命令表", argv: ["schema"] },
      { id: "skills.status", label: "技能安装状态", argv: ["skills", "status"] },
      { id: "asr.status", label: "语音转写状态", argv: ["asr", "status"] },
    ],
  },
];

export function findBiliCatalogItem(itemId: string): BiliCatalogItem | null {
  for (const group of BILI_CATALOG) {
    for (const item of group.items) {
      if (item.id === itemId) return item;
    }
  }
  return null;
}

/** 侧栏默认收起的命令 id。前端首次加载 / 点「恢复默认」时用它。 */
export function defaultHiddenBiliItemIds(): string[] {
  return BILI_CATALOG.flatMap((group) => group.items.filter((item) => !item.common).map((item) => item.id));
}
