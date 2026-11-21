// AI팀룸 데스크톱 앱 — 메인 프로세스
// 왼쪽: 진짜 ChatGPT/Claude/Gemini 웹 화면 (각자 로그인, API 키 불필요)
// 오른쪽: 팀룸 패널. 왼쪽에서 나눈 대화가 자동으로 팀룸에 공유됨
const { app, BrowserWindow, ipcMain, session, shell, webContents } = require("electron");
const path = require("path");
const fs = require("fs");

const TEST = process.env.TEAMROOM_TEST === "1";
if (TEST) app.setPath("userData", path.join(app.getPath("temp"), `ai-teamroom-test-${Date.now()}`));
// --panel: Claude Code·Codex 옆에 띄우는 "팀룸 패널" 전용 모드 (AI 화면 없이 팀룸만, 화면 오른쪽에 붙음)
// 커넥터가 설정된 PC에서는 그냥 더블클릭해도 팀룸 패널로 열림 (앱 안에서 ChatGPT를 쓰는 예전 화면은 --full)
const connectorReady = fs.existsSync(path.join(process.env.TEAMROOM_HOME || require("os").homedir(), ".ai-teamroom", "connector.json"));
const PANEL = process.argv.includes("--panel") || (!TEST && !process.argv.includes("--full") && connectorReady);
// (테스트로 홈 폴더를 바꿔 띄울 때는 저장 폴더도 따로 → 실제로 떠 있는 팀룸 창과 섞이지 않게)
if (PANEL) app.setPath("userData", process.env.TEAMROOM_HOME ? path.join(process.env.TEAMROOM_HOME, ".ai-teamroom", "panel-data") : app.getPath("userData") + "-panel");

// 팀룸 창 모드: 창을 숨겼다 다시 보여 줄 때 내용이 하얗게 비는 문제 방지
//  · 그래픽 가속 끄기 (일부 노트북 그래픽 드라이버에서 다시 보인 창이 안 그려짐 — 이 앱은 가속이 필요 없음)
//  · "가려진 창은 그리지 않기" 끄기 (다른 창에 가려졌다고 잘못 판단하면 계속 하얗게 남음)
if (PANEL) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

// 일부 사이트(특히 구글 로그인)는 "Electron"이 들어간 브라우저를 막으므로 일반 크롬처럼 보이게 함
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|AI팀룸|ai-teamroom-desktop)\/\S+/g, "");

// ───────── 설정 저장 (내 PC: %APPDATA%/AI팀룸) ─────────
const userData = () => app.getPath("userData");
const configFile = () => path.join(userData(), "config.json");
const queueFile = () => path.join(userData(), "queue.json");

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

let config = null;
function loadConfig() {
  // askEachChat: 새 대화마다 공유할지 물어봄 (자동 테스트에서는 묻지 않고 자동 공유)
  config = { roomUrl: "", sharing: true, sharedConvs: [], privateConvs: [], askEachChat: !TEST, aiTab: "chatgpt", identity: null, ...readJSON(configFile(), {}) };
  if (TEST && process.env.TEAMROOM_ROOM_URL) config.roomUrl = process.env.TEAMROOM_ROOM_URL;
}

// ───────── 동기화 대기열: 인터넷이 끊겨도 내 PC에 보관했다가 다시 전송 ─────────
const pending = new Map(); // "방:출처:대화" -> 최신 대화 스냅샷 (같은 대화는 최신 것 하나만 보내면 됨)
let online = true;
let flushing = false;
let persistTimer = null;

function persistQueue() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => writeJSON(queueFile(), [...pending.entries()]), 300);
}
function sendStatus() {
  mainWindow?.webContents.send("sync-status", { online, waiting: pending.size });
}

async function flush() {
  if (flushing || !pending.size) { sendStatus(); return; }
  flushing = true;
  for (const [key, p] of [...pending]) {
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
      // 4xx(잘못된 데이터)는 재시도해도 소용없으므로 버림
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        if (res.status >= 400) console.warn("동기화 거부:", res.status, await res.text());
        if (pending.get(key) === p) pending.delete(key);
        online = true;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      online = false;
      break;
    }
  }
  flushing = false;
  persistQueue();
  sendStatus();
}
let kickTimer = null;
const kick = () => { clearTimeout(kickTimer); kickTimer = setTimeout(flush, 250); };

