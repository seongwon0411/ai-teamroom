// 크롬 확장의 대화 읽기 코드(extension/content.js)로 데스크톱 앱용 preload를 생성
// → 두 버전이 항상 같은 방식으로 ChatGPT/Claude/Gemini 화면을 읽도록 유지
// 사용: node build-preload.mjs   (npm run dist 전에 자동 실행)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let src = fs.readFileSync(path.join(here, "..", "extension", "content.js"), "utf8");

const swap = (from, to) => {
  if (!src.includes(from)) throw new Error(`content.js 구조가 바뀌었습니다. 다음 부분을 찾을 수 없음:\n${from}`);
  src = src.replace(from, to);
};

// 1) 확장 메시지 → 앱(웹뷰) 메시지
swap(
  "const send = (msg) => { try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); } };",
  "const send = (msg) => { const { type, ...rest } = msg; ipcRenderer.sendToHost(type, type === \"snapshot\" ? msg.snap : rest); };",
);
// 2) preload는 페이지보다 먼저 실행되므로 화면이 준비된 뒤 감시 시작
swap(
  "  new MutationObserver(schedule).observe(document.documentElement, {",
  "  const startObserve = () => new MutationObserver(schedule).observe(document.documentElement, {",
);
swap(
  "  setInterval(schedule, 1500);\n  schedule();",
  "  if (document.documentElement) startObserve(); else document.addEventListener(\"DOMContentLoaded\", startObserve);\n  setInterval(schedule, 1500);\n  schedule();",
);
// 3) 피드백 넣기 요청 수신 방식
swap(
  "  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {\n    if (msg?.type !== \"insert-text\") return;",
  "  ipcRenderer.on(\"insert-text\", (_e, text) => {\n    const msg = { text };\n    const reply = (r) => ipcRenderer.sendToHost(\"insert-result\", !!r.ok);",
);

const out = `// ⚠️ 자동 생성 파일 — 직접 고치지 말고 extension/content.js 를 고친 뒤 \`node build-preload.mjs\` 실행
const { ipcRenderer } = require("electron");
${src}`;
fs.writeFileSync(path.join(here, "preload", "ai-preload.js"), out);
console.log("preload/ai-preload.js 생성 완료");

// 커넥터(Claude Code·Codex 대화 공유)를 앱에 함께 넣음 → 팀룸 창이 직접 실행·업데이트
fs.mkdirSync(path.join(here, "connector"), { recursive: true });
fs.copyFileSync(path.join(here, "..", "connector", "teamroom-connector.mjs"), path.join(here, "connector", "teamroom-connector.mjs"));
console.log("connector/teamroom-connector.mjs 복사 완료");
