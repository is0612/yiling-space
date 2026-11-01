import { inject, provide, ref, type ComputedRef, type InjectionKey } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { BiliAccount, BiliBinding } from "./types";
import { readErrorMessage } from "./utils";

/**
 * 账号与绑定 —— 弹窗开关 + 解绑 / 删号。
 *
 * 添加账号、绑定角色这两个表单在各自的弹窗里（BiliAccountDialog / BiliBindDialog），
 * 这里只管「谁打开哪个弹窗」和两个不需要表单的破坏性操作。
 *
 * ⚠️ 依赖走参数，不走 inject：Vue 的 inject 是从**父组件**的 provides 里找，
 * 页面自己 provide 的东西在同一个 setup 里 inject 不到。
 * 页面把 dashboard 的 accounts / reload 传进来，解绑删号后就能自己重读。
 */
export type BiliAccountsDeps = {
  accounts: ComputedRef<BiliAccount[]>;
  reload: () => Promise<void>;
};

export type BiliAccounts = ReturnType<typeof createAccounts>;

const ACC_KEY: InjectionKey<BiliAccounts> = Symbol("bili-accounts");

function createAccounts(deps: BiliAccountsDeps) {
  const { accounts, reload } = deps;

  const accountVisible = ref(false);
  const bindVisible = ref(false);
  const bindTarget = ref<BiliAccount | null>(null);
  const dutyVisible = ref(false);
  const dutyTarget = ref<BiliAccount | null>(null);

  function openAddAccount() {
    accountVisible.value = true;
  }

  function openBind(account: BiliAccount) {
    bindTarget.value = account;
    bindVisible.value = true;
  }

  function openDutySettings(account: BiliAccount) {
    dutyTarget.value = account;
    dutyVisible.value = true;
  }

  /** 侧栏点「值班设置」：没有账号时给提示，别弹一个空表单 */
  function openDutyForFirstAccount() {
    const account = accounts.value[0];
    if (!account) {
      ElMessage.warning("还没有 B站 账号，先点下方「添加账号」。");
      return;
    }
    openDutySettings(account);
  }

  async function unbind(account: BiliAccount, binding: BiliBinding) {
    const confirmed = await ElMessageBox.confirm(
      `解除「${binding.characterName}」与「${account.displayName}」的绑定？该账号的报告、判重记录会一并随绑定删除。`,
      "解除绑定",
      { confirmButtonText: "解绑", cancelButtonText: "取消", type: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    try {
      await $fetch(
        `/api/admin/channels/${encodeURIComponent(account.connectionId)}/bindings/${encodeURIComponent(binding.bindingId)}`,
        { method: "DELETE" },
      );
      ElMessage.success("已解绑。");
      await reload();
    } catch (error) {
      ElMessage.error(readErrorMessage(error, "解绑失败，请稍后重试。"));
    }
  }

  async function removeAccount(account: BiliAccount) {
    const confirmed = await ElMessageBox.confirm(
      `删除「${account.displayName}」？它的绑定、报告、判重记录会一并删除，且不可恢复。`,
      "删除账号",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    try {
      await $fetch(`/api/admin/channels/${encodeURIComponent(account.connectionId)}`, { method: "DELETE" });
      ElMessage.success("账号已删除。");
      await reload();
    } catch (error) {
      ElMessage.error(readErrorMessage(error, "删除失败，请稍后重试。"));
    }
  }

  return {
    accountVisible, bindVisible, bindTarget, dutyVisible, dutyTarget,
    openAddAccount, openBind, openDutySettings, openDutyForFirstAccount,
    unbind, removeAccount,
  };
}

export function provideBiliAccounts(deps: BiliAccountsDeps): BiliAccounts {
  const store = createAccounts(deps);
  provide(ACC_KEY, store);
  return store;
}

export function useBiliAccounts(): BiliAccounts {
  const store = inject(ACC_KEY, null);
  if (!store) throw new Error("useBiliAccounts() 必须在值班台页面子树里调用。");
  return store;
}
