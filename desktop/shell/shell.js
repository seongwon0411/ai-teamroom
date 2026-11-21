// 앱 바깥 틀: AI 탭, 공유 토글, 팀룸 패널, 동기화 연결
const $ = (s) => document.querySelector(s);
const AI_URLS = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
};

let config;
let roomInfo = null; // { origin, roomId }
let identity = null; // { roomId, memberId }
const views = {}; // AI 탭별 webview
const lastSnap = {}; // AI 탭별 마지막으로 읽은 대화
let active = null;
let shared = new Set(); // 팀에 공유하기로 된 대화들 ("출처:대화ID")

(async function init() {
  config = await shellApi.getConfig();
  if (await shellApi.isTest()) AI_URLS.chatgpt = new URL("/mock-ai.html", config.roomUrl).href;
  shared = new Set(config.sharedConvs || []);
  privateSet = new Set(config.privateConvs || []);
  if (config.roomUrl) showMain();
  else showConnect();
})();

function parseRoomUrl(v) {
  const u = new URL(v.trim());
  const roomId = u.searchParams.get("room");
  if (!roomId) throw new Error("링크에 방 정보(room=…)가 없습니다");
  return { origin: u.origin, roomId, url: `${u.origin}/?room=${encodeURIComponent(roomId)}` };
}

// ───────── 처음 연결 ─────────
function showConnect() {
  $("#connect").hidden = false;
  $("#main").hidden = true;
  $("#connect-form").onsubmit = async (e) => {
    e.preventDefault();
    $("#connect-error").textContent = "";
    try {
      const info = parseRoomUrl($("#room-url").value);
      const res = await fetch(`${info.origin}/api/rooms/${info.roomId}/state`).catch(() => null);
      if (!res) throw new Error("팀룸 서버에 연결할 수 없습니다. 주소를 확인하세요");
      if (!res.ok) throw new Error("존재하지 않는 팀룸입니다");
      config = await shellApi.setConfig({ roomUrl: info.url, identity: null });
      location.reload();
    } catch (err) {
      $("#connect-error").textContent = err.message.startsWith("Invalid URL") ? "올바른 링크가 아닙니다" : err.message;
    }
  };
}

// ───────── 메인 화면 ─────────
function showMain() {
  $("#main").hidden = false;
  roomInfo = parseRoomUrl(config.roomUrl);
  if (config.identity?.roomId === roomInfo.roomId) identity = config.identity;

  // 오른쪽: 팀룸 패널
  const room = document.createElement("webview");
  room.setAttribute("partition", "persist:room");
  room.src = `${roomInfo.url}&embed=1`;
  room.addEventListener("ipc-message", (e) => {
    if (e.channel === "identity") {
      const info = e.args[0];
      if (info?.roomId !== roomInfo.roomId) return;
      identity = info;
      shellApi.setConfig({ identity });
      // 입장 전에 쌓인 대화도 바로 전송
      Object.values(lastSnap).forEach((s) => maybeSync(s));
      updateConvStatus();
    } else if (e.channel === "insert") {
      views[active]?.send("insert-text", e.args[0]);
    }
  });
  $("#room-area").appendChild(room);

  // AI 탭
  document.querySelectorAll("[data-ai]").forEach((b) => (b.onclick = () => switchAI(b.dataset.ai)));
  switchAI(config.aiTab || "chatgpt");

  $("#share-toggle").onclick = async () => {
    config = await shellApi.setConfig({ sharing: !config.sharing });
    renderShare();
    if (config.sharing) Object.values(lastSnap).forEach((s) => maybeSync(s));
  };
  $("#toggle-room").onclick = () => {
    const c = $("#room-area").classList.toggle("collapsed");
    $("#toggle-room").textContent = c ? "◂ 팀룸" : "팀룸 ▸";
  };
  $("#change-room").onclick = async () => {
    if (!confirm("다른 팀룸으로 연결할까요?\n(이미 공유된 내용은 지금 팀룸에 그대로 남습니다)")) return;
    await shellApi.setConfig({ roomUrl: "", identity: null });
    location.reload();
  };
  shellApi.onSyncStatus(renderSync);
  renderShare();
}

function switchAI(name) {
  active = name;
  shellApi.setConfig({ aiTab: name });
  document.querySelectorAll("[data-ai]").forEach((b) => b.classList.toggle("active", b.dataset.ai === name));
  if (!views[name]) {
    const v = document.createElement("webview");
    v.setAttribute("partition", "persist:ai"); // 로그인 상태가 앱을 껐다 켜도 유지됨
    v.setAttribute("allowpopups", "");
    v.src = AI_URLS[name];
    v.addEventListener("ipc-message", (e) => {
      if (e.channel === "snapshot") onSnapshot(name, e.args[0]);
      else if (e.channel === "insert-result" && !e.args[0]) alert("AI 입력창을 찾지 못했어요. 대화 화면을 연 상태에서 다시 시도하세요.");
    });
    $("#ai-area").appendChild(v);
    views[name] = v;
  }
  Object.entries(views).forEach(([k, v]) => v.classList.toggle("hidden", k !== name));
  updateConvStatus();
}

