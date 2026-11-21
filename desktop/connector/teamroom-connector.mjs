#!/usr/bin/env node
// AI 팀룸 커넥터 — Claude Code / Codex 대화를 팀룸에 자동 공유
//
// 동작: Claude Code(~/.claude/projects)와 Codex(~/.codex/sessions)가 남기는 대화 기록 파일을 지켜보다가,
//       "팀 프로젝트 폴더"에서 나눈 대화의 질문·답변만 팀룸으로 보냄 (도구 실행 내용·생각 과정은 제외)
//       Claude Code·Codex 설정은 전혀 건드리지 않음
//
// 사용법:
//   node teamroom-connector.mjs setup     처음 설정 (초대 링크, 이름, 공유할 팀 폴더, 자동 실행)
//   node teamroom-connector.mjs run       실행 (계속 켜 두기)
//   node teamroom-connector.mjs status    상태 보기
//   node teamroom-connector.mjs pause | resume
//   node teamroom-connector.mjs uninstall 자동 실행 해제
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "2026.11.14-12"; // 팀룸 창(exe)이 이 값으로 최신 커넥터인지 확인함
const HOME = process.env.TEAMROOM_HOME || os.homedir(); // 테스트용으로 바꿀 수 있음
const DIR = path.join(HOME, ".ai-teamroom");
const CONFIG = path.join(DIR, "connector.json");
const STATE = path.join(DIR, "connector-state.json");
const CLAUDE_DIR = path.join(HOME, ".claude", "projects");
const CODEX_DIR = path.join(HOME, ".codex", "sessions");
// 자동 실행: 시작 프로그램 폴더의 일반 바로가기 (창이 최소화된 채로 보임 — 숨김 실행 스크립트는 백신이 지움)
const STARTUP = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "AI팀룸 커넥터.lnk");
const POLL_MS = Number(process.env.TEAMROOM_POLL_MS || 2000);
const MAX_MESSAGES = 300;

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

// ───────── 대화 기록 읽기 ─────────
// 질문·답변 본문만 남기고 시스템이 끼워 넣은 안내문은 제거
const stripSystem = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
// 사람이 친 질문이 아니라 도구가 끼워 넣은 알림·안내 (작업 완료 알림, 명령 실행 기록 등)
const SKIP_USER = /^(<task-notification|<side-sessions-event|<ci-monitor-event|<system-|<command-|<local-command|<environment_context|<user_instructions|<permissions|<INSTRUCTIONS|<turn_aborted|\[SYSTEM NOTIFICATION|\[Request interrupted|Caveat:|# AGENTS\.md)/i;

function textBlocks(content, types) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => types.includes(b?.type) && typeof b.text === "string").map((b) => b.text).join("\n\n");
}

// Claude Code: 한 줄 = 하나의 기록. 답변은 같은 message.id로 여러 줄에 나뉘어 옴(글·도구·생각) → 글만 모음
function parseClaude(line, s) {
  if (line.isSidechain) return; // 하위 에이전트 내부 대화는 제외
  if (line.type === "custom-title" && line.customTitle) s.title = line.customTitle;
  if (line.cwd) s.cwd = line.cwd;
  if (line.sessionId) s.sessionId ||= line.sessionId;
  const ts = Date.parse(line.timestamp) || Date.now();
  if (line.type === "user" && line.message?.role === "user" && !line.isMeta) {
    const c = line.message.content;
    // 도구 실행 결과가 돌아옴 → AI가 이어서 작업 중
    if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) { if (!s.suppress) setWorking(s, true); return; }
    const text = stripSystem(textBlocks(c, ["text"]));
    if (!text) return;
    // 시스템 알림이면 그 알림과, 알림에 대한 AI의 응답도 공유하지 않음 (다음 진짜 질문까지)
    if (SKIP_USER.test(text)) { s.suppress = true; setWorking(s, false); return; }
    s.suppress = false;
    addMessage(s, line.uuid, "user", text, ts);
    setWorking(s, true); // 질문을 보냄 → 작업 시작
  } else if (line.type === "assistant" && line.message?.role === "assistant") {
    // 작업 중/끝 판단: 도구를 쓰는 중이면 stop_reason이 tool_use, 답변을 마치면 end_turn
    if (!s.suppress) {
      const stop = line.message.stop_reason;
      setWorking(s, stop == null || stop === "tool_use" || stop === "pause_turn");
    }
    // AI가 파일을 쓰거나 고친 경우(Write·Edit) → 문서면 공유 후보
    for (const b of Array.isArray(line.message.content) ? line.message.content : []) {
      if (b?.type === "tool_use" && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name || "")) noteDoc(s, b.input?.file_path || b.input?.notebook_path);
    }
    const text = textBlocks(line.message.content, ["text"]).trim();
    if (!text || s.suppress) return;
    appendAnswer(s, line.message.id || line.uuid, text, ts);
  }
}

