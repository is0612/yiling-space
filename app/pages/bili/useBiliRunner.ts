import { computed, inject, provide, reactive, ref, watch, type InjectionKey, type Ref } from "vue";
import { ElMessage } from "element-plus";
import type { BiliCatalogItem, BiliRunResult, RunLogEntry } from "./types";
import { readErrorMessage } from "./utils";

/**
 * 命令执行 —— 参数表单、argv 拼装、执行、结果、本次启动的运行记录。
 *
 * 切命令时清空上一组参数（含 dryRun 和上一次结果）这件事也在这里做：
 * 之前散在页面的 openCommand 里，拆分时最容易丢的就是这种「顺手重置」。
 * 现在挂在 `watch(activeCmd)` 上，谁打开命令谁就自动拿到一份干净表单。
 *
 * ⚠️ activeCmd 走参数而不是 inject（同 setup 里 provide 的东西 inject 不到），
 * 页面把 desk.activeCmd 传进来，两边看的是同一个 ref。
 */
export type BiliRunnerDeps = { activeCmd: Ref<BiliCatalogItem | null> };

export type BiliRunner = ReturnType<typeof createRunner>;

const RUN_KEY: InjectionKey<BiliRunner> = Symbol("bili-runner");

/** 升级自检：工作台没有 bili-desk 的自检面板，用背后真正跑的三条命令代替。 */
const SELF_CHECK = [
  { itemId: "schema", label: "全量命令表", desc: "确认 CLI 认识哪些子命令", argv: ["schema"] },
  { itemId: "skills.status", label: "技能安装状态", desc: "装没装、缺哪个技能", argv: ["skills", "status"] },
  { itemId: "asr.status", label: "语音转写状态", desc: "字幕/转写能不能用", argv: ["asr", "status"] },
];

function createRunner(deps: BiliRunnerDeps) {
  const { activeCmd } = deps;

  /**
   * 一个记录装所有参数值：文本是 string、数字框是 number、开关是 boolean。
   * 用 `any` 是没办法的事 —— 同一个键在不同命令里类型不同，
   * 收窄成 union 后 el-input 的 v-model 会因为 boolean 报 TS2322。
   */
  const values = reactive<Record<string, any>>({});
  const dryRun = ref(true);
  const busy = ref(false);
  const lastResult = ref<BiliRunResult | null>(null);
  const lastLabel = ref("");
  const runLog = ref<RunLogEntry[]>([]);

  // 切命令 = 换一张表单。不清的话上一条命令的 BV 号会留在下一条的输入框里。
  watch(
    activeCmd,
    (item) => {
      lastResult.value = null;
      for (const key of Object.keys(values)) delete values[key];
      for (const p of item?.params ?? []) {
        values[p.key] = p.type === "bool" ? false : (p.default ?? "");
      }
      dryRun.value = true;
    },
    { immediate: true },
  );

  const params = computed(() => activeCmd.value?.params ?? []);
  const inputs = computed(() => params.value.filter((p) => p.type !== "bool"));
  const toggles = computed(() => params.value.filter((p) => p.type === "bool"));
  const isSelfCheck = computed(() => activeCmd.value?.kind === "selfcheck");

  const argv = computed(() => {
    if (!activeCmd.value) return [];
    const out = [...activeCmd.value.argv];
    for (const p of params.value) {
      const v = values[p.key];
      if (p.type === "bool") {
        if (v && p.flag) out.push(p.flag);
        continue;
      }
      const text = String(v ?? "").trim();
      if (!text) continue;
      if (p.pos) out.push(text);
      else if (p.flag) out.push(p.flag, text);
    }
    if (activeCmd.value.write && dryRun.value) out.push("--dry-run");
    return out;
  });

  const preview = computed(
    () => "bili " + argv.value.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "),
  );

  /** 必填却没填的位置参数（只算 pos，flag 型可以缺） */
  const missing = computed(() =>
    inputs.value.filter((p) => p.pos && !String(values[p.key] ?? "").trim()).map((p) => p.label),
  );

  async function execute(argvList: string[], itemId: string, label: string) {
    if (busy.value) return;
    if (!argvList.length) {
      ElMessage.warning("这条命令没有可执行的参数。");
      return;
    }
    busy.value = true;
    lastResult.value = null;
    lastLabel.value = label;
    try {
      const result = await $fetch<BiliRunResult>("/api/admin/bili/run", {
        method: "POST",
        body: { argv: argvList, itemId, allowWrite: argvList.includes("--dry-run") ? false : !dryRun.value },
      });
      lastResult.value = result;
      runLog.value = [
        {
          id: `${itemId}-${Date.now()}`,
          label,
          argv: result.argv,
          at: new Date().toISOString(),
          ok: result.code === 0,
          seconds: result.elapsed,
        },
        ...runLog.value,
      ].slice(0, 30);
    } catch (error) {
      ElMessage.error(readErrorMessage(error, "命令执行失败。"));
    } finally {
      busy.value = false;
    }
  }

  async function runCommand() {
    if (!activeCmd.value) return;
    if (missing.value.length) {
      ElMessage.warning(`还差：${missing.value.join("、")}`);
      return;
    }
    await execute(argv.value, activeCmd.value.id, activeCmd.value.label);
  }

  function runSelfCheck(entry: (typeof SELF_CHECK)[number]) {
    void execute(entry.argv, entry.itemId, entry.label);
  }

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(preview.value);
      ElMessage.success("命令已复制。");
    } catch {
      ElMessage.warning("剪贴板不可用。");
    }
  }

  /** 结果卡抬头的一句话摘要：错误码 > 数组长度 > 字段数 > 成功/无输出 */
  function resultSummary(result: BiliRunResult | null) {
    if (!result) return "";
    const json = result.json as { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown } | null;
    if (json?.error) return `${json.error.code ?? "错误"}：${json.error.message ?? ""}`;
    if (Array.isArray(json?.data)) return `${json.data.length} 条结果`;
    if (json?.data && typeof json.data === "object") return `${Object.keys(json.data as object).length} 个字段`;
    return json?.ok ? "执行成功" : "无输出";
  }

  function formatResult(): string {
    const r = lastResult.value;
    if (!r) return "";
    if (r.json !== null && r.json !== undefined) return JSON.stringify(r.json, null, 2);
    if (r.stdout) return r.stdout.trim();
    if (r.stderr) return r.stderr.trim();
    return "（无输出）";
  }

  return {
    values, dryRun, busy, lastResult, lastLabel, runLog,
    params, inputs, toggles, isSelfCheck, argv, preview, missing, SELF_CHECK,
    execute, runCommand, runSelfCheck, copyCmd, resultSummary, formatResult,
  };
}

export function provideBiliRunner(deps: BiliRunnerDeps): BiliRunner {
  const store = createRunner(deps);
  provide(RUN_KEY, store);
  return store;
}

export function useBiliRunner(): BiliRunner {
  const store = inject(RUN_KEY, null);
  if (!store) throw new Error("useBiliRunner() 必须在值班台页面子树里调用。");
  return store;
}
