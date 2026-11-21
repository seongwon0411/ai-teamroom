// AI 팀룸 클라이언트
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const params = new URLSearchParams(location.search);
const roomId = params.get("room");
let room = null;
let me = null; // memberId
let pendingFeedback = []; // 내가 반영하려고 고른 피드백 id들
let fbTarget = null; // {messageId, quote}

const DEFAULT_MODELS = { mock: "demo", anthropic: "claude-opus-5-5", openai: "gpt-5-mini", gemini: "gemini-2.5-flash" };
const PROVIDER_LABEL = { mock: "데모", anthropic: "Claude", openai: "ChatGPT", gemini: "Gemini", chatgpt: "ChatGPT", claude: "Claude", claudecode: "Claude Code", codex: "Codex", upload: "파일", mockai: "테스트 AI" };
const EXT_SOURCES = ["chatgpt", "claude", "gemini", "claudecode", "codex", "mockai"];
// 데스크톱 앱(AI팀룸.exe) 또는 크롬 확장 사이드패널 안에서 열렸을 때 제공되는 연결 통로
function extensionBridge() {
  // 크롬/엣지/웨일 확장 페이지가 이 화면을 감싸고 있을 때만 (다른 사이트가 감싼 경우는 무시)
  const parentOrigin = location.ancestorOrigins?.[0] || "";
  if (params.get("ext") !== "1" || window.parent === window || !/^(chrome|edge|whale)-extension:\/\//.test(parentOrigin)) return null;
  const post = (msg) => window.parent.postMessage({ teamroom: true, ...msg }, parentOrigin);
  return {
    async: true, // 넣기 성공 여부를 나중에 알려줌 (insert-result)
    identity: (info) => post({ type: "identity", ...info }),
    insertToAI: (text, commentId) => post({ type: "insert", text: String(text), commentId }),
  };
}
// 확장이 알려주는 "AI 입력창에 넣기" 결과 → 성공했을 때만 반영 처리
window.addEventListener("message", (e) => {
  if (e.origin !== location.ancestorOrigins?.[0] || !e.data?.teamroom || e.data.type !== "insert-result") return;
  if (e.data.ok) {
    act({ type: "applyComment", commentId: e.data.commentId });
    toast("AI 입력창에 피드백을 넣었어요. 확인 후 전송하세요!");
  }
});
const bridge = window.desktopBridge || extensionBridge();
if (bridge || params.get("embed")) document.documentElement.classList.add("embed");

// ───────── 로컬 저장 (개인 설정 · 키는 이 브라우저에만) ─────────
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const settings = () => store.get("ai-settings", { provider: "mock", model: "", keys: {} });

// ───────── 유틸 ─────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// 아주 가벼운 마크다운 렌더러 (제목·굵게·코드·목록)
function md(src) {
  const lines = esc(src).split("\n");
  let out = "", inCode = false;
  for (const raw of lines) {
    if (raw.startsWith("```")) { out += inCode ? "</code></pre>" : "<pre><code>"; inCode = !inCode; continue; }
    if (inCode) { out += raw + "\n"; continue; }
    let l = raw
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    if (/^#{1,3} /.test(l)) l = `<div class="md-h">${l.replace(/^#+ /, "")}</div>`;
    else if (/^\s*[-*] /.test(l)) l = `<div class="md-li">• ${l.replace(/^\s*[-*] /, "")}</div>`;
    else if (/^\s*\d+\. /.test(l)) l = `<div class="md-li">${l.trim()}</div>`;
    else l = l ? `<div>${l}</div>` : `<div class="md-gap"></div>`;
    out += l;
  }
  if (inCode) out += "</code></pre>";
  return out;
}
const timeAgo = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(ts).toLocaleDateString();
};
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}
const member = (id) => room?.members[id] || { name: "?", color: "#999" };
const avatar = (m, size = "") => `<span class="avatar ${size}" style="--c:${m.color}" title="${esc(m.name)}">${esc(m.name[0] || "?")}</span>`;

async function act(action) {
  const res = await fetch(`/api/rooms/${roomId}/action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ memberId: me, ...action }),
  });
  const data = await res.json();
  // (방장이 비밀번호를 걸었거나 바꿈 → 다시 불러와서 비밀번호부터 물어봄)
  if (res.status === 401 && data.locked) { location.reload(); throw new Error(data.error); }
  if (!res.ok) { toast(data.error || "오류"); throw new Error(data.error); }
  return data;
}
// 비밀번호가 걸린 방이면 맞는 비밀번호를 넣을 때까지 기다림 (맞으면 서버가 이 브라우저에 입장 열쇠를 심어 줌)
async function ensureUnlocked() {
  const probe = await fetch(`/api/rooms/${roomId}/state`).catch(() => null);
  if (probe?.status !== 401) return;
  const dlg = $("#unlock-dialog");
  dlg.addEventListener("cancel", (e) => e.preventDefault()); // (Esc로 닫히지 않게)
  dlg.showModal();
  await new Promise((done) => {
    $("#unlock-form").onsubmit = async (e) => {
      e.preventDefault();
      const res = await fetch(`/api/rooms/${roomId}/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("#unlock-pass").value }) }).catch(() => null);
      if (res?.ok) { dlg.close(); return done(); }
      $("#unlock-error").textContent = (await res?.json().catch(() => null))?.error || "서버에 연결할 수 없어요";
      $("#unlock-pass").select();
    };
  });
}

// ───────── 시작 ─────────
if (!roomId) {
  $("#landing").hidden = false;
  // 방 만들기 비밀번호가 걸린 서버면 그 칸을 보여 줌
  fetch("/api/info").then((r) => r.json()).then((info) => { $("#create-pass").hidden = !info.createLocked; $("#create-pass").required = !!info.createLocked; }).catch(() => {});
  $("#create-form").onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("#room-name").value, password: $("#room-pass").value, createPassword: $("#create-pass").value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.createLocked) { $("#create-pass").hidden = false; $("#create-pass").focus(); }
      $("#create-error").textContent = data.error || "방을 만들지 못했어요"; $("#create-error").hidden = false;
      return;
    }
    location.href = `?room=${data.id}`;
  };
  $("#join-code-form").onsubmit = (e) => {
    e.preventDefault();
    const code = $("#room-code").value.trim().replace(/.*room=/, "");
    if (code) location.href = `?room=${encodeURIComponent(code)}`;
  };
} else {
  start();
}

