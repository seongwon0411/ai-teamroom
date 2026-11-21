// 대화 공유 · 방 관리 창에서 쓰는 기능
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sessionsApi", {
  list: () => ipcRenderer.invoke("sessions:list"),
  status: () => ipcRenderer.invoke("sessions:status"),
  set: (id, status) => ipcRenderer.invoke("sessions:set", id, status),
  onChange: (cb) => ipcRenderer.on("sessions:changed", () => cb()),
});
// 방 여러 개: 목록 · 바꾸기 · 새로 만들기 · 초대 링크로 들어가기 (결과는 { ok, value } 또는 { ok: false, error })
contextBridge.exposeInMainWorld("roomsApi", {
  list: () => ipcRenderer.invoke("rooms:list"),
  switch: (roomUrl) => ipcRenderer.invoke("rooms:switch", roomUrl),
  create: (name, password, createPassword) => ipcRenderer.invoke("rooms:create", name, password, createPassword),
  add: (link, password) => ipcRenderer.invoke("rooms:add", link, password),
  copy: (text) => ipcRenderer.invoke("rooms:copy", text),
  remove: (roomUrl) => ipcRenderer.invoke("rooms:remove", roomUrl),
});