ipcMain.on("sync", (_e, p) => {
  if (!p?.origin || !p.roomId || !p.memberId || !p.convId) return;
  pending.set(`${p.roomId}:${p.source}:${p.convId}`, p);
  if (p.renameFrom) pending.delete(`${p.roomId}:${p.source}:${p.renameFrom}`); // 임시 ID 쪽 미전송분은 진짜 ID 쪽에 포함됨
  persistQueue();
  kick();
});
ipcMain.handle("config:get", () => config);
ipcMain.handle("config:set", (_e, patch) => {
  Object.assign(config, patch);
  writeJSON(configFile(), config);
  return config;
});
ipcMain.handle("test:is", () => TEST);

// ───────── 창과 웹뷰 보안 설정 ─────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "AI팀룸",
    backgroundColor: "#f5f6f8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload", "shell-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  // 웹뷰마다 정해진 preload만 쓰도록 강제 (페이지가 임의로 바꿀 수 없게)
  mainWindow.webContents.on("will-attach-webview", (_e, prefs, params) => {
    delete prefs.preloadURL;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    const preloadName = params.partition === "persist:room" ? "room-preload.js" : "ai-preload.js";
    prefs.preload = path.join(__dirname, "preload", preloadName);
  });

  mainWindow.loadFile(path.join(__dirname, "shell", "index.html"));
  mainWindow.webContents.on("did-finish-load", sendStatus);
}

app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() !== "webview") return;
  const isRoom = () => contents.session === session.fromPartition("persist:room");
  contents.setWindowOpenHandler(({ url }) => {
    // 팀룸의 외부 링크는 기본 브라우저로, AI 사이트의 로그인 팝업(구글 로그인 등)은 앱 안에서 허용
    if (isRoom()) { shell.openExternal(url); return { action: "deny" }; }
    return {
      action: "allow",
      overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition: "persist:ai" } },
    };
  });
});