async function start() {
  // 확장이 "이미 입장한 사람"을 알려주면 그대로 사용 (AI 사이트마다 따로 입장하지 않게)
  // (커넥터가 알려주는 "내 팀룸 링크"로 열었을 때도 같은 사람으로 — 한 칸에 모이도록)
  await ensureUnlocked();
  const knownMember = params.get("member");
  if (knownMember) {
    const prev = store.get(`member:${roomId}`, null);
    store.set(`member:${roomId}`, knownMember);
    // 이전에 따로 입장해 둔 빈 참여자는 정리
    if (prev && prev !== knownMember) {
      fetch(`/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "leave", memberId: prev }) }).catch(() => {});
    }
  }
  me = store.get(`member:${roomId}`, null);
  if (!me) {
    const dlg = $("#join-dialog");
    dlg.showModal();
    await new Promise((r) => ($("#join-form").onsubmit = r));
    const { member: m } = await fetch(`/api/rooms/${roomId}/action`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "join", name: $("#join-name").value }),
    }).then((r) => (r.ok ? r.json() : Promise.reject(r)));
    me = m.id;
    store.set(`member:${roomId}`, me);
  } else {
    await act({ type: "join" }).catch(() => {});
  }
  $("#app").hidden = false;
  // 설치 안내 링크에 이 방 정보를 붙여 줌 (설치 페이지에 초대 링크가 미리 채워지도록)
  $("#ext-link").href = `/install.html?room=${encodeURIComponent(roomId)}#extension`;
  $("#conn-link").href = `/install.html?room=${encodeURIComponent(roomId)}`;
  bridge?.identity({ roomId, memberId: me, origin: location.origin });
  bindStatic();
  connect();
}

function applyState(newRoom) {
  room = newRoom;
  // 한글 조합 중에 화면을 다시 그리면 입력이 끊기므로, 조합이 끝난 뒤에 반영
  if (composing) renderPending = true;
  else render();
}

let polling = false;
function connect() {
  if (polling) return;
  const es = new EventSource(`/api/rooms/${roomId}/events?memberId=${me}`);
  let gotState = false;
  // 일부 프록시(임시 공개 주소 등)는 실시간 스트림을 막음 → 6초 안에 소식이 없으면 주기적 가져오기로 전환
  const fallback = setTimeout(() => { if (!gotState) { es.close(); startPolling(); } }, 6000);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "state") { gotState = true; applyState(ev.room); }
    else if (ev.type === "delta") onDelta(ev);
    else if (ev.type === "msgUpdate") onMsgUpdate(ev);
  };
  es.onerror = () => {
    if (es.readyState === 2) { clearTimeout(fallback); if (gotState) setTimeout(connect, 1500); else startPolling(); }
  };
}

function startPolling() {
  if (polling) return;
  polling = true;
  let last = "";
  const tick = async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/state?memberId=${me}&since=${room?.rev ?? ""}`);
      if (res.status === 401) return location.reload(); // (비밀번호가 걸렸거나 바뀜 → 다시 물어봄)
      const txt = res.status === 200 ? await res.text() : ""; // (204 = 바뀐 것 없음)
      // 바뀐 게 있을 때만 다시 그림 (드래그 중인 선택 영역 등이 풀리지 않게)
      if (txt && txt !== last) { last = txt; applyState(JSON.parse(txt)); }
    } catch {}
    setTimeout(tick, 1500);
  };
  tick();
}

// ───────── 한글(IME) 입력 보호 ─────────
let composing = false;
let renderPending = false;
document.addEventListener("compositionstart", () => { composing = true; }, true);
document.addEventListener("compositionend", () => {
  composing = false;
  if (renderPending) { renderPending = false; setTimeout(() => { if (!composing) render(); else renderPending = true; }, 0); }
}, true);

// ───────── 렌더링 ─────────
function render() {
  if (!room.members[me]) { store.set(`member:${roomId}`, null); location.reload(); return; }
  document.title = `${room.name} · AI 팀룸`;
  $("#room-name-label").textContent = room.name;
  renderPresence();
  renderTasks();
  renderSourceFilter();
  renderColumns();
  renderDoc();
  renderStats();
  window.renderProject?.(); // 프로젝트 현황 (project.js)
  const inbox = room.comments.filter((c) => c.toId === me && !c.resolved).length;
  $("#inbox-count").textContent = inbox;
  $("#inbox-count").classList.toggle("hot", inbox > 0);
}

function renderPresence() {
  $("#presence").innerHTML = Object.values(room.members)
    .map((m) => `<span class="presence-item ${room.online.includes(m.id) ? "on" : ""}">${avatar(m)}<span class="pname">${esc(m.name)}${m.id === me ? " (나)" : ""}${m.id === room.ownerId ? " 👑" : ""}</span></span>`)
    .join("");
}

function renderTasks() {
  const st = { todo: "할 일", doing: "진행중", done: "완료" };
  $("#tasks").innerHTML = room.tasks.length
    ? room.tasks.map((t) => {
        const a = member(t.assigneeId);
        return `<span class="task ${t.status}" data-task="${t.id}" title="클릭해서 상태 변경">
          <span class="dot" style="background:${a.color}"></span>${esc(t.title)}
          <span class="task-who">${esc(a.name)}</span><span class="task-st">${st[t.status]}</span>
          <button class="x" data-del-task="${t.id}" title="삭제">×</button></span>`;
      }).join("")
    : `<span class="muted small">과제를 나눠서 추가해보세요</span>`;
  const sel = $("#task-assignee");
  const cur = sel.value || me;
  sel.innerHTML = Object.values(room.members).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  sel.value = room.members[cur] ? cur : me;
}

// 팀원별 AI 작업 칼럼 — 칼럼/입력창은 유지하고 메시지 목록만 다시 그림
function renderColumns() {
  const wrap = $("#columns");
  const ids = [me, ...Object.keys(room.members).filter((id) => id !== me)];
  for (const id of ids) {
    let col = wrap.querySelector(`[data-col="${id}"]`);
    if (!col) {
      col = document.createElement("section");
      col.className = "col" + (id === me ? " mine" : "");
      col.dataset.col = id;
      const showComposer = id === me && !bridge;
      col.innerHTML = `<div class="col-head"></div><div class="msgs"></div>` +
        (showComposer
          ? `<div class="composer hint">🧩 크롬 확장을 설치하면 ChatGPT·Claude·Gemini에서 나눈 대화가 여기에 자동으로 표시됩니다</div>
             <details class="direct-ai"><summary>팀룸에서 직접 AI 쓰기 (API 키가 있는 경우)</summary>${composerHTML()}</details>`
          : id === me ? `<div class="composer hint">${bridge?.clipboard ? "💻 Claude Code·Codex에서 대화하면 여기에 자동으로 공유됩니다" : "👈 ChatGPT·Claude·Gemini 화면에서 대화하면 여기에 자동으로 공유됩니다"}</div>` : "") +
        (id === me ? `<div class="upload-row"><label class="upload-btn">📎 파일 올리기<input type="file" multiple hidden></label><span class="muted small">또는 이 칸에 파일을 끌어다 놓기</span></div>` : "");
      wrap.appendChild(col);
      if (showComposer) bindComposer(col);
      if (id === me) bindUpload(col);
    }
    const m = member(id);
    const online = room.online.includes(id);
    const streaming = room.messages.some((x) => x.authorId === id && x.status === "streaming");
    col.querySelector(".col-head").innerHTML = `${avatar(m)}<div class="col-title"><b>${esc(m.name)}${id === me ? " (나)" : ""}</b>
      <span class="muted small">${aiLabel(m)}</span></div>
      <span class="status ${streaming ? "busy" : online ? "on" : ""}">${streaming ? "AI 작업 중…" : online ? "접속 중" : "오프라인"}</span>`;

    const list = col.querySelector(".msgs");
    // 위에서 이름을 고른 사람의 칸만 보여 줌
    col.hidden = id !== viewMember;
    const msgs = room.messages.filter((x) => x.authorId === id);
    // 채팅방(대화·세션)별로 나눠서: 왼쪽에 채팅방 목록, 오른쪽에 고른 채팅방의 대화
    const groups = groupByConversation(msgs);
    const latest = groups[groups.length - 1]?.key;
    let sel = selectedConv.get(id);
    if (!groups.some((g) => g.key === sel)) sel = latest;
    const old = list.querySelector(".chat-view");
    const same = old && old.dataset.conv === sel;
    const atBottom = !same || old.scrollHeight - old.scrollTop - old.clientHeight < 80;
    const keepTop = same ? old.scrollTop : 0;
    const listTop = list.querySelector(".chat-list")?.scrollTop || 0;
    const itemHTML = (g) => {
      const live = g.items.some((x) => x.status === "streaming");
      return `<button class="chat-item ${g.key === sel ? "on" : ""}" data-chat="${esc(g.key)}" title="${esc(g.title)}">
        <span class="ci-title">${esc(g.title)}</span>
        <span class="ci-meta">${live ? '<span class="live-dot">● 작업 중</span> · ' : ""}${g.folder ? esc(g.folder) + " · " : ""}${g.items.length}개 · ${timeAgo(g.lastTs)}</span>
      </button>`;
    };
    // 목록은 종류별로 묶음: 일반 채팅 / Claude Code / Codex / 파일·팀룸 (각 종류 안에서는 최근 채팅방이 위)
    const listHTML = CATEGORIES.map((c) => {
      const rooms = groups.filter((g) => c.sources.includes(g.source)).reverse();
      return rooms.length ? `<div class="chat-cat">${c.label}<span class="muted">${rooms.length}</span></div>${rooms.map(itemHTML).join("")}` : "";
    }).join("");
    const g = groups.find((x) => x.key === sel);
    const viewHTML = g ? `<div class="chat-head">
        <button class="chat-back" data-chat-back title="채팅방 목록으로">← 목록</button>
        <span class="src-badge src-${esc(g.source)}">${esc(SOURCE_LABEL(g.source))}</span>
        <b class="chat-title">${esc(g.title)}</b>
        <span class="muted small">${g.folder ? esc(g.folder) + " · " : ""}${g.items.some((x) => x.status === "streaming") ? '<span class="live-dot">● 작업 중</span>' : g.items.length + "개"}</span>
      </div>
      <div class="conv-body">${g.items.map(messageHTML).join("")}</div>` : "";
    const emptyText = id === me ? "ChatGPT·Claude·Gemini·Claude Code·Codex에서 대화하면 여기에 실시간으로 표시됩니다" : "아직 공유한 AI 대화가 없습니다";
    list.innerHTML = msgs.length ? `<div class="chat-list">${listHTML}</div><div class="chat-view" data-conv="${esc(sel || "")}">${viewHTML}</div>` : `<div class="empty">${emptyText}</div>`;
    list.classList.toggle("show-view", openedChat.has(id)); // (좁은 창에서는 목록과 대화를 번갈아 보여 줌)
    const view = list.querySelector(".chat-view");
    if (view) view.scrollTop = atBottom ? view.scrollHeight : keepTop;
    const cl = list.querySelector(".chat-list");
    if (cl) cl.scrollTop = listTop;
  }
  wrap.classList.add("single");
  if (wrap.firstChild !== wrap.querySelector(`[data-col="${me}"]`)) wrap.prepend(wrap.querySelector(`[data-col="${me}"]`));
  renderPendingFeedback();
}

// ───────── AI별 보기 · 대화별 묶음 ─────────
let viewMember = null; // 지금 보고 있는 사람 (위쪽 이름을 눌러 바꿈, 처음엔 나)
// 한 사람의 대화를 나눠 보여 주는 종류
const CATEGORIES = [
  { key: "chat", label: "💬 일반 채팅", sources: ["chatgpt", "claude", "gemini", "mockai"] },
  { key: "claudecode", label: "⌨️ Claude Code", sources: ["claudecode"] },
  { key: "codex", label: "⌨️ Codex", sources: ["codex"] },
  { key: "etc", label: "📎 파일 · 팀룸에서 직접", sources: ["upload", "room"] },
];
const openConvs = new Map(); // (예전 접기 방식에서 쓰던 것)
const selectedConv = new Map(); // 사람별로 지금 보고 있는 채팅방
const openedChat = new Set(); // 좁은 창에서 채팅방을 열어 둔 사람 (목록 대신 대화를 보여 줌)
const sourceOf = (m) => (m.convId ? m.source : m.source === "upload" ? "upload" : "room");
const SOURCE_LABEL = (s) => ({ room: "팀룸 직접", upload: "파일" }[s] || PROVIDER_LABEL[s] || s);
function groupByConversation(msgs) {
  const map = new Map();
  for (const m of msgs) {
    const key = m.convId ? `${m.source}:${m.convId}` : sourceOf(m);
    if (!map.has(key)) map.set(key, { key, source: sourceOf(m), items: [], title: "", folder: "", lastTs: 0 });
    const g = map.get(key);
    g.items.push(m);
    g.lastTs = Math.max(g.lastTs, m.updatedAt || m.ts);
    if (m.convTitle) g.title = m.convTitle;
    if (m.convFolder) g.folder = m.convFolder;
  }
  for (const g of map.values()) {
    if (!g.title) g.title = g.source === "room" ? "팀룸에서 직접 대화" : g.source === "upload" ? "올린 파일" : (g.items.find((x) => x.role === "user")?.text || "대화").split("\n")[0].slice(0, 40);
  }
  return [...map.values()].sort((a, b) => a.lastTs - b.lastTs);
}
// 위쪽 "팀원" 줄: 이름을 누르면 그 사람이 공유한 대화를 종류별로 보여 줌
function renderSourceFilter() {
  if (!viewMember || !room.members[viewMember]) viewMember = me;
  const ids = [me, ...Object.keys(room.members).filter((id) => id !== me)];
  $("#source-filter").innerHTML = `<span class="filter-label">팀원</span>` + ids.map((id) => {
    const m = member(id);
    const mine = room.messages.filter((x) => x.authorId === id);
    const convs = groupByConversation(mine).length;
    const busy = mine.some((x) => x.status === "streaming");
    return `<button class="chip person ${viewMember === id ? "on" : ""}" data-view="${esc(id)}" title="${esc(m.name)}님이 공유한 대화 보기">
      <span class="pdot ${busy ? "busy" : room.online.includes(id) ? "on" : ""}" style="--c:${m.color}"></span>${esc(m.name)}${id === me ? " (나)" : ""} <span class="muted">${convs}</span></button>`;
  }).join("") + `<button class="chip retain-note" data-retention title="대화를 얼마 뒤에 자동으로 지울지 (방마다 따로 정함)">🕒 ${retentionLabel(room.retentionHours)}</button>`
    + `<button class="chip retain-note" data-password title="방 비밀번호 (방장이 정함)">${room.locked ? "🔒 비밀번호 있음" : "🔓 비밀번호 없음"}</button>`;
}
function openPassword() {
  const owner = room.ownerId === me;
  $("#password-state").textContent = room.locked
    ? "이 방은 비밀번호를 아는 사람만 들어올 수 있어요."
    : "지금은 초대 링크만 알면 누구나 들어올 수 있어요.";
  $("#password-new").value = "";
  $("#password-new").hidden = !owner;
  $("#password-save").hidden = !owner;
  $("#password-clear").hidden = !owner || !room.locked;
  $("#password-note").textContent = owner
    ? (room.locked ? "바꾸면 다른 팀원들은 새 비밀번호를 다시 넣어야 해요. 비밀번호는 팀원에게 직접 알려 주세요." : "정하면 지금 들어와 있는 팀원들도 비밀번호를 넣어야 계속 볼 수 있어요. 비밀번호는 팀원에게 직접 알려 주세요.")
    : `방장(${member(room.ownerId).name})만 바꿀 수 있어요.`;
  $("#password-dialog").showModal();
}
// 자동 삭제 시간 표시 (0 = 지우지 않음)
const RETENTION_CHOICES = [[0, "지우지 않음"], [1, "1시간"], [6, "6시간"], [12, "12시간"], [24, "하루"], [72, "3일"], [168, "일주일"], [720, "30일"]];
function retentionLabel(h) {
  if (!h) return "대화 자동 삭제 안 함";
  const named = RETENTION_CHOICES.find(([v]) => v === h)?.[1];
  return `대화는 ${named || h + "시간"} 뒤 자동 삭제`;
}
function openRetention() {
  const owner = room.ownerId === me;
  const sel = $("#retention-hours");
  sel.innerHTML = RETENTION_CHOICES.map(([v, t]) => `<option value="${v}">${t}${v ? " 뒤에 지움" : ""}</option>`).join("") + (RETENTION_CHOICES.some(([v]) => v === room.retentionHours) ? "" : `<option value="${room.retentionHours}">${room.retentionHours}시간 뒤에 지움</option>`);
  sel.value = String(room.retentionHours || 0);
  sel.disabled = !owner;
  $("#retention-save").hidden = !owner;
  $("#retention-note").textContent = owner
    ? "시간을 줄이면 그보다 오래된 대화는 바로 지워지고 되돌릴 수 없어요. 늘려도 이미 지워진 대화는 돌아오지 않습니다."
    : `이 설정은 방장(${member(room.ownerId).name})만 바꿀 수 있어요.`;
  $("#retention-dialog").showModal();
}

function messageHTML(msg) {
  const comments = room.comments.filter((c) => c.messageId === msg.id);
  const isAI = msg.role === "assistant";
  const fbUsed = (msg.feedbackIds || []).length;
  return `<div class="msg ${msg.role} ${msg.status}" data-msg="${msg.id}">
    <div class="msg-meta">${isAI ? `🤖 ${PROVIDER_LABEL[msg.provider] || msg.provider}` : "🙋 요청"}
      ${EXT_SOURCES.includes(msg.source) ? `<span class="tag ext">${PROVIDER_LABEL[msg.source]} 앱에서 자동 공유</span>` : ""}
      ${fbUsed ? `<span class="tag">피드백 ${fbUsed}개 반영</span>` : ""}
      ${isAI && msg.keySource && msg.keySource !== "personal" && msg.keySource !== "demo" ? `<span class="tag">${msg.keySource === "team" ? "팀 공용 키" : "서버 키"}</span>` : ""}
      <span class="muted">${timeAgo(msg.ts)}</span>
      ${msg.authorId === me && msg.status !== "streaming" ? `<button class="x del-msg" data-delmsg="${msg.id}" title="이 메시지를 팀룸에서 삭제">✕</button>` : ""}</div>
    <div class="text">${md(msg.text)}${msg.status === "streaming" ? '<span class="cursor">▍</span>' : ""}</div>
    ${filesHTML(msg.files)}
    ${isAI && msg.status === "done" ? `<div class="msg-actions">
      <button class="ghost small" data-fb="${msg.id}">💬 피드백</button>
      <button class="ghost small" data-todoc="${msg.id}">📄 문서로 보내기</button></div>` : ""}
    ${comments.map(commentHTML).join("")}
  </div>`;
}

// AI가 만든 파일·이미지 (원본 사이트 링크라 열 때 그 사이트 로그인이 필요할 수 있음)
function filesHTML(files) {
  if (!files?.length) return "";
  // 외부 링크(http/https) 또는 팀룸에 올린 파일(/api/rooms/…)만 허용
  const safe = (u) => (/^https?:\/\//i.test(u) || /^\/api\/rooms\/[\w-]+\/files\/[\w-]+$/.test(u) ? esc(u) : "#");
  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 1024 ? `${Math.round(n / 1024)}KB` : n ? `${n}B` : "");
  const pending = files.filter((f) => f.kind === "pending").map((f) =>
    `<span class="file-chip pending" title="AI 화면에서 이 파일을 다운로드하면 팀룸에 자동으로 올라와요">📎 ${esc(f.name)} · AI 화면에서 다운로드하면 여기에 올라와요</span>`).join("");
  const hosted = files.filter((f) => f.hosted && f.kind !== "image").map((f) =>
    `<a class="file-chip hosted" href="${safe(f.url)}" download="${esc(f.name)}">⬇ ${esc(f.name)} <span class="muted">${size(f.size)}</span></a>`).join("");
  files = files.filter((f) => f.kind !== "pending" && !(f.hosted && f.kind !== "image"));
  const imgs = files.filter((f) => f.kind === "image").map((f) =>
    `<a href="${safe(f.url)}" target="_blank" rel="noopener noreferrer" title="${esc(f.name)}"><img src="${safe(f.url)}" alt="${esc(f.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('broken')"></a>`).join("");
  const docs = files.filter((f) => f.kind !== "image").map((f) =>
    `<a class="file-chip" href="${safe(f.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(f.name)}</a>`).join("");
  return `<div class="files">${imgs ? `<div class="imgs">${imgs}</div>` : ""}${hosted}${docs}${pending}</div>`;
}

function commentHTML(c) {
  const from = member(c.fromId);
  const mine = c.toId === me;
  const picked = pendingFeedback.includes(c.id);
  return `<div class="comment ${c.resolved ? "resolved" : ""}">
    <div class="comment-head">${avatar(from, "sm")}<b>${esc(from.name)}</b> <span class="muted small">${timeAgo(c.ts)}</span>
      ${c.resolved ? `<span class="tag ok">✓ ${c.appliedInMessageId ? "AI에 반영됨" : "해결됨"}</span>` : ""}</div>
    ${c.quote ? `<blockquote class="quote">${esc(c.quote)}</blockquote>` : ""}
    <div>${esc(c.text)}</div>
    ${mine && !c.resolved ? `<div class="comment-actions">
      <button class="primary small" data-apply="${c.id}">${picked ? "✓ 반영 대기 중" : "↪ 피드백 반영"}</button>
      <button class="ghost small" data-resolve="${c.id}">해결로 표시</button></div>` : ""}
  </div>`;
}

// 팀원이 쓰는 AI 표시 (아직 대화가 없으면 "대기 중")
function aiLabel(m) {
  const hasChat = room.messages.some((x) => x.authorId === m.id);
  if (!hasChat || m.provider === "none") return "AI 대화 기다리는 중";
  return `${PROVIDER_LABEL[m.provider] || m.provider}${m.model ? ` · ${esc(m.model)}` : ""}`;
}

// 팀룸에 파일 직접 올리기 (버튼 또는 내 칸에 끌어다 놓기)
async function uploadFiles(list) {
  for (const f of list) {
    if (f.size > 30 * 1024 * 1024) { toast(`${f.name}: 30MB 이하만 올릴 수 있어요`); continue; }
    toast(`${f.name} 올리는 중…`);
    try {
      const res = await fetch(`/api/rooms/${roomId}/upload?memberId=${encodeURIComponent(me)}&name=${encodeURIComponent(f.name)}`, {
        method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: f,
      });
      const data = await res.json();
      toast(res.ok ? `📎 ${f.name} 올렸어요` : data.error || "올리기 실패");
    } catch {
      toast("올리기 실패 · 연결을 확인하세요");
    }
  }
}
function bindUpload(col) {
  const input = col.querySelector('.upload-btn input');
  input.onchange = () => { uploadFiles([...input.files]); input.value = ""; };
  col.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); col.classList.add("drop"); } });
  col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop"); });
  col.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    col.classList.remove("drop");
    uploadFiles([...e.dataTransfer.files]);
  });
}

