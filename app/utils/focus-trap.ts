/**
 * 弹窗焦点管理的纯函数。
 *
 * 单独抽出来是为了能测：本项目没有浏览器自动化，DOM 只能靠替身驱动，
 * 所以这里只做「给定容器 + 当前焦点 → 下一个该聚焦谁」的计算，
 * 由组件负责真正调用 focus()。全部函数不读写全局状态，方便单测。
 */

/** 可聚焦元素的 CSS 选择器；排除 disabled 与 tabindex="-1"。 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

/** 只依赖渲染后才有的布局信息判断是否可见；替身没有布局信息时按可见处理。 */
export function isFocusVisible(node: { getClientRects?: () => ArrayLike<unknown> }): boolean {
  const rects = node.getClientRects?.();
  return rects === undefined ? true : rects.length > 0;
}

/** 容器内可聚焦且可见的元素，按 DOM 顺序返回（即自然 Tab 顺序）。 */
export function focusableElements<T = HTMLElement>(root: { querySelectorAll: (selector: string) => ArrayLike<T> } | null): T[] {
  if (!root) return [];
  const nodes = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR) as ArrayLike<T>);
  return nodes.filter(node => isFocusVisible(node as { getClientRects?: () => ArrayLike<unknown> }));
}

export type TabFocusDecision =
  /** 交给浏览器默认行为（焦点在弹窗内且不是边界）。 */
  | { kind: "native" }
  /** 焦点必须移动到指定元素。 */
  | { kind: "move"; target: HTMLElement };

/**
 * 计算 Tab / Shift+Tab 的落点。
 *
 * - 没有可聚焦元素：焦点收到弹窗容器本身，避免 Tab 跑出弹窗；
 * - 焦点已经在弹窗外面（例如用户点了浏览器地址栏）：拉回第一个/最后一个；
 * - 走到最后一个（Tab）或第一个（Shift+Tab）：绕回另一端。
 */
export function resolveTabFocus(root: HTMLElement | null, active: Element | null, shiftKey: boolean): TabFocusDecision {
  if (!root) return { kind: "native" };
  const nodes = focusableElements<HTMLElement>(root);
  if (!nodes.length) return { kind: "move", target: root };

  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;

  if (!active || !root.contains(active)) return { kind: "move", target: shiftKey ? last : first };
  if (!shiftKey && active === last) return { kind: "move", target: first };
  if (shiftKey && active === first) return { kind: "move", target: last };
  return { kind: "native" };
}
