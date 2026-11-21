// 확장의 두뇌: 공유 규칙 판단, 팀룸 서버로 전송, 인터넷이 끊겼을 때 대기열 보관
// askEachChat: 새 대화마다 "공유할까요?"를 물어봄 (끄면 답변이 생성된 대화를 자동 공유)
const DEFAULT_CONFIG = { roomUrl: "", sharing: true, sharedConvs: [], privateConvs: [], askEachChat: true, identity: null };

// 툴바 아이콘 클릭: 오른쪽 패널을 열고, 패널을 열 수 없으면 팀룸을 새 탭으로 엶 (어떤 경우든 화면이 뜨도록)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener((tab) => {
  const openTab = () => chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
  try {
    // 클릭 직후 바로 호출해야 함 (기다렸다 호출하면 크롬이 거부)
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(openTab);
  } catch {
    openTab();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("retry", { periodInMinutes: 0.5 });
  connectOpenTabs();
});

// ───────── 이미 열려 있던 AI 탭에도 자동 연결 (F5 안 해도 되게) ─────────
const AI_URLS = () => chrome.runtime.getManifest().content_scripts[0].matches;
let lastConnect = 0;
async function connectOpenTabs() {
  lastConnect = Date.now();
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: AI_URLS() }); } catch {}
  const failed = [];
  for (const t of tabs) {
    try {
      // 다운로드 파일 보관 도우미(페이지 안) + 대화 읽기(확장 쪽) 둘 다 연결
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["page-hook.js"], world: "MAIN" }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
    } catch (e) {
      failed.push(String(e?.message || e));
    }
  }
  await chrome.storage.session.set({ connect: { tabs: tabs.length, failed } });
  notify();
}
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("retry", { periodInMinutes: 0.5 });
  flush();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "retry") flush(); });

// ───────── 설정 (이 브라우저에 저장 → 껐다 켜도 유지) ─────────
async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...config };
}
async function setConfig(patch) {
  const config = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ config });
  notify();
  return config;
}
function roomInfo(url) {
  const u = new URL(url);
  return { origin: u.origin, roomId: u.searchParams.get("room") };
}

// ───────── 탭별 마지막 대화 (브라우저를 닫으면 지워지는 임시 저장소) ─────────
async function getSession() {
  const s = await chrome.storage.session.get(["snaps", "aiTab", "sync"]);
  return { snaps: s.snaps || {}, aiTab: s.aiTab ?? null, sync: s.sync || { online: true, waiting: 0 } };
}
const notify = () => chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
const convKey = (s) => `${s.source}:${s.convId}`;

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { snaps, aiTab } = await getSession();
  delete snaps[tabId];
  await chrome.storage.session.set({ snaps, aiTab: aiTab === tabId ? null : aiTab });
  notify();
});

// ───────── 메시지 처리 ─────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (err) => reply({ ok: false, error: String(err) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg?.type) {
    case "snapshot":
      return onSnapshot(sender.tab?.id, msg.snap);
    case "focus":
      if (sender.tab?.id != null) await chrome.storage.session.set({ aiTab: sender.tab.id });
      notify();
      return { ok: true };
    case "status":
      return status();
    case "setConfig":
      return setConfig(msg.patch);
    case "identity": {
      const config = await getConfig();
      if (!config.roomUrl || roomInfo(config.roomUrl).roomId !== msg.info?.roomId) return { ok: false };
      await setConfig({ identity: { roomId: msg.info.roomId, memberId: msg.info.memberId } });
      // 입장 전에 이미 나눈 대화도 바로 전송
      const { snaps } = await getSession();
      for (const s of Object.values(snaps)) await maybeSync(s);
      return { ok: true };
    }
    case "decide": {
      // 이 대화를 공유할지(share=true) 비공개로 둘지 결정. key가 없으면 지금 보고 있는 AI 탭의 대화
      const { snaps, aiTab } = await getSession();
      const key = msg.key || (snaps[aiTab]?.convId ? convKey(snaps[aiTab]) : null);
      if (!key) return { ok: false };
      await decide(key, !!msg.share);
      // 공유로 정했으면 지금까지의 내용을 바로 전송
      if (msg.share) for (const s of Object.values(snaps)) if (s.convId && convKey(s) === key) await maybeSync(s);
      broadcastDecision(key);
      return { ok: true };
    }
    case "insert": {
      // 피드백을 넣을 탭: 마지막으로 보고 있던 AI 탭 → 없으면 가장 최근에 대화가 바뀐 AI 탭
      const { aiTab, snaps } = await getSession();
      const recent = Object.entries(snaps).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).map(([id]) => Number(id));
      const candidates = [...new Set([aiTab, ...recent].filter((t) => t != null))];
      for (const tabId of candidates) {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: "insert-text", text: msg.text });
          if (r?.ok) {
            chrome.tabs.update(tabId, { active: true }).catch(() => {});
            await chrome.storage.session.set({ aiTab: tabId });
            return r;
          }
        } catch {}
      }
      return { ok: false, reason: "no-tab" };
    }
    default:
      return { ok: false };
  }
}