function composerHTML() {
  return `<div class="composer">
    <div class="pending-fb"></div>
    <textarea placeholder="내 AI에게 요청하기 (Enter 전송, Shift+Enter 줄바꿈)" rows="3"></textarea>
    <div class="composer-row"><span class="muted small model-label"></span><button class="primary send">보내기</button></div>
  </div>`;
}

function bindComposer(col) {
  const ta = col.querySelector("textarea");
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const s = settings();
    const provider = s.provider || "mock";
    ta.disabled = true;
    try {
      await act({ type: "chat", text, provider, model: s.model || DEFAULT_MODELS[provider], apiKey: s.keys?.[provider] || "", feedbackIds: pendingFeedback });
      ta.value = ""; pendingFeedback = [];
    } catch {}
    ta.disabled = false; ta.focus();
  };
  col.querySelector(".send").onclick = send;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
}

function renderPendingFeedback() {
  const box = $(`[data-col="${me}"] .pending-fb`);
  if (!box) return;
  const list = pendingFeedback.map((id) => room.comments.find((c) => c.id === id)).filter(Boolean);
  box.innerHTML = list.map((c) => `<span class="chip">💬 ${esc(member(c.fromId).name)}: ${esc(c.text.slice(0, 30))}<button class="x" data-unpick="${c.id}">×</button></span>`).join("");
  const s = settings();
  const p = s.provider || "mock";
  $(`[data-col="${me}"] .model-label`).textContent = `${PROVIDER_LABEL[p]} · ${s.model || DEFAULT_MODELS[p]} · ${keySourceLabel(p)}`;
}

