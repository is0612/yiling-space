/**
 * 将只处理了部分媒体的结果，放回原始媒体数组的位置。
 *
 * targetIndexes 与 results 一一对应，但 targetIndexes 可以跳过没有 URL 的媒体。
 * 未参与识别或识别失败的原始位置统一返回 null，由调用方生成明确的失败占位符。
 */
export function alignMediaResults<T>(
  sourceLength: number,
  targetIndexes: readonly number[],
  results: readonly (T | null | undefined)[],
  unselectedValue: T | null | undefined = null,
): Array<T | null | undefined> {
  const aligned = Array.from(
    { length: Math.max(0, Math.trunc(sourceLength)) },
    () => unselectedValue,
  );

  for (let resultIndex = 0; resultIndex < targetIndexes.length; resultIndex += 1) {
    const sourceIndex = targetIndexes[resultIndex];
    if (sourceIndex === undefined || !Number.isInteger(sourceIndex)
      || sourceIndex < 0 || sourceIndex >= aligned.length) {
      continue;
    }
    aligned[sourceIndex] = results[resultIndex] ?? null;
  }

  return aligned;
}
