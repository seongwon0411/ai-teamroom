// 팀룸 패널 창(Claude Code·Codex 옆에 뜨는 창)에서 팀룸 페이지에 제공하는 기능
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  clipboard: true, // 피드백은 입력창에 직접 넣을 수 없으니 복사해 줌 → 사용자가 Claude Code·Codex에 붙여넣기
  identity: () => {},
  insertToAI: (text) => ipcRenderer.send("panel-copy", String(text)),
});
