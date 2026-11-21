// 방 여러 개 테스트: A방에 공유하기로 한 대화가, 방을 B로 바꿨을 때 B로 새지 않는지 / B에서 다시 허가하면 B에만 올라가는지
// 사용: node tools/rooms-test.mjs http://localhost:3000
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.argv[2] || "http://localhost:3000";
const connector = path.join(here, "..", "connector", "teamroom-connector.mjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-rooms-"));
const FEED = path.join(HOME, "feed.jsonl");
const CFG = path.join(HOME, ".ai-teamroom", "connector.json");
const steps = [];
const step = (name, ok, detail = "") => { steps.push(ok); console.log(ok ? "✅" : "❌", name, detail); };
const env = { ...process.env, TEAMROOM_HOME: HOME, TEAMROOM_ONCE: "1", TEAMROOM_APP_FEED: FEED, TEAMROOM_NO_APPS: "1", APPDATA: path.join(HOME, "appdata") };
delete env.TEAMROOM_AUTO_SHARE;
const run = (...args) => execFileSync(process.execPath, [connector, ...args], { env, encoding: "utf8" });
const post = (p, body) => fetch(server + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const texts = async (roomId) => (await (await fetch(`${server}/api/rooms/${roomId}/state`)).json()).messages.map((m) => m.text);
const CONV = "cccccccc-1111-2222-3333-444444444444";
const feed = (msgs) => fs.appendFileSync(FEED, JSON.stringify({ type: "chat", app: "claude", id: CONV, title: "방 테스트 - Claude", total: msgs.at(-1).k, busy: false, msgs }) + "\n");

const A = (await post("/api/rooms", { name: "A방" })).id;
const B = (await post("/api/rooms", { name: "B방" })).id;
run("setup", "--room", `${server}/?room=${A}`, "--name", "방테스터", "--folder", path.join(HOME, "team"), "--yes", "--no-startup");

feed([{ k: 1, role: "user", text: "A방에서 한 질문" }, { k: 2, role: "assistant", text: "A방에서 받은 답" }]);
run("run");
run("share", CONV);
run("run");
step("A방에 공유하기로 한 대화가 A방에 올라감", (await texts(A)).length === 2);

// 팀룸 창에서 방을 B로 바꾼 상황 (설정의 방 주소·참여자만 바뀜)
const memberB = (await post(`/api/rooms/${B}/action`, { type: "join", name: "방테스터" })).member.id;
const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
const memberA = cfg.memberId;
fs.writeFileSync(CFG, JSON.stringify({ ...cfg, roomUrl: `${server}/?room=${B}`, memberId: memberB }));
feed([{ k: 3, role: "user", text: "방을 바꾼 뒤의 질문" }]);
run("run");
step("방을 바꿔도 A방에 허가한 대화가 B방으로 새지 않음", (await texts(B)).length === 0, `B방 ${(await texts(B)).length}개`);
step("A방에도 더 올라가지 않음 (지금 방이 아니므로)", !(await texts(A)).includes("방을 바꾼 뒤의 질문"));

// B방에서 다시 공유하기
run("share", CONV);
run("run");
const inB = await texts(B);
step("B방에서 공유하기를 누르면 B방에 올라감", inB.includes("A방에서 한 질문") && inB.includes("방을 바꾼 뒤의 질문"), `B방 ${inB.length}개`);

// A방으로 돌아오면: 이 대화는 이제 B방 것이므로 A방에는 올라가지 않음
fs.writeFileSync(CFG, JSON.stringify({ ...JSON.parse(fs.readFileSync(CFG, "utf8")), roomUrl: `${server}/?room=${A}`, memberId: memberA }));
feed([{ k: 4, role: "assistant", text: "A방으로 돌아온 뒤의 답" }]);
run("run");
step("A방으로 돌아와도 B방에 허가한 대화는 A방에 올라가지 않음", !(await texts(A)).includes("A방으로 돌아온 뒤의 답"));

console.log(steps.every(Boolean) ? "\n🎉 모두 통과" : `\n❌ ${steps.filter((s) => !s).length}개 실패`);
process.exit(steps.every(Boolean) ? 0 : 1);
