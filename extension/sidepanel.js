// 크롬 오른쪽 사이드패널: 팀룸 화면 + 공유 상태 표시
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// AI 열기 버튼: 같은 창에 이미 열린 탭이 있으면 그 탭으로, 없으면 새로 열기 (팀룸 패널은 오른쪽에 그대로)
const AI_SITES = {
  chatgpt: { home: "https://chatgpt.com/", match: ["https://chatgpt.com/*", "https://chat.openai.com/*"] },
  claude: { home: "https://claude.ai/new", match: ["https://claude.ai/*"] },
  gemini: { home: "https://gemini.google.com/app", match: ["https://gemini.google.com/*"] },
};
document.querySelectorAll("[data-ai]").forEach((b) => (b.onclick = async () => {
  const site = AI_SITES[b.dataset.ai];
  const win = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ windowId: win.id, url: site.match });
  if (tab) await chrome.tabs.update(tab.id, { active: true });
  else await chrome.tabs.create({ windowId: win.id, url: site.home, active: true });
}));
const bg = (msg) => chrome.runtime.sendMessage(msg);
let roomOrigin = null;
let lastFileEvent = null;
let loadedRoomUrl = null;

function parseRoomUrl(v) {
  const u = new URL(v.trim());
  const roomId = u.searchParams.get("room");
  if (!roomId) throw new Error("링크에 방 정보(room=…)가 없습니다");
  return { origin: u.origin, roomId, url: `${u.origin}/?room=${encodeURIComponent(roomId)}` };
}

async function refresh() {
  let st = null;
  try {
    st = await bg({ type: "status" });
  } catch (err) {
    console.error(err);
  }
  if (!st?.config) {
    // 확장 내부가 아직 준비 안 됐거나 오류 → 빈 화면 대신 안내하고, 연결 화면은 보여줌
    $("#loading").textContent = "확장을 준비하는 중입니다… 계속 이 상태면 chrome://extensions 에서 AI 팀룸의 ↻(새로고침)을 눌러주세요.";
    $("#connect").hidden = false;
    setTimeout(refresh, 1500);
    return;
  }
  $("#loading").hidden = true;
  const { config, sync, conv } = st;
  // 파일 자동 업로드 결과 안내 (한 번만)
  if (st.fileEvent && st.fileEvent !== lastFileEvent && !noticeTimer) {
    lastFileEvent = st.fileEvent;
    setTimeout(() => notice(st.fileEvent), 0);
  }

  if (!config.roomUrl) {
    $("#connect").hidden = false;
    $("#main").hidden = true;
    return;
  }
  $("#connect").hidden = true;
  $("#main").hidden = false;

  // 팀룸 화면 (처음 한 번만 불러옴)
  if (loadedRoomUrl !== config.roomUrl) {
    loadedRoomUrl = config.roomUrl;
    roomOrigin = new URL(config.roomUrl).origin;
    // 이미 입장한 적 있으면 같은 사람으로 (ChatGPT·Claude·Gemini 화면마다 다시 입장하지 않게)
    const roomId = new URL(config.roomUrl).searchParams.get("room");
    const member = config.identity?.roomId === roomId ? `&member=${encodeURIComponent(config.identity.memberId)}` : "";
    $("#room").src = `${config.roomUrl}&embed=1&ext=1${member}`;
  }

  const share = $("#share-toggle");
  share.className = `share ${config.sharing ? "on" : "off"}`;
  share.textContent = config.sharing ? "● 팀에 공유 중" : "⏸ 공유 꺼짐";
  $("#ask-toggle").textContent = config.askEachChat ? "새 대화: 물어보기 ▾" : "새 대화: 자동 공유 ▾";
  $("#ask-toggle").hidden = !config.sharing;

  const s = $("#sync");
  s.classList.toggle("off", !sync.online);
  s.textContent = sync.online
    ? (sync.waiting ? `↻ 전송 중 (${sync.waiting})` : "● 연결됨")
    : `⚠️ 오프라인 · ${sync.waiting}개 대기 (연결되면 자동 전송)`;

  const c = $("#conv");
  if (!noticeTimer) c.classList.remove("warn");
  c.classList.remove("ask");
  if (!config.identity) c.textContent = "👇 아래 팀룸에 먼저 입장하세요";
  else if (!st.aiTabs) {
    const cn = st.connect;
    if (cn?.failed?.length) {
      // 탭은 있는데 크롬이 접근을 막음 → 사이트 액세스 설정 문제
      c.classList.add("warn");
      c.textContent = `⚠️ ChatGPT 등의 탭을 찾았지만 확장이 접근할 수 없어요 → chrome://extensions → AI 팀룸 '세부정보' → '사이트 액세스'를 '모든 사이트에서'(또는 '특정 사이트에서')로 바꿔주세요 · (${cn.failed[0]})`;
    } else if (cn && cn.tabs === 0) {
      c.textContent = "🔎 크롬에 열린 ChatGPT·Claude·Gemini 탭이 없어요 · 새 탭에서 chatgpt.com 을 열어주세요 (ChatGPT 데스크톱 앱에서 한 대화는 공유되지 않아요)";
    } else {
      c.textContent = "🔄 열려 있는 AI 탭에 연결하는 중…";
    }
  }
  else if (!conv) c.textContent = "💬 AI 탭에서 대화를 시작하면 자동으로 공유됩니다";
  else if (conv.unreadable) {
    // 대화를 읽지 못함 → 거짓으로 "공유 중"이라 하지 않고 원인 표시 (캡처해서 보내면 바로 고칠 수 있게)
    c.classList.add("warn");
    c.textContent = conv.missingAnswer
      ? `⚠️ ${conv.source}: 질문은 읽었지만 AI 답변을 찾지 못했어요. 이 문구를 캡처해서 보내주세요 · 진단: ${JSON.stringify(conv.probe)}`
      : `⚠️ 이 ${conv.source} 화면에서 대화를 읽지 못했어요. 이 문구를 캡처해서 보내주세요 · 진단: ${JSON.stringify(conv.probe)}`;
    return;
  }
  else if (!config.sharing) c.textContent = "이 대화는 공유되지 않습니다";
  else {
    // 지금 보고 있는 대화의 공유 상태 + 바꾸는 버튼
    const title = esc(conv.title || "");
    if (conv.decision === "shared") {
      c.innerHTML = `✅ 이 대화 공유 중 · ${title} <button data-decide="0">공유 중지</button>`;
    } else if (conv.decision === "private") {
      c.innerHTML = `🔒 비공개 대화 · ${title} <button data-decide="1">공유하기</button>`;
    } else if (conv.live) {
      c.classList.add("ask");
      c.innerHTML = `❓ 이 새 대화를 팀룸에 공유할까요? <button class="primary" data-decide="1">공유하기</button><button data-decide="0">비공개</button>`;
    } else {
      c.innerHTML = `💬 예전 대화 (공유 안 됨) · ${title} <button data-decide="1">이 대화 공유하기</button>`;
    }
    c.querySelectorAll("[data-decide]").forEach((b) => (b.onclick = () => bg({ type: "decide", key: conv.key, share: b.dataset.decide === "1" })));
  }
}

