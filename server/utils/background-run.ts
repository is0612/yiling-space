/**
 * 在请求里等一小会儿，等不到就把执行留在后台。
 *
 * 记忆类任务（忆泡整理、阶段总结）一次要几十秒到几分钟，全靠模型。把整个执行
 * 绑在 HTTP 请求上有两个问题：页面只能干转圈；切走/刷新时响应没人接，用户就以为
 * 任务被中断了 —— 而实际上任务行还在库里，进度应该照常可查。
 *
 * 这里给一个很短的等待窗口：
 * - 跑得快（没对话、直接跳过、缓存命中）→ 照旧把结果带回响应，页面行为和以前一样；
 * - 超过窗口 → 立刻回 `processing: true`，执行继续在后台跑，前端靠轮询看进度。
 *
 * 注意：后台执行必须自己吞掉异常。响应已经发出去了，未捕获的 Promise 拒绝会变成
 * 进程级错误（Node 默认直接退出）。调用方负责在超时分支上 `void work.catch(...)`。
 */
export type BriefWaitResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: false; failed: true; error: unknown }
  | { timedOut: true };

export function waitBriefly<T>(work: Promise<T>, timeoutMs: number): Promise<BriefWaitResult<T>> {
  const settled = work.then(
    (value): BriefWaitResult<T> => ({ timedOut: false, value }),
    (error): BriefWaitResult<T> => ({ timedOut: false, failed: true, error }),
  );
  return new Promise<BriefWaitResult<T>>((resolve) => {
    let done = false;
    const finish = (result: BriefWaitResult<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    // 只是显示用的等待窗口，别让它拖住进程退出（脚本化测试里尤其明显）。
    (timer as unknown as { unref?: () => void }).unref?.();
    void settled.then(finish);
  });
}

/** 手动触发时愿意在请求里等多久；超过就交给后台。 */
export const INLINE_MEMORY_WORK_MS = 3_500;