// ───────── 내 PC 경로 숨기기 · AI가 만든 문서 찾기 ─────────
// 팀룸에 올리는 글에서 "C:\Users\…\보고서.html" 같은 경로는 파일 이름만 남김
const PATH_CHARS = "[^\\\\/\\s\"'`<>|*?()\\[\\]]";
const ABS_PATH = new RegExp(`(?:file:///)?(?:[A-Za-z]:[\\\\/]|~[\\\\/]|/(?:[a-z]/)?(?:Users|home|mnt|tmp|var)/)(?:${PATH_CHARS}+[\\\\/])*(${PATH_CHARS}*)`, "g");
function hidePaths(text) {
  return text
    // 마크다운 링크의 대상이 내 PC 파일이면 링크 글자만 남김: [보고서](docs/보고서.html) → 보고서
    .replace(/\[([^\]\n]+)\]\((?!https?:|mailto:|#)[^)\n]+\)/g, "$1")
    .replace(ABS_PATH, (m, name) => name || "(폴더)");
}
// 자동으로 올릴 "문서" 종류 (코드 파일은 제외)
const DOC_EXT = /\.(html?|pdf|docx?|pptx?|xlsx?|csv|hwpx?|md|txt|png|jpe?g|gif|webp)$/i;
const MAX_DOC = 30 * 1024 * 1024;
function noteDoc(s, p) {
  if (!p || !DOC_EXT.test(p)) return;
  const abs = path.isAbsolute(p) ? p : s.cwd ? path.resolve(s.cwd, p) : null;
  if (abs) (s.docs ||= {})[path.normalize(abs)] ??= 0; // 값 = 마지막으로 올린 수정 시각
}
// 답변 글에 언급된 문서 경로도 후보로 (실제로 있는 파일만, 팀 폴더 안만 올라감)
function noteDocsInText(s, text) {
  for (const m of text.matchAll(/\]\(((?!https?:|mailto:|#)[^)\n]+)\)/g)) noteDoc(s, decodeURIComponent(m[1].replace(/^file:\/\/\//, "")));
  for (const m of text.matchAll(new RegExp(`(?:[A-Za-z]:[\\\\/])?(?:${PATH_CHARS}+[\\\\/])*${PATH_CHARS}+\\.[A-Za-z]{2,5}`, "g"))) noteDoc(s, m[0]);
}
// 올려도 되는 파일인지: 팀 공유 폴더 안, 숨김 폴더(.git·.claude 등)·node_modules 밖
function docAllowed(config, s, file) {
  const f = norm(file);
  // 팀 폴더 + (직접 공유에 추가한 다른 폴더의 대화라면) 그 대화의 작업 폴더
  const roots = [...(config.shareAll ? [] : config.shareFolders), ...(config.shareAll || s.outside ? [s.cwd] : [])].filter(Boolean);
  const root = roots.map(norm).find((r) => f.startsWith(r + path.sep));
  if (!root) return false;
  return !f.slice(root.length).split(path.sep).some((seg) => seg.startsWith(".") || seg === "node_modules");
}
async function uploadDocs(config, s) {
  if (!s.docs) return;
  const { origin, roomId } = roomInfo(config.roomUrl);
  for (const [file, sentAt] of Object.entries(s.docs)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    // 이번 커넥터 설치 이후에 만들어졌거나 고쳐진 파일만, 바뀌었을 때만 다시 올림
    if (!st.isFile() || st.size === 0 || st.size > MAX_DOC || st.mtimeMs <= sentAt || st.mtimeMs < config.since || !docAllowed(config, s, file)) continue;
    const name = path.basename(file);
    const url = `${origin}/api/rooms/${roomId}/upload?memberId=${encodeURIComponent(config.memberId)}&name=${encodeURIComponent(name)}&source=${s.source}&convId=${encodeURIComponent(s.sessionId)}`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: fs.readFileSync(file), signal: AbortSignal.timeout(60000) });
    if (res.ok) { s.docs[file] = st.mtimeMs; log(`📎 문서 공유: ${name}`); }
    else if (res.status < 500) { s.docs[file] = st.mtimeMs; log(`⚠️ 문서를 올리지 못했어요: ${name} (${res.status})`); }
    else throw new Error(`HTTP ${res.status}`);
  }
}

function setWorking(s, on) {
  if (!!s.working !== on) { s.working = on; s.dirty = true; }
}
// 작업 중으로 보되, 기록 파일이 15분 넘게 조용하면(창을 닫았거나 멈춘 경우) 끝난 것으로 봄
const isWorking = (s) => !!s.working && Date.now() - (s.mtime || 0) < 15 * 60000;

// 질문 하나에 AI가 중간중간 쓴 글(작업 진행 메모 + 최종 답)을 하나의 답변으로 합침
function appendAnswer(s, key, text, ts) {
  const turnKey = (s.turnKey ||= key);
  noteDocsInText(s, text);
  const prev = s.messages[turnKey];
  addMessage(s, turnKey, "assistant", prev ? `${prev.text}\n\n${text}` : text, prev?.ts || ts);
}

// Codex: response_item 중 message(user/assistant)만. turn_context에 작업 폴더가 있음
function parseCodex(line, s) {
  const p = line.payload || {};
  if (line.type === "session_meta") { s.sessionId ||= p.id; if (p.cwd) s.cwd = p.cwd; }
  if (line.type === "turn_context" && p.cwd) s.cwd = p.cwd;
  if (line.type === "event_msg" && p.thread_id) s.sessionId ||= p.thread_id;
  // 작업 시작/끝 표시
  if (line.type === "event_msg" && p.type === "task_started") setWorking(s, true);
  if (line.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted")) setWorking(s, false);
  // Codex가 파일을 만들거나 고친 경우(apply_patch) → 문서면 공유 후보
  if (line.type === "response_item" && /tool_call$/.test(p.type || "") && typeof (p.input ?? p.arguments) === "string") {
    for (const m of (p.input ?? p.arguments).matchAll(/\*\*\* (?:Add|Update) File: (.+)/g)) noteDoc(s, m[1].trim());
  }
  if (line.type !== "response_item" || p.type !== "message" || !["user", "assistant"].includes(p.role)) return;
  const text = stripSystem(textBlocks(p.content, ["input_text", "output_text", "text"]));
  if (!text) return;
  if (p.role === "user") {
    if (SKIP_USER.test(text)) { s.suppress = true; return; }
    s.suppress = false;
  } else if (s.suppress) return;
  const ts = Date.parse(line.timestamp) || Date.now();
  if (p.role === "assistant") appendAnswer(s, p.id || `l${s.lineNo}`, text, ts);
  else addMessage(s, p.id || `l${s.lineNo}`, "user", text, ts);
}

function addMessage(s, extId, role, text, ts) {
  if (role === "user") s.turnKey = `ans:${extId}`; // 새 질문 → 이 질문의 답변이 들어갈 자리
  if (!s.messages[extId]) s.order.push(extId);
  s.messages[extId] = { role, text: text.slice(0, 100000), ts };
  if (role === "user" && !s.firstPrompt) s.firstPrompt = text.split("\n")[0].slice(0, 60);
  s.dirty = true;
}

// 파일에서 새로 추가된 부분만 읽기 (마지막 위치 기억)
function readNew(file, s, parse) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  s.mtime = st.mtimeMs;
  if (st.size < s.offset) { s.offset = 0; s.partial = ""; } // 파일이 새로 써진 경우
  if (st.size === s.offset) return;
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(st.size - s.offset);
  fs.readSync(fd, buf, 0, buf.length, s.offset);
  fs.closeSync(fd);
  s.offset = st.size;
  const chunk = s.partial + buf.toString("utf8");
  const lines = chunk.split("\n");
  s.partial = lines.pop(); // 아직 다 안 써진 마지막 줄
  for (const l of lines) {
    s.lineNo = (s.lineNo || 0) + 1;
    if (!l.trim()) continue;
    try { parse(JSON.parse(l), s); } catch {}
  }
}

// 최근에 바뀐 기록 파일 찾기
function listFiles(since, days = 3) {
  const out = [];
  const add = (f, source) => { try { const mtime = fs.statSync(f).mtimeMs; if (mtime >= since) out.push({ file: f, source, mtime }); } catch {} };
  try {
    for (const proj of fs.readdirSync(CLAUDE_DIR)) {
      const d = path.join(CLAUDE_DIR, proj);
      // (agent-* 는 하위 에이전트의 내부 기록이라 제외)
      try { for (const f of fs.readdirSync(d)) if (f.endsWith(".jsonl") && !f.startsWith("agent-")) add(path.join(d, f), "claudecode"); } catch {}
    }
  } catch {}
  // Codex: sessions/YYYY/MM/DD — 최근 며칠 폴더만 확인
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 864e5);
    const dir = path.join(CODEX_DIR, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) add(path.join(dir, f), "codex"); } catch {}
  }
  return out;
}

// ───────── 공유 규칙 ─────────
function inTeamFolder(config, s) {
  if (!s.cwd) return false;
  if (config.shareAll) return true;
  const cwd = norm(s.cwd);
  return (config.shareFolders || []).some((f) => cwd === norm(f) || cwd.startsWith(norm(f) + path.sep));
}
const shareable = (config, s) => !config.paused && inTeamFolder(config, s);

// ───────── 예전 대화 목록 만들기 ─────────
// 최근 30일간의 Claude Code·Codex 대화를 "비공개"로 목록(sessions.json)에 올려 둠 → 관리 창에서 골라 공유할 수 있게
// 내용은 읽지 않고 앞부분만 훑어서 제목(첫 질문)·폴더만 알아냄. 이 목록은 내 PC에만 있음
const cataloged = new Set();
function catalog(config) {
  const found = {};
  const files = listFiles(Date.now() - 30 * 864e5, 30).sort((a, b) => b.mtime - a.mtime).slice(0, 120);
  for (const { file, source, mtime } of files) {
    if (cataloged.has(file)) continue;
    cataloged.add(file);
    const s = { source, offset: 0, partial: "", messages: {}, order: [], sessionId: null, cwd: null };
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 400000));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString("utf8").split("\n");
      lines.pop();
      for (const l of lines) { try { (source === "claudecode" ? parseClaude : parseCodex)(JSON.parse(l), s); } catch {} }
    } catch { continue; }
    const id = s.sessionId || path.basename(file, ".jsonl").match(/[0-9a-f-]{36}$/i)?.[0];
    if (!id || !s.cwd || !s.firstPrompt) continue;
    found[id] = { status: "private", past: true, outside: !inTeamFolder(config, s), source, folder: path.basename(s.cwd), title: `${path.basename(s.cwd)} · ${s.title || s.firstPrompt}`.slice(0, 100), ts: mtime, file };
  }
  if (!Object.keys(found).length) return;
  const all = readSessions();
  let changed = false;
  for (const [id, d] of Object.entries(found)) if (!all[id]) { all[id] = d; changed = true; }
  if (changed) writeJSON(SESSIONS, all);
}

