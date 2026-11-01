/**
 * 群聊里的「去刷一轮 B站」指令识别。
 *
 * 只做文本判定，不碰 B站 流程：真正的执行仍走 `bili/duty-pipeline.ts` 的
 * `runDutyRound`，额度、模型、bili CLI 都与值班台手动跑一轮完全一致。
 */

export function isBiliRunCommand(content: string): boolean {
  // @QQ号 不算内容；统一小写后同时认 B站 / bilibili。
  const text = content.replace(/@\d+/gu, "").replace(/\s+/g, "").toLowerCase();
  if (!text) return false;
  // 「别刷B站」「不要跑B站」不是指令。
  if (/(别|不要|不用|停止|取消).{0,3}(刷|跑|逛|看)/u.test(text)) return false;
  return /(刷|跑|逛|看)(?:一|1)?(?:轮|圈|下)?(?:b站|bilibili)|(?:b站|bilibili)(?:刷|跑|逛|看)(?:一|1)?(?:轮|圈|下)?/u.test(text);
}
