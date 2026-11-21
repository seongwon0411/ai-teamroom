// 커넥터 자동 테스트: 가짜 홈 폴더에 Claude Code·Codex 기록(실제와 같은 형식)을 만들고 팀룸에 올라가는지 확인
// 사용: node tools/connector-test.mjs http://localhost:3000
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.argv[2] || "http://localhost:3000";
const connector = path.join(here, "..", "connector", "teamroom-connector.mjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-home-"));
const TEAM = path.join(HOME, "work", "team-project");
const PRIVATE = path.join(HOME, "work", "my-private");
const steps = [];
const step = (name, ok, detail = "") => { steps.push(ok); console.log(ok ? "✅" : "❌", name, detail); };
const now = () => new Date().toISOString();
// 앞쪽 테스트는 "대화마다 묻지 않고 공유" 모드로 진행하고, 묻기 모드는 맨 뒤에서 따로 확인
const env = { ...process.env, TEAMROOM_HOME: HOME, TEAMROOM_ONCE: "1", TEAMROOM_AUTO_SHARE: "1", APPDATA: path.join(HOME, "appdata") };
const runConnector = (...args) => execFileSync(process.execPath, [connector, ...args], { env, encoding: "utf8" });
const state = async (roomId) => (await fetch(`${server}/api/rooms/${roomId}/state`)).json();

// 방 만들고, 크롬 확장으로 이미 "성원"이 들어와 있는 상황
const { id: roomId } = await (await fetch(`${server}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "커넥터 테스트" }) })).json();
const existing = await (await fetch(`${server}/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "join", name: "성원" }) })).json();

// 설정 (질문 없이 진행)
const out = runConnector("setup", "--room", `${server}/?room=${roomId}`, "--name", "성원", "--folder", TEAM, "--yes", "--no-startup");
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".ai-teamroom", "connector.json"), "utf8"));
step("설정: 이미 있는 같은 이름과 같은 사람으로 연결", cfg.memberId === existing.member.id, out.split("\n").find((l) => l.includes("설정 완료")));

// ① Claude Code 기록 (팀 폴더) — 실제 형식: user(문자열/도구결과), assistant(생각·도구·글이 여러 줄)
const ccFile = path.join(HOME, ".claude", "projects", "C--work-team-project", "11111111-2222-3333-4444-555555555555.jsonl");
fs.mkdirSync(path.dirname(ccFile), { recursive: true });
const cc = (o) => fs.appendFileSync(ccFile, JSON.stringify({ sessionId: "11111111-2222-3333-4444-555555555555", cwd: TEAM, timestamp: now(), ...o }) + "\n");
cc({ type: "user", uuid: "u1", message: { role: "user", content: "로그인 API 만들어줘<system-reminder>내부 안내</system-reminder>" } });
cc({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "생각" }] } });
cc({ type: "assistant", uuid: "a2", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "파일을 확인할게요." }] } });
cc({ type: "assistant", uuid: "a3", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } });
cc({ type: "user", uuid: "t1", message: { role: "user", content: [{ type: "tool_result", content: "파일 내용" }] } });
cc({ type: "assistant", uuid: "a4", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "login.js 에 API를 추가했어요." }] } });
cc({ type: "custom-title", customTitle: "로그인 API" });

