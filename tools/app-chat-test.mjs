// Claude 앱 "채팅" 탭 공유 자동 테스트: 화면에서 읽힌 내용(가짜)을 차례로 넣어 보며
//  · 열어 보기만 한 대화는 묻지 않고 비공개  · 새 글이 오가면 공유할지 물어봄  · 허가한 대화만 올라감 을 확인
// 사용: node tools/app-chat-test.mjs http://localhost:3000
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.argv[2] || "http://localhost:3000";
const connector = path.join(here, "..", "connector", "teamroom-connector.mjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-app-"));
const FEED = path.join(HOME, "feed.jsonl");
const steps = [];
const step = (name, ok, detail = "") => { steps.push(ok); console.log(ok ? "✅" : "❌", name, detail); };
const env = { ...process.env, TEAMROOM_HOME: HOME, TEAMROOM_ONCE: "1", TEAMROOM_APP_FEED: FEED, TEAMROOM_NO_APPS: "1", APPDATA: path.join(HOME, "appdata") };
delete env.TEAMROOM_AUTO_SHARE;
const run = (...args) => execFileSync(process.execPath, [connector, ...args], { env, encoding: "utf8" });
const feed = (o) => fs.appendFileSync(FEED, JSON.stringify(o) + "\n");
const sessions = () => JSON.parse(fs.readFileSync(path.join(HOME, ".ai-teamroom", "sessions.json"), "utf8"));
const post = (roomId, body) => fetch(`${server}/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const { id: roomId } = await (await fetch(`${server}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "앱 채팅 테스트" }) })).json();
run("setup", "--room", `${server}/?room=${roomId}`, "--name", "앱테스터", "--folder", path.join(HOME, "team"), "--yes", "--no-startup");
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".ai-teamroom", "connector.json"), "utf8"));
const mine = async () => Object.values((await (await fetch(`${server}/api/rooms/${roomId}/state`)).json()).messages || {}).filter((m) => m.memberId === cfg.memberId || m.authorId === cfg.memberId);
const roomMessages = async () => {
  const st = await (await fetch(`${server}/api/rooms/${roomId}/state`)).json();
  const list = Array.isArray(st.messages) ? st.messages : Object.values(st.messages || {});
  return list.filter((m) => m.source === "claude");
};

const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
const LIVE = "bbbbbbbb-1111-2222-3333-444444444444";
const chat = (id, title, msgs, extra = {}) => ({ type: "chat", app: "claude", id, title: `${title} - Claude`, total: msgs.at(-1).k, busy: false, msgs, ...extra });

// ① 예전 대화를 열어 보기만 함
feed(chat(OLD, "지난주 회의록 정리", [{ k: 1, role: "user", label: "입력 내용: 정리해줘", text: "회의록 정리해줘" }, { k: 2, role: "assistant", label: "Claude 응답: 네", text: "정리했습니다.\n\n1시간 전" }]));
run("run");
step("열어 보기만 한 대화: 묻지 않고 비공개로 목록에", sessions()[OLD]?.status === "private" && sessions()[OLD]?.app === true, sessions()[OLD]?.title);
step("비공개 대화는 팀룸에 올라가지 않음", (await roomMessages()).length === 0);

// ② 새 대화를 시작: 첫 화면(질문 1개) → 답변이 붙음
feed(chat(LIVE, "발표 자료 목차", [{ k: 1, role: "user", label: "입력 내용: 목차", text: "발표 자료 목차 짜줘" }]));
run("run");
step("처음 본 대화는 아직 묻지 않음", sessions()[LIVE]?.status === "private");
feed(chat(LIVE, "발표 자료 목차", [{ k: 1, role: "user", label: "입력 내용: 목차", text: "발표 자료 목차 짜줘" }, { k: 2, role: "assistant", label: "Claude 응답: 목차", text: "1. 서론\n2. 본론" }], { busy: true }));
run("run");
step("새 글이 오가면 공유할지 물어봄", sessions()[LIVE]?.status === "ask");
step("물어보는 동안에는 올라가지 않음", (await roomMessages()).length === 0);

// ③ 공유하기 → 지금까지 읽은 내용이 올라감
run("share", LIVE);
run("run");
let msgs = await roomMessages();
step("공유하기로 한 대화가 올라감 (질문+답변)", msgs.length === 2 && msgs.some((m) => m.role === "user" && m.text === "발표 자료 목차 짜줘") && msgs.some((m) => m.role === "assistant" && m.text.includes("서론")), `${msgs.length}개`);
step("대화 제목·종류가 Claude로 표시", msgs.every((m) => m.convTitle === "발표 자료 목차" && m.convId === LIVE), msgs[0]?.convTitle);

// ④ 답변이 이어서 길어지고(같은 자리 갱신), 다음 질문이 추가됨
feed(chat(LIVE, "발표 자료 목차", [{ k: 2, role: "assistant", label: "Claude 응답: 목차", text: "1. 서론\n2. 본론\n3. 결론\n\n방금" }, { k: 3, role: "user", label: "입력 내용: 더", text: "결론을 더 자세히" }]));
run("run");
msgs = await roomMessages();
const answer = msgs.find((m) => m.role === "assistant" && m.text.includes("서론"));
step("답변이 같은 자리에서 갱신되고 시각 표시는 빠짐", !!answer && answer.text === "1. 서론\n2. 본론\n3. 결론", JSON.stringify(answer?.text));
step("새 질문이 추가되고, 답을 기다리는 동안 '작업 중' 표시", msgs.some((m) => m.text === "결론을 더 자세히") && msgs.some((m) => m.text.includes("작업 중")), `${msgs.length}개`);

// ⑤ 예전 대화도 목록에서 골라 공유할 수 있음 / 공유 중지하면 더 올라가지 않음
run("share", OLD);
run("run");
msgs = await roomMessages();
step("예전 대화를 골라 공유 (시각 표시 제외)", msgs.some((m) => m.convId === OLD && m.text === "정리했습니다."));
run("private", LIVE);
feed(chat(LIVE, "발표 자료 목차", [{ k: 4, role: "assistant", label: "Claude 응답: 결론", text: "비공개로 돌린 뒤의 답변" }]));
run("run");
step("공유 중지 뒤의 내용은 올라가지 않음", !(await roomMessages()).some((m) => m.text.includes("비공개로 돌린")));

console.log(steps.every(Boolean) ? "\n🎉 모두 통과" : `\n❌ ${steps.filter((s) => !s).length}개 실패`);
process.exit(steps.every(Boolean) ? 0 : 1);