// ───────── 공유 규칙 ─────────
// · 새 대화가 시작되면(AI가 답변 생성) "공유할까요?"를 물어봄 → 공유/비공개 선택에 따름
//   (설정에서 묻기를 끄면 답변이 생성된 대화를 자동 공유)
// · 예전 대화를 열어보기만 하면 묻지도, 공유하지도 않음
// · 한 번 공유로 정한 대화는 이어지는 내용도 계속 공유, 공유 중지하면 이후 내용은 안 올라감
// · 이미 공유된 내용은 원본에서 지워도 팀룸에 남음 (삭제는 동기화하지 않음)
function decisionOf(config, key) {
  if (config.sharedConvs.includes(key)) return "shared";
  if (config.privateConvs.includes(key)) return "private";
  return "undecided";
}
async function decide(key, share) {
  const config = await getConfig();
  await setConfig({
    sharedConvs: share ? [...new Set([...config.sharedConvs, key])] : config.sharedConvs.filter((k) => k !== key),
    privateConvs: share ? config.privateConvs.filter((k) => k !== key) : [...new Set([...config.privateConvs, key])],
  });
}
// 결정이 바뀌면 그 대화가 열린 탭의 "공유할까요?" 카드를 닫도록 알림
async function broadcastDecision(key) {
  const { snaps } = await getSession();
  const config = await getConfig();
  for (const [tabId, s] of Object.entries(snaps)) {
    if (s.convId && convKey(s) === key) chrome.tabs.sendMessage(Number(tabId), { type: "decision", key, decision: decisionOf(config, key) }).catch(() => {});
  }
}

async function onSnapshot(tabId, snap) {
  if (tabId == null || !snap) return { ok: false };
  const { snaps } = await getSession();
  snaps[tabId] = { ...snap, ts: Date.now() };
  await chrome.storage.session.set({ snaps });
  let config = await getConfig();
  const key = snap.convId ? convKey(snap) : null;
  let decision = key ? decisionOf(config, key) : "undecided";
  // 임시 ID로 쓰던 대화가 진짜 ID를 받으면 그 결정을 이어받음
  if (key && decision === "undecided" && snap.renameFrom) {
    const old = decisionOf(config, `${snap.source}:${snap.renameFrom}`);
    if (old !== "undecided") { await decide(key, old === "shared"); decision = old; }
  }
  // 묻기를 끈 경우: 답변이 생성된 대화는 자동 공유
  if (key && decision === "undecided" && snap.live && config.sharing && !config.askEachChat) {
    await decide(key, true);
    decision = "shared";
  }
  await maybeSync(snap);
  notify();
  config = await getConfig();
  // 새 대화(답변 생성됨)인데 아직 결정 안 했으면 → 그 화면에 "공유할까요?" 카드 표시
  const ask = !!key && decision === "undecided" && snap.live && config.sharing && config.askEachChat && !!config.identity;
  return { ok: true, key, decision, ask };
}

async function maybeSync(snap) {
  const config = await getConfig();
  if (!snap?.convId || !config.sharing || !config.roomUrl || !config.identity) return;
  if (!config.sharedConvs.includes(convKey(snap))) return;
  const { origin, roomId } = roomInfo(config.roomUrl);
  if (config.identity.roomId !== roomId) return;
  const q = await loadQueue();
  q[`${roomId}:${convKey(snap)}`] = {
    origin, roomId, memberId: config.identity.memberId,
    source: snap.source, convId: snap.convId, convTitle: snap.convTitle, messages: snap.messages,
    renameFrom: snap.renameFrom,
  };
  // 임시 ID로 아직 못 보낸 내용은 버림 (진짜 ID 쪽에 같은 내용이 다 들어있음)
  if (snap.renameFrom) delete q[`${roomId}:${snap.source}:${snap.renameFrom}`];
  await saveQueue();
  flushSoon();
}

