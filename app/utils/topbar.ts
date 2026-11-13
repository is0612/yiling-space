/**
 * 顶栏标题。
 *
 * 页面用 `definePageMeta({ topbar: {...} })` 声明，AppShell 从 route.meta 读出来渲染到顶栏左侧。
 * 顶栏只有 56px，只放 h1 一行（有 crumbs 时是「上级 / 当前页」一行）；
 * 页面说明留在正文页头（PageHeader 的 description），别往这里塞。
 *
 * 二级页用 crumbs 声明上级入口：顶栏是常驻的，滚到页面底部也能一键跳回列表，
 * 而正文里的返回链接会跟着内容滚走。
 *
 * 不走 Teleport：SSR 阶段 teleport 内容会被塞到 body 末尾，首屏会先闪到错误位置；
 * 也不走 useState：父组件的顶栏比子页面的 setup 先渲染，服务端首屏会读到空值。
 * route.meta 是路由解析期就定好的，服务端渲染出来就在正确位置，客户端切页也天然同步。
 */
export type TopbarCrumb = {
  label: string;
  /** 带上 to 才是可点的；当前页那一段由 title 承担，不再重复出现在 crumbs 里 */
  to?: string;
};

export type TopbarHeading = {
  title: string;
  /** 前置层级，如「角色管理 / 记忆周期设置」里的「角色管理」。从深页往回走的唯一常驻入口 */
  crumbs?: TopbarCrumb[];
  /** 页面有需要手动拉取的数据时，顶栏右侧给一个刷新按钮（内部调 refreshNuxtData） */
  refreshable?: boolean;
};

/** route.meta 是 Record<string, unknown>，这里收窄一次，避免每个调用点各写一遍断言。 */
export function readTopbarHeading(meta: Record<string, unknown>): TopbarHeading | null {
  const value = meta.topbar;
  if (!value || typeof value !== "object") return null;
  const { title, crumbs, refreshable } = value as Partial<TopbarHeading>;
  if (typeof title !== "string" || !title) return null;
  return {
    title,
    crumbs: readCrumbs(crumbs),
    refreshable: refreshable === true,
  };
}

/** 面包屑来自页面声明，脏数据（缺 label / to 不是字符串）直接丢掉，别把顶栏渲染成半截 */
function readCrumbs(value: unknown): TopbarCrumb[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const crumbs = value.flatMap((item): TopbarCrumb[] => {
    if (!item || typeof item !== "object") return [];
    const { label, to } = item as Partial<TopbarCrumb>;
    if (typeof label !== "string" || !label) return [];
    return [{ label, to: typeof to === "string" && to ? to : undefined }];
  });
  return crumbs.length ? crumbs : undefined;
}