async function send(config, s) {
  const { origin, roomId } = roomInfo(config.roomUrl);
  const working = isWorking(s);
  const all = s.order.map((id) => ({ extId: id, ...s.messages[id] }));
  // 작업 중인데 아직 AI가 쓴 글이 없으면 "작업 중" 자리 표시를 먼저 올림 (글이 나오면 그 내용으로 바뀜)
  if (working && s.turnKey && !s.messages[s.turnKey] && !s.suppress) {
    all.push({ extId: s.turnKey, role: "assistant", text: "⏳ 작업 중…", ts: Date.now() });
    s.placeholder = s.turnKey;
  } else if (!working && s.placeholder && !s.messages[s.placeholder]) {
    // 글을 하나도 안 쓰고 멈춘 경우(중단 등) → 자리 표시를 정리
    all.push({ extId: s.placeholder, role: "assistant", text: "(답변 없이 중단됨)", ts: Date.now() });
    s.placeholder = null;
  }
  const messages = all
    .filter((m) => s.full || m.ts >= config.since) // 커넥터를 켜기 전 내용은 올리지 않음 (직접 "공유하기"로 고른 대화는 전체)
    .slice(-MAX_MESSAGES)
    .map(({ extId, role, text }) => ({ extId, role, text: hidePaths(text), streaming: working && extId === s.turnKey }));
  if (!messages.length) return true;
  const folder = path.basename(s.cwd || "");
  const res = await fetch(`${origin}/api/rooms/${roomId}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "syncExternal", memberId: config.memberId, source: s.source,
      convId: s.sessionId, convTitle: `${folder} · ${s.title || s.firstPrompt || "세션"}`.slice(0, 100), messages,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
  if (!res.ok) log("⚠️ 팀룸이 거부:", res.status, (await res.text()).slice(0, 100));
  return true;
}

// 팀룸 패널(화면 오른쪽에 뜨는 창) 열기 — 이미 떠 있으면 그 창을 앞으로 가져옴
function openPanel(config, extra = []) {
  if (!config.panelExe || !fs.existsSync(config.panelExe)) return false;
  // (커넥터가 팀룸 앱의 내장 Node로 실행된 경우의 표시를 지워야 앱이 창으로 뜸)
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try { spawn(config.panelExe, ["--panel", ...extra], { detached: true, stdio: "ignore", env }).unref(); return true; } catch { return false; }
}
// 패널 창이 지금 떠 있는지 (패널이 남기는 표시 파일로 확인)
function panelAlive() {
  try { process.kill(Number(fs.readFileSync(path.join(DIR, "panel.pid"), "utf8")), 0); return true; } catch { return false; }
}

// ───────── 대화(세션)별 공유 허가 ─────────
// sessions.json: { 세션ID: { status: "ask"|"shared"|"private", source, folder, title, ts } }
// 커넥터는 새 세션을 "ask"로 추가만 하고, 공유/비공개 결정은 팀룸 패널 창(또는 share/private 명령)에서 함
// 이 파일은 내 PC에만 있고 팀룸 서버로 가지 않음
const SESSIONS = path.join(DIR, "sessions.json");
const readSessions = () => readJSON(SESSIONS, {});
function upsertSession(id, patch) {
  const all = readSessions(); // 패널이 바꾼 결정을 덮어쓰지 않도록 매번 새로 읽어서 합침
  const cur = all[id];
  const next = { ...patch, ...(cur ? { status: cur.status } : {}) };
  if (cur && cur.title === next.title && cur.ts === next.ts) return cur;
  all[id] = { ...cur, ...next };
  writeJSON(SESSIONS, all);
  return all[id];
}
function patchSession(id, patch) {
  const all = readSessions();
  if (!all[id]) return null;
  all[id] = { ...all[id], ...patch };
  writeJSON(SESSIONS, all);
  return all[id];
}
// 사용자가 직접 정함: 공유로 고르면 그 대화 전체(설치 전 내용 포함)를 올림
const setSessionStatus = (id, status) => !!patchSession(id, { status, decided: true, ...(status === "shared" ? { full: true, room: currentRoomId() } : {}) });
// 공유 허가는 방마다 따로: "공유"로 정한 방(d.room)이 지금 방일 때만 올림 → 방을 바꿔도 예전 방에 허가한 대화가 새 방으로 새지 않음
const currentRoomId = (config = readJSON(CONFIG, {})) => { try { return roomInfo(config.roomUrl).roomId; } catch { return null; } };
const sharedHere = (config, d) => d?.status === "shared" && (!d.room || d.room === currentRoomId(config));

function roomInfo(url) {
  const u = new URL(url);
  return { origin: u.origin, roomId: u.searchParams.get("room") };
}

// ───────── Claude 데스크톱 앱의 "채팅" 탭 ─────────
// 채팅 탭의 대화는 PC에 파일로 남지 않아서, 화면에 열려 있는 대화를 Windows 접근성 API(스크린리더가 쓰는 것)로 읽음
// · 읽기만 함 (클릭·입력 없음) · 지금 화면에 열려 있는 대화만 · 공유하기로 한 대화만 팀룸으로 감
// 아래 스크립트는 Windows PowerShell 5.1로 실행 — 영문·숫자만 쓸 것 (한글을 넣으면 깨짐)
const APP_READER = path.join(DIR, "app-reader.ps1");
const APP_READER_PS = String.raw`param([int]$Interval = 2500, [switch]$Once, [int]$Tail = 4, [int]$ParentPid = 0)
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$NL = [string][char]10
$FENCE = ([string][char]96) * 3
$CLIP = [char]::ConvertFromUtf32(0x1F4CE)
$BULLET = [string][char]0x2022
function Cond($type) { New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type) }
$condDoc = Cond $CT::Document
$condGroup = Cond $CT::Group
$condButton = Cond $CT::Button
$crName = New-Object System.Windows.Automation.CacheRequest
$crName.Add($A::NameProperty)
$crTree = New-Object System.Windows.Automation.CacheRequest
$crTree.Add($A::NameProperty); $crTree.Add($A::ControlTypeProperty); $crTree.Add($A::ClassNameProperty)
$crTree.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
$crTree.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
$stopPattern = $env:TEAMROOM_STOP_PATTERN
if (-not $stopPattern) { $stopPattern = "^Stop" }
$known = @{}

function Url($el) {
  $pat = $null
  if ($el -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) { return [string]$pat.Current.Value }
  return ""
}
function Skip($el) {
  $t = $el.Cached.ControlType
  if ($t -eq $CT::Button -or $t -eq $CT::StatusBar -or $t -eq $CT::Image -or $t -eq $CT::Thumb) { return $true }
  return ([string]$el.Cached.ClassName -match "sr-only|group/status|^sticky ")
}
function Flat($el) {
  if (Skip $el) { return "" }
  $kids = $el.CachedChildren
  if ($kids.Count -eq 0) {
    $t = $el.Cached.ControlType
    if ($t -eq $CT::Text -or $t -eq $CT::Hyperlink) { return [string]$el.Cached.Name }
    return ""
  }
  $sb = New-Object Text.StringBuilder
  foreach ($k in $kids) { [void]$sb.Append([string](Flat $k)) }
  return $sb.ToString()
}
function FindClass($el, $pattern) {
  if ([string]$el.Cached.ClassName -match $pattern) { return $el }
  foreach ($k in $el.CachedChildren) { $r = FindClass $k $pattern; if ($r) { return $r } }
  return $null
}
function FirstText($el) {
  if ($el.Cached.ControlType -eq $CT::Text -and $el.CachedChildren.Count -eq 0 -and $el.Cached.Name) { return [string]$el.Cached.Name }
  foreach ($k in $el.CachedChildren) { $r = FirstText $k; if ($r) { return $r } }
  return ""
}
function ListLines($list, $indent, $out) {
  foreach ($item in $list.CachedChildren) {
    if ($item.Cached.ControlType -ne $CT::ListItem) { continue }
    $sb = New-Object Text.StringBuilder
    foreach ($k in $item.CachedChildren) { if ($k.Cached.ControlType -ne $CT::List) { [void]$sb.Append([string](Flat $k)) } }
    $line = $sb.ToString().Trim()
    if ($line.StartsWith($BULLET)) { $line = "- " + $line.Substring(1).Trim() }
    if ($line) { $out.Add($indent + $line) }
    foreach ($k in $item.CachedChildren) { if ($k.Cached.ControlType -eq $CT::List) { ListLines $k ($indent + "  ") $out } }
  }
}
function TableRows($el, $out) {
  $cells = New-Object 'System.Collections.Generic.List[string]'
  foreach ($k in $el.CachedChildren) {
    $kt = $k.Cached.ControlType
    if ($kt -eq $CT::DataItem -or $kt -eq $CT::HeaderItem -or $kt -eq $CT::Header) { $cells.Add(([string](Flat $k)).Trim()) }
  }
  if ($cells.Count) { $out.Add("| " + ($cells -join " | ") + " |"); return }
  foreach ($k in $el.CachedChildren) { TableRows $k $out }
}
function Render($el, $out) {
  if (Skip $el) { return }
  $t = $el.Cached.ControlType
  $c = [string]$el.Cached.ClassName
  if ($c -match "group/card") {
    $meta = New-Object Text.StringBuilder
    foreach ($k in $el.CachedChildren) { if ($k.Cached.ControlType -eq $CT::Text) { [void]$meta.Append(([string](Flat $k)) + " ") } }
    $out.Add($CLIP + " " + (FirstText $el) + " (" + $meta.ToString().Trim() + ")")
    return
  }
  if ($c -match "group/copy|code-block") {
    $code = FindClass $el "^language-"
    if ($code) {
      $lang = ([string]$code.Cached.ClassName) -replace "^language-(\S+).*$", '$1'
      $out.Add($FENCE + $lang + $NL + ([string](Flat $code)).TrimEnd() + $NL + $FENCE)
      return
    }
  }
  if ($t -eq $CT::List) {
    $lines = New-Object 'System.Collections.Generic.List[string]'
    ListLines $el "" $lines
    if ($lines.Count) { $out.Add($lines -join $NL) }
    return
  }
  if ($t -eq $CT::Table) {
    $rows = New-Object 'System.Collections.Generic.List[string]'
    TableRows $el $rows
    if ($rows.Count) { $out.Add($rows -join $NL); return }
  }
  $kids = $el.CachedChildren
  if ($kids.Count -eq 0) {
    $s = [string](Flat $el)
    if ($s.Trim()) { $out.Add($s.Trim()) }
    return
  }
  $bubble = $c -match "group/bubble"
  $run = New-Object Text.StringBuilder
  foreach ($k in $kids) {
    $kt = $k.Cached.ControlType
    if ($kt -eq $CT::Text -or $kt -eq $CT::Hyperlink) {
      if (-not $bubble) { [void]$run.Append([string](Flat $k)) }
    } else {
      if ($run.ToString().Trim()) { $out.Add($run.ToString().Trim()) }
      [void]$run.Clear()
      Render $k $out
    }
  }
  if ($run.ToString().Trim()) { $out.Add($run.ToString().Trim()) }
}
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }

function ReadOnce {
  $found = $false
  foreach ($p in @(Get-Process -Name claude | Where-Object { $_.MainWindowHandle -ne 0 })) {
    $win = $A::FromHandle($p.MainWindowHandle)
    if (-not $win) { continue }
    foreach ($d in $win.FindAll($T::Descendants, $condDoc)) {
      $url = Url $d
      if ($url -notmatch "^https://claude\.ai/chat/([0-9a-fA-F-]{20,})") { continue }
      $id = $Matches[1]
      $crName.Push()
      try { $all = $d.FindAll($T::Descendants, $condGroup); $buttons = $d.FindAll($T::Descendants, $condButton) } finally { $crName.Pop() }
      $groups = @()
      foreach ($g in $all) {
        $name = [string]$g.Cached.Name
        if ($name.Length -gt 0 -and $name.Length -lt 40 -and $name -match "^\D*(\d+)\D+(\d+)\D*$") {
          $a = [int]$Matches[1]; $b = [int]$Matches[2]
          $groups += New-Object psobject -Property @{ el = $g; k = [Math]::Min($a, $b) }
        }
      }
      if (-not $groups.Count) { continue }
      $found = $true
      $maxK = ($groups | Measure-Object -Property k -Maximum).Maximum
      $from = 0
      if ($known.ContainsKey($id)) { $from = $known[$id] - $Tail }
      $msgs = @()
      foreach ($g in $groups) {
        if ($g.k -le $from) { continue }
        $tree = $g.el.GetUpdatedCache($crTree)
        if (-not $tree) { continue }
        $label = ""
        $lab = FindClass $tree "sr-only"
        if ($lab) { $label = [string]$lab.Cached.Name }
        $role = ""
        if (FindClass $tree "group/bubble") { $role = "user" } elseif (FindClass $tree "group/message-row") { $role = "assistant" }
        $out = New-Object 'System.Collections.Generic.List[string]'
        Render $tree $out
        $msgs += New-Object psobject -Property @{ k = $g.k; role = $role; label = $label; text = ($out -join ($NL + $NL)) }
      }
      $busy = $false
      foreach ($b in $buttons) { if ([string]$b.Cached.Name -match $stopPattern) { $busy = $true; break } }
      $known[$id] = $maxK
      Emit (New-Object psobject -Property @{ type = "chat"; app = "claude"; id = $id; title = [string]$d.Current.Name; total = $maxK; busy = $busy; msgs = @($msgs) })
    }
  }
  if (-not $found) { Emit (New-Object psobject -Property @{ type = "idle" }) }
}