// ───────── AI 화면에서 파일을 다운로드하면 같은 파일을 팀룸에도 올림 ─────────
// (공유하기로 한 대화에서 받은 파일만. 비공개 대화나 다른 사이트 다운로드는 건드리지 않음)
const AI_DOWNLOAD = /(^|\.)(chatgpt\.com|openai\.com|oaiusercontent\.com|claude\.ai|gemini\.google\.com)|^blob:https:\/\/(chatgpt\.com|claude\.ai|gemini\.google\.com)/;
const hostOf = (u) => { try { return u.startsWith("blob:") ? u : new URL(u).hostname; } catch { return ""; } };
chrome.downloads.onChanged.addListener(async (d) => {
  if (d.state?.current !== "complete") return;
  const [item] = await chrome.downloads.search({ id: d.id });
  if (!item) return;
  const fromAI = [item.referrer, item.url, item.finalUrl].some((u) => u && AI_DOWNLOAD.test(hostOf(u)));
  const config = await getConfig();
  // 테스트용 가짜 AI 페이지에서 받은 파일도 허용 (테스트 빌드에서만 해당 주소가 matches에 있음)
  const fromMock = [item.referrer, item.url].some((u) => u && u.includes("/mock-ai.html"));
  if (!(fromAI || fromMock) || !config.roomUrl || !config.identity) return;

  // 어느 대화에서 받은 파일인지: 지금 보고 있는 AI 탭의 대화
  const { snaps, aiTab } = await getSession();
  const snap = snaps[aiTab];
  if (!snap?.convId || decisionOf(config, convKey(snap)) !== "shared") {
    await fileEvent(`📎 파일을 받았지만 이 대화는 공유 중이 아니라서 팀룸에 올리지 않았어요 · 위쪽에서 '공유하기'를 누른 뒤 다시 다운로드하세요`);
    return;
  }
  const name = item.filename.split(/[\\/]/).pop();
  const { origin, roomId } = roomInfo(config.roomUrl);
  const uploadUrl = `${origin}/api/rooms/${roomId}/upload?memberId=${encodeURIComponent(config.identity.memberId)}&name=${encodeURIComponent(name)}&source=${snap.source}&convId=${encodeURIComponent(snap.convId)}`;
  const src = item.finalUrl || item.url;
  let ok = false;
  const reasons = [];
  // ① 확장이 직접 받아서 올리기 → ② 안 되면 AI 화면 안에서 받아서(또는 보관해 둔 파일로) 올리기
  if (!src.startsWith("blob:") && !src.startsWith("data:")) {
    try {
      const res = await fetch(src, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      ok = (await fetch(uploadUrl, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob })).ok;
    } catch (e) { reasons.push(`확장: ${e.message || e}`); }
  }
  if (!ok && aiTab != null) {
    try {
      const r = await chrome.tabs.sendMessage(aiTab, { type: "fetch-upload", url: src, uploadUrl });
      ok = !!r?.ok;
      if (!ok) reasons.push(`화면: ${r?.error || "응답 없음"}`);
    } catch { reasons.push("화면: 연결 안 됨 (AI 탭 F5 후 다시 다운로드)"); }
  }
  const kind = src.startsWith("blob:") ? "blob" : src.startsWith("data:") ? "data" : (() => { try { return new URL(src).hostname; } catch { return "?"; } })();
  await fileEvent(ok
    ? `📎 ${name} 을(를) 팀룸에 올렸어요`
    : `⚠️ ${name} 을(를) 자동으로 올리지 못했어요 · 팀룸의 '📎 파일 올리기'로 직접 올려주세요 (원인: ${kind} / ${reasons.join(", ")})`);
});
async function fileEvent(text) {
  await chrome.storage.session.set({ fileEvent: { text, ts: Date.now() } });
  notify();
}

// ───────── 전송 대기열: 같은 대화는 최신 상태 하나만 보내면 됨 ─────────
let queue = null;
async function loadQueue() {
  if (!queue) queue = (await chrome.storage.local.get("queue")).queue || {};
  return queue;
}
const saveQueue = () => chrome.storage.local.set({ queue });

let flushTimer = null;
const flushSoon = () => { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 250); };

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  const q = await loadQueue();
  let online = true;
  for (const [key, p] of Object.entries(q)) {
    try {
      const res = await fetch(`${p.origin}/api/rooms/${encodeURIComponent(p.roomId)}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "syncExternal", memberId: p.memberId, source: p.source,
          convId: p.convId, convTitle: p.convTitle, messages: p.messages, renameFrom: p.renameFrom,
        }),
        signal: AbortSignal.timeout(10000),
      });
      // 4xx(잘못된 데이터)는 다시 보내도 소용없으므로 버림
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        if (q[key] === p) delete q[key];
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      online = false;
      break;
    }
  }
  await saveQueue();
  await chrome.storage.session.set({ sync: { online, waiting: Object.keys(q).length } });
  flushing = false;
  notify();
}

async function status() {
  const config = await getConfig();
  const { snaps, aiTab, sync } = await getSession();
  // 아직 아무 AI 탭과도 연결 안 됐으면 열려 있는 탭에 연결 시도 (5초에 한 번)
  if (!Object.keys(snaps).length && Date.now() - lastConnect > 5000) connectOpenTabs();
  const { connect, fileEvent: fe } = await chrome.storage.session.get(["connect", "fileEvent"]);
  const snap = snaps[aiTab] || null;
  return {
    config, sync, aiTabs: Object.keys(snaps).length, connect: connect || null,
    fileEvent: fe && Date.now() - fe.ts < 8000 ? fe.text : null,
    conv: snap?.convId || snap?.unreadable ? {
      source: snap.source, title: snap.convTitle, shared: config.sharedConvs.includes(convKey(snap)),
      key: snap.convId ? convKey(snap) : null, decision: snap.convId ? decisionOf(config, convKey(snap)) : "undecided", live: !!snap.live,
      unreadable: !!snap.unreadable, missingAnswer: !!snap.missingAnswer, probe: snap.probe || null,
    } : null,
  };
}
