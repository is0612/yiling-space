import { computed, inject, provide, ref, type InjectionKey } from "vue";
import { ElMessage } from "element-plus";
import type { BiliCliEnv } from "./types";

/**
 * bili CLI 在不在 —— 值班台所有功能的地基。
 *
 * 这一层存在的理由：CLI 缺失时 dashboard 只是「空」，命令台靠 schema-catalog 的手写目录
 * 照样列得出命令，登录按钮点下去才炸。三处都不会说「你没装 CLI」，于是人只会觉得页面坏了。
 * 探测一次，把结论摆到页面上，剩下的交给用户决定装不装。
 *
 * 和 useBiliMe 的区别：那个问「登录的是谁」，这个问「这台机器能不能跑 bili」。
 * 顺序也是先有环境、再有登录。
 */
export type BiliEnvStore = ReturnType<typeof createEnv>;

const ENV_KEY: InjectionKey<BiliEnvStore> = Symbol("bili-env");

function createEnv() {
  const env = ref<BiliCliEnv | null>(null);
  const loading = ref(false);

  /** 探测失败（网络/权限）当成「不知道」，不冒充「没装」—— 否则会误导人去装一遍。 */
  async function loadEnv() {
    loading.value = true;
    try {
      env.value = await $fetch<BiliCliEnv>("/api/admin/bili/env");
    } catch {
      env.value = null;
    } finally {
      loading.value = false;
    }
  }

  /** null（探测失败）不算缺失，不然一断网就喊「没装 bili」。 */
  const cliMissing = computed(() => env.value !== null && !env.value.installed);

  /** 只有「已装但版本读不出来」才值得说一句，正常情况不打扰。 */
  const unknownVersion = computed(() => env.value?.installed === true && !env.value.version);

  async function copyInstall() {
    const command = env.value?.installCommand;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      ElMessage.success("安装命令已复制，到项目根目录执行。");
    } catch {
      ElMessage.warning("剪贴板不可用，请手动选中复制。");
    }
  }

  return { env, loading, cliMissing, unknownVersion, loadEnv, copyInstall };
}

export function provideBiliEnv(): BiliEnvStore {
  const store = createEnv();
  provide(ENV_KEY, store);
  return store;
}

export function useBiliEnv(): BiliEnvStore {
  const store = inject(ENV_KEY, null);
  if (!store) throw new Error("useBiliEnv() 必须在值班台页面子树里调用。");
  return store;
}