if ($Once) { ReadOnce; exit }
for (;;) {
  if ($ParentPid -and -not (Get-Process -Id $ParentPid)) { exit }
  try { ReadOnce } catch { try { Emit (New-Object psobject -Property @{ type = "error"; message = [string]$_ }) } catch { exit } }
  Start-Sleep -Milliseconds $Interval
}
`;
const appReader = { proc: null, startedAt: 0, lastLine: 0, queue: [], error: "" };
function startAppReader(extra = []) {
  if (process.platform !== "win32" || process.env.TEAMROOM_NO_APPS) return null;
  if (appReader.proc || Date.now() - appReader.startedAt < 30000) return appReader.proc;
  appReader.startedAt = Date.now();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(APP_READER, APP_READER_PS);
    const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", APP_READER, "-ParentPid", String(process.pid), ...extra], {
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      // 답변을 쓰는 중인지 알아내는 "중지" 버튼 이름 (앱 언어에 따라 다름)
      env: { ...process.env, TEAMROOM_STOP_PATTERN: "^(Stop|응답 중지|응답 중단|중지|중단)" },
    });
    appReader.proc = p;
    let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk) => {
      buf += chunk;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i).replace(/^﻿/, "").trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          appReader.lastLine = Date.now();
          if (j.type === "chat") appReader.queue.push(j);
          else if (j.type === "error") appReader.error = String(j.message || "").slice(0, 200);
        } catch {}
      }
    });
    p.on("exit", () => { appReader.proc = null; });
    p.on("error", () => { appReader.proc = null; });
    return p;
  } catch { return null; }
}
const appReaderState = () => process.platform !== "win32" ? "unsupported" : !appReader.proc ? "off" : Date.now() - appReader.lastLine < 20000 ? "on" : "starting";

// 마지막 답변 밑에 붙는 "1시간 전" 같은 시각 표시는 대화 내용이 아니므로 뗌
const APP_TIME_TAIL = /\n\n(?:지금|방금(?: 전)?|어제|now|\d+\s*(?:초|분|시간|일|주|개월|달|년)\s*전|just now|yesterday|\d+\s*(?:s|m|h|d|w|sec|min|hr|hour|day|week|month|year)s?\s*ago)$/i;
// 읽어 온 화면을 대화 상태에 반영 (메시지 번호 = 대화 안에서의 순서)
function applyAppSnapshot(apps, j, now) {
  const first = !apps[j.id];
  const s = (apps[j.id] ||= { source: "claude", app: true, sessionId: j.id, messages: {}, order: [] });
  s.title = String(j.title || "").replace(/\s*[-–—]\s*Claude\s*$/, "").trim() || "채팅";
  s.seenAt = now;
  s.busy = !!j.busy;
  for (const m of j.msgs || []) {
    const text = String(m.text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().replace(APP_TIME_TAIL, "").trim();
    if (!text || !m.k) continue;
    const role = m.role || (/^Claude/i.test(m.label || "") ? "assistant" : "user");
    const id = `i${m.k - 1}`; // (크롬 확장이 같은 대화를 올릴 때 쓰는 번호와 같게 → 겹쳐도 한 번만 보임)
    const prev = s.messages[id];
    if (prev && prev.text === text && prev.role === role) continue;
    if (!prev) s.order.push(id);
    s.messages[id] = { role, text: text.slice(0, 100000), ts: prev?.ts || now };
    s.dirty = true;
    if (!first) s.liveAt = now; // 지켜보는 동안 새 글이 생김 = 지금 쓰고 있는 대화
  }
  // 질문을 고쳐 다시 보내서 대화가 짧아진 경우 → 사라진 뒤쪽 메시지는 내 쪽 목록에서 정리
  if (j.total) for (const id of s.order) if (Number(id.slice(1)) >= j.total) delete s.messages[id];
  s.order = s.order.filter((id) => s.messages[id]).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  s.total = j.total || s.order.length;
  return s;
}

async function sendApp(config, s, working) {
  const { origin, roomId } = roomInfo(config.roomUrl);
  const all = s.order.map((id) => ({ extId: id, ...s.messages[id] }));
  const last = all.at(-1);
  // 질문만 있고 아직 답이 안 나왔으면 "작업 중" 자리 표시 (답이 나오면 같은 자리에 그 내용이 들어감)
  if (working && last?.role === "user") {
    s.placeholder = `i${s.total}`;
    all.push({ extId: s.placeholder, role: "assistant", text: "⏳ 작업 중…" });
  } else if (last?.role === "user" && s.placeholder === `i${s.total}`) {
    // 답이 나오기 전에 다른 화면으로 넘어간 경우 → 화면에 없는 답변은 읽을 수 없으므로 그렇게 표시
    all.push({ extId: s.placeholder, role: "assistant", text: "(답변은 Claude 앱에서 이 대화를 다시 열면 올라옵니다)" });
    s.placeholder = null;
  }
  const messages = all.slice(-MAX_MESSAGES).map(({ extId, role, text }, i, arr) => ({ extId, role, text: hidePaths(text), streaming: working && role === "assistant" && i === arr.length - 1 }));
  if (!messages.length) return;
  const res = await fetch(`${origin}/api/rooms/${roomId}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "syncExternal", memberId: config.memberId, source: "claude", convId: s.sessionId, convTitle: s.title.slice(0, 100), messages }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
  if (!res.ok) log("⚠️ 팀룸이 거부:", res.status, (await res.text()).slice(0, 100));
}

// 메인 루프에서 매번 호출: 새로 읽힌 화면 반영 → 공유 여부 확인 → 공유 중인 대화만 팀룸으로
async function handleApps(cfg, sessions, state) {
  const apps = (state.apps ||= {});
  const now = Date.now();
  // (자동 테스트용: 화면을 읽는 대신 파일에 적힌 화면 내용을 한 줄씩 받아 씀)
  if (process.env.TEAMROOM_APP_FEED) {
    try {
      const lines = fs.readFileSync(process.env.TEAMROOM_APP_FEED, "utf8").split("\n").filter(Boolean);
      for (const l of lines.slice(state.appFeedLine || 0)) appReader.queue.push(JSON.parse(l));
      state.appFeedLine = lines.length;
    } catch {}
  }
  for (const j of appReader.queue.splice(0)) applyAppSnapshot(apps, j, now);
  let failed = null;
  for (const [id, s] of Object.entries(apps)) {
    if (now - (s.seenAt || 0) > 30 * 864e5) { delete apps[id]; continue; } // 한 달 넘게 안 연 대화는 내 쪽 기록에서 지움
    if (!s.order.length || cfg.paused) continue;
    const onScreen = now - (s.seenAt || 0) < 15000;
    const last = s.messages[s.order.at(-1)];
    const recent = now - (s.liveAt || 0);
    // 작업 중: 중지 버튼이 보이거나, 답변 글이 방금까지 늘어나고 있었거나, 질문을 보낸 직후
    const working = onScreen && (s.busy || (last.role === "assistant" && recent < 6000) || (last.role === "user" && recent < 120000));
    if (working !== !!s.sentWorking) s.dirty = true;
    const title = `Claude 앱 · ${s.title}`.slice(0, 100);
    let d = sessions[id];
    // 처음 본 대화 → 비공개로 목록에만 올림 (열어 보기만 한 예전 대화까지 일일이 묻지 않도록)
    if (!d) d = sessions[id] = upsertSession(id, { status: "private", past: true, app: true, source: "claude", folder: "Claude 앱", title, ts: now });
    else if (d.title !== title) upsertSession(id, { ...d, title });
    // 지켜보는 동안 새 글이 오간 대화 = 지금 쓰고 있는 대화 → 공유할지 물어봄 (한 번만)
    if (d.status === "private" && !d.decided && !d.asked && s.liveAt && cfg.askEach !== false) {
      d = sessions[id] = patchSession(id, { status: "ask", past: false, asked: true, ts: now });
      log(`❓ Claude 앱 채팅 — 공유할지 정해 주세요: ${s.title}`);
      if (!process.env.TEAMROOM_ONCE) openPanel(cfg, ["--background"]);
    }
    const allowed = sharedHere(cfg, d) || !!process.env.TEAMROOM_AUTO_SHARE;
    const decision = allowed ? `shared:${currentRoomId(cfg)}` : d.status === "shared" ? "elsewhere" : d.status;
    if (allowed && s.decision !== decision) s.dirty = true; // 방금 허가됨(또는 방을 바꿈) → 지금까지 읽은 내용을 올림
    s.decision = decision;
    if (!s.dirty) continue;
    if (!allowed) { s.dirty = false; continue; }
    if (!s.panelOpened && !process.env.TEAMROOM_ONCE) { s.panelOpened = true; openPanel(cfg, ["--background"]); }
    try {
      await sendApp(cfg, s, working);
      s.dirty = false;
      if (!process.env.TEAMROOM_ONCE && panelAlive() && !working && s.sentWorking) openPanel(cfg, ["--notify-done"]);
      s.sentWorking = working;
      s.lastSent = now;
      log(`↑ Claude 앱 채팅 · ${s.title} · ${s.order.length}개 메시지`);
    } catch (e) { failed = e; }
  }
  if (failed) throw failed;
}

