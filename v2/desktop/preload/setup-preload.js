// 처음 실행 설정 화면에서 쓰는 기능
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("setupApi", {
  pickFolder: () => ipcRenderer.invoke("setup:pickFolder"),
  submit: (input) => ipcRenderer.invoke("setup:submit", input),
});