// ───────── 팀룸 패널 모드 ─────────
function runPanel() {
  const { screen, Menu, clipboard, dialog } = require("electron");
  const os = require("os");
  // 커넥터 설정(방 주소·내 참여자 ID)을 그대로 사용 → 커넥터가 올린 대화와 같은 사람으로 보임
  const cfg = readJSON(path.join(process.env.TEAMROOM_HOME || os.homedir(), ".ai-teamroom", "connector.json"), null);
  if (!cfg?.roomUrl) {
    dialog.showErrorBox("AI 팀룸 패널", "먼저 커넥터를 설정하세요:\nnode teamroom-connector.mjs setup");
    app.quit();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const saved = readJSON(path.join(userData(), "panel.json"), {});
  const width = Math.min(Math.max(saved.width || 440, 320), area.width);
  const win = new BrowserWindow({
    x: area.x + area.width - width, y: area.y, width, height: area.height,
    minWidth: 320, title: "AI 팀룸", backgroundColor: "#f5f6f8",
    show: false,
    alwaysOnTop: saved.pinned === true, // 기본은 일반 창: 누른 창이 앞으로 옴 (메뉴에서 "항상 위"를 켠 경우만 고정)
    webPreferences: { preload: path.join(__dirname, "preload", "panel-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow = win;
  // (방을 바꾸면 cfg.roomUrl·memberId가 바뀌므로 주소는 그때그때 만듦)
  const panelUrl = () => `${cfg.roomUrl}${cfg.roomUrl.includes("?") ? "&" : "?"}embed=1&member=${encodeURIComponent(cfg.memberId || "")}`;
  win.loadURL(panelUrl());
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<body style="font:14px 'Malgun Gothic',sans-serif;padding:24px"><h3>팀룸에 연결할 수 없어요</h3><p>${cfg.roomUrl}</p><p>팀룸 서버(방장 PC)가 켜져 있는지 확인한 뒤 <b>보기 → 새로고침</b>을 누르세요.</p><p>방장 PC를 껐다 켜면 <b>주소가 바뀝니다.</b> 새 초대 링크를 받아서 메뉴 <b>방 → 방 바꾸기 · 새 방 만들기…</b>의 "초대 링크로 들어가기"에 붙여넣으세요. 설정과 공유 목록은 그대로 유지됩니다.</p><p style="color:#888">${desc} (${code})</p></body>`));
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  ipcMain.on("panel-copy", (_e, text) => clipboard.writeText(String(text)));
  const save = () => writeJSON(path.join(userData(), "panel.json"), { width: win.getBounds().width, pinned: win.isAlwaysOnTop() });
  win.on("resized", save);
  // ───── 커넥터를 팀룸 창이 직접 켜고 관리 (터미널을 켜 둘 필요 없음, Node.js 설치 없이도 실행) ─────
  // 앱에 들어 있는 커넥터를 ~/.ai-teamroom 에 최신으로 맞춰 두고, 꺼져 있거나 예전 버전이면 다시 실행
  const homeDir = path.join(process.env.TEAMROOM_HOME || os.homedir(), ".ai-teamroom");
  const statusFile = path.join(homeDir, "status.json");
  const bundled = path.join(__dirname, "connector", "teamroom-connector.mjs");
  const installedConnector = path.join(homeDir, "teamroom-connector.mjs");
  let bundledVersion = null;
  try { bundledVersion = fs.readFileSync(bundled, "utf8").match(/const VERSION = "([^"]+)"/)?.[1] || null; } catch {}
  const connectorStatus = () => {
    const st = readJSON(statusFile, null);
    return { ...(st || {}), running: !!st && Date.now() - st.ts < 15000, bundledVersion };
  };
  // 커넥터는 PC에 설치된 Node.js로 띄움 (있을 때).
  // 이 앱의 실행 파일로 띄우면, 팀룸 창을 닫은 뒤에도 커넥터가 앱의 임시 실행 폴더를 붙잡고 있어서
  // exe를 다시 실행할 때 창이 아주 늦게 뜨거나 안 뜸
  let nodeExe;
  function findNode() {
    if (nodeExe !== undefined) return nodeExe;
    nodeExe = null;
    try {
      const { execFileSync } = require("child_process");
      // (where.exe 출력은 한글 경로가 깨지므로 PATH 폴더를 직접 살펴봄)
      const found = (process.env.PATH || process.env.Path || "").split(";").map((d) => path.join(d.trim().replace(/^"|"$/g, ""), "node.exe")).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
      if (found && Number(execFileSync(found, ["-v"], { encoding: "utf8", windowsHide: true }).match(/^v(\d+)/)?.[1]) >= 18) nodeExe = found;
    } catch {}
    return nodeExe;
  }
  let lastStart = 0;
  let ownConnector = false; // 이 앱의 실행 파일로 띄운 커넥터가 있는지 (Node.js가 없는 PC)
  function ensureConnector() {
    if (!bundledVersion || Date.now() - lastStart < 20000) return;
    const st = connectorStatus();
    if (st.running && st.version === bundledVersion) return;
    lastStart = Date.now();
    try {
      if (st.running && st.pid) { try { process.kill(st.pid); } catch {} } // 예전 버전이 돌고 있으면 끄고 새로
      fs.writeFileSync(installedConnector, fs.readFileSync(bundled));
      const { spawn } = require("child_process");
      const node = findNode();
      const env = { ...process.env };
      if (node) delete env.ELECTRON_RUN_AS_NODE; else env.ELECTRON_RUN_AS_NODE = "1";
      spawn(node || process.execPath, [installedConnector, "run"], { env, detached: true, stdio: "ignore", windowsHide: true }).unref();
      ownConnector = !node;
    } catch (e) { console.error("커넥터 시작 실패:", e); }
  }
  ensureConnector();
  setInterval(ensureConnector, 5000);
  // Node.js가 없어서 이 앱의 실행 파일로 띄운 커넥터는 앱을 끝낼 때 같이 끔 (다음 실행을 막지 않도록) → 다시 실행하면 다시 켜짐
  app.on("quit", () => {
    if (!ownConnector) return;
    const st = readJSON(statusFile, null);
    if (st?.pid) { try { process.kill(st.pid); } catch {} }
  });
  ipcMain.handle("sessions:status", () => connectorStatus());

  // ───── 대화별 공유 허가: 커넥터가 새 대화를 "ask"로 적어 두면 작은 창을 띄워 물어봄 ─────
  const sessionsFile = path.join(process.env.TEAMROOM_HOME || os.homedir(), ".ai-teamroom", "sessions.json");
  let manageWin = null;
  // 문제가 생기면 원인을 볼 수 있게 내 PC에 기록 (~/.ai-teamroom/panel-error.log)
  const logError = (where, e) => { try { fs.appendFileSync(path.join(homeDir, "panel-error.log"), `${new Date().toISOString()} ${where}: ${e?.stack || e}\n`); } catch {} };
  process.on("uncaughtException", (e) => logError("uncaught", e));
  // 다시 보여 준 창이 하얗게 비어 있지 않게: 화면을 강제로 다시 그리고, 내용이 응답하지 않으면 페이지를 새로 불러옴
  function healManage(w) {
    try { w.webContents.invalidate(); } catch {}
    setTimeout(async () => {
      if (w.isDestroyed() || !w.isVisible()) return;
      const ok = await Promise.race([
        w.webContents.executeJavaScript(`!!document.querySelector("#list") && document.body.innerText.length > 10`).catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 2000)),
      ]);
      if (ok) { try { w.webContents.invalidate(); } catch {} return; }
      logError("manage", "내용이 비어 있어 다시 불러옴");
      try { w.loadFile(path.join(__dirname, "shell", "sessions.html")); } catch (e) { logError("manage(reload)", e); }
    }, 800);
  }
  function openManage(focus) {
    try {
      if (manageWin && !manageWin.isDestroyed()) {
        if (manageWin.isMinimized()) manageWin.restore();
        if (focus) { manageWin.show(); manageWin.focus(); } else manageWin.showInactive();
        manageWin.webContents.send("sessions:changed");
        healManage(manageWin);
        return;
      }
    } catch (e) { logError("openManage(reuse)", e); try { manageWin.destroy(); } catch {} manageWin = null; }
    const a = screen.getPrimaryDisplay().workArea;
    manageWin = new BrowserWindow({
      // 팀룸 창 왼쪽에 붙이되, 화면 밖으로 나가지 않게
      width: 420, height: 560, x: Math.max(a.x + 8, a.x + a.width - 420 - win.getBounds().width - 12), y: a.y + 12,
      title: "대화 공유 · 방 관리", alwaysOnTop: true, show: false, minimizable: false, maximizable: false, autoHideMenuBar: true,
      backgroundColor: "#f5f6f8",
      webPreferences: { preload: path.join(__dirname, "preload", "sessions-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    manageWin.setMenu(null);
    manageWin.loadFile(path.join(__dirname, "shell", "sessions.html"));
    const created = manageWin;
    created.once("ready-to-show", () => { if (!created.isDestroyed()) { focus ? created.show() : created.showInactive(); healManage(created); } });
    // 화면이 안 나올 때 원인을 기록
    created.webContents.on("did-fail-load", (_e, code, desc) => logError("manage(load)", `${code} ${desc}`));
    created.webContents.on("render-process-gone", (_e, d) => { logError("manage(renderer)", JSON.stringify(d)); if (!created.isDestroyed()) created.loadFile(path.join(__dirname, "shell", "sessions.html")); });
    created.on("unresponsive", () => logError("manage", "응답 없음"));
    // X로 닫으면 없애지 않고 숨기기만 함 → 다시 열 때 새로 만들지 않고 그대로 보여 줌 (닫았다 다시 열 때 오류가 나던 문제)
    created.on("close", (e) => { if (!quitting && !win.isDestroyed()) { e.preventDefault(); created.hide(); } });
  }
  let quitting = false; // 앱을 끝내는 중이면 관리 창도 진짜로 닫음
  app.on("before-quit", () => { quitting = true; });
  // ───── 방 여러 개: 새 방 만들기 · 초대 링크로 들어가기 · 방 바꾸기 ─────
  // 커넥터 설정(connector.json)의 roomUrl·memberId가 "지금 방"이고, rooms에 들어가 본 방들을 기억함
  // 방을 바꾸면 그때부터 공유하는 대화가 새 방으로 올라감 (대화별 공유 허가는 방마다 따로)
  const cfgFile = path.join(homeDir, "connector.json");
  const roomIdOf = (u) => { try { return new URL(u).searchParams.get("room"); } catch { return null; } };
  // 같은 방인지는 방 ID로만 판단 (서버 주소는 본체를 껐다 켜면 바뀔 수 있음 → 새 주소의 링크를 넣으면 같은 방의 주소만 갈아 끼움)
  const sameRoom = (a, b) => { const x = roomIdOf(a); return !!x && x === roomIdOf(b); };
  const roomList = () => {
    const list = Array.isArray(cfg.rooms) ? cfg.rooms.map((r) => ({ ...r })) : [];
    if (!list.some((r) => sameRoom(r.roomUrl, cfg.roomUrl))) list.unshift({ roomUrl: cfg.roomUrl, memberId: cfg.memberId, title: "" });
    return list;
  };
  const saveCfg = (patch) => {
    const cur = { ...readJSON(cfgFile, cfg), ...patch }; // (일시정지 등 커넥터가 바꾼 값은 유지)
    writeJSON(cfgFile, cur);
    Object.assign(cfg, cur);
  };
  const api = async (origin, p, body) => {
    const r = await fetch(origin + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) } : { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(r.status === 404 ? "그런 방이 없어요" : `팀룸 서버 응답 ${r.status}`);
    return r.json();
  };
  async function enterRoom(link) {
    let u;
    try { u = new URL(String(link).trim()); } catch { throw new Error("초대 링크를 그대로 붙여넣어 주세요"); }
    const rid = u.searchParams.get("room");
    if (!rid) throw new Error("초대 링크가 아니에요 (주소에 ?room=… 이 있어야 해요)");
    const state = await api(u.origin, `/api/rooms/${rid}/state`);
    const list = roomList();
    let entry = list.find((r) => sameRoom(r.roomUrl, u.href));
    if (!entry || !state.members[entry.memberId]) {
      // 같은 이름이 이미 있으면 같은 사람으로 연결, 없으면 새로 입장
      const same = Object.values(state.members).find((m) => m.name === cfg.name);
      const memberId = same ? same.id : (await api(u.origin, `/api/rooms/${rid}/action`, { type: "join", name: cfg.name })).member.id;
      if (entry) entry.memberId = memberId; else { entry = { memberId }; list.push(entry); }
    }
    entry.roomUrl = `${u.origin}/?room=${rid}`; // 주소가 바뀐 경우 새 주소로
    entry.title = state.name;
    saveCfg({ rooms: list, roomUrl: entry.roomUrl, memberId: entry.memberId });
    win.loadURL(panelUrl());
    return state.name;
  }
  const guard = (fn) => async (...args) => { try { return { ok: true, value: await fn(...args) }; } catch (e) { logError("rooms", e); return { ok: false, error: String(e?.message || e) }; } };
  ipcMain.handle("rooms:list", guard(async () => {
    const list = roomList();
    let invite = cfg.roomUrl;
    // 이름을 아직 모르는 방은 서버에 물어봄 (연결이 안 되면 주소만 보여 줌)
    await Promise.all(list.map(async (r) => {
      const cur = sameRoom(r.roomUrl, cfg.roomUrl);
      if (r.title && !cur) return;
      try {
        const u = new URL(r.roomUrl);
        const st = await api(u.origin, `/api/rooms/${roomIdOf(r.roomUrl)}/state`);
        r.title = st.name;
        if (cur) invite = `${st.publicOrigin || u.origin}/?room=${st.id}`;
      } catch {}
    }));
    if (list.some((r, i) => r.title !== (cfg.rooms || [])[i]?.title)) saveCfg({ rooms: list });
    return { current: cfg.roomUrl, invite, name: cfg.name, rooms: list.map((r) => ({ roomUrl: r.roomUrl, title: r.title || roomIdOf(r.roomUrl), current: sameRoom(r.roomUrl, cfg.roomUrl) })) };
  }));
  ipcMain.handle("rooms:switch", guard((_e, roomUrl) => enterRoom(roomUrl)));
  ipcMain.handle("rooms:add", guard((_e, link) => enterRoom(link)));
  ipcMain.handle("rooms:create", guard(async (_e, name) => {
    const title = String(name || "").trim().slice(0, 50);
    if (!title) throw new Error("방 이름을 입력하세요");
    const origin = new URL(cfg.roomUrl).origin;
    const { id } = await api(origin, "/api/rooms", { name: title });
    return enterRoom(`${origin}/?room=${id}`);
  }));
  ipcMain.handle("rooms:copy", (_e, text) => { clipboard.writeText(String(text)); return true; });
  // 대화별 공유 허가는 방마다 따로: 다른 방에 공유하기로 한 대화는 이 방에서는 비공개로 보임
  ipcMain.handle("sessions:list", () => {
    const here = roomIdOf(cfg.roomUrl);
    const all = readJSON(sessionsFile, {});
    for (const d of Object.values(all)) if (d.status === "shared" && d.room && d.room !== here) d.status = "private";
    return all;
  });
  ipcMain.handle("sessions:set", (_e, id, status) => {
    if (!["shared", "private"].includes(status)) return false;
    const all = readJSON(sessionsFile, {});
    if (!all[id]) return false;
    // 사용자가 직접 정함 → 공유로 고르면 그 대화 전체(커넥터 설치 전 내용 포함)를 올림
    all[id] = { ...all[id], status, decided: true, ...(status === "shared" ? { full: true, room: roomIdOf(cfg.roomUrl) } : {}) };
    writeJSON(sessionsFile, all);
    return true;
  });
  // 이미 물어본(창을 띄운) 대화 — 비공개였다가 나중에 "물어보기"로 바뀐 대화도 다시 잡히도록, 물어보는 중인 것만 기억
  const asked = new Set();
  const checkSessions = () => {
    const all = readJSON(sessionsFile, {});
    for (const [id, d] of Object.entries(all)) if (d.status !== "ask") asked.delete(id);
    const newAsk = Object.entries(all).filter(([id, d]) => d.status === "ask" && !asked.has(id));
    for (const [id] of newAsk) asked.add(id);
    if (newAsk.length) openManage(false); // 새로 물어볼 대화가 생김 → 창 띄우기 (포커스는 뺏지 않음)
    try { if (manageWin && !manageWin.isDestroyed() && manageWin.isVisible()) manageWin.webContents.send("sessions:changed"); } catch (e) { logError("checkSessions", e); }
  };
  setInterval(checkSessions, 1500);
  setTimeout(checkSessions, 800);
  // 팀룸 창을 닫으면 관리 창도 같이 닫고 앱을 끝냄
  // (관리 창만 남아 앱이 살아 있으면, exe를 다시 실행해도 팀룸 창이 안 뜸)
  win.on("closed", () => {
    if (manageWin && !manageWin.isDestroyed()) manageWin.destroy();
    app.quit();
  });
  if (process.env.TEAMROOM_MANAGE_OPEN) setTimeout(() => openManage(true), 2500); // (테스트용: 관리 창을 띄워 둔 상태 만들기)

  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: "공유",
    submenu: [{ label: "대화 공유 관리…", click: () => openManage(true) }],
  }, {
    label: "방",
    submenu: [{ label: "방 바꾸기 · 새 방 만들기…", click: () => openManage(true) }],
  }, {
    label: "보기",
    submenu: [
      { label: "항상 다른 창 위에", type: "checkbox", checked: win.isAlwaysOnTop(), click: (item) => { win.setAlwaysOnTop(item.checked); save(); } },
      { label: "화면 오른쪽에 붙이기", click: () => { const a = screen.getPrimaryDisplay().workArea; const w = win.getBounds().width; win.setBounds({ x: a.x + a.width - w, y: a.y, width: w, height: a.height }); } },
      { label: "새로고침", accelerator: "F5", click: () => win.loadURL(panelUrl()) },
    ],
  }]));
  // 커넥터가 자동으로 띄울 때(--background)는 쓰던 창의 포커스를 뺏지 않고 옆에 조용히 표시, 직접 열면 앞으로
  if (process.argv.includes("--background") || process.argv.includes("--notify-done")) win.showInactive(); else win.show();
  // 커넥터가 패널이 떠 있는지 알 수 있게 표시 파일을 남김
  const pidFile = path.join(process.env.TEAMROOM_HOME || os.homedir(), ".ai-teamroom", "panel.pid");
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}
  app.on("quit", () => { try { fs.unlinkSync(pidFile); } catch {} });
  // 이미 떠 있을 때 다시 실행되면: 요청에 따라 최소화 / 완료 알림(작업표시줄 깜빡임) / 앞으로 꺼내기
  app.on("second-instance", (_e, argv) => {
    if (argv.includes("--notify-done")) { if (!win.isFocused()) { win.flashFrame(true); setTimeout(() => !win.isDestroyed() && win.flashFrame(false), 8000); } return; }
    if (win.isDestroyed()) { app.relaunch({ args: process.argv.slice(1).filter((a) => a !== "--background" && a !== "--notify-done") }); app.quit(); return; } // 창이 없는 채로 남은 경우 → 새로 띄움
    if (argv.includes("--background")) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.moveTop();
  });
  win.on("focus", () => win.flashFrame(false));
  // 자가 테스트: 관리 창에서 새 방 만들기 → 원래 방으로 돌아오기
  if (process.env.TEAMROOM_ROOMS_TEST) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const js = (code) => manageWin.webContents.executeJavaScript(code).catch((e) => String(e));
    const snap = async (label) => ({ label, rooms: await js(`[...document.querySelectorAll(".room")].map(r => r.className + " | " + r.innerText.replace(/\\s+/g, " "))`), msg: await js(`document.querySelector("#room-msg").textContent`), cfgRoom: readJSON(cfgFile, {}).roomUrl, panel: win.webContents.getURL(), title: win.getTitle() });
    setTimeout(async () => {
      const result = [];
      try {
        openManage(true);
        await wait(3000);
        result.push(await snap("처음"));
        if (process.env.TEAMROOM_ADD_LINK) {
          // 서버 주소가 바뀐 상황: 같은 방의 새 주소 링크를 붙여넣음 → 방이 늘지 않고 주소만 바뀌어야 함
          await js(`document.querySelector("#room-add input").value = ${JSON.stringify(process.env.TEAMROOM_ADD_LINK)}; document.querySelector("#room-add").requestSubmit(); true`);
          await wait(3500);
          result.push({ ...(await snap("새 주소 링크를 넣은 뒤")), member: readJSON(cfgFile, {}).memberId });
          writeJSON(process.env.TEAMROOM_ROOMS_TEST, result);
          app.quit();
          return;
        }
        await js(`document.querySelector("#room-create input").value = "자동 테스트 방"; document.querySelector("#room-create").requestSubmit(); true`);
        await wait(3500);
        result.push(await snap("새 방 만든 뒤"));
        await js(`document.querySelector(".room:not(.current) button").click(); true`);
        await wait(3500);
        result.push(await snap("원래 방으로 돌아온 뒤"));
      } catch (e) { result.push({ error: String(e?.stack || e) }); }
      writeJSON(process.env.TEAMROOM_ROOMS_TEST, result);
      app.quit();
    }, 4000);
  }
  // 자가 테스트: 관리 창을 열고 → 닫고 → 다시 열었을 때도 목록이 나오는지
  if (process.env.TEAMROOM_MANAGE_TEST) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const snap = async () => ({
      exists: !!(manageWin && !manageWin.isDestroyed()),
      visible: !!(manageWin && !manageWin.isDestroyed() && manageWin.isVisible()),
      rows: manageWin && !manageWin.isDestroyed() ? await manageWin.webContents.executeJavaScript(`document.querySelectorAll(".row").length + "행 / " + (document.querySelector("#diag")?.innerText || "").split("\\n")[0]`).catch((e) => String(e)) : null,
    });
    setTimeout(async () => {
      const result = [];
      try {
        process.on("uncaughtException", (e) => result.push({ uncaught: String(e?.stack || e) }));
        for (let i = 0; i < 3; i++) {
          // 첫 번째는 자동으로 뜬 창 그대로, 그다음부터는 실제 메뉴(공유 → 대화 공유 관리…)를 눌러서 엶
          if (i > 0 || !(manageWin && !manageWin.isDestroyed())) Menu.getApplicationMenu().items[0].submenu.items[0].click();
          await wait(2500);
          result.push({ round: i + 1, ...(await snap()) });
          if (manageWin && !manageWin.isDestroyed()) manageWin.close();
          await wait(1200);
        }
      } catch (e) { result.push({ error: String(e?.stack || e) }); }
      writeJSON(process.env.TEAMROOM_MANAGE_TEST, result);
      app.quit();
    }, 4000);
  }
  if (process.env.TEAMROOM_PANEL_TEST) {
    setTimeout(async () => {
      const out = process.env.TEAMROOM_PANEL_TEST;
      const info = await win.webContents.executeJavaScript(`({ mine: document.querySelector(".col.mine .col-title b")?.textContent || null, joinOpen: !!document.querySelector("#join-dialog")?.open, bridge: !!window.desktopBridge?.clipboard, groups: document.querySelectorAll("details.conv-group").length })`).catch((e) => ({ error: String(e) }));
      fs.writeFileSync(out.replace(/\.json$/, ".png"), (await win.webContents.capturePage()).toPNG());
      // 물어보는 창이 떴는지, 거기서 "공유하기"를 누르면 결정이 저장되는지
      let ask = { opened: !!(manageWin && !manageWin.isDestroyed()) };
      if (ask.opened) {
        ask.rows = await manageWin.webContents.executeJavaScript(`[...document.querySelectorAll(".row")].map(r => r.className + " | " + r.innerText.replace(/\\s+/g, " "))`).catch((e) => [String(e)]);
        fs.writeFileSync(out.replace(/\.json$/, "-ask.png"), (await manageWin.webContents.capturePage()).toPNG());
        await manageWin.webContents.executeJavaScript(`document.querySelector(".row.ask button.primary")?.click()`).catch(() => {});
        await new Promise((r) => setTimeout(r, 700));
        ask.after = readJSON(sessionsFile, {});
      }
      writeJSON(out, { ...info, bounds: win.getBounds(), area, onTop: win.isAlwaysOnTop(), ask, connector: connectorStatus() });
      app.quit();
    }, 10000);
  }
}

app.whenReady().then(() => {
  if (PANEL) {
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    runPanel();
    return;
  }
  loadConfig();
  for (const [k, v] of readJSON(queueFile(), [])) pending.set(k, v);
  createWindow();
  setInterval(flush, 5000); // 오프라인이었다면 주기적으로 재시도
  flush();
  if (TEST) runSelfTest();
});
app.on("window-all-closed", () => {
  if (pending.size) writeJSON(queueFile(), [...pending.entries()]);
  app.quit();
});

// ───────── 자동 자가 테스트 (TEAMROOM_TEST=1) ─────────
// 가짜 AI 페이지에서 대화 → 팀룸 동기화 → 팀원 피드백 → 입력창 삽입까지 확인
async function runSelfTest() {
  const out = process.env.TEAMROOM_TEST_OUT || path.join(userData(), "test-result.json");
  const result = { steps: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (name, ok, detail) => { result.steps.push({ name, ok, detail }); console.log(ok ? "✅" : "❌", name, detail ?? ""); };
  const findWC = (partition) => webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.session === session.fromPartition(partition));
  try {
    const roomURL = new URL(config.roomUrl);
    const origin = roomURL.origin;
    const roomId = roomURL.searchParams.get("room");
    await wait(4000);
    const roomWC = findWC("persist:room");
    const aiWC = findWC("persist:ai");
    step("웹뷰 생성", !!roomWC && !!aiWC);

    await roomWC.executeJavaScript(`document.querySelector('#join-name').value='데스크톱테스터'; document.querySelector('#join-form').requestSubmit(); true`);
    await wait(2000);
    step("팀룸 입장", !!config.identity?.memberId, config.identity?.memberId);

    await aiWC.executeJavaScript(`document.querySelector('#prompt-textarea').value='마케팅 4P 전략 정리해줘'; document.querySelector('#send').click(); true`);
    await wait(1500);
    const mid = await (await fetch(`${origin}/api/rooms/${roomId}/state`).catch(() => null))?.json?.().catch(() => null);
    step("생성 중 실시간 공유", !!mid?.messages?.some((m) => m.source === "mockai" && m.status === "streaming"), mid ? undefined : "state API 없음");
    await wait(6000);

    let state = await (await fetch(`${origin}/api/rooms/${roomId}/state`)).json();
    const synced = state.messages.filter((m) => m.source === "mockai");
    step("대화 자동 공유", synced.length >= 2 && synced.every((m) => m.status === "done"), synced.map((m) => `${m.role}:${m.text.slice(0, 20)}`).join(" | "));

    // 다른 팀원이 피드백
    const j = await (await fetch(`${origin}/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "join", name: "지영" }) })).json();
    const aiMsg = synced.find((m) => m.role === "assistant");
    await fetch(`${origin}/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "comment", memberId: j.member.id, messageId: aiMsg.id, quote: "", text: "가격 전략에 구체적 사례 추가해줘" }) });
    await wait(1500);
    await roomWC.executeJavaScript(`document.querySelector('[data-apply]').click(); true`);
    await wait(1000);
    const inputVal = await aiWC.executeJavaScript(`document.querySelector('#prompt-textarea').value`);
    step("피드백 → AI 입력창 삽입", inputVal.includes("가격 전략에 구체적 사례"), inputVal.slice(0, 60));

    state = await (await fetch(`${origin}/api/rooms/${roomId}/state`)).json();
    step("피드백 반영 처리", state.comments.some((c) => c.resolved && c.appliedInMessageId === "external"));

    // 로그인 없이 쓰는 ChatGPT처럼 주소에 대화 ID가 없어도 공유되는지
    await aiWC.loadURL(`${origin}/mock-ai.html?noid=1`);
    await wait(1500);
    await aiWC.executeJavaScript(`document.querySelector('#prompt-textarea').value='hi'; document.querySelector('#send').click(); true`);
    await wait(6000);
    state = await (await fetch(`${origin}/api/rooms/${roomId}/state`)).json();
    step("대화 ID 없는 채팅(비로그인)도 공유", state.messages.some((m) => m.text === "hi" && m.convId?.startsWith("tmp-")));

    // 오프라인 보관: 서버에 닿지 않으면 대기열에 남고 파일로 저장되어야 함
    const deadKey = "offline-test:mockai:x";
    pending.set(deadKey, { origin: "http://127.0.0.1:9", roomId: "offline-test", memberId: "m", source: "mockai", convId: "x", convTitle: "", messages: [] });
    await flush();
    await wait(800);
    const saved = readJSON(queueFile(), []).some(([k]) => k === deadKey);
    step("오프라인 시 대기열 보관", !online && pending.has(deadKey) && saved, `online=${online}, 파일저장=${saved}`);
    pending.delete(deadKey);

    const img = await mainWindow.webContents.capturePage();
    const shot = out.replace(/\.json$/, ".png");
    fs.writeFileSync(shot, img.toPNG());
    result.screenshot = shot;
  } catch (err) {
    step("테스트 오류", false, String(err.stack || err));
  }
  result.ok = result.steps.every((s) => s.ok);
  writeJSON(out, result);
  app.quit();
}
