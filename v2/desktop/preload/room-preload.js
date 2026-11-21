// 오른쪽 팀룸 패널 안에서 실행 — 웹페이지에 desktopBridge를 제공
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  // 팀룸 입장 정보 전달 (동기화할 때 누구 이름으로 올릴지)
  identity: (info) => ipcRenderer.sendToHost("identity", info),
  // 피드백을 왼쪽 AI 입력창에 넣기
  insertToAI: (text) => ipcRenderer.sendToHost("insert", String(text)),
});
