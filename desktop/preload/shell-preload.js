// 앱 바깥 틀(툴바·탭)에서 쓰는 기능
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellApi", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  sync: (payload) => ipcRenderer.send("sync", payload),
  onSyncStatus: (cb) => ipcRenderer.on("sync-status", (_e, s) => cb(s)),
  isTest: () => ipcRenderer.invoke("test:is"),
});