// ───────── 실행 ─────────
async function run() {
  const config = readJSON(CONFIG, null);
  if (!config) { console.log("먼저 설정하세요:  node teamroom-connector.mjs setup"); process.exit(1); }
  // 이미 다른 커넥터가 돌고 있으면 중복 실행하지 않음 (팀룸 창이 자동으로 켠 것 + 직접 실행한 것)
  const STATUS = path.join(DIR, "status.json");
  if (!process.env.TEAMROOM_ONCE) {
    const other = readJSON(STATUS, null);
    let alive = false;
    try { alive = !!other && other.pid !== process.pid && Date.now() - other.ts < 8000 && (process.kill(other.pid, 0), true); } catch {}
    if (alive) { console.log("커넥터가 이미 실행 중이에요 (중복 실행하지 않습니다)"); return; }
  }
  const state = readJSON(STATE, { files: {} });
  log(`🤝 AI 팀룸 커넥터 실행 중 (${VERSION}) · ${config.name} → ${config.roomUrl}`);
  log(config.shareAll ? "   모든 작업 폴더의 대화를 공유합니다" : `   공유 폴더: ${config.shareFolders.join(", ")}`);
  // 시작할 때 한 번: 이미 올린 대화도 다시 보내서 경로 숨김 등 새 규칙을 반영하고, 답변에 언급된 문서도 찾아 올림
  for (const s of Object.values(state.files)) {
    s.dirty = true;
    for (const id of s.order || []) {
      const m = s.messages[id];
      if (m?.role === "assistant" && m.ts >= config.since) noteDocsInText(s, m.text);
    }
  }
  // 방 구분이 생기기 전부터 공유하던 대화는 지금 방에 공유한 것으로 표시해 둠
  {
    const all = readSessions();
    let changed = false;
    for (const d of Object.values(all)) if (d.status === "shared" && !d.room) { d.room = currentRoomId(config); changed = true; }
    if (changed) writeJSON(SESSIONS, all);
  }
  let online = true;
  let lastSave = 0;
  let lastCatalog = 0;
  for (;;) {
    const cfg = readJSON(CONFIG, config); // pause/resume 반영
    // 1분마다 예전 대화 목록 갱신 (관리 창에서 골라 공유할 수 있게)
    if (Date.now() - lastCatalog > 60000) { try { catalog(cfg); } catch {} lastCatalog = Date.now(); }
    const sessions = readSessions(); // 대화별 공유 허가 (패널 창에서 바꾼 내용 반영)
    // 살펴볼 기록: 최근에 바뀐 대화 + 사용자가 직접 "공유하기"로 고른 대화(예전 대화일 수 있음)
    const files = listFiles(cfg.since - 60000);
    for (const d of Object.values(sessions)) {
      if (sharedHere(cfg, d) && d.file && !files.some((f) => f.file === d.file) && fs.existsSync(d.file)) files.push({ file: d.file, source: d.source });
    }
    for (const { file, source } of files) {
      const s = (state.files[file] ||= { source, offset: 0, partial: "", messages: {}, order: [], sessionId: null, cwd: null });
      s.source = source;
      readNew(file, s, source === "claudecode" ? parseClaude : parseCodex);
      if (!s.sessionId) s.sessionId = path.basename(file, ".jsonl").match(/[0-9a-f-]{36}$/i)?.[0] || path.basename(file, ".jsonl");
      // 작업 중 상태가 바뀌었거나(끝남·멈춤), 작업 중이면 30초마다 "아직 작업 중"을 다시 알림
      const w = isWorking(s);
      if (w !== !!s.sentWorking || (w && Date.now() - (s.lastSent || 0) > 30000)) s.dirty = true;
      // 이 대화를 공유해도 되는지: 팀 폴더 + (대화별 허가를 쓰는 경우) 사용자가 "공유"로 정한 대화만
      // (직접 "공유하기"로 고른 대화는 설치 전 내용까지 전체를 올림)
      s.full = !!sessions[s.sessionId]?.full;
      const recent = s.order.some((id) => s.messages[id].ts >= cfg.since);
      const hasNew = recent || (s.full && s.order.length > 0);
      // · 팀 폴더의 대화: 새 대화마다 물어봄
      // · 팀 폴더 밖의 대화: 묻지 않고 비공개. 단, "대화 공유 관리"에서 직접 추가한 대화는 공유
      const inFolder = shareable(cfg, s);
      const asking = cfg.askEach !== false && !process.env.TEAMROOM_AUTO_SHARE;
      let allowed = inFolder && hasNew;
      if (hasNew && s.cwd && !cfg.paused && (inFolder ? asking : true)) {
        const title = `${path.basename(s.cwd)} · ${s.title || s.firstPrompt || "새 대화"}`.slice(0, 100);
        let d = sessions[s.sessionId];
        // 예전 대화로만 목록에 있던 팀 폴더 대화를 다시 이어서 쓰기 시작함 → 새 대화처럼 물어보기
        if (d?.past && !d.decided && d.status === "private" && inFolder && recent) {
          d = sessions[s.sessionId] = patchSession(s.sessionId, { status: "ask", past: false, ts: Date.now() });
          log(`❓ 이어서 쓰는 대화 — 공유할지 정해 주세요: ${title}`);
          if (!process.env.TEAMROOM_ONCE) openPanel(cfg, ["--background"]);
        }
        if (!d) {
          // 처음 보는 대화 → 팀 폴더면 물어보기, 밖이면 비공개로 목록에만 (이전부터 공유하던 대화는 그대로 공유)
          const status = !inFolder ? "private" : s.lastSent ? "shared" : "ask";
          d = sessions[s.sessionId] = upsertSession(s.sessionId, { status, ...(status === "shared" ? { room: currentRoomId(cfg) } : {}), outside: !inFolder, source, folder: path.basename(s.cwd), title, ts: Date.now(), file });
          if (d.status === "ask") {
            log(`❓ 새 대화 — 공유할지 정해 주세요: ${title}`);
            if (!process.env.TEAMROOM_ONCE) openPanel(cfg, ["--background"]);
          }
        } else if (d.title !== title) {
          upsertSession(s.sessionId, { ...d, title });
        }
        const decision = sharedHere(cfg, d) ? `shared:${currentRoomId(cfg)}` : d.status === "shared" ? "elsewhere" : d.status;
        if (sharedHere(cfg, d) && s.decision !== decision) s.dirty = true; // 방금 허가됨(또는 방을 바꿈) → 지금까지 내용을 올림
        s.decision = decision;
        s.outside = !inFolder;
        allowed = sharedHere(cfg, d);
      }
      if (s.dirty && allowed) {
        // 팀 폴더에서 새 세션이 시작되면 팀룸 패널을 옆에 띄움 (세션당 한 번 — 닫으면 다시 안 뜸)
        // (쓰던 창의 포커스를 뺏지 않고 화면 오른쪽에 표시 — 일반 창이라 다른 창을 누르면 그 창이 앞으로 옴)
        if (hasNew && !s.panelOpened && !process.env.TEAMROOM_ONCE) { s.panelOpened = true; openPanel(cfg, ["--background"]); }
        try {
          await send(cfg, s);
          s.dirty = false;
          // 작업이 끝나면 팀룸 창의 작업표시줄 아이콘을 깜빡여 알림 (창을 앞으로 꺼내지는 않음)
          if (!process.env.TEAMROOM_ONCE && hasNew && panelAlive() && !w && s.sentWorking) openPanel(cfg, ["--notify-done"]);
          s.sentWorking = w;
          s.lastSent = Date.now();
          // 답변이 끝났으면 이번에 만든·고친 문서를 팀룸에 올림 (그 답변에 붙음)
          if (!w) await uploadDocs(cfg, s);
          if (!online) log("✅ 다시 연결됨");
          online = true;
          log(`↑ ${source === "claudecode" ? "Claude Code" : "Codex"} · ${path.basename(s.cwd)} · ${s.order.length}개 메시지`);
        } catch (e) {
          if (online) log("⚠️ 팀룸에 연결할 수 없어요 — 연결되면 자동으로 다시 보냅니다", e.message);
          online = false;
        }
      } else if (s.dirty && !allowed) {
        s.dirty = false; // 공유 대상이 아닌 폴더이거나 허가되지 않은 대화 → 보내지 않음
      }
      // 메모리 절약: 너무 오래된 메시지는 버림
      if (s.order.length > MAX_MESSAGES * 2) {
        for (const id of s.order.splice(0, s.order.length - MAX_MESSAGES)) delete s.messages[id];
      }
    }
    // Claude 데스크톱 앱 "채팅" 탭에 열려 있는 대화 (화면 읽기 — 꺼져 있으면 다시 켬)
    if (!process.env.TEAMROOM_ONCE || process.env.TEAMROOM_APPS) startAppReader();
    try {
      await handleApps(cfg, sessions, state);
    } catch (e) {
      if (online) log("⚠️ 팀룸에 연결할 수 없어요 — 연결되면 자동으로 다시 보냅니다", e.message);
      online = false;
    }
    // 상태 기록 (팀룸 창이 "커넥터가 살아 있는지, 대화 기록을 찾았는지" 보여주는 데 사용)
    if (!process.env.TEAMROOM_ONCE) {
      try {
        writeJSON(STATUS, {
          ts: Date.now(), pid: process.pid, version: VERSION, online, paused: !!cfg.paused,
          claudeDir: fs.existsSync(CLAUDE_DIR), codexDir: fs.existsSync(CODEX_DIR),
          watching: files.length, listed: Object.keys(sessions).length,
          // Claude 앱 채팅 읽기: on(읽는 중) / starting / off / unsupported(윈도우가 아님), 지금 화면에 열린 대화 제목
          appReader: appReaderState(), appError: appReader.error || "",
          appChat: Object.values(state.apps || {}).find((a) => Date.now() - (a.seenAt || 0) < 8000)?.title || "",
        });
      } catch {}
    }
    if (Date.now() - lastSave > 10000) { writeJSON(STATE, state); lastSave = Date.now(); }
    if (process.env.TEAMROOM_ONCE) { writeJSON(STATE, state); return; }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ───────── 설정 ─────────
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => arg(q.key) ?? (process.argv.includes("--yes") && def !== undefined ? def : ((await rl.question(`${q.text}${def ? ` [${def}]` : ""}: `)).trim() || def));
  const old = readJSON(CONFIG, {});
  console.log("\n🤝 AI 팀룸 커넥터 설정 — Claude Code·Codex 대화를 팀룸에 자동 공유합니다\n");

  const roomUrl = await ask({ key: "room", text: "팀룸 초대 링크" }, old.roomUrl);
  const { origin, roomId } = roomInfo(roomUrl);
  const res = await fetch(`${origin}/api/rooms/${roomId}/state`).catch(() => null);
  if (!res?.ok) { console.log("❌ 팀룸에 연결할 수 없어요. 링크와 서버를 확인하세요."); process.exit(1); }
  const room = await res.json();

  const name = await ask({ key: "name", text: "팀룸에 보일 이름" }, old.name);
  // 같은 이름이 이미 있으면(크롬 확장으로 입장한 경우 등) 같은 사람으로 연결 → 한 칸에 모아서 보임
  let memberId = old.roomUrl === roomUrl ? old.memberId : null;
  const same = Object.values(room.members).find((m) => m.name === name);
  if (!memberId && same) {
    const yes = (await ask({ key: "reuse", text: `팀룸에 이미 '${name}'이(가) 있어요. 같은 사람으로 연결할까요? (Y/n)` }, "Y")).toLowerCase() !== "n";
    if (yes) memberId = same.id;
  }
  if (!memberId || !room.members[memberId]) {
    const j = await (await fetch(`${origin}/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "join", name }) })).json();
    memberId = j.member.id;
  }

  const folderAns = await ask({ key: "folder", text: "공유할 팀 프로젝트 폴더 (여러 개는 ; 로 구분, 모든 폴더는 *)" }, (old.shareFolders || [process.cwd()]).join(";"));
  const shareAll = folderAns.trim() === "*";
  const shareFolders = shareAll ? [] : folderAns.split(";").map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));
  // 팀룸 패널 앱(AI팀룸.exe): Claude Code·Codex를 쓰기 시작하면 화면 오른쪽에 팀룸을 띄워 줌
  const self0 = fileURLToPath(import.meta.url);
  const guess = [old.panelExe, path.join(path.dirname(self0), "AI팀룸.exe"), path.join(path.dirname(self0), "..", "desktop", "release", "win-unpacked", "AI팀룸.exe")].find((p) => p && fs.existsSync(p)) || "";
  const panelAns = await ask({ key: "panel", text: "팀룸 패널 앱(AI팀룸.exe) 경로 (없으면 Enter — 패널 없이 공유만)" }, guess);
  const panelExe = panelAns && fs.existsSync(panelAns) ? path.resolve(panelAns) : "";
  const config = { roomUrl, memberId, name, shareFolders, shareAll, panelExe, paused: false, since: old.roomUrl === roomUrl && old.since ? old.since : Date.now() };
  writeJSON(CONFIG, config);

  // 이 파일을 고정된 위치로 복사 (프로젝트 폴더를 옮겨도 동작하도록)
  const self = fileURLToPath(import.meta.url);
  const installed = path.join(DIR, "teamroom-connector.mjs");
  if (norm(self) !== norm(installed)) fs.copyFileSync(self, installed);

  if (process.platform === "win32" && !process.argv.includes("--no-startup")) {
    const yes = (await ask({ key: "startup", text: "윈도우를 켤 때 커넥터를 자동으로 실행할까요? (Y/n)" }, "Y")).toLowerCase() !== "n";
    if (yes) {
      fs.mkdirSync(path.dirname(STARTUP), { recursive: true });
      try {
        execFileSync("powershell", ["-NoProfile", "-Command",
          "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:TR_LNK);$s.TargetPath=$env:TR_NODE;$s.Arguments=$env:TR_ARGS;$s.WindowStyle=7;$s.Description='AI 팀룸 커넥터';$s.Save()"],
          { env: { ...process.env, TR_LNK: STARTUP, TR_NODE: process.execPath, TR_ARGS: `"${installed}" run` } });
        console.log(fs.existsSync(STARTUP) ? `✅ 자동 실행 등록: ${STARTUP}` : "⚠️ 자동 실행 바로가기를 만들지 못했어요 (직접 run 으로 실행하세요)");
      } catch {
        console.log("⚠️ 자동 실행 바로가기를 만들지 못했어요 (직접 run 으로 실행하세요)");
      }
    }
  }
  rl.close();
  console.log(`\n✅ 설정 완료 · ${name} → ${roomUrl}`);
  console.log(shareAll ? "   모든 폴더의 Claude Code·Codex 대화가 공유됩니다" : `   공유 폴더: ${shareFolders.join(", ")}`);
  console.log("   지금 바로 시작하려면 (이 폴더에서):  node teamroom-connector.mjs run\n");
}

function status() {
  const c = readJSON(CONFIG, null);
  if (!c) return console.log("아직 설정 안 됨 → node teamroom-connector.mjs setup");
  const st = readJSON(STATE, { files: {} });
  console.log(`방: ${c.roomUrl}\n이름: ${c.name}\n상태: ${c.paused ? "⏸ 일시정지" : "● 공유 중"}\n공유 폴더: ${c.shareAll ? "모든 폴더" : c.shareFolders.join(", ")}\n자동 실행: ${fs.existsSync(STARTUP) ? "켜짐" : "꺼짐"}`);
  const recent = Object.values(st.files).filter((s) => shareable(c, s)).slice(-5);
  for (const s of recent) console.log(`  · ${s.source} ${path.basename(s.cwd || "")} — ${s.order.length}개 메시지`);
}

// 시험 읽기: 최근 기록 파일을 읽어 질문·답변 개수만 보여줌 (아무것도 보내지 않음)
function dry() {
  const given = process.argv[3];
  const files = given ? [{ file: given, source: given.includes(".codex") ? "codex" : "claudecode" }] : listFiles(Date.now() - 3 * 864e5).slice(0, 8);
  if (!files.length) return console.log("최근 3일간 Claude Code·Codex 기록이 없어요");
  for (const { file, source } of files) {
    const s = { source, offset: 0, partial: "", messages: {}, order: [], sessionId: null, cwd: null };
    readNew(file, s, source === "claudecode" ? parseClaude : parseCodex);
    const roles = s.order.map((id) => s.messages[id].role);
    console.log(`${source.padEnd(10)} 폴더=${path.basename(s.cwd || "?")}  질문 ${roles.filter((r) => r === "user").length}개 · 답변 ${roles.filter((r) => r === "assistant").length}개  세션=${(s.sessionId || "?").slice(0, 8)}`);
  }
}

// 대화별 공유 상태 보기·바꾸기 (패널 창 없이 쓸 때)
function listSessions() {
  const rows = Object.entries(readSessions()).sort((a, b) => b[1].ts - a[1].ts).slice(0, 20);
  if (!rows.length) console.log("아직 대화가 없어요");
  rows.forEach(([id, d], i) => console.log(`${String(i + 1).padStart(2)}. ${{ ask: "❓ 미정  ", shared: "✅ 공유중", private: "🔒 비공개" }[d.status]}  ${d.source === "codex" ? "Codex      " : "Claude Code"}  ${d.outside ? "[다른 폴더] " : ""}${d.title}`));
  console.log("\n바꾸기:  share <번호>  |  private <번호>");
  return rows;
}
function decideSession(status) {
  const rows = Object.entries(readSessions()).sort((a, b) => b[1].ts - a[1].ts).slice(0, 20);
  const pick = rows[Number(process.argv[3]) - 1]?.[0] || process.argv[3];
  console.log(setSessionStatus(pick, status) ? (status === "shared" ? "✅ 이 대화를 공유합니다" : "🔒 이 대화는 공유하지 않습니다") : "그런 대화가 없어요 (sessions 로 번호 확인)");
}

// 시험 읽기: Claude 앱 "채팅" 탭에 지금 열려 있는 대화를 한 번 읽어서 보여줌 (아무것도 보내지 않음)
async function appread() {
  const p = startAppReader(["-Once"]);
  if (!p) return console.log("이 PC에서는 앱 화면 읽기를 쓸 수 없어요 (Windows 전용)");
  await new Promise((r) => p.on("exit", r));
  const j = appReader.queue.at(-1);
  if (!j) return console.log("Claude 앱의 채팅 탭에 열려 있는 대화를 찾지 못했어요 (앱에서 '채팅' 탭의 대화를 화면에 띄워 두세요)" + (appReader.error ? ` · 오류: ${appReader.error}` : ""));
  const s = applyAppSnapshot({}, j, Date.now());
  console.log(`대화: ${s.title}  (메시지 ${s.order.length}개${j.busy ? " · 답변 작성 중" : ""})`);
  for (const id of s.order) {
    const m = s.messages[id];
    console.log(`
── ${m.role === "user" ? "질문" : "답변"} ${id.slice(1) * 1 + 1} ${process.argv.includes("--full") ? "" : "(앞부분)"}
${process.argv.includes("--full") ? m.text : m.text.slice(0, 400)}`);
  }
}

const cmd = process.argv[2] || "run";
if (cmd === "dry") dry();
else if (cmd === "appread") await appread();
else if (cmd === "sessions") listSessions();
else if (cmd === "share") decideSession("shared");
else if (cmd === "private") decideSession("private");
else if (cmd === "panel") console.log(openPanel(readJSON(CONFIG, {})) ? "팀룸 패널을 열었어요" : "패널 앱 경로가 설정되지 않았어요 (setup 에서 AI팀룸.exe 경로 입력)");
else if (cmd === "setup") await setup();
else if (cmd === "run") await run();
else if (cmd === "status") status();
else if (cmd === "pause" || cmd === "resume") {
  const c = readJSON(CONFIG, null);
  if (!c) { console.log("먼저 setup 하세요"); process.exit(1); }
  c.paused = cmd === "pause";
  writeJSON(CONFIG, c);
  console.log(c.paused ? "⏸ 공유를 멈췄어요 (resume 으로 다시 시작)" : "● 공유를 다시 시작했어요");
} else if (cmd === "uninstall") {
  try { fs.unlinkSync(STARTUP); console.log("자동 실행을 해제했어요"); } catch { console.log("자동 실행이 등록되어 있지 않아요"); }
} else console.log("사용법: setup | run | status | pause | resume | uninstall");
