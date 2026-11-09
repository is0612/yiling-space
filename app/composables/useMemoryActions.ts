import { ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { ensureMemoryProgressPolling, refreshMemoryProgress } from "~/composables/useMemoryProgress";

/**
 * 记忆系统的两个手动动作：「整理忆泡」和「阶段总结」。
 *
 * 这两个动作原本各写一遍在 MemoryWorkspace / DaysWorkspace / SnapshotsWorkspace 里，
 * 确认文案、结果分支、错误兜底逐字重复。成长模式把入口统一收到总览页之后，
 * 总览只负责「对哪个角色、点了哪个按钮」，执行细节都在这里。
 *
 * 动作名和按钮文案对齐：按钮叫「阶段总结」，代码里也叫 snapshot，不再用 archive
 * —— 服务端任务确实叫自动归档，但用户在页面上看到的是「阶段总结」，别让两套词互相打架。
 *
 * 两个动作都是「排队 + 当场跑一会儿」：服务端等一小会儿就把响应放回来，执行留在后台，
 * 进度由右下角的 MemoryProgressPanel 从数据库读。所以这里暴露的 loading 只代表
 * 「这次请求还在等」，不代表任务已经结束 —— 页面不要用它判断任务是不是跑完了。
 */

/** `snapshots/generate` 的返回。`processing` = 已转后台，进度看面板。 */
type GenerateResult = {
  queued: string[];
  skipped: string[];
  processed: Array<{ status: string; message: string }>;
  pending: number;
  advancedTo: string | null;
  processing?: boolean;
};

/** `memory-events/extract` 的返回。`notice` 解释「一条都没排」的真实原因。 */
type ExtractResult = {
  queued: string[];
  processed: Array<{ status: string; message: string }>;
  notice?: "queued" | "running" | "no-new-messages";
  processing?: boolean;
};

/** 服务端把原因放在 statusMessage 里，拿不到才退回通用文案。 */
function statusMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function useMemoryActions(
  resolveCharacterId: () => string,
  resolveCharacterName: () => string = () => "",
) {
  const snapshotGenerating = ref(false);
  const eventExtracting = ref(false);

  /**
   * 生成一次阶段总结：手动触发「自动归档」跑一次。
   *
   * 走的是和自动归档同一套队列与幂等键，不会另造一份总结，只是把「现在」当成周期边界。
   * 会产生模型调用费用，所以保留二次确认。
   *
   * @returns 是否真的发起了请求（取消、没选角色、失败都为 false）
   */
  async function runSnapshotGeneration(): Promise<boolean> {
    const id = resolveCharacterId();
    if (!id || snapshotGenerating.value) return false;
    const name = resolveCharacterName();
    try {
      await ElMessageBox.confirm(
        `现在${name ? `为「${name}」` : ""}生成一份阶段总结：调模型提炼最近一个周期的对话，并按结果新增 / 更新长期记忆。会产生模型调用费用。`,
        "阶段总结",
        { confirmButtonText: "开始生成", cancelButtonText: "取消", type: "warning" },
      );
    } catch {
      return false;
    }

    snapshotGenerating.value = true;
    // 排队之后面板才看得见任务；提前起轮询，免得几十秒里右下角一片安静。
    ensureMemoryProgressPolling();
    try {
      const result = await $fetch<GenerateResult>(
        `/api/characters/${encodeURIComponent(id)}/snapshots/generate`,
        { method: "POST" },
      );
      void refreshMemoryProgress();

      const failed = result.processed.find((item) => item.status === "FAILED" || item.status === "RETRY_WAIT");
      const ok = result.processed.filter((item) => item.status === "SUCCEEDED");
      if (result.processing) {
        ElMessage.info("已开始生成阶段总结，进度在右下角；切页面、刷新都不会中断。");
      } else if (failed) {
        // 失败时周期边界不会推进，这段数据下次还能补上：要说「去重试」而不是「重来」。
        ElMessage.warning(`${failed.message}（这次没有推进周期，去「后台任务」点重试即可）`);
      } else if (result.pending > 0) {
        ElMessage.warning(`还有 ${result.pending} 个阶段总结任务在队列里没跑完，去「后台任务」看一下。`);
      } else if (ok.length) {
        ElMessage.success(ok.map((item) => item.message).join("；"));
      } else if (result.skipped.length) {
        ElMessage.info(result.skipped.join("；"));
      } else {
        ElMessage.info("任务已排队，但没有可执行的 worker；启动 worker 后会继续处理。");
      }
      return true;
    } catch (error) {
      ElMessage.error(statusMessage(error, "生成阶段总结失败，请检查模型配置与数据库连接。"));
      return false;
    } finally {
      snapshotGenerating.value = false;
    }
  }

  /**
   * 立即整理忆泡：昨天收口 + 今天增量。
   *
   * 不弹确认 —— 它不像阶段总结那样会新增一份总结，重复点也只是复用同一个幂等键。
   */
  async function runEventExtraction(): Promise<boolean> {
    const id = resolveCharacterId();
    if (!id || eventExtracting.value) return false;

    eventExtracting.value = true;
    ensureMemoryProgressPolling();
    try {
      const result = await $fetch<ExtractResult>(
        `/api/characters/${encodeURIComponent(id)}/memory-events/extract`,
        { method: "POST" },
      );
      void refreshMemoryProgress();

      const failed = result.processed.find((item) => item.status !== "SUCCEEDED" && item.status !== "SKIPPED");
      if (result.processing) {
        // 响应先回来了、执行还在后台跑：不要说成「没有 worker」，那是另一回事。
        ElMessage.info(`已开始整理 ${result.queued.length} 段，进度在右下角；切页面、刷新都不会中断。`);
      } else if (result.queued.length === 0) {
        ElMessage.info(result.notice === "running"
          ? "上一次整理正在跑，等它结束再点一次。"
          : "昨天和今天没有可整理的新对话：已经整理过的不会重复跑一遍。");
      } else if (failed) {
        ElMessage.warning(failed.message);
      } else if (result.processed.length === 0) {
        ElMessage.info("已排队，但当前没有可执行的 worker；启动 worker 后会继续处理。");
      } else {
        ElMessage.success(result.processed.map((item) => item.message).join("；"));
      }
      return true;
    } catch (error) {
      ElMessage.error(statusMessage(error, "整理忆泡失败，请检查本地开发服务器日志。"));
      return false;
    } finally {
      eventExtracting.value = false;
    }
  }

  return { snapshotGenerating, eventExtracting, runSnapshotGeneration, runEventExtraction };
}