function keySourceLabel(p) {
  if (p === "mock") return "키 필요 없음";
  if (settings().keys?.[p]) return "개인 키";
  if (room?.sharedKeys?.[p]) return "팀 공용 키";
  if (room?.serverKeys?.[p]) return "서버 키";
  return "⚠️ 키 없음";
}

// 데스크톱 앱에서 동기화된 메시지 내용 갱신 (스트리밍 중인 답변 등)
function onMsgUpdate({ messageId, text, status, files }) {
  const msg = room?.messages.find((m) => m.id === messageId);
  if (!msg) return;
  const wasStreaming = msg.status === "streaming";
  const filesChanged = JSON.stringify(msg.files || []) !== JSON.stringify(files || []);
  msg.text = text;
  msg.status = status;
  msg.files = files || [];
  const el = $(`[data-msg="${messageId}"]`);
  if (!el) return;
  if (wasStreaming !== (status === "streaming") || filesChanged) { renderColumns(); return; }
  const list = el.closest(".chat-view") || el.closest(".msgs");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  el.querySelector(".text").innerHTML = md(text) + (status === "streaming" ? '<span class="cursor">▍</span>' : "");
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function onDelta({ messageId, text }) {
  const msg = room?.messages.find((m) => m.id === messageId);
  if (!msg) return;
  msg.text += text;
  const el = $(`[data-msg="${messageId}"] .text`);
  if (!el) return;
  const list = el.closest(".chat-view") || el.closest(".msgs");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  el.innerHTML = md(msg.text) + '<span class="cursor">▍</span>';
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

// 공동 문서 — 편집 중인 블록이 있으면 그 블록은 덮어쓰지 않음
function renderDoc() {
  const doc = $("#doc");
  const editing = document.activeElement?.closest?.("[data-block]")?.dataset.block;
  if (!room.doc.length) {
    doc.innerHTML = `<div class="empty">AI 답변의 <b>📄 문서로 보내기</b>를 누르면 여기에 모입니다.<br/>복사·붙여넣기는 이제 그만!</div>`;
    return;
  }
  const existing = new Map($$("[data-block]", doc).map((el) => [el.dataset.block, el]));
  const ordered = [];
  room.doc.forEach((b, i) => {
    let el = existing.get(b.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "block";
      el.dataset.block = b.id;
      el.innerHTML = `<div class="block-meta"></div><textarea></textarea>`;
      const ta = el.querySelector("textarea");
      ta.addEventListener("input", () => autosize(ta));
      ta.addEventListener("blur", () => {
        const cur = room.doc.find((x) => x.id === b.id);
        if (cur && cur.text !== ta.value) act({ type: "docEdit", blockId: b.id, text: ta.value });
        setTimeout(renderDoc, 0);
      });
    }
    const src = b.sourceAuthorId ? member(b.sourceAuthorId) : null;
    const srcMsg = b.sourceMessageId && room.messages.find((m) => m.id === b.sourceMessageId);
    el.querySelector(".block-meta").innerHTML = `
      ${src ? `<span class="src" data-jump="${b.sourceMessageId}" title="원본 대화로 이동">${avatar(src, "sm")} ${esc(src.name)}의 ${PROVIDER_LABEL[srcMsg?.provider] || "AI"} 답변</span>` : `<span class="src">✏️ 직접 작성</span>`}
      <span class="muted small">${b.updatedBy === b.addedBy ? "추가" : "수정"}: ${esc(member(b.updatedBy).name)} · ${timeAgo(b.ts)}</span>
      <span class="block-tools">
        <button class="ghost xs" data-move="${b.id}" data-dir="up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="ghost xs" data-move="${b.id}" data-dir="down" ${i === room.doc.length - 1 ? "disabled" : ""}>↓</button>
        <button class="ghost xs" data-deldoc="${b.id}">삭제</button></span>`;
    const ta = el.querySelector("textarea");
    if (b.id !== editing && ta.value !== b.text) ta.value = b.text;
    ordered.push(el);
  });
  // 입력칸을 떼었다 붙이지 않고 제자리에서 갱신 (떼어내면 입력 중이던 글자가 끊김)
  doc.querySelector(".empty")?.remove();
  const keep = new Set(room.doc.map((b) => b.id));
  for (const el of $$("[data-block]", doc)) if (!keep.has(el.dataset.block)) el.remove();
  ordered.forEach((el, i) => { if (doc.children[i] !== el) doc.insertBefore(el, doc.children[i] || null); });
  $$("textarea", doc).forEach(autosize);
  if (editing) $(`[data-block="${editing}"] textarea`)?.focus();
}
function autosize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }

// 기여 로그 — 누가 무엇을 했는지 자동 집계
function renderStats() {
  const rows = Object.values(room.members).map((m) => {
    const prompts = room.messages.filter((x) => x.authorId === m.id && x.role === "user").length;
    const blocks = room.doc.filter((b) => b.sourceAuthorId === m.id || (!b.sourceAuthorId && b.addedBy === m.id)).length;
    const given = room.comments.filter((c) => c.fromId === m.id).length;
    const received = room.comments.filter((c) => c.toId === m.id).length;
    const applied = room.comments.filter((c) => c.toId === m.id && c.appliedInMessageId).length;
    const tasksDone = room.tasks.filter((t) => t.assigneeId === m.id && t.status === "done").length;
    const tasksAll = room.tasks.filter((t) => t.assigneeId === m.id).length;
    return { m, prompts, blocks, given, received, applied, tasksDone, tasksAll };
  });
  const totalBlocks = room.doc.length || 1;
  const labels = { join: "입장", prompt: "AI에게 요청", ai_done: "AI 답변 완료", feedback: "피드백 보냄", doc_add: "문서에 추가", doc_edit: "문서 수정", doc_delete: "문서 블록 삭제", task_add: "과제 추가", task_update: "과제 상태 변경", shared_key: "공용 키 설정",
    ext_prompt: "AI에게 요청", feedback_apply: "피드백 반영", file_upload: "파일 올림", password: "방 비밀번호", retention: "자동 삭제 시간 변경",
    work_add: "작업 추가", work_status: "작업 상태 변경", work_report: "작업 현황 갱신", project_detach: "프로젝트 연결 해제" };
  // 기록 속 영어 값(상태·AI 이름)을 한글로 — 서버에 이미 쌓인 기록도 바로 고쳐 보이도록 화면에서 바꿈
  const words = { todo: "할 일", doing: "진행 중", done: "완료", planned: "계획됨", review: "검토 중", blocked: "차단됨",
    chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", claudecode: "Claude Code", codex: "Codex", mockai: "테스트 AI" };
  const detailText = (a) => {
    let d = String(a.detail || "");
    if (a.kind === "task_update" || a.kind === "work_status") d = d.replace(/→ (\w+)$/, (s, w) => `→ ${words[w] || w}`);
    if (a.kind === "ext_prompt") d = d.replace(/^(\w+):/, (s, w) => `${words[w] || w}:`);
    return d;
  };
  $("#stats").innerHTML = `
    <table class="stats-table">
      <thead><tr><th>팀원</th><th>AI 요청</th><th>문서 기여</th><th>피드백 준/받은/반영</th><th>과제</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${avatar(r.m, "sm")} ${esc(r.m.name)}</td><td>${r.prompts}</td>
        <td><div class="bar"><span style="width:${(r.blocks / totalBlocks) * 100}%;background:${r.m.color}"></span></div>${r.blocks}</td>
        <td>${r.given} / ${r.received} / ${r.applied}</td><td>${r.tasksDone}/${r.tasksAll}</td></tr>`).join("")}</tbody>
    </table>
    <h4>최근 활동</h4>
    <ul class="activity">${room.activity.slice(-40).reverse().map((a) => `<li>${avatar(member(a.memberId), "sm")} <b>${esc(member(a.memberId).name)}</b> ${labels[a.kind] || "활동"} <span class="muted">${esc(detailText(a))}</span> <span class="muted small">${timeAgo(a.ts)}</span></li>`).join("")}</ul>`;
}

// ───────── 이벤트 바인딩 ─────────
function bindStatic() {
  // 대화 자동 삭제 시간 저장 (방장만)
  // (대화상자가 닫히는 신호 대신 [저장] 버튼으로 낸 제출을 직접 받음 — 닫힘 신호는 창이 가려져 있으면 오지 않는 경우가 있음)
  $("#retention-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok" || room.ownerId !== me) return;
    const hours = Number($("#retention-hours").value);
    if (hours === (room.retentionHours || 0)) return;
    // 줄이면 그보다 오래된 대화가 바로 지워지므로 한 번 더 확인
    const shorter = hours && (!room.retentionHours || hours < room.retentionHours);
    if (shorter && !confirm(`${retentionLabel(hours)}로 바꾸면 그보다 오래된 대화는 지금 바로 지워지고 되돌릴 수 없어요. 바꿀까요?`)) return;
    try { await act({ type: "setRetention", hours }); toast(retentionLabel(hours)); } catch (err) { toast(err.message); }
  });
  // 방 비밀번호 저장·없애기 (방장만)
  $("#password-form").addEventListener("submit", async (e) => {
    const how = e.submitter?.value;
    if ((how !== "ok" && how !== "clear") || room.ownerId !== me) return;
    const password = how === "ok" ? $("#password-new").value : "";
    if (how === "ok" && password.length < 4) { e.preventDefault(); $("#password-note").textContent = "비밀번호는 4자 이상으로 정하세요."; return; }
    if (how === "clear" && !confirm("비밀번호를 없애면 초대 링크만 알아도 들어올 수 있어요. 없앨까요?")) return;
    try { const r = await act({ type: "setPassword", password }); room.locked = !!r.locked; render(); toast(password ? "방 비밀번호를 정했어요" : "방 비밀번호를 없앴어요"); } catch (err) { toast(err.message); }
  });
  // 초대: 다른 사람이 열 수 있는 주소(서버가 기억한 공개 주소)로 링크를 만들어 보여줌
  $("#invite-btn").onclick = () => {
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    const origin = local && room.publicOrigin ? room.publicOrigin : location.origin;
    $("#invite-room").value = `${origin}/?room=${roomId}`;
    $("#invite-install").value = `${origin}/install.html?room=${roomId}`;
    const stillLocal = /\/\/(localhost|127\.0\.0\.1)/.test(origin);
    $("#invite-note").textContent = stillLocal
      ? "⚠️ 이 주소는 이 PC에서만 열립니다. 다른 사람을 초대하려면 터널(cloudflared)을 켜거나 서버를 배포한 뒤 다시 눌러주세요."
      : origin.includes("trycloudflare.com") ? "임시 공개 주소입니다. 이 PC의 터널(cloudflared)과 팀룸 서버가 켜져 있는 동안만 열려요." : "";
    $("#invite-dialog").showModal();
  };
  $$("[data-copy-from]").forEach((b) => (b.onclick = async () => {
    const input = $(`#${b.dataset.copyFrom}`);
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand("copy"); }
    toast("복사했어요");
  }));
  $("#room-name-label").ondblclick = () => {
    const n = prompt("방 이름 변경", room.name);
    if (n) act({ type: "rename", name: n });
  };

  $("#task-form").onsubmit = (e) => {
    e.preventDefault();
    const title = $("#task-title").value.trim();
    if (!title) return;
    act({ type: "taskAdd", title, assigneeId: $("#task-assignee").value });
    $("#task-title").value = "";
  };

  $$(".tab").forEach((t) => (t.onclick = () => {
    $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $("#tab-doc").hidden = t.dataset.tab !== "doc";
    $("#tab-stats").hidden = t.dataset.tab !== "stats";
  }));

  $("#doc-add-empty").onclick = () => act({ type: "docAdd", text: "" });
  const docMd = () => room.doc.map((b) => b.text).join("\n\n");
  $("#doc-copy").onclick = async () => { await navigator.clipboard.writeText(docMd()); toast("문서를 마크다운으로 복사했어요"); };
  $("#doc-download").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([docMd()], { type: "text/markdown" }));
    a.download = `${room.name}.md`; a.click();
  };

  $("#inbox-btn").onclick = () => {
    const c = room.comments.find((c) => c.toId === me && !c.resolved);
    if (!c) return toast("받은 피드백이 없어요");
    jumpTo(c.messageId);
  };

  // 피드백 다이얼로그
  $("#feedback-form").onsubmit = (e) => {
    if (e.submitter?.value !== "ok") return;
    const text = $("#fb-text").value.trim();
    if (text && fbTarget) act({ type: "comment", messageId: fbTarget.messageId, quote: fbTarget.quote, text });
  };

  // 설정 다이얼로그
  $("#settings-btn").onclick = openSettings;
  $("#set-provider").onchange = () => fillSettingsFields($("#set-provider").value);
  $("#settings-form").onsubmit = () => {
    const s = settings();
    const p = $("#set-provider").value;
    s.provider = p;
    s.model = $("#set-model").value.trim();
    s.keys = { ...(s.keys || {}), [p]: $("#set-key").value.trim() };
    store.set("ai-settings", s);
    renderPendingFeedback();
    toast(`${PROVIDER_LABEL[p]}(으)로 설정했어요`);
  };
  $("#save-shared").onclick = async () => {
    for (const inp of $$("[data-shared]")) {
      if (inp.value.trim() || inp.dataset.clear) await act({ type: "setSharedKey", provider: inp.dataset.shared, key: inp.value.trim() });
      inp.value = "";
    }
    toast("팀 공용 키를 저장했어요");
    updateKeyStatus();
  };

  // 위임 클릭 처리
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, [data-task], [data-jump]");
    if (!t) return;
    const d = t.dataset;
    if (d.view !== undefined) { viewMember = d.view; renderSourceFilter(); renderColumns(); return; }
    if (d.chat !== undefined) { selectedConv.set(viewMember, d.chat); openedChat.add(viewMember); renderColumns(); return; }
    if (d.chatBack !== undefined) { openedChat.delete(viewMember); renderColumns(); return; }
    if (d.retention !== undefined) { openRetention(); return; }
    if (d.password !== undefined) { openPassword(); return; }
    if (d.delmsg) { if (confirm("이 메시지를 팀룸에서 삭제할까요? (다시 올라오지 않습니다)")) act({ type: "deleteMessage", messageId: d.delmsg }); return; }
    if (d.fb) openFeedback(d.fb);
    else if (d.todoc) { act({ type: "docAdd", sourceMessageId: d.todoc }); toast("공동 문서에 추가했어요"); }
    else if (d.apply) applyFeedback(d.apply);
    else if (d.unpick) { pendingFeedback = pendingFeedback.filter((x) => x !== d.unpick); renderColumns(); }
    else if (d.resolve) act({ type: "resolveComment", commentId: d.resolve });
    else if (d.deldoc) { if (confirm("이 블록을 삭제할까요?")) act({ type: "docDelete", blockId: d.deldoc }); }
    else if (d.move) act({ type: "docMove", blockId: d.move, dir: d.dir });
    else if (d.delTask) { e.stopPropagation(); act({ type: "taskDelete", taskId: d.delTask }); }
    else if (d.task) {
      const task = room.tasks.find((x) => x.id === d.task);
      const next = { todo: "doing", doing: "done", done: "todo" }[task.status];
      act({ type: "taskUpdate", taskId: task.id, status: next });
    }
    else if (d.jump) jumpTo(d.jump);
  });
}