$("#connect-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#connect-error").textContent = "";
  try {
    const info = parseRoomUrl($("#room-url").value);
    const res = await fetch(`${info.origin}/api/rooms/${info.roomId}/state`).catch(() => null);
    if (!res) throw new Error("팀룸 서버에 연결할 수 없습니다. 주소를 확인하세요");
    if (!res.ok) throw new Error("존재하지 않는 팀룸입니다");
    await bg({ type: "setConfig", patch: { roomUrl: info.url, identity: null } });
    refresh();
  } catch (err) {
    $("#connect-error").textContent = /Invalid URL/i.test(err.message) ? "올바른 링크가 아닙니다" : err.message;
  }
};

$("#share-toggle").onclick = async () => {
  const st = await bg({ type: "status" });
  await bg({ type: "setConfig", patch: { sharing: !st.config.sharing } });
};

$("#ask-toggle").onclick = async () => {
  const st = await bg({ type: "status" });
  await bg({ type: "setConfig", patch: { askEachChat: !st.config.askEachChat } });
};

$("#menu").onclick = async () => {
  if (!confirm("다른 팀룸으로 연결할까요?\n(이미 공유된 내용은 지금 팀룸에 그대로 남습니다)")) return;
  await bg({ type: "setConfig", patch: { roomUrl: "", identity: null } });
  loadedRoomUrl = null;
  $("#room").src = "about:blank";
  refresh();
};

// 팀룸 화면에서 오는 요청 (입장 정보, 피드백 넣기)
window.addEventListener("message", async (e) => {
  if (e.origin !== roomOrigin || !e.data?.teamroom) return;
  if (e.data.type === "identity") {
    await bg({ type: "identity", info: { roomId: e.data.roomId, memberId: e.data.memberId } });
  } else if (e.data.type === "insert") {
    const r = await bg({ type: "insert", text: e.data.text });
    $("#room").contentWindow.postMessage({ teamroom: true, type: "insert-result", ok: !!r?.ok, commentId: e.data.commentId }, roomOrigin);
    if (!r?.ok) notice("⚠️ 피드백을 넣을 AI 탭을 찾지 못했어요. ChatGPT·Claude·Gemini 대화 탭을 연 뒤 다시 눌러주세요.");
  }
});

// 잠깐 보여주는 안내 (팝업 대신 상단 바에 표시)
let noticeTimer = null;
function notice(text) {
  const c = $("#conv");
  c.textContent = text;
  c.classList.add("warn");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { c.classList.remove("warn"); noticeTimer = null; refresh(); }, 5000);
}

chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "changed" && !noticeTimer) refresh(); });
refresh();