// ② Codex 기록 (팀 폴더)
const d = new Date();
const cxDir = path.join(HOME, ".codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
fs.mkdirSync(cxDir, { recursive: true });
const cxFile = path.join(cxDir, "rollout-2026-11-14T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
const cx = (o) => fs.appendFileSync(cxFile, JSON.stringify({ timestamp: now(), ...o }) + "\n");
cx({ type: "session_meta", payload: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: TEAM } });
cx({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "시스템 지시" }] } });
cx({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>환경</environment_context>" }] } });
cx({ type: "turn_context", payload: { cwd: TEAM } });
cx({ type: "response_item", payload: { type: "message", id: "cu1", role: "user", content: [{ type: "input_text", text: "테스트 코드 작성해줘" }] } });
cx({ type: "response_item", payload: { type: "reasoning", summary: [] } });
cx({ type: "response_item", payload: { type: "message", id: "ca1", role: "assistant", content: [{ type: "output_text", text: "테스트 3개를 추가했습니다." }] } });

// ③ Claude Code 기록 (개인 폴더) → 공유되면 안 됨
const privFile = path.join(HOME, ".claude", "projects", "C--work-my-private", "99999999-2222-3333-4444-555555555555.jsonl");
fs.mkdirSync(path.dirname(privFile), { recursive: true });
fs.appendFileSync(privFile, JSON.stringify({ type: "user", uuid: "p1", sessionId: "99999999-2222-3333-4444-555555555555", cwd: PRIVATE, timestamp: now(), message: { role: "user", content: "개인 비밀 질문" } }) + "\n");

runConnector("run");
let st = await state(roomId);
const mine = st.messages.filter((m) => m.authorId === cfg.memberId);
const ccMsgs = mine.filter((m) => m.source === "claudecode");
step("Claude Code: 질문·답변만 공유 (도구·생각·시스템 안내 제외, 중간 메모+답은 하나로)",
  ccMsgs.length === 2 && ccMsgs[0].text === "로그인 API 만들어줘" && ccMsgs[1].text === "파일을 확인할게요.\n\nlogin.js 에 API를 추가했어요.",
  ccMsgs.map((m) => `${m.role}:${m.text.replace(/\n/g, "⏎")}`).join(" | "));
step("Claude Code: 대화 제목에 폴더·세션 이름", ccMsgs[0]?.convTitle === "team-project · 로그인 API", ccMsgs[0]?.convTitle);
const cxMsgs = mine.filter((m) => m.source === "codex");
step("Codex: 질문·답변만 공유 (시스템·환경 안내 제외)", cxMsgs.length === 2 && cxMsgs[0].text === "테스트 코드 작성해줘" && cxMsgs[1].text === "테스트 3개를 추가했습니다.",
  cxMsgs.map((m) => `${m.role}:${m.text}`).join(" | "));
step("팀 폴더가 아닌 개인 폴더 대화는 공유 안 됨", !st.messages.some((m) => m.text.includes("개인 비밀")));

// ④ 이어서 대화 → 새 내용만 추가
cc({ type: "user", uuid: "u2", message: { role: "user", content: "비밀번호 암호화도 해줘" } });
cc({ type: "assistant", uuid: "a5", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "bcrypt로 암호화했어요." }] } });
runConnector("run");
st = await state(roomId);
const cc2 = st.messages.filter((m) => m.source === "claudecode");
step("이어지는 대화도 추가 (중복 없음)", cc2.length === 4 && cc2[3].text === "bcrypt로 암호화했어요.", `${cc2.length}개`);