function openFeedback(messageId) {
  const msg = room.messages.find((m) => m.id === messageId);
  const sel = window.getSelection();
  let quote = "";
  if (sel && !sel.isCollapsed && $(`[data-msg="${messageId}"]`)?.contains(sel.anchorNode)) quote = sel.toString().trim();
  fbTarget = { messageId, quote };
  $("#fb-target").textContent = msg.authorId === me ? "나" : member(msg.authorId).name;
  $("#fb-quote").textContent = quote || "(팁: 답변에서 특정 부분을 드래그한 뒤 누르면 그 부분을 인용합니다)";
  $("#fb-quote").classList.toggle("muted", !quote);
  $("#fb-text").value = "";
  $("#feedback-dialog").showModal();
}

// 받은 피드백을 내 AI 요청에 자동으로 넣기
function applyFeedback(commentId) {
  const c = room.comments.find((x) => x.id === commentId);
  if (!c) return;
  if (bridge) {
    // 데스크톱 앱: 피드백을 왼쪽 ChatGPT/Claude 입력창에 바로 넣어줌 (전송은 사용자가)
    const text = `[팀원 피드백 - ${member(c.fromId).name}]${c.quote ? `\n대상 부분: "${c.quote}"` : ""}\n의견: ${c.text}\n\n위 팀원 피드백을 반영해서 이전 답변을 수정해줘.`;
    bridge.insertToAI(text, c.id);
    if (!bridge.async) {
      act({ type: "applyComment", commentId: c.id });
      toast(bridge.clipboard ? "피드백을 복사했어요. Claude Code·Codex 입력창에 붙여넣기(Ctrl+V) 하세요!" : "왼쪽 AI 입력창에 피드백을 넣었어요. 확인 후 전송하세요!");
    }
    return;
  }
  if (!pendingFeedback.includes(c.id)) pendingFeedback.push(c.id);
  const details = $(`[data-col="${me}"] .direct-ai`);
  if (details) details.open = true;
  const ta = $(`[data-col="${me}"] textarea`);
  const lines = pendingFeedback.map((id) => room.comments.find((x) => x.id === id)).filter(Boolean).map((x) =>
    `[팀원 피드백 - ${member(x.fromId).name}]${x.quote ? `\n대상 부분: "${x.quote}"` : ""}\n의견: ${x.text}`);
  ta.value = `${lines.join("\n\n")}\n\n위 팀원 피드백을 반영해서 이전 답변을 수정해줘.`;
  ta.focus();
  renderColumns();
  toast("피드백을 입력창에 넣었어요. 다듬어서 보내세요!");
}

