/** 桌面壳通过 preload 暴露的受限桥；这里只有无秘密的能力描述。 */
export type DesktopIdentityState = "bound" | "unbound" | "revoked" | "blocked";

export type DesktopIdentityStatus = {
  enabled: boolean;
  state: DesktopIdentityState;
  code?: string;
};

export type DesktopBindResult = { ok: boolean; cancelled?: boolean };
export type DesktopReconnectResult = { ok: boolean };

export type YilingDesktopBridge = {
  version: () => Promise<string>;
  openDataDir: () => Promise<void>;
  openLogs: () => Promise<void>;
  identityStatus: () => Promise<DesktopIdentityStatus>;
  bindCurrentAccount: () => Promise<DesktopBindResult>;
  reconnectIdentity: () => Promise<DesktopReconnectResult>;
  quit: () => Promise<void>;
};

declare global {
  interface Window {
    /** 仅安装版桌面壳注入；HTTP 页面与源码模式没有该对象。 */
    yilingDesktop?: YilingDesktopBridge;
  }
}
