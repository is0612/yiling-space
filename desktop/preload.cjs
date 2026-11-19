const { contextBridge, ipcRenderer } = require("electron");

// 渲染层只拿到这几个有限能力；不暴露 require、fs、child_process。
contextBridge.exposeInMainWorld("yilingDesktop", {
  version: () => ipcRenderer.invoke("desktop:version"),
  openDataDir: () => ipcRenderer.invoke("desktop:open-data-dir"),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
});
