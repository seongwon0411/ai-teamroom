// 12시간 자동 삭제 테스트: 서버를 따로 띄워(임시 데이터 폴더·다른 포트) 오래된 메시지가 지워지고 되살아나지 않는지 확인
// 사용: node tools/retention-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-data-"));
const PORT = 3977;
const base = `http://localhost:${PORT}`;
const steps = [];
const step = (name, ok, detail = "") => { steps.push(ok); console.log(ok ? "✅" : "❌", name, detail); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = () => spawn(process.execPath, [path.join(root, "server.js")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA }, stdio: "ignore" });
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const state = (id) => fetch(`${base}/api/rooms/${id}/state`).then((r) => r.json());

let srv = start();
await sleep(2500);
const { id: roomId } = await post("/api/rooms", { name: "삭제 테스트" });
const { member } = await post(`/api/rooms/${roomId}/action`, { type: "join", name: "테스터" });
const sync = (messages) => post(`/api/rooms/${roomId}/action`, { type: "syncExternal", memberId: member.id, source: "claudecode", convId: "conv-1", convTitle: "테스트 대화", messages });
await sync([{ extId: "q1", role: "user", text: "어제 한 질문" }, { extId: "a1", role: "assistant", text: "어제 받은 답변" }]);
let st = await state(roomId);
const answer = st.messages.find((m) => m.text === "어제 받은 답변");
await post(`/api/rooms/${roomId}/action`, { type: "docAdd", memberId: member.id, text: "문서로 보낸 내용", sourceMessageId: answer.id });
await post(`/api/rooms/${roomId}/action`, { type: "comment", memberId: member.id, messageId: answer.id, text: "피드백" });
step("처음엔 2개가 올라가 있음", st.messages.length === 2 && st.retentionHours === 12, `보관 ${st.retentionHours}시간`);

// 서버를 끄고, 저장된 메시지의 시각을 13시간 전으로 바꾼 뒤 다시 켬 (시간이 흐른 상황)
await sleep(600);
srv.kill();
await sleep(500);
const file = path.join(DATA, `${roomId}.json`);
const saved = JSON.parse(fs.readFileSync(file, "utf8"));
for (const m of saved.messages) { m.ts -= 13 * 3600e3; m.updatedAt -= 13 * 3600e3; }
fs.writeFileSync(file, JSON.stringify(saved));
srv = start();
await sleep(2500);

st = await state(roomId);
step("12시간이 지난 메시지는 지워짐", st.messages.length === 0, `${st.messages.length}개 남음`);
step("그 메시지의 피드백도 같이 지워짐", st.comments.length === 0);
step("공동 문서로 보낸 내용은 남음", st.doc.some((b) => b.text === "문서로 보낸 내용"));
step("내부 기록은 화면으로 보내지 않음", st.expiredKeys === undefined);

// 커넥터가 대화 전체를 다시 보냄(예전 2개 + 새 2개) → 예전 것은 되살아나지 않고 새 것만 올라감
await sync([{ extId: "q1", role: "user", text: "어제 한 질문" }, { extId: "a1", role: "assistant", text: "어제 받은 답변" }, { extId: "q2", role: "user", text: "오늘 한 질문" }, { extId: "a2", role: "assistant", text: "오늘 받은 답변" }]);
st = await state(roomId);
step("지워진 메시지는 다시 올라오지 않고 새 메시지만 올라감", st.messages.length === 2 && st.messages.every((m) => m.text.startsWith("오늘")), st.messages.map((m) => m.text).join(" / "));

srv.kill();
console.log(steps.every(Boolean) ? "\n🎉 모두 통과" : `\n❌ ${steps.filter((s) => !s).length}개 실패`);
process.exit(steps.every(Boolean) ? 0 : 1);
