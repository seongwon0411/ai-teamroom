// 대화 공유 관리 창: 새 대화의 공유 여부를 묻고, 예전 대화를 포함해 어떤 대화든 골라서 공유를 켜고 끔
const list = document.getElementById("list");
const search = document.getElementById("search");
const LABEL = { claudecode: "Claude Code", codex: "Codex · ChatGPT 앱", claude: "Claude 앱 채팅" };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const day = (ts) => {
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : `${d.getMonth() + 1}/${d.getDate()}`;
};

async function render() {
  const sessions = await sessionsApi.list();
  const q = search.value.trim().toLowerCase();
  // 물어보는 대화 → 공유 중 → 나머지(최근순)
  const rank = (d) => (d.status === "ask" ? 0 : d.status === "shared" ? 1 : 2);
  const sorted = Object.entries(sessions)
    .filter(([, d]) => !q || `${d.title} ${LABEL[d.source] || d.source}`.toLowerCase().includes(q))
    .sort((a, b) => rank(a[1]) - rank(b[1]) || b[1].ts - a[1].ts);
  const chats = sorted.filter(([, d]) => d.app).slice(0, 40);
  const team = sorted.filter(([, d]) => !d.app && !d.outside).slice(0, 40);
  const others = sorted.filter(([, d]) => !d.app && d.outside).slice(0, 40);
  list.replaceChildren();
  if (!team.length && !others.length && !chats.length) { list.appendChild(el("div", "empty", q ? "검색 결과가 없어요" : "최근 30일간 Claude Code·Codex(ChatGPT 앱)·Claude 앱 채팅으로 나눈 대화가 없어요")); return; }
  if (team.length) list.appendChild(el("h2", "", "팀 폴더의 대화"));
  team.forEach(addRow);
  if (chats.length) {
    list.appendChild(el("h2", "", "Claude 앱 채팅"));
    list.appendChild(el("p", "sub", "Claude 앱의 '채팅' 탭에서 화면에 열어 본 대화가 여기에 나타납니다. 공유 중인 대화는 앱 화면에 열려 있는 동안 올라가요."));
    chats.forEach(addRow);
  }
  if (others.length) {
    list.appendChild(el("h2", "", "다른 폴더의 대화"));
    list.appendChild(el("p", "sub", "기본은 비공개입니다. 팀에 보여줄 대화만 [공유하기]를 눌러 추가하세요."));
    others.forEach(addRow);
  }
  function addRow([id, d]) {
    const row = el("div", `row ${d.status}`);
    const head = el("div", "head");
    head.append(el("span", "badge", LABEL[d.source] || d.source), el("span", "title", d.title), el("span", "date", day(d.ts)));
    head.children[1].title = d.title;
    const foot = el("div", "foot");
    const btn = (label, status, primary) => {
      const b = el("button", primary ? "primary" : "", label);
      b.onclick = async () => { await sessionsApi.set(id, status); render(); };
      return b;
    };
    if (d.status === "ask") foot.append(el("span", "state", "❓ 이 대화를 팀룸에 공유할까요?"), btn("공유하기", "shared", true), btn("비공개", "private"));
    else if (d.status === "shared") foot.append(el("span", "state shared", "✅ 공유 중"), btn("공유 중지", "private"));
    else foot.append(el("span", "state", "🔒 비공개"), btn("공유하기", "shared"));
    row.append(head, foot);
    list.appendChild(row);
  }
}