// ───────── 대화 공유 규칙 (크롬 확장과 같음) ─────────
// · 새 대화가 시작되면(AI가 답변 생성) 위쪽 바에서 "공유할까요?"를 물어봄 → 공유/비공개 선택
// · 예전 대화를 열어보기만 하면 묻지도, 공유하지도 않음
// · 공유로 정한 대화는 이어지는 내용도 계속 공유 / 이미 공유된 내용은 원본에서 지워도 팀룸에 남음
const convKey = (s) => `${s.source}:${s.convId}`;
let privateSet = new Set();
const decisionOf = (key) => (shared.has(key) ? "shared" : privateSet.has(key) ? "private" : "undecided");
function decide(key, share) {
  if (share) { shared.add(key); privateSet.delete(key); } else { shared.delete(key); privateSet.add(key); }
  shellApi.setConfig({ sharedConvs: [...shared], privateConvs: [...privateSet] });
  Object.values(lastSnap).forEach((s) => s?.convId && convKey(s) === key && maybeSync(s));
  updateConvStatus();
}

function onSnapshot(tab, snap) {
  lastSnap[tab] = snap;
  if (snap.convId) {
    const key = convKey(snap);
    // 임시 ID로 쓰던 대화가 진짜 ID를 받으면 그 결정을 이어받음
    if (decisionOf(key) === "undecided" && snap.renameFrom) {
      const old = decisionOf(`${snap.source}:${snap.renameFrom}`);
      if (old !== "undecided") decide(key, old === "shared");
    }
    // 묻기를 끈 경우: 답변이 생성된 대화는 자동 공유
    if (decisionOf(key) === "undecided" && snap.live && config.sharing && !config.askEachChat) decide(key, true);
  }
  maybeSync(snap);
  if (tab === active) updateConvStatus();
}

function maybeSync(snap) {
  if (!snap?.convId || !config.sharing || !identity || !shared.has(convKey(snap))) return;
  shellApi.sync({
    origin: roomInfo.origin, roomId: roomInfo.roomId, memberId: identity.memberId,
    source: snap.source, convId: snap.convId, convTitle: snap.convTitle, messages: snap.messages,
    renameFrom: snap.renameFrom,
  });
}

function updateConvStatus() {
  const el = $("#conv-status");
  const snap = lastSnap[active];
  if (!identity) { el.textContent = "👉 오른쪽 팀룸에 먼저 입장하세요"; return; }
  if (snap?.unreadable) { el.textContent = `⚠️ 이 화면에서 대화를 읽지 못했어요 (캡처해서 보내주세요) · 진단: ${JSON.stringify(snap.probe)}`; return; }
  if (!snap?.convId) { el.textContent = ""; return; }
  if (!config.sharing) { el.textContent = "공유 꺼짐 · 이 대화는 공유되지 않습니다"; return; }
  const key = convKey(snap);
  const d = decisionOf(key);
  el.classList.toggle("ask", d === "undecided" && snap.live);
  if (d === "shared") el.innerHTML = `✅ 이 대화 팀에 공유 중 <button data-decide="0">공유 중지</button>`;
  else if (d === "private") el.innerHTML = `🔒 비공개 대화 <button data-decide="1">공유하기</button>`;
  else if (snap.live) el.innerHTML = `❓ 이 새 대화를 팀룸에 공유할까요? <button class="primary" data-decide="1">공유하기</button><button data-decide="0">비공개</button>`;
  else el.innerHTML = `💬 예전 대화 (공유 안 됨) <button data-decide="1">이 대화 공유하기</button>`;
  el.querySelectorAll("[data-decide]").forEach((b) => (b.onclick = () => decide(key, b.dataset.decide === "1")));
}

function renderShare() {
  const b = $("#share-toggle");
  b.className = `share ${config.sharing ? "on" : "off"}`;
  b.textContent = config.sharing ? "● 팀에 공유 중" : "⏸ 공유 꺼짐";
  updateConvStatus();
}

function renderSync({ online, waiting }) {
  const el = $("#sync-status");
  el.classList.toggle("off", !online);
  el.textContent = online
    ? waiting ? `↻ 전송 중 (${waiting})` : "● 팀룸 연결됨"
    : `⚠️ 오프라인 · ${waiting}개 대기 중 (연결되면 자동 전송)`;
}
