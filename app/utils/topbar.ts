/**
 * 顶栏标题。
 *
 * 页面用 `definePageMeta({ topbar: {...} })` 声明，AppShell 从 route.meta 读出来渲染到顶栏左侧。
 * 顶栏只有 56px，只放 h1 一行；页面说明留在正文页头（PageHeader 的 description），别往这里塞。
 *
 * 不走 Teleport：SSR 阶段 teleport 内容会被塞到 body 末尾，首屏会先闪到错误位置；
 * 也不走 useState：父组件的顶栏比子页面的 setup 先渲染，服务端首屏会读到空值。
 * route.meta 是路由解析期就定好的，服务端渲染出来就在正确位置，客户端切页也天然同步。
 */
export type TopbarHeading = {
  title: string;
  /** 页面有需要手动拉取的数据时，顶栏右侧给一个刷新按钮（内部调 refreshNuxtData） */
  refreshable?: boolean;
};

/** route.meta 是 Record<string, unknown>，这里收窄一次，避免每个调用点各写一遍断言。 */
export function readTopbarHeading(meta: Record<string, unknown>): TopbarHeading | null {
  const value = meta.topbar;
  if (!value || typeof value !== "object") return null;
  const { title, refreshable } = value as Partial<TopbarHeading>;
  if (typeof title !== "string" || !title) return null;
  return {
    title,
    refreshable: refreshable === true,
  };
}