// 아래쪽 상태 줄: 커넥터가 살아 있는지, 대화 기록 폴더를 찾았는지 (안 될 때 원인을 바로 볼 수 있게)
const diag = document.getElementById("diag");
async function renderStatus() {
  const s = await sessionsApi.status();
  diag.replaceChildren();
  const line = (cls, text) => { const d = el("div", "", ""); d.append(el("span", cls, text)); diag.appendChild(d); return d; };
  if (!s.running) { line("bad", "⚠️ 커넥터가 아직 실행되지 않았어요 — 잠시 후 자동으로 켜집니다"); return; }
  line("good", `● 커넥터 실행 중`).append(el("span", "", ` (${s.version || "?"})${s.paused ? " · ⏸ 일시정지됨" : ""}${s.online === false ? " · 팀룸 서버에 연결 안 됨" : ""}`));
  line(s.claudeDir ? "" : "bad", `Claude Code 기록: ${s.claudeDir ? "찾음" : "없음 (이 PC에서 Claude Code를 쓴 적이 없거나 저장 위치가 다름)"}`);
  line("", `Codex·ChatGPT 앱 기록: ${s.codexDir ? "찾음" : "없음"}`);
  const app = { on: s.appChat ? `읽는 중 — 지금 열린 대화: ${s.appChat}` : "켜짐 (앱의 '채팅' 탭에서 대화를 열면 목록에 나타나요)", starting: "켜는 중…", off: "꺼짐 — 잠시 후 다시 켜집니다", unsupported: "이 PC에서는 지원하지 않음 (Windows 전용)" }[s.appReader];
  if (app) line(s.appReader === "off" ? "bad" : "", `Claude 앱 채팅: ${app}`);
  line("", `지금 살펴보는 대화 ${s.watching ?? 0}개 · 목록에 ${s.listed ?? 0}개`);
}
setInterval(renderStatus, 3000);
renderStatus();

// ───── 방: 지금 방 표시 · 다른 방으로 바꾸기 · 새 방 만들기 · 초대 링크로 들어가기 ─────
const roomList = document.getElementById("room-list");
const roomMsg = document.getElementById("room-msg");
const say = (text, bad) => { roomMsg.textContent = text; roomMsg.className = bad ? "sub bad" : "sub"; };
async function renderRooms() {
  const res = await roomsApi.list();
  if (!res.ok) { say(`방 목록을 불러오지 못했어요: ${res.error}`, true); return; }
  const { rooms, invite, createLocked } = res.value;
  document.querySelector('#room-create [name="createPassword"]').hidden = !createLocked;
  roomList.replaceChildren();
  for (const r of rooms) {
    const row = el("div", r.current ? "room current" : "room");
    row.append(el("span", "name", r.title));
    row.firstChild.title = r.title;
    if (r.current) {
      const copy = el("button", "", "초대 링크 복사");
      copy.onclick = async () => { await roomsApi.copy(invite); copy.textContent = "복사됨 ✓"; setTimeout(() => (copy.textContent = "초대 링크 복사"), 1500); };
      row.append(el("span", "now", "● 지금 이 방"), copy);
    } else {
      const go = el("button", "", "이 방으로");
      go.onclick = () => run(() => roomsApi.switch(r.roomUrl), go);
      // 목록에서 빼기: 내 PC의 목록에서만 지움 (방과 그 안의 내용은 그대로)
      const del = el("button", "", "✕");
      del.title = "내 목록에서 이 방 빼기";
      del.onclick = async () => { const res = await roomsApi.remove(r.roomUrl); if (!res.ok) say(res.error, true); else { say(`'${r.title}' 방을 목록에서 뺐어요.`); renderRooms(); } };
      if (r.stale) row.append(el("span", "now", "예전 주소 · 연결 안 됨"));
      row.append(go, del);
    }
    roomList.appendChild(row);
  }
}
// 방을 바꾸는 동작 공통: 버튼을 잠깐 막고, 결과를 알려 주고, 목록(방·대화)을 새로 그림
async function run(fn, button) {
  if (button) button.disabled = true;
  say("처리 중…");
  const res = await fn();
  if (button) button.disabled = false;
  if (!res.ok) { say(res.error, true); return false; }
  say(`'${res.value}' 방으로 바꿨어요. 지금부터 공유하는 대화는 이 방에 올라갑니다. (대화별 공유는 방마다 따로 정해요)`);
  await renderRooms();
  render();
  return true;
}
document.getElementById("room-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (await run(() => roomsApi.create(f.name.value, f.password.value, f.createPassword.value), e.target.querySelector("button"))) { e.target.reset(); document.getElementById("room-more").open = false; }
});
document.getElementById("room-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (await run(() => roomsApi.add(f.link.value, f.password.value), e.target.querySelector("button"))) { e.target.reset(); document.getElementById("room-more").open = false; }
});
renderRooms();

search.addEventListener("input", render);
// 검색어를 입력하는 중에는 자동 갱신으로 목록이 튀지 않게, 입력 중이 아닐 때만 다시 그림
sessionsApi.onChange(() => { if (document.activeElement !== search) render(); });
render();