function jumpTo(messageId) {
  // 그 메시지를 쓴 사람의 칸으로 바꿔서 보여 줌
  const author = room.messages.find((x) => x.id === messageId)?.authorId;
  if (author && author !== viewMember) { viewMember = author; renderSourceFilter(); renderColumns(); }
  const target = room.messages.find((x) => x.id === messageId);
  if (target) {
    const key = target.convId ? `${target.source}:${target.convId}` : sourceOf(target);
    selectedConv.set(target.authorId, key);
    openedChat.add(target.authorId);
    renderColumns();
  }
  const el = $(`[data-msg="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1500);
}

function openSettings() {
  const s = settings();
  $("#set-provider").value = s.provider || "mock";
  fillSettingsFields(s.provider || "mock");
  $("#owner-keys").hidden = room.ownerId !== me;
  $("#settings-dialog").showModal();
}
function fillSettingsFields(p) {
  const s = settings();
  $("#set-model").value = p === s.provider ? s.model || "" : "";
  $("#set-model").placeholder = `기본값: ${DEFAULT_MODELS[p]}`;
  $("#set-model").disabled = p === "mock";
  $("#set-key").value = s.keys?.[p] || "";
  $("#set-key").disabled = p === "mock";
  updateKeyStatus(p);
}
function updateKeyStatus(p = $("#set-provider").value) {
  const el = $("#key-status");
  if (p === "mock") { el.textContent = "✅ 데모 모드는 키 없이 가짜 AI 답변으로 기능을 체험할 수 있어요."; return; }
  const parts = [];
  if (room.sharedKeys[p]) parts.push("팀 공용 키 ✅");
  if (room.serverKeys[p]) parts.push("서버 키 ✅");
  el.textContent = parts.length ? `개인 키가 없어도 사용 가능: ${parts.join(", ")}` : "⚠️ 팀 공용 키가 없어요. 개인 키를 입력하거나 방장에게 공용 키 등록을 부탁하세요.";
}