// ④-2 도구가 끼워 넣은 시스템 알림과 그에 대한 응답은 올라가지 않음, 그다음 진짜 질문은 올라감
cc({ type: "user", uuid: "n1", message: { role: "user", content: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>" } });
cc({ type: "assistant", uuid: "n2", message: { id: "m4", role: "assistant", content: [{ type: "text", text: "백그라운드 작업이 끝났다는 알림입니다." }] } });
cc({ type: "user", uuid: "u2b", message: { role: "user", content: "진짜 다음 질문" } });
cc({ type: "assistant", uuid: "a6", message: { id: "m5", role: "assistant", content: [{ type: "text", text: "진짜 다음 답변" }] } });
runConnector("run");
st = await state(roomId);
step("시스템 알림(<task-notification>)과 그 응답은 공유 안 됨", !st.messages.some((m) => m.text.includes("task-notification") || m.text.includes("알림입니다")) && st.messages.some((m) => m.text === "진짜 다음 답변"));

// ④-3 내가 지운 메시지는 다시 올라오지 않음
const victim = st.messages.find((m) => m.text === "진짜 다음 질문");
await fetch(`${server}/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "deleteMessage", memberId: cfg.memberId, messageId: victim.id }) });
cc({ type: "user", uuid: "u2c", message: { role: "user", content: "삭제 후 질문" } });
runConnector("run");
st = await state(roomId);
step("지운 메시지는 다시 올라오지 않음", !st.messages.some((m) => m.text === "진짜 다음 질문") && st.messages.some((m) => m.text === "삭제 후 질문"));

// ④-4 작업 중/완료 표시
const last = async () => { st = await state(roomId); return st.messages.filter((m) => m.source === "claudecode").slice(-1)[0]; };
cc({ type: "user", uuid: "w1", message: { role: "user", content: "오래 걸리는 작업 해줘" } });
runConnector("run");
let lm = await last();
step("질문 직후: '작업 중' 자리 표시", lm.role === "assistant" && lm.status === "streaming" && lm.text.startsWith("⏳"), `${lm.status}:${lm.text}`);
cc({ type: "assistant", uuid: "w2", message: { id: "mw1", role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "네." }] } });
cc({ type: "assistant", uuid: "w3", message: { id: "mw1", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: {} }] } });
cc({ type: "user", uuid: "w4", message: { role: "user", content: [{ type: "tool_result", content: "결과" }] } });
runConnector("run");
lm = await last();
step("도구 실행 중: 중간 글이 보이고 계속 '작업 중'", lm.status === "streaming" && lm.text === "네.", `${lm.status}:${lm.text}`);
cc({ type: "assistant", uuid: "w5", message: { id: "mw2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "다 끝났어요." }] } });
runConnector("run");
lm = await last();
step("답변을 마치면 '완료'로 바뀜", lm.status === "done" && lm.text === "네.\n\n다 끝났어요.", `${lm.status}:${lm.text.replace(/\n/g, "⏎")}`);

// ④-5 AI가 만든 문서 자동 공유 + 경로 숨기기
const mk = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
const report = mk(path.join(TEAM, "docs", "보고서.html"), "<h1>보고서 v1</h1>");
const summary = mk(path.join(TEAM, "docs", "요약.md"), "# 요약");
const code = mk(path.join(TEAM, "src", "app.js"), "console.log(1)");
const hidden = mk(path.join(TEAM, ".secret", "note.md"), "숨김 폴더");
const outside = mk(path.join(PRIVATE, "비밀.md"), "팀 폴더 밖");
const write = (uuid, file) => cc({ type: "assistant", uuid, message: { id: "md1", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Write", input: { file_path: file, content: "…" } }] } });
cc({ type: "user", uuid: "d1", message: { role: "user", content: "보고서 문서 만들어줘" } });
[report, code, hidden, outside].forEach((f, i) => write(`dw${i}`, f));
cc({ type: "assistant", uuid: "d2", message: { id: "md2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `완성했습니다. 파일: ${report} 그리고 [요약 문서](docs/요약.md) 도 만들었어요.` }] } });
runConnector("run");
lm = await last();
step("내 PC 경로는 숨기고 파일 이름만 표시", !lm.text.includes(HOME) && !lm.text.includes("docs/") && lm.text.includes("보고서.html") && lm.text.includes("요약 문서"), lm.text);
const hosted = (lm.files || []).filter((f) => f.hosted).map((f) => f.name).sort();
step("만든 문서 자동 업로드 (코드·숨김 폴더·팀 폴더 밖 파일은 제외)", JSON.stringify(hosted) === JSON.stringify(["보고서.html", "요약.md"]), JSON.stringify(hosted));
const body1 = await (await fetch(server + lm.files.find((f) => f.name === "보고서.html").url)).text();
step("팀원이 받은 파일 내용이 원본과 같음", body1 === "<h1>보고서 v1</h1>", body1);
// 문서를 고치면 새 버전으로 교체
await new Promise((r) => setTimeout(r, 1100));
fs.writeFileSync(report, "<h1>보고서 v2</h1>");
cc({ type: "user", uuid: "d3", message: { role: "user", content: "보고서 제목 고쳐줘" } });
cc({ type: "assistant", uuid: "d4", message: { id: "md3", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Edit", input: { file_path: report } }] } });
cc({ type: "assistant", uuid: "d5", message: { id: "md4", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "제목을 고쳤어요." }] } });
runConnector("run");
lm = await last();
const v2 = (lm.files || []).filter((f) => f.hosted && f.name === "보고서.html");
const body2 = v2.length ? await (await fetch(server + v2[0].url)).text() : "";
step("문서를 고치면 새 버전이 그 답변에 올라감", v2.length === 1 && body2 === "<h1>보고서 v2</h1>", body2);

// ⑤ 일시정지하면 안 올라감
runConnector("pause");
cc({ type: "user", uuid: "u3", message: { role: "user", content: "멈춘 동안 질문" } });
runConnector("run");
st = await state(roomId);
step("pause 하면 공유 멈춤", !st.messages.some((m) => m.text === "멈춘 동안 질문"));
runConnector("resume");

// ⑥ 커넥터 설치 전 대화는 올라가지 않음
const oldFile = path.join(HOME, ".claude", "projects", "C--work-team-project", "77777777-2222-3333-4444-555555555555.jsonl");
fs.appendFileSync(oldFile, JSON.stringify({ type: "user", uuid: "o1", sessionId: "77777777-2222-3333-4444-555555555555", cwd: TEAM, timestamp: new Date(Date.now() - 864e5).toISOString(), message: { role: "user", content: "설치 전 옛날 질문" } }) + "\n");
runConnector("run");
st = await state(roomId);
step("설치 전(옛날) 대화는 올리지 않음", !st.messages.some((m) => m.text === "설치 전 옛날 질문"));

// ⑦ 대화별 공유 허가: 같은 팀 폴더라도 허가한 대화만 공유
delete env.TEAMROOM_AUTO_SHARE;
const sessionsPath = path.join(HOME, ".ai-teamroom", "sessions.json");
const newSession = (sid, uuid, q, a) => {
  const f = path.join(HOME, ".claude", "projects", "C--work-team-project", `${sid}.jsonl`);
  const w = (o) => fs.appendFileSync(f, JSON.stringify({ sessionId: sid, cwd: TEAM, timestamp: now(), ...o }) + "\n");
  w({ type: "user", uuid, message: { role: "user", content: q } });
  w({ type: "assistant", uuid: uuid + "a", message: { id: uuid + "m", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: a }] } });
  return w;
};
const sidA = "aaaaaaa1-2222-3333-4444-555555555555";
const sidB = "bbbbbbb1-2222-3333-4444-555555555555";
const wA = newSession(sidA, "sa1", "허가 전 질문 A", "허가 전 답변 A");
newSession(sidB, "sb1", "비공개로 둘 질문 B", "비공개 답변 B");
runConnector("run");
st = await state(roomId);
let sess = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
step("새 대화는 허가 전에는 올라가지 않고 '물어보기' 상태로 대기", !st.messages.some((m) => /질문 [AB]$/.test(m.text)) && sess[sidA]?.status === "ask" && sess[sidB]?.status === "ask", `${sess[sidA]?.status}/${sess[sidB]?.status}`);
// 패널 창에서 A는 공유, B는 비공개로 고른 상황
sess[sidA].status = "shared"; sess[sidB].status = "private";
fs.writeFileSync(sessionsPath, JSON.stringify(sess));
runConnector("run");
st = await state(roomId);
step("'공유하기'로 정한 대화만 올라감 (지금까지 내용 포함), '비공개'는 안 올라감",
  st.messages.some((m) => m.text === "허가 전 답변 A") && !st.messages.some((m) => m.text.includes("질문 B") || m.text.includes("답변 B")));
// 공유 중지 후에는 이어지는 내용이 안 올라감
sess = JSON.parse(fs.readFileSync(sessionsPath, "utf8")); sess[sidA].status = "private";
fs.writeFileSync(sessionsPath, JSON.stringify(sess));
wA({ type: "user", uuid: "sa2", message: { role: "user", content: "공유 중지 후 질문" } });
runConnector("run");
st = await state(roomId);
step("공유를 중지하면 이후 내용은 올라가지 않음 (이미 올라간 건 유지)", !st.messages.some((m) => m.text === "공유 중지 후 질문") && st.messages.some((m) => m.text === "허가 전 답변 A"));

// ⑧ 팀 폴더 밖의 대화: 기본은 비공개(묻지도 않음), 직접 추가한 것만 공유
const sidO = "ccccccc1-2222-3333-4444-555555555555";
const oFile = path.join(HOME, ".claude", "projects", "C--work-my-private", `${sidO}.jsonl`);
const wO = (o) => fs.appendFileSync(oFile, JSON.stringify({ sessionId: sidO, cwd: PRIVATE, timestamp: now(), ...o }) + "\n");
const oDoc = mk(path.join(PRIVATE, "참고자료.md"), "# 다른 폴더 문서");
wO({ type: "user", uuid: "o1", message: { role: "user", content: "다른 폴더에서 한 질문" } });
wO({ type: "assistant", uuid: "o2", message: { id: "om1", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Write", input: { file_path: oDoc } }] } });
wO({ type: "assistant", uuid: "o3", message: { id: "om2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "다른 폴더 답변" }] } });
runConnector("run");
st = await state(roomId);
sess = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
step("다른 폴더의 대화: 올라가지 않고, 묻지 않고, 목록에만 '비공개'로 표시", !st.messages.some((m) => m.text.includes("다른 폴더")) && sess[sidO]?.status === "private" && sess[sidO]?.outside === true, JSON.stringify(sess[sidO]));
sess[sidO].status = "shared";
fs.writeFileSync(sessionsPath, JSON.stringify(sess));
runConnector("run");
st = await state(roomId);
const oAns = st.messages.find((m) => m.text === "다른 폴더 답변");
step("목록에서 '공유하기'로 추가하면 그 대화와 문서가 올라감", st.messages.some((m) => m.text === "다른 폴더에서 한 질문") && !!oAns?.files?.some((f) => f.hosted && f.name === "참고자료.md"), JSON.stringify(oAns?.files?.map((f) => f.name)));

// ⑨ 예전 대화(커넥터 설치 전): 목록에 '비공개'로 나오고, 골라서 공유하면 처음부터 전체가 올라감
const sidP = "ddddddd1-2222-3333-4444-555555555555";
const pFile = path.join(HOME, ".claude", "projects", "C--work-my-private", `${sidP}.jsonl`);
const old = new Date(Date.now() - 5 * 864e5);
const wP = (o) => fs.appendFileSync(pFile, JSON.stringify({ sessionId: sidP, cwd: PRIVATE, timestamp: old.toISOString(), ...o }) + "\n");
wP({ type: "user", uuid: "p1", message: { role: "user", content: "닷새 전 질문" } });
wP({ type: "assistant", uuid: "p2", message: { id: "pm1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "닷새 전 답변" }] } });
fs.utimesSync(pFile, old, old);
runConnector("run");
st = await state(roomId);
sess = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
step("예전 대화: 목록에 '비공개'로 나오고 올라가지 않음", sess[sidP]?.status === "private" && sess[sidP]?.past === true && sess[sidP]?.title.includes("닷새 전 질문") && !st.messages.some((m) => m.text.includes("닷새 전")), JSON.stringify(sess[sidP] && { status: sess[sidP].status, title: sess[sidP].title }));
// 관리 창에서 "공유하기"를 누른 것과 같은 동작 (명령으로 실행)
const idx = Object.entries(sess).sort((a, b) => b[1].ts - a[1].ts).findIndex(([id]) => id === sidP) + 1;
runConnector("share", String(idx));
runConnector("run");
st = await state(roomId);
step("예전 대화를 골라 공유하면 처음부터 전체가 올라감", st.messages.some((m) => m.text === "닷새 전 질문") && st.messages.some((m) => m.text === "닷새 전 답변"));

console.log(steps.every(Boolean) ? "\n모두 통과" : "\n실패 있음");
console.log(`(방: ${server}/?room=${roomId})`);
