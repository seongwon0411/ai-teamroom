// AI 팀룸 — 팀원들이 각자의 AI와 작업하는 과정을 실시간으로 공유하는 서버
// 실행: npm install && npm start  →  http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3100); // (새 버전은 3100번 — 기존 팀룸 3000번과 따로 돌아감)
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data"); // (테스트에서는 임시 폴더로 바꿈)
fs.mkdirSync(DATA_DIR, { recursive: true });

const id = () => crypto.randomBytes(6).toString("base64url");
const now = () => Date.now();

// ───────────────────────── 방 상태 ─────────────────────────
// rooms: 공개 상태(파일 저장·브로드캐스트 대상)
// secrets: 팀 공용 API 키 — 메모리에만 보관, 절대 브로드캐스트/저장하지 않음
const rooms = new Map();
const secrets = new Map(); // roomId -> { anthropic, openai, gemini, ownerId }
const clients = new Map(); // roomId -> Set<{res, memberId}>
const lastSeen = new Map(); // roomId -> { memberId: 마지막으로 상태를 가져간 시각 }

function newRoom(name) {
  return {
    id: id(),
    name: name || "새 팀플 방",
    createdAt: now(),
    ownerId: null,
    members: {}, // memberId -> {id, name, color, provider, model, joinedAt}
    messages: [], // {id, authorId, role, text, status, model, provider, ts, replyTo?, feedbackIds?}
    comments: [], // {id, messageId, fromId, toId, quote, text, resolved, appliedInMessageId, ts}
    doc: [], // {id, text, sourceMessageId, sourceAuthorId, addedBy, updatedBy, ts}
    tasks: [], // {id, title, assigneeId, status: todo|doing|done, ts}
    work: [], // 프로젝트 현황의 작업 {id, title, status, ownerId, deps, goal, done, remaining, problems, blockReason, unblock, ...}
    activity: [], // {ts, memberId, kind, detail}
  };
}

function roomFile(rid) {
  return path.join(DATA_DIR, `${rid.replace(/[^\w-]/g, "")}.json`);
}

function getRoom(rid) {
  if (rooms.has(rid)) return rooms.get(rid);
  const f = roomFile(rid);
  if (fs.existsSync(f)) {
    const room = JSON.parse(fs.readFileSync(f, "utf8"));
    // 서버가 꺼질 때 스트리밍 중이던 메시지 정리
    // (외부 앱에서 동기화된 메시지는 이미 받은 내용까지는 유효하므로 완료 처리)
    for (const m of room.messages) {
      if (m.status === "streaming") m.status = m.extKey ? "done" : "error";
    }
    dedupeMembers(room);
    room.work ||= [];
    try { syncGitWork(room); } catch {} // (이미 올라와 있는 브랜치·PR 정보로 작업을 맞춤)
    pruneOld(room);
    rooms.set(rid, room);
    return room;
  }
  return null;
}

// ───────── 비밀번호 ─────────
// ① 방 만들기 비밀번호: 서버 전체에 하나 (환경변수 CREATE_PASSWORD 또는 data/create-password.txt). 없으면 누구나 방을 만들 수 있음(내 PC에서만 쓸 때)
// ② 방 비밀번호: 방마다 따로 (방장이 정함). 비밀번호 자체는 저장하지 않고 풀 수 없는 값(scrypt)만 저장
//    맞게 넣으면 "입장 열쇠"를 내주고, 그 뒤 요청은 열쇠(쿠키 또는 x-room-key)로 확인. 비밀번호를 바꾸면 예전 열쇠는 못 씀
const SECRET_FILE = path.join(DATA_DIR, "secret.key");
let SERVER_SECRET;
try { SERVER_SECRET = fs.readFileSync(SECRET_FILE); } catch {}
if (!SERVER_SECRET || SERVER_SECRET.length < 32) { SERVER_SECRET = crypto.randomBytes(32); fs.writeFileSync(SECRET_FILE, SERVER_SECRET, { mode: 0o600 }); }
function createPassword() {
  if (process.env.CREATE_PASSWORD) return process.env.CREATE_PASSWORD;
  try { return fs.readFileSync(path.join(DATA_DIR, "create-password.txt"), "utf8").trim(); } catch { return ""; }
}
const sameText = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function makePass(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString("base64url") };
}
const checkPass = (room, password) => !!room.pass && sameText(crypto.scryptSync(String(password), room.pass.salt, 32).toString("base64url"), room.pass.hash);
const roomKey = (room) => crypto.createHmac("sha256", SERVER_SECRET).update(`${room.id}:${room.pass.salt}`).digest("base64url");
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function authorized(req, url, room) {
  if (!room.pass) return true;
  const given = req.headers["x-room-key"] || url.searchParams.get("key") || cookieOf(req, `tr_${room.id}`);
  return !!given && sameText(given, roomKey(room));
}
const keyCookie = (req, room) =>
  `tr_${room.id}=${room.pass ? roomKey(room) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${room.pass ? 31536000 : 0}${String(req.headers["x-forwarded-proto"] || "").startsWith("https") ? "; Secure" : ""}`;
// 비밀번호 마구 넣어 보기 막기: 같은 곳에서 10분 동안 10번 틀리면 잠시 막음
const fails = new Map(); // "종류:대상:주소" -> [틀린 시각…]
function clientIp(req) {
  const direct = req.socket.remoteAddress || "";
  // (같은 서버의 프록시·터널을 거쳐 온 요청만 전달된 주소를 믿음)
  if (/^(::1|127\.|::ffff:127\.)/.test(direct)) return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || direct).split(",")[0].trim();
  return direct;
}
function tooManyFails(key) {
  const list = (fails.get(key) || []).filter((t) => now() - t < 600e3);
  fails.set(key, list);
  return list.length >= 10;
}
const noteFail = (key) => fails.set(key, [...(fails.get(key) || []), now()]);
setInterval(() => { for (const [k, v] of fails) if (!v.some((t) => now() - t < 600e3)) fails.delete(k); }, 600e3).unref();
function normPassword(p) {
  const s = String(p ?? "");
  if (s.length < 4 || s.length > 100) throw new Error("비밀번호는 4자 이상 100자 이하로 정하세요");
  return s;
}

const saveTimers = new Map();
// 저장은 "임시 파일에 다 쓴 뒤 이름 바꾸기"로 함 → 쓰는 도중에 서버가 죽어도 원래 파일이 비거나 깨지지 않음
// (예전에는 파일을 바로 덮어썼고, 쓰는 순간 서버가 강제 종료되면서 방 파일이 0바이트가 된 적이 있음)
const saving = new Map(); // roomId -> "busy" | "again"
function writeRoom(room) {
  if (saving.has(room.id)) { saving.set(room.id, "again"); return; } // 앞의 저장이 끝나면 한 번 더
  saving.set(room.id, "busy");
  const file = roomFile(room.id), tmp = `${file}.tmp`;
  const done = () => { const again = saving.get(room.id) === "again"; saving.delete(room.id); if (again) writeRoom(room); };
  let text;
  try { text = JSON.stringify(room); } catch { return done(); }
  fs.writeFile(tmp, text, (err) => (err ? done() : fs.rename(tmp, file, done)));
}
function save(room) {
  clearTimeout(saveTimers.get(room.id));
  saveTimers.set(room.id, setTimeout(() => writeRoom(room), 300));
}

// ───────── 오래된 대화 자동 삭제 ─────────
// 팀룸에 올라온 지 12시간(RETENTION_HOURS로 변경, 0이면 끔)이 지난 메시지는 지움 — 공동 문서로 보낸 내용은 남음
// 커넥터·확장은 대화 전체를 다시 보내므로, 지운 메시지가 되살아나지 않게 표시(expiredKeys)를 남겨 둠
const RETENTION_HOURS = process.env.RETENTION_HOURS === undefined ? 12 : Number(process.env.RETENTION_HOURS) || 0;
const expiredIndex = new Map(); // roomId -> Set(extKey)
function expiredSet(room) {
  if (!expiredIndex.has(room.id)) expiredIndex.set(room.id, new Set(room.expiredKeys || []));
  return expiredIndex.get(room.id);
}
// 방마다 따로 정한 시간(room.retentionHours)이 있으면 그 값을, 없으면 기본값을 씀 (0 = 지우지 않음)
const retentionOf = (room) => (typeof room.retentionHours === "number" ? room.retentionHours : RETENTION_HOURS);
function pruneOld(room) {
  const hours = retentionOf(room);
  if (!hours) return false;
  const cut = now() - hours * 3600e3;
  const old = room.messages.filter((m) => m.ts < cut && m.status !== "streaming");
  if (!old.length) return false;
  const gone = new Set(old.map((m) => m.id));
  const set = expiredSet(room);
  for (const m of old) {
    if (m.extKey) { set.add(m.extKey); extIndex.get(room.id)?.delete(m.extKey); }
    // 그 메시지에 붙어 있던 올린 파일도 같이 지움
    for (const file of m.files || []) {
      const fileId = file.hosted && String(file.url || "").split("/files/")[1];
      if (!fileId || !room.uploads?.[fileId]) continue;
      delete room.uploads[fileId];
      fs.unlink(path.join(FILES_DIR, room.id.replace(/[^\w-]/g, ""), fileId.replace(/[^\w-]/g, "")), () => {});
    }
  }
  room.expiredKeys = [...set].slice(-10000);
  if (set.size > 10000) expiredIndex.set(room.id, new Set(room.expiredKeys));
  room.messages = room.messages.filter((m) => !gone.has(m.id));
  room.comments = room.comments.filter((c) => !gone.has(c.messageId));
  return true;
}

// 외부 앱에서 "작성 중"이던 답변이 1분 넘게 소식이 없으면(탭을 닫는 등) 완료로 간주
function settleStale(room) {
  for (const m of room.messages) {
    if (m.extKey && m.status === "streaming" && now() - (m.updatedAt || m.ts) > 60000) m.status = "done";
  }
}

function publicRoom(room) {
  settleStale(room);
  const s = secrets.get(room.id) || {};
  return {
    ...room,
    expiredKeys: undefined, deletedKeys: undefined, // (서버 내부용 기록 — 화면으로 보내지 않음)
    pass: undefined, locked: !!room.pass, // (비밀번호 값은 절대 내보내지 않고, 걸려 있는지만 알림)
    retentionHours: retentionOf(room),
    rev: revOf(room),
    online: [...new Set([
      ...[...(clients.get(room.id) || [])].map((c) => c.memberId),
      // 실시간 연결이 안 되는 환경(일부 프록시)에서 주기적으로 상태를 가져가는 사람도 접속 중으로 표시
      ...Object.entries(lastSeen.get(room.id) || {}).filter(([, t]) => now() - t < 10000).map(([m]) => m),
    ])],
    publicOrigin, // 초대 링크에 쓸 공개 주소 (없으면 null)
    // 키 값은 숨기고 "등록 여부"만 공개
    sharedKeys: {
      anthropic: !!s.anthropic,
      openai: !!s.openai,
      gemini: !!s.gemini,
    },
    serverKeys: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
    },
  };
}

// ───────── 실시간 전송 ─────────
// 방 상태 전체는 크기가 큼(대화가 쌓이면 수 MB). 그래서:
//  · 받는 쪽이 느려서 앞의 것을 아직 못 받은 연결에는 더 쌓지 않음 → 다 받으면 그때 최신 상태를 한 번 보냄
//    (예전에는 계속 쌓아서, 잠든 노트북 같은 연결 하나가 서버 메모리를 다 써 버릴 수 있었음)
//  · 짧은 시간에 여러 번 바뀌면 묶어서 한 번만 보냄
//  · 방마다 "몇 번째 상태인지"(rev)를 세어, 주기적으로 물어보는 쪽에는 바뀐 게 없으면 다시 보내지 않음
const MAX_BUFFERED = 8 * 1024 * 1024;
const revs = new Map(); // roomId -> 상태 번호
const revOf = (room) => { if (!revs.has(room.id)) revs.set(room.id, now()); return revs.get(room.id); };
const stateTimers = new Map();
function broadcast(room, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients.get(room.id) || []) {
    if (c.res.writableLength > MAX_BUFFERED) { c.res.destroy(); continue; } // 너무 밀린 연결은 끊음 (다시 붙으면 최신 상태를 받음)
    c.res.write(data);
  }
}
function sendState(room) {
  stateTimers.delete(room.id);
  let data = null;
  for (const c of clients.get(room.id) || []) {
    if (c.res.writableNeedDrain) { c.stale = true; continue; } // 아직 받는 중 → 다 받은 뒤(drain) 최신으로
    c.stale = false;
    data ||= `data: ${JSON.stringify({ type: "state", room: publicRoom(room) })}\n\n`;
    c.res.write(data);
  }
}
const scheduleState = (room) => { if (!stateTimers.has(room.id)) stateTimers.set(room.id, setTimeout(() => sendState(room), 300)); };
function broadcastState(room) {
  save(room);
  revs.set(room.id, revOf(room) + 1);
  scheduleState(room);
}
function log(room, memberId, kind, detail = "") {
  room.activity.push({ ts: now(), memberId, kind, detail });
  if (room.activity.length > 500) room.activity.shift();
}

// ───────────────────────── AI 제공자 ─────────────────────────
const DEFAULT_MODELS = {
  mock: "demo",
  anthropic: "claude-opus-5-5",
  openai: "gpt-5-mini",
  gemini: "gemini-2.5-flash",
};

const SYSTEM_PROMPT =
  "당신은 대학생 팀 프로젝트(팀플)를 돕는 AI 조수입니다. 한국어로 명확하고 구조적으로 답하세요. " +
  "사용자가 팀원 피드백을 전달하면 그 피드백을 구체적으로 반영해 결과물을 수정하세요.";

function resolveKey(room, provider, userKey) {
  if (userKey) return { key: userKey, source: "personal" };
  const s = secrets.get(room.id) || {};
  if (s[provider]) return { key: s[provider], source: "team" };
  const envName = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" }[provider];
  if (envName && process.env[envName]) return { key: process.env[envName], source: "server" };
  return { key: null, source: null };
}

async function streamMock(history, onText) {
  const last = history[history.length - 1]?.content || "";
  const isFeedback = last.includes("[팀원 피드백");
  const body = isFeedback
    ? `피드백 감사합니다! 지적해주신 부분을 반영해서 수정했습니다.\n\n## 수정 사항\n- 지적된 내용을 최신 근거로 보완했습니다.\n- 문장을 더 간결하게 다듬었습니다.\n\n## 수정본\n요청하신 "${last.slice(0, 40).replace(/\n/g, " ")}..." 부분을 아래처럼 고쳤습니다. 기존 논지는 유지하되 근거 자료를 2024년 이후 사례로 교체했고, 결론과의 연결을 명확히 했습니다.\n\n(※ 데모 모드 응답입니다. 실제 AI를 쓰려면 ⚙️ 설정에서 제공자를 바꾸세요.)`
    : `좋아요, "${last.slice(0, 50).replace(/\n/g, " ")}"에 대해 정리해볼게요.\n\n## 1. 핵심 요약\n이 주제는 세 가지 관점에서 볼 수 있습니다: 배경, 현재 쟁점, 시사점.\n\n## 2. 세부 내용\n- **배경**: 관련 제도와 시장 환경이 최근 몇 년간 빠르게 변화했습니다.\n- **쟁점**: 이해관계자 간의 시각 차이가 존재하며, 데이터로 뒷받침된 비교가 필요합니다.\n- **시사점**: 팀 보고서에서는 사례 2~3개를 비교 분석하는 구성이 효과적입니다.\n\n## 3. 다음 단계 제안\n1. 비교할 사례 선정\n2. 각 사례의 수치 자료 수집\n3. 결론 초안 작성\n\n(※ 데모 모드 응답입니다. 실제 AI를 쓰려면 ⚙️ 설정에서 제공자를 바꾸세요.)`;
  const tokens = body.match(/[\s\S]{1,4}/g);
  for (const t of tokens) {
    onText(t);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function streamAnthropic(key, model, history, onText) {
  const client = new Anthropic({ apiKey: key });
  // 거절(refusal) 시 서버 측 폴백 모델로 자동 재시도 (fallbacks: "default")
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    messages: history,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      onText(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") onText("\n\n(⚠️ AI가 이 요청에 대한 답변을 거절했습니다.)");
  if (final.stop_reason === "max_tokens") onText("\n\n(⚠️ 최대 길이에 도달해 답변이 잘렸습니다.)");
}

// OpenAI / Gemini 는 SSE 형식으로 스트리밍 — 공통 파서
async function readSSE(res, onData) {
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onData(JSON.parse(payload));
      } catch {}
    }
  }
}

async function streamOpenAI(key, model, history, onText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    }),
  });
  await readSSE(res, (j) => {
    const t = j.choices?.[0]?.delta?.content;
    if (t) onText(t);
  });
}

async function streamGemini(key, model, history, onText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    }),
  });
  await readSSE(res, (j) => {
    const t = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
    if (t) onText(t);
  });
}

async function runChat(room, member, { text, provider, model, apiKey, feedbackIds }) {
  provider = provider || "mock";
  model = model || DEFAULT_MODELS[provider];

  const userMsg = {
    id: id(), authorId: member.id, role: "user", text, status: "done",
    provider, model, ts: now(), feedbackIds: feedbackIds || [],
  };
  room.messages.push(userMsg);

  // 반영한 피드백은 "반영됨" 처리
  for (const fid of feedbackIds || []) {
    const c = room.comments.find((c) => c.id === fid && c.toId === member.id);
    if (c) { c.resolved = true; c.appliedInMessageId = userMsg.id; }
  }

  const { key, source } = provider === "mock" ? { key: "-", source: "demo" } : resolveKey(room, provider, apiKey);
  const aiMsg = {
    id: id(), authorId: member.id, role: "assistant", text: "", status: "streaming",
    provider, model, keySource: source, ts: now(), replyTo: userMsg.id,
  };
  room.messages.push(aiMsg);
  member.provider = provider;
  member.model = model;
  log(room, member.id, "prompt", text.slice(0, 80));
  broadcastState(room);

  if (!key) {
    aiMsg.status = "error";
    aiMsg.text = "API 키가 없습니다. ⚙️ 설정에서 개인 키를 입력하거나, 방장에게 팀 공용 키 등록을 요청하세요. (데모 모드는 키 없이 사용 가능)";
    broadcastState(room);
    return;
  }

  // 이 팀원의 대화 기록만 AI에게 전달 (각자 독립된 대화)
  const history = room.messages
    .filter((m) => m.authorId === member.id && m.id !== aiMsg.id && m.status === "done" && m.text)
    .map((m) => ({ role: m.role, content: m.text }));

  const onText = (t) => {
    aiMsg.text += t;
    broadcast(room, { type: "delta", messageId: aiMsg.id, text: t });
  };

  try {
    if (provider === "mock") await streamMock(history, onText);
    else if (provider === "anthropic") await streamAnthropic(key, model, history, onText);
    else if (provider === "openai") await streamOpenAI(key, model, history, onText);
    else if (provider === "gemini") await streamGemini(key, model, history, onText);
    else throw new Error(`알 수 없는 제공자: ${provider}`);
    aiMsg.status = "done";
  } catch (err) {
    aiMsg.status = "error";
    aiMsg.text += `${aiMsg.text ? "\n\n" : ""}⚠️ 오류: ${err.message || err}`;
  }
  log(room, member.id, "ai_done", `${provider}/${model}`);
  broadcastState(room);
}

// 같은 이름의 참여자가 여러 명이면: 먼저 들어온 사람을 남기고, 아무 활동이 없는 나머지는 정리
function dedupeMembers(room) {
  const byName = new Map();
  for (const m of Object.values(room.members).sort((x, y) => x.joinedAt - y.joinedAt)) {
    if (!byName.has(m.name)) { byName.set(m.name, m); continue; }
    const used = room.messages.some((x) => x.authorId === m.id) || room.comments.some((c) => c.fromId === m.id || c.toId === m.id) ||
      room.doc.some((b) => b.addedBy === m.id) || room.tasks.some((t) => t.assigneeId === m.id) || room.ownerId === m.id;
    if (!used) delete room.members[m.id];
  }
}

// ───────────────────────── 액션 처리 ─────────────────────────
function applyAction(room, a) {
  const me = room.members[a.memberId];
  if (!me && a.type !== "join") throw new Error("먼저 방에 입장하세요");

  switch (a.type) {
    case "join": {
      dedupeMembers(room);
      let m = a.memberId && room.members[a.memberId];
      // 같은 이름으로 다시 들어오면 같은 사람으로 (웹·확장·커넥터로 각각 입장해도 한 칸에 모이도록)
      const wanted = (a.name || "").trim().slice(0, 20);
      if (!m && wanted) m = Object.values(room.members).find((x) => x.name === wanted);
      if (!m) {
        const palette = ["#6366f1", "#ec4899", "#10b981", "#f59e0b", "#0ea5e9", "#ef4444", "#8b5cf6", "#14b8a6"];
        m = {
          id: id(),
          name: (a.name || "익명").slice(0, 20),
          color: palette[Object.keys(room.members).length % palette.length],
          provider: "none", model: "", joinedAt: now(), // 확장/앱에서 첫 대화가 들어오면 실제 AI 이름으로 바뀜
        };
        room.members[m.id] = m;
        if (!room.ownerId) room.ownerId = m.id;
        log(room, m.id, "join");
      }
      return { member: m };
    }
    case "chat":
      if (!a.text?.trim()) throw new Error("내용을 입력하세요");
      if (room.messages.some((m) => m.authorId === me.id && m.status === "streaming"))
        throw new Error("이전 답변이 아직 생성 중입니다");
      runChat(room, me, a); // 비동기로 스트리밍
      return {};
    case "comment": {
      const msg = room.messages.find((m) => m.id === a.messageId);
      if (!msg) throw new Error("메시지를 찾을 수 없습니다");
      room.comments.push({
        id: id(), messageId: msg.id, fromId: me.id, toId: msg.authorId,
        quote: (a.quote || "").slice(0, 500), text: a.text.slice(0, 2000),
        resolved: false, ts: now(),
      });
      log(room, me.id, "feedback", `→ ${room.members[msg.authorId]?.name}`);
      break;
    }
    case "syncExternal":
      return syncExternal(room, me, a);
    case "deleteMessage": {
      // 내가 올린 메시지만 삭제 가능. 외부 앱에서 온 메시지는 다시 올라오지 않도록 기록해 둠
      const m = room.messages.find((x) => x.id === a.messageId);
      if (!m || m.authorId !== me.id) throw new Error("내 메시지만 삭제할 수 있습니다");
      if (m.extKey) {
        room.deletedKeys = [...(room.deletedKeys || []), m.extKey].slice(-2000);
        extMap(room).delete(m.extKey);
      }
      room.messages = room.messages.filter((x) => x.id !== m.id);
      room.comments = room.comments.filter((c) => c.messageId !== m.id);
      break;
    }
    case "leave": {
      // 아무 활동도 없는 참여자만 방에서 제거 (같은 사람이 실수로 두 번 입장한 경우 정리용)
      const used = room.messages.some((x) => x.authorId === me.id) || room.comments.some((c) => c.fromId === me.id) ||
        room.doc.some((b) => b.addedBy === me.id) || room.tasks.some((t) => t.assigneeId === me.id) || room.ownerId === me.id;
      if (!used) delete room.members[me.id];
      break;
    }
    case "applyComment": {
      // 데스크톱 앱: 피드백을 ChatGPT/Claude 입력창에 넣은 경우
      const c = room.comments.find((c) => c.id === a.commentId && c.toId === me.id);
      if (c) { c.resolved = true; c.appliedInMessageId = c.appliedInMessageId || "external"; }
      log(room, me.id, "feedback_apply");
      break;
    }
    case "resolveComment": {
      const c = room.comments.find((c) => c.id === a.commentId);
      if (c) c.resolved = !c.resolved;
      break;
    }
    case "docAdd": {
      const msg = a.sourceMessageId && room.messages.find((m) => m.id === a.sourceMessageId);
      room.doc.push({
        id: id(), text: a.text ?? (msg ? msg.text + filesMarkdown(msg.files) : ""),
        sourceMessageId: msg?.id || null, sourceAuthorId: msg?.authorId || null,
        addedBy: me.id, updatedBy: me.id, ts: now(),
      });
      log(room, me.id, "doc_add");
      break;
    }
    case "docEdit": {
      const b = room.doc.find((b) => b.id === a.blockId);
      if (b && b.text !== a.text) { b.text = a.text; b.updatedBy = me.id; b.ts = now(); log(room, me.id, "doc_edit"); }
      break;
    }
    case "docMove": {
      const i = room.doc.findIndex((b) => b.id === a.blockId);
      const j = i + (a.dir === "up" ? -1 : 1);
      if (i >= 0 && j >= 0 && j < room.doc.length) [room.doc[i], room.doc[j]] = [room.doc[j], room.doc[i]];
      break;
    }
    case "docDelete":
      room.doc = room.doc.filter((b) => b.id !== a.blockId);
      log(room, me.id, "doc_delete");
      break;
    case "taskAdd":
      room.tasks.push({ id: id(), title: a.title.slice(0, 100), assigneeId: a.assigneeId || me.id, status: "todo", ts: now() });
      log(room, me.id, "task_add", a.title);
      break;
    case "taskUpdate": {
      const t = room.tasks.find((t) => t.id === a.taskId);
      if (t) {
        if (a.status) t.status = a.status;
        if (a.assigneeId) t.assigneeId = a.assigneeId;
        log(room, me.id, "task_update", `${t.title} → ${t.status}`);
      }
      break;
    }
    case "taskDelete":
      room.tasks = room.tasks.filter((t) => t.id !== a.taskId);
      break;
    // ───── 프로젝트 현황: 작업(상태 5가지 · 선후관계 · 막힌 이유) ─────
    case "workAdd": {
      const title = String(a.title || "").trim().slice(0, 100);
      if (!title) throw new Error("작업 이름을 입력하세요");
      (room.work ||= []).push({ id: id(), title, status: WORK_STATUS.includes(a.status) ? a.status : "planned", ownerId: room.members[a.ownerId] ? a.ownerId : me.id, deps: [], source: "manual", ts: now(), updatedAt: now() });
      log(room, me.id, "work_add", title);
      break;
    }
    case "workUpdate": {
      const w = (room.work || []).find((x) => x.id === a.workId);
      if (!w) break;
      // 사람이 상태를 직접 바꾸면 그 값을 우선함 (AI가 올리는 현황이 덮어쓰지 않음)
      if (WORK_STATUS.includes(a.status) && a.status !== w.status) { w.status = a.status; w.statusBy = me.id; log(room, me.id, "work_status", `${w.title} → ${a.status}`); }
      if (a.followAI) { delete w.statusBy; if (WORK_STATUS.includes(w.aiStatus)) w.status = w.aiStatus; }
      if (room.members[a.ownerId]) w.ownerId = a.ownerId;
      for (const k of WORK_TEXT) if (typeof a[k] === "string") w[k] = a[k].slice(0, 2000);
      if (typeof a.title === "string" && a.title.trim()) w.title = a.title.trim().slice(0, 100);
      if (Array.isArray(a.deps)) w.deps = a.deps.filter((d) => d !== w.id && room.work.some((x) => x.id === d) && !dependsOn(room, d, w.id)).slice(0, 20);
      w.updatedAt = now();
      break;
    }
    case "workDelete":
      room.work = (room.work || []).filter((x) => x.id !== a.workId);
      for (const x of room.work) x.deps = (x.deps || []).filter((d) => d !== a.workId);
      break;
    case "workReport":
      workReport(room, me, a);
      syncGitWork(room);
      break;
    // 각자 PC의 git 브랜치 상태 (그 PC에서 본 로컬 브랜치 + 마지막으로 받아 온 원격 브랜치 + 최근 커밋)
    // 이 방에서 내 프로젝트(폴더)를 뺌: 내가 올린 그 폴더의 브랜치 정보와 AI가 적은 작업을 지움 (직접 추가한 작업은 남김)
    case "projectDetach": {
      const folder = String(a.folder || "").slice(0, 80);
      if (room.git) delete room.git[`${me.id}:${folder}`];
      const gone = new Set((room.work || []).filter((w) => w.source === "ai" && w.key?.startsWith(`${me.id}:${folder}:`)).map((w) => w.id));
      room.work = (room.work || []).filter((w) => !gone.has(w.id));
      for (const w of room.work) w.deps = (w.deps || []).filter((d) => !gone.has(d));
      syncGitWork(room);
      log(room, me.id, "project_detach", folder);
      break;
    }
    case "gitReport": {
      const folder = String(a.folder || "").slice(0, 80);
      const str = (v, n) => String(v ?? "").slice(0, n);
      (room.git ||= {})[`${me.id}:${folder}`] = {
        memberId: me.id, folder, repo: str(a.repo, 100), current: str(a.current, 120), dirty: Number(a.dirty) || 0, at: now(),
        me: { name: str(a.me?.name, 60), login: str(a.me?.login, 60) }, // 그 PC의 git 이름·GitHub 계정
        branches: (Array.isArray(a.branches) ? a.branches : []).slice(0, 200).map((b) => ({
          name: str(b.name, 120), kind: b.kind === "remote" ? "remote" : "local", sha: str(b.sha, 12), upstream: str(b.upstream, 120),
          ahead: Number(b.ahead) || 0, behind: Number(b.behind) || 0, gone: !!b.gone, ts: Number(b.ts) || 0, author: str(b.author, 40), subject: str(b.subject, 120),
        })),
        // GitHub PR (그 PC에 GitHub CLI가 로그인돼 있을 때만 옴)
        prs: Array.isArray(a.prs) ? a.prs.slice(0, 40).map((p) => ({ number: Number(p.number) || 0, title: str(p.title, 120), state: str(p.state, 12), draft: !!p.draft, head: str(p.head, 120), base: str(p.base, 120), review: str(p.review, 24), url: /^https:\/\/github\.com\//.test(String(p.url)) ? str(p.url, 200) : "", updatedAt: Number(p.updatedAt) || 0, author: str(p.author, 40), mergedBy: str(p.mergedBy, 40), mergedAt: Number(p.mergedAt) || 0 })) : null,
        commits: (Array.isArray(a.commits) ? a.commits : []).slice(0, 120).map((c) => ({ h: str(c.h, 12), p: (Array.isArray(c.p) ? c.p : []).slice(0, 4).map((x) => str(x, 12)), an: str(c.an, 40), ct: Number(c.ct) || 0, s: str(c.s, 120), refs: str(c.refs, 300) })),
      };
      syncGitWork(room); // 브랜치·PR에서 작업을 만들고 상태를 맞춤
      break;
    }
    // 대화 자동 삭제 시간 (방장만, 0 = 지우지 않음, 최대 1년)
    case "setRetention": {
      if (room.ownerId !== me.id) throw new Error("자동 삭제 시간은 방장만 바꿀 수 있습니다");
      const h = Number(a.hours);
      if (!Number.isFinite(h) || h < 0 || h > 8760) throw new Error("시간이 올바르지 않습니다");
      room.retentionHours = Math.round(h);
      log(room, me.id, "retention", h ? `${room.retentionHours}시간` : "지우지 않음");
      pruneOld(room); // 줄였다면 그보다 오래된 대화는 바로 정리
      break;
    }
    // 방 비밀번호 정하기·바꾸기·없애기 (방장만, 빈 값 = 없앰). 바꾸면 다른 사람들은 새 비밀번호를 다시 넣어야 함
    case "setPassword": {
      if (room.ownerId !== me.id) throw new Error("방 비밀번호는 방장만 바꿀 수 있습니다");
      if (a.password) room.pass = makePass(normPassword(a.password)); else delete room.pass;
      log(room, me.id, "password", room.pass ? "설정" : "해제");
      return { passwordChanged: true };
    }
    // git 작성자 이름을 팀룸 참여자와 맞춤 (자동으로 못 맞춘 이름을 사람이 정해 줌)
    case "setAuthor": {
      const author = String(a.author || "").trim().toLowerCase().slice(0, 60);
      if (!author) break;
      room.authorMap ||= {};
      if (room.members[a.who]) room.authorMap[author] = a.who; else delete room.authorMap[author];
      syncGitWork(room);
      break;
    }
    case "setSharedKey": {
      // 팀 공용 키: 방장만 등록 가능, 메모리에만 저장
      if (room.ownerId !== me.id) throw new Error("팀 공용 키는 방장만 등록할 수 있습니다");
      if (!["anthropic", "openai", "gemini"].includes(a.provider)) throw new Error("잘못된 제공자");
      const s = secrets.get(room.id) || {};
      s[a.provider] = a.key?.trim() || null;
      secrets.set(room.id, s);
      log(room, me.id, "shared_key", `${a.provider} ${s[a.provider] ? "등록" : "삭제"}`);
      break;
    }
    case "rename":
      room.name = a.name.slice(0, 50);
      break;
    default:
      throw new Error("알 수 없는 액션");
  }
  return {};
}

// ─────────────── 데스크톱 앱(ChatGPT/Claude/Gemini 화면)에서 온 대화 동기화 ───────────────
// 정책: 한 번 공유된 내용은 원본 앱에서 지워도 팀룸에서는 유지 (삭제 동기화 없음)
const EXT_SOURCES = ["chatgpt", "claude", "gemini", "claudecode", "codex", "mockai"];
// ───────── 프로젝트 현황 ─────────
const WORK_STATUS = ["planned", "doing", "review", "blocked", "done"];
const WORK_TEXT = ["goal", "done", "remaining", "problems", "blockReason", "unblock", "branch"];
// a가 (직접·간접으로) b가 끝나기를 기다리는지 — 서로 물고 물리는 선후관계를 막는 데 사용
function dependsOn(room, a, b, seen = new Set()) {
  if (a === b) return true;
  if (seen.has(a)) return false;
  seen.add(a);
  return ((room.work || []).find((x) => x.id === a)?.deps || []).some((d) => dependsOn(room, d, b, seen));
}
// 각자의 AI(Claude Code·Codex·Gemini 등)가 프로젝트 폴더의 현황 파일에 적은 내용을 받아 반영
// 같은 사람·같은 폴더·같은 작업 이름이면 같은 작업으로 보고 갱신함
function workReport(room, me, a) {
  const folder = String(a.folder || "").slice(0, 80);
  const items = Array.isArray(a.items) ? a.items.slice(0, 50) : [];
  room.work ||= [];
  const mine = [];
  for (const it of items) {
    const title = String(it?.title || "").trim().slice(0, 100);
    if (!title) continue;
    const key = `${me.id}:${folder}:${title}`;
    let w = room.work.find((x) => x.key === key);
    if (!w) { w = { id: id(), key, title, ownerId: me.id, deps: [], source: "ai", status: "planned", ts: now() }; room.work.push(w); }
    w.folder = folder;
    w.ai = String(it.ai || "").slice(0, 30);
    w.aiStatus = WORK_STATUS.includes(it.status) ? it.status : "doing";
    if (!w.statusBy) w.status = w.aiStatus;
    const text = (v) => (Array.isArray(v) ? v.map((x) => `- ${x}`).join("\n") : String(v ?? "")).slice(0, 2000);
    for (const k of WORK_TEXT) if (it[k] !== undefined) w[k] = text(it[k]);
    // (dependsOn을 안 적은 보고는 이전 연결을 그대로 둠)
    if (Array.isArray(it.dependsOn) || !w.dependsOnTitles) w.dependsOnTitles = (Array.isArray(it.dependsOn) ? it.dependsOn : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
    w.updatedAt = now();
    w.reportedAt = now();
    mine.push(w);
  }
  // "먼저 끝나야 하는 작업"은 이름으로 적혀 오므로 이 방의 작업 중에서 찾아 연결 (다른 사람의 작업도 가능)
  // (나중에 올라온 다른 사람의 작업을 가리키는 경우도 있으므로, AI가 적은 작업 전체를 매번 다시 연결)
  for (const w of room.work.filter((x) => x.source === "ai" && x.dependsOnTitles)) {
    const ids = w.dependsOnTitles.map((t) => room.work.find((x) => x.id !== w.id && x.title === t)?.id).filter(Boolean);
    w.deps = [...new Set([...(w.deps || []).filter((d) => room.work.find((x) => x.id === d)?.source !== "ai"), ...ids])].filter((d) => !dependsOn(room, d, w.id));
  }
  if (mine.length) log(room, me.id, "work_report", `${folder}: ${mine.length}개 작업`);
}

// ───── 브랜치·PR에서 작업을 기본으로 만듦 ─────
// AI가 아무것도 적지 않아도 흐름도가 채워지도록, 각 PC가 올린 git 정보(room.git)로 작업을 만들고 갱신함
//  · 상태: PR 병합됨 → 완료 / PR 검토 대기·승인·수정 요청 → 검토 중 / PR 초안 또는 PR 없음 → 진행 중
//  · 로컬·원격 구분은 AI가 적는 게 아니라 실제 브랜치 비교로 정함 (내 PC에만 있음 / 안 올린 커밋 n개 / 원격과 같음 …)
//  · 같은 브랜치를 AI가 적은 작업이 있으면 따로 만들지 않고 그 작업에 PR·브랜치 상태만 붙임
const short7 = (h) => String(h || "").slice(0, 7);
const stripRemote = (n) => String(n).replace(/^[^/]+\//, "");
// git 작성자 이름(또는 GitHub 계정)이 팀룸의 누구인지 찾음
//  ① 사람이 직접 맞춰 둔 것(room.authorMap) ② 각 PC가 올린 자기 git 이름·GitHub 계정 ③ 팀룸 이름과 같거나 그 이름으로 시작하는 경우
function whoIs(room, reports, value, kind) {
  const v = String(value || "").trim();
  if (!v) return null;
  const low = v.toLowerCase();
  const mapped = room.authorMap?.[low];
  if (mapped && room.members[mapped]) return { id: mapped };
  for (const r of reports) if (r.me && [r.me.name, r.me.login].some((x) => x && x.toLowerCase() === low)) return { id: r.memberId };
  for (const m of Object.values(room.members)) { const n = m.name.toLowerCase(); if (n.length >= 3 && (low === n || low.startsWith(n) || n.startsWith(low))) return { id: m.id }; }
  return null;
}
function syncGitWork(room) {
  room.work ||= [];
  const reports = Object.values(room.git || {}).filter((r) => room.members[r.memberId]);
  const byRepo = new Map();
  for (const r of reports) { const k = r.repo || r.folder; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(r); }
  const live = new Set(); // 이번에 확인된 자동 작업의 key
  const facts = new Map(); // `${repo}\n${branch}` → { pr, sync, ownerId, ... }

  for (const [repo, list] of byRepo) {
    const prs = [...list].filter((r) => r.prs).sort((a, b) => b.at - a.at)[0]?.prs || [];
    const remote = new Map(); // 브랜치 이름 → 가장 최신으로 보이는 원격 커밋
    for (const r of list) for (const b of r.branches) if (b.kind === "remote") { const n = stripRemote(b.name); if (!remote.has(n) || remote.get(n).ts < b.ts) remote.set(n, b); }
    const names = new Set([...remote.keys()]);
    for (const r of list) for (const b of r.branches) if (b.kind === "local") names.add(b.name);
    for (const p of prs) names.add(p.head);
    // main에 이미 들어간 커밋들 (각 PC가 올린 최근 커밋 기록으로, 원격 main의 끝에서 부모를 따라가며 모음)
    const parents = new Map();
    for (const r of list) for (const c of r.commits || []) parents.set(short7(c.h), (c.p || []).map(short7));
    const mainTip = remote.get("main") || remote.get("master");
    const inMain = new Set();
    for (const stack = mainTip ? [short7(mainTip.sha)] : []; stack.length; ) { const h = stack.pop(); if (inMain.has(h)) continue; inMain.add(h); for (const p of parents.get(h) || []) stack.push(p); }
    for (const name of names) {
      if (/^(main|master|develop|dev|HEAD)$/.test(name)) continue; // 기준 브랜치는 작업이 아님
      const pr = prs.filter((p) => p.head === name).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
      const rb = remote.get(name);
      const locals = list.map((r) => ({ r, b: r.branches.find((x) => x.kind === "local" && x.name === name) })).filter((x) => x.b);
      // 이미 병합되어 원격·로컬 어디에도 안 남은 브랜치는 PR 기록만으로는 최근 것만 보여 줌 (오래된 PR이 끝없이 쌓이지 않게)
      if (!rb && !locals.length && pr && now() - pr.updatedAt > 14 * 864e5) continue;
      // 담당: ① PR을 올린 사람 → ② 그 브랜치에 마지막으로 커밋한 사람 → ③ (둘 다 알 수 없을 때만) 지금 열어 놓은 사람
      // 남의 브랜치를 검토하려고 열어 보기만 해도 내 작업이 되지 않도록, "열어 놓은 사람"은 맨 마지막에만 씀
      // (정보를 올린 PC의 주인으로 정하지 않음 — 남이 만든 브랜치가 내 이름으로 나오던 문제)
      const lastCommit = locals.map((x) => x.b).concat(rb ? [rb] : []).sort((a, b) => b.ts - a.ts)[0];
      const working = locals.find((x) => x.r.current === name);
      const who = whoIs(room, list, pr?.author, "login") || whoIs(room, list, lastCommit?.author, "name")
        || (pr?.author || lastCommit?.author ? { name: pr?.author || lastCommit?.author } : working ? { id: working.r.memberId } : { name: "" });
      const owner = who.id || null;
      // "완료"라고 적혀 있어도 main에 아직 없는 경우를 구분하기 위한 사실 정보
      const tip = short7((rb || locals[0]?.b)?.sha);
      const merged = pr?.state === "MERGED" || (!!tip && inMain.has(tip));
      // 로컬·원격 비교 (사람별)
      const sync = locals.map(({ r, b }) => {
        const who = room.members[r.memberId]?.name || "?";
        let text, stale = false;
        if (!rb && !b.upstream) text = "내 PC에만 있음 (아직 안 올림)";
        else if (b.ahead && b.behind) text = `갈라짐 (↑${b.ahead} 안 올림 · ↓${b.behind} 안 받음)`;
        else if (b.ahead) text = `안 올린 커밋 ${b.ahead}개`;
        else if (b.behind) { text = `${b.behind}개 뒤처짐 (받아 오기 필요)`; stale = true; }
        else if (rb && short7(rb.sha) !== short7(b.sha)) { text = "원격에 새 커밋 있음 (받아 오기 필요)"; stale = true; }
        else text = "원격과 같음";
        // 병합까지 끝난 작업이면, 내 PC의 예전 브랜치가 뒤처진 것은 경고할 일이 아님 (안 올린 커밋이 있는 경우만 계속 알림)
        if (merged && stale) return { who, text: "병합 끝남 · 내 PC에 예전 브랜치가 남아 있음", current: r.current === name, dirty: r.current === name ? r.dirty : 0, level: "ok" };
        return { who, text, current: r.current === name, dirty: r.current === name ? r.dirty : 0, level: /같음/.test(text) ? "ok" : "warn" };
      });
      if (!locals.length && rb) sync.push({ who: "", text: "원격(GitHub)에만 있음", level: "ok" });
      const pending = merged ? "" : !rb ? "아직 안 올림" : locals.some((x) => x.b.ahead > 0) ? "안 올린 커밋 있음" : "main 병합 전";
      const status = pr?.state === "MERGED" ? "done" : pr && pr.state === "OPEN" && !pr.draft ? "review" : pr?.state === "CLOSED" ? "planned" : "doing";
      const last = locals.map((x) => x.b).concat(rb ? [rb] : []).sort((a, b) => b.ts - a.ts)[0];
      // 흐름도의 시간축 위치 = 이 작업이 마지막으로 움직인 때 (병합됐으면 병합 시각, 아니면 마지막 커밋)
      const at = (pr?.state === "MERGED" && pr.mergedAt) || last?.ts || pr?.updatedAt || 0;
      facts.set(`${repo}\n${name}`, {
        at, repo, branch: name, status, ownerId: owner, ownerName: who.id ? "" : who.name, sync, pending, title: pr?.title || name, subject: last?.subject || "",
        pr: pr ? { number: pr.number, state: pr.state, draft: pr.draft, review: pr.review, url: pr.url, author: pr.author, mergedBy: pr.mergedBy, mergedAt: pr.mergedAt, base: pr.base } : null,
      });
    }
  }

  // AI가 적은(또는 사람이 추가한) 작업 중 같은 브랜치를 가리키는 것에는 사실 정보만 붙임
  const claimed = new Set();
  for (const w of room.work) {
    if (w.source === "git") continue;
    const hit = w.branch && [...facts.entries()].find(([, f]) => f.branch === w.branch.trim());
    if (!hit) { delete w.pr; delete w.sync; delete w.pending; delete w.at; continue; }
    claimed.add(hit[0]);
    w.at = hit[1].at; w.pr = hit[1].pr; w.sync = hit[1].sync; w.repo = hit[1].repo; w.pending = hit[1].pending;
    if (!w.statusBy && hit[1].pr?.state === "MERGED" && w.status !== "done") w.status = "done"; // 병합됐으면 완료 (사실 우선)
  }
  // 나머지 브랜치는 자동 작업으로
  for (const [k, f] of facts) {
    if (claimed.has(k)) continue;
    const key = `git:${k}`;
    live.add(key);
    let w = room.work.find((x) => x.key === key);
    if (!w) { w = { id: id(), key, source: "git", deps: [], ts: now() }; room.work.push(w); }
    const before = JSON.stringify([w.title, w.autoStatus, w.pr, w.sync, w.ownerId]);
    Object.assign(w, { at: f.at, title: f.title.slice(0, 100), branch: f.branch, repo: f.repo, folder: f.repo.split("/").pop(), pr: f.pr, sync: f.sync, pending: f.pending, ownerId: f.ownerId, ownerName: f.ownerName, autoStatus: f.status, goal: f.pr ? "" : f.subject });
    if (!w.statusBy) w.status = f.status;
    w.aiStatus = f.status; // ("자동으로 정한 상태 따르기"에 사용)
    if (before !== JSON.stringify([w.title, w.autoStatus, w.pr, w.sync, w.ownerId])) w.updatedAt = now();
  }
  // 없어진 브랜치의 자동 작업은 지움 (사람이 손댄 것도 브랜치가 없으면 근거가 없으므로 같이)
  const gone = new Set(room.work.filter((w) => w.source === "git" && !live.has(w.key)).map((w) => w.id));
  if (gone.size) { room.work = room.work.filter((w) => !gone.has(w.id)); for (const w of room.work) w.deps = (w.deps || []).filter((d) => !gone.has(d)); }
  // 선후관계: PR이 main이 아닌 다른 브랜치로 향하면, 그 브랜치의 작업이 먼저 (자동 작업끼리만)
  for (const w of room.work) {
    if (w.source !== "git") continue;
    const base = w.pr?.base && room.work.find((x) => x.id !== w.id && x.branch === w.pr.base && x.repo === w.repo);
    // 화살표는 "지금" PR이 향하는 브랜치만 따름: 대상이 main으로 바뀌면(앞 작업이 병합돼 main에 들어간 경우 등)
    // 그 작업은 이제 main 위에 바로 올라가는 것이므로 연결을 없앰. 사람이 직접 이은 연결은 그대로 둠
    delete w.baseOf;
    const manual = (w.deps || []).filter((d) => room.work.find((x) => x.id === d)?.source !== "git");
    w.deps = base && !dependsOn(room, base.id, w.id) ? [...new Set([...manual, base.id])] : manual;
  }
}

const extIndex = new Map(); // roomId -> Map(extKey -> message)

function extMap(room) {
  if (!extIndex.has(room.id)) {
    extIndex.set(room.id, new Map(room.messages.filter((m) => m.extKey).map((m) => [m.extKey, m])));
  }
  return extIndex.get(room.id);
}

// AI가 만든 파일·이미지 정리
// - file/image: http/https 링크
// - pending: AI 화면에 파일 카드만 있고 링크는 없음(다운로드해야 받을 수 있음) → 이름만
function cleanFiles(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).flatMap((f) => {
    const name = String(f?.name || "파일").slice(0, 100);
    if (f?.kind === "pending") return [{ kind: "pending", name, url: "" }];
    const url = String(f?.url || "");
    if (!/^https?:\/\//i.test(url) || url.length > 2000) return [];
    return [{ kind: f.kind === "image" ? "image" : "file", name, url }];
  });
}
// 첨부 합치기: 같은 링크는 한 번만, 같은 이름의 "업로드된 파일"이 있으면 대기(pending) 표시는 빼기
function mergeFiles(oldList = [], newList = []) {
  const merged = [...oldList];
  for (const f of newList) {
    if (f.kind === "pending" ? merged.some((x) => x.name === f.name) : merged.some((x) => x.url === f.url)) continue;
    merged.push(f);
  }
  const hostedNames = new Set(merged.filter((x) => x.hosted).map((x) => x.name));
  return merged.filter((x) => !(x.kind === "pending" && hostedNames.has(x.name))).slice(0, 20);
}

// ───────── 팀룸에 올린 파일 저장 (data/files/<방>/<파일ID>) ─────────
const FILES_DIR = path.join(DATA_DIR, "files");
const MAX_UPLOAD = 30 * 1024 * 1024; // 30MB
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("파일이 너무 큽니다 (최대 30MB)")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function safeFileName(name) {
  return String(name || "파일").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "파일";
}
// 올린 파일을 메시지에 붙임: 같은 이름의 "대기" 첨부가 있는 AI 답변 → 그 대화의 마지막 AI 답변 → 없으면 새 메시지
function attachUpload(room, me, file, { source, convId }) {
  const mine = room.messages.filter((m) => m.authorId === me.id);
  let target =
    [...mine].reverse().find((m) => m.files?.some((f) => f.kind === "pending" && f.name === file.name)) ||
    (convId ? [...mine].reverse().find((m) => m.role === "assistant" && m.source === source && m.convId === convId) : null);
  if (!target) {
    target = { id: id(), authorId: me.id, role: "user", text: `📎 파일 공유: ${file.name}`, status: "done", source: "upload", provider: "upload", model: "", ts: now(), files: [] };
    room.messages.push(target);
  }
  // 같은 이름의 파일을 다시 올리면 새 버전으로 교체
  target.files = mergeFiles((target.files || []).filter((f) => !(f.hosted && f.name === file.name)), [file]);
  log(room, me.id, "file_upload", file.name);
  return target;
}
// 공동 문서로 보낼 때 첨부를 마크다운 링크로
const filesMarkdown = (files) => (files?.length ? `\n\n📎 첨부\n${files.map((f) => `- [${f.name}](${f.url})`).join("\n")}` : "");

function syncExternal(room, me, a) {
  if (!EXT_SOURCES.includes(a.source)) throw new Error("알 수 없는 출처");
  if (!a.convId || !Array.isArray(a.messages)) throw new Error("잘못된 동기화 데이터");
  const index = extMap(room);
  const convTitle = String(a.convTitle || "").slice(0, 100);
  const convFolder = String(a.convFolder || "").slice(0, 80); // 그 대화를 나눈 프로젝트 폴더 이름 (채팅방 이름과 따로 표시)

  // 임시 ID(tmp-…)로 올라온 대화가 진짜 ID를 받은 경우 → 기존 메시지를 진짜 대화로 옮김 (중복 방지)
  if (typeof a.renameFrom === "string" && a.renameFrom.startsWith("tmp-") && a.renameFrom !== a.convId) {
    const oldPrefix = `${me.id}:${a.source}:${a.renameFrom}:`;
    for (const m of room.messages) {
      if (!m.extKey?.startsWith(oldPrefix)) continue;
      index.delete(m.extKey);
      m.extKey = `${me.id}:${a.source}:${a.convId}:${m.extKey.slice(oldPrefix.length)}`;
      m.convId = a.convId;
      index.set(m.extKey, m);
    }
  }
  // 이 대화가 어느 브랜치에서 진행됐고 어떤 PR을 만들었는지 (작업 흐름도의 "근거 대화"를 짝짓는 데 사용)
  if (typeof a.convBranch === "string" || Array.isArray(a.convPRs)) {
    (room.convMeta ||= {})[`${me.id}:${a.source}:${a.convId}`] = {
      branch: String(a.convBranch || "").slice(0, 120),
      // 그 대화가 실제로 작업한 브랜치들 (한 대화에서 여러 작업을 한 경우)
      branches: (Array.isArray(a.convBranches) ? a.convBranches : []).slice(0, 20).map((b) => String(b).slice(0, 120)),
      prs: (Array.isArray(a.convPRs) ? a.convPRs : []).slice(0, 10).map((p) => ({ repo: String(p?.repo || "").slice(0, 100), n: Number(p?.n) || 0 })),
    };
  }
  let added = 0;
  let tagsChanged = false;
  const updates = [];

  for (const em of a.messages.slice(0, 500)) {
    if (!em || !["user", "assistant"].includes(em.role)) continue;
    const text = String(em.text || "").slice(0, 100000);
    const status = em.streaming ? "streaming" : "done";
    const files = cleanFiles(em.files);
    const extKey = `${me.id}:${a.source}:${a.convId}:${em.extId}`;
    if (room.deletedKeys?.includes(extKey)) continue; // 사용자가 지운 메시지는 다시 올리지 않음
    if (expiredSet(room).has(extKey)) continue; // 12시간이 지나 자동으로 지워진 메시지도 다시 올리지 않음
    const existing = index.get(extKey);
    // 이 질문·답변에서 작업한 브랜치와 만든 PR (근거 대화를 그 부분으로 바로 보내는 데 사용)
    const workBranches = (Array.isArray(em.branches) ? em.branches : []).slice(0, 10).map((b) => String(b).slice(0, 120));
    const workPRs = (Array.isArray(em.prs) ? em.prs : []).slice(0, 10).map(Number).filter(Boolean);
    if (existing && JSON.stringify([existing.workBranches || [], existing.workPRs || [], existing.convFolder || "", existing.convTitle || ""]) !== JSON.stringify([workBranches, workPRs, convFolder, convTitle])) { existing.workBranches = workBranches; existing.workPRs = workPRs; existing.convFolder = convFolder; existing.convTitle = convTitle; tagsChanged = true; }
    if (!existing) {
      if (!text.trim()) continue;
      const msg = {
        id: id(), authorId: me.id, role: em.role, text, status,
        provider: a.source, model: convTitle || "앱 대화", source: a.source,
        convId: a.convId, convTitle, convFolder, extKey, ts: now(), updatedAt: now(), files, workBranches, workPRs,
      };
      room.messages.push(msg);
      index.set(extKey, msg);
      added++;
      if (em.role === "user") log(room, me.id, "ext_prompt", `${a.source}: ${text.slice(0, 60)}`);
    } else if (existing.text !== text || existing.status !== status || existing.convTitle !== convTitle || JSON.stringify(existing.files || []) !== JSON.stringify(files)) {
      // 내용이 줄어드는 경우(화면 일부만 읽힌 경우 등)는 무시하고 기존 내용 유지
      if (text.length >= existing.text.length || status === "done" || existing.text.startsWith("⏳")) {
        if (text.trim()) existing.text = text;
      }
      existing.status = status;
      existing.convTitle = convTitle;
      existing.updatedAt = now();
      // 첨부는 사라지지 않게 합침 (화면에서 잠깐 안 보여도 유지)
      existing.files = mergeFiles(existing.files, files);
      updates.push(existing);
    } else if (status === "streaming") {
      existing.updatedAt = now(); // "아직 작업 중" 소식 → 오래 걸리는 작업도 완료로 바뀌지 않게
    }
  }

  me.provider = a.source;
  me.model = convTitle || "앱 대화";
  if (added || tagsChanged) {
    broadcastState(room);
  } else if (updates.length) {
    save(room);
    for (const m of updates) broadcast(room, { type: "msgUpdate", messageId: m.id, text: m.text, status: m.status, files: m.files });
  }
  return { skipBroadcast: true, added, updated: updates.length };
}

// ───────────────────────── HTTP ─────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
// 크롬 확장(다른 출처)에서 API를 호출할 수 있도록 허용
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-room-key",
};
function json(res, code, obj, extra = {}) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra });
  res.end(JSON.stringify(obj));
}

// 다른 사람이 접속할 수 있는 주소(터널·내부망 IP)를 기억해 둠 → 초대 링크를 그 주소로 만들어 줌
// (PUBLIC_URL 환경변수로 직접 지정 가능. https 주소를 우선)
let publicOrigin = (process.env.PUBLIC_URL || "").replace(/\/$/, "") || null;
const publicFile = path.join(DATA_DIR, "public-origin.txt");
if (!publicOrigin) { try { publicOrigin = fs.readFileSync(publicFile, "utf8").trim() || null; } catch {} }
function notePublicOrigin(req) {
  if (process.env.PUBLIC_URL) return;
  const host = String(req.headers.host || "");
  if (!host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const origin = `${proto}://${host}`;
  if (origin === publicOrigin || (publicOrigin?.startsWith("https://") && proto !== "https")) return;
  publicOrigin = origin;
  fs.writeFile(publicFile, origin, () => {});
}

const server = http.createServer(async (req, res) => {
  notePublicOrigin(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    // POST /api/rooms → 방 생성
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readBody(req);
      const need = createPassword();
      if (need) {
        const fk = `create:${clientIp(req)}`;
        if (tooManyFails(fk)) return json(res, 429, { error: "여러 번 틀렸습니다. 10분 뒤에 다시 해 보세요" });
        if (!sameText(body.createPassword ?? "", need)) {
          if (body.createPassword) noteFail(fk);
          return json(res, 403, { error: body.createPassword ? "방 만들기 비밀번호가 틀렸습니다" : "방을 만들려면 방 만들기 비밀번호가 필요합니다", createLocked: true });
        }
      }
      // 한곳에서 방을 마구 만드는 것 막기 (10분에 10개까지)
      const mk = `made:${clientIp(req)}`;
      if (tooManyFails(mk)) return json(res, 429, { error: "방을 너무 많이 만들었습니다. 10분 뒤에 다시 해 보세요" });
      const pass = body.password ? makePass(normPassword(body.password)) : null;
      noteFail(mk);
      const room = newRoom(String(body.name || "").slice(0, 50));
      if (pass) room.pass = pass;
      rooms.set(room.id, room);
      save(room);
      return json(res, 200, { id: room.id, ...(pass ? { key: roomKey(room) } : {}) }, pass ? { "set-cookie": keyCookie(req, room) } : {});
    }

    // GET /api/info → 방을 만들 때 비밀번호가 필요한 서버인지
    if (req.method === "GET" && url.pathname === "/api/info") return json(res, 200, { createLocked: !!createPassword() });

    if (req.method === "OPTIONS" && parts[0] === "api") {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
      const room = getRoom(parts[2]);
      if (!room) return json(res, 404, { error: "방을 찾을 수 없습니다" });

      // POST /api/rooms/:id/unlock {password} → 입장 열쇠 (브라우저에는 쿠키로도 심어 줌)
      if (req.method === "POST" && parts[3] === "unlock") {
        if (!room.pass) return json(res, 200, { ok: true, key: "" });
        const fk = `room:${room.id}:${clientIp(req)}`;
        if (tooManyFails(fk)) return json(res, 429, { error: "여러 번 틀렸습니다. 10분 뒤에 다시 해 보세요" });
        const body = await readBody(req);
        if (!checkPass(room, body.password ?? "")) { noteFail(fk); return json(res, 403, { error: "비밀번호가 틀렸습니다" }); }
        return json(res, 200, { ok: true, key: roomKey(room) }, { "set-cookie": keyCookie(req, room) });
      }
      // 비밀번호가 걸린 방은 열쇠 없이는 아무것도 볼 수 없음 (방 이름도 알려 주지 않음)
      if (!authorized(req, url, room)) return json(res, 401, { error: "이 방은 비밀번호가 필요합니다", locked: true });

      // GET /api/rooms/:id/events → 실시간 스트림(SSE)
      if (req.method === "GET" && parts[3] === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...CORS });
        res.write(": connected\n\n");
        const client = { res, memberId: url.searchParams.get("memberId") };
        if (!clients.has(room.id)) clients.set(room.id, new Set());
        clients.get(room.id).add(client);
        broadcastState(room);
        const ping = setInterval(() => { if (!res.writableNeedDrain) res.write(": ping\n\n"); }, 20000);
        res.on("drain", () => { if (client.stale) scheduleState(room); }); // 밀렸던 연결이 다 받았으면 최신 상태를 보냄
        req.on("close", () => {
          clearInterval(ping);
          clients.get(room.id)?.delete(client);
          broadcastState(room);
        });
        return;
      }

      // GET /api/rooms/:id/state → 현재 방 상태 (데스크톱 앱 연결 확인용)
      if (req.method === "GET" && parts[3] === "state") {
        const mid = url.searchParams.get("memberId");
        if (mid && room.members[mid]) {
          if (!lastSeen.has(room.id)) lastSeen.set(room.id, {});
          lastSeen.get(room.id)[mid] = now();
        }
        // 이미 갖고 있는 상태와 같으면(since = 지금 번호) 내용 없이 답함 → 큰 상태를 1.5초마다 다시 보내지 않음
        if (url.searchParams.get("since") === String(revOf(room))) { res.writeHead(204, CORS); return res.end(); }
        return json(res, 200, publicRoom(room));
      }

      // POST /api/rooms/:id/upload?memberId=&name=&source=&convId= → 파일 올리기 (본문 = 파일 그대로)
      if (req.method === "POST" && parts[3] === "upload") {
        const me = room.members[url.searchParams.get("memberId")];
        if (!me) return json(res, 400, { error: "먼저 방에 입장하세요" });
        const buf = await readRaw(req, MAX_UPLOAD);
        if (!buf.length) return json(res, 400, { error: "빈 파일입니다" });
        const fileId = id() + id();
        const name = safeFileName(url.searchParams.get("name"));
        const dir = path.join(FILES_DIR, room.id.replace(/[^\w-]/g, ""));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fileId), buf);
        const isImage = /\.(png|jpe?g|gif|webp)$/i.test(name);
        room.uploads = room.uploads || {};
        room.uploads[fileId] = { name, size: buf.length, type: req.headers["content-type"] || "application/octet-stream", by: me.id, ts: now() };
        const file = { kind: isImage ? "image" : "file", name, url: `/api/rooms/${room.id}/files/${fileId}`, hosted: true, size: buf.length };
        const msg = attachUpload(room, me, file, { source: url.searchParams.get("source"), convId: url.searchParams.get("convId") });
        broadcastState(room);
        return json(res, 200, { ok: true, url: file.url, messageId: msg.id });
      }

      // GET /api/rooms/:id/files/:fileId → 올린 파일 받기
      if (req.method === "GET" && parts[3] === "files" && parts[4]) {
        const meta = room.uploads?.[parts[4]];
        const file = path.join(FILES_DIR, room.id.replace(/[^\w-]/g, ""), parts[4].replace(/[^\w-]/g, ""));
        if (!meta || !fs.existsSync(file)) return json(res, 404, { error: "파일이 없습니다" });
        const inline = /\.(png|jpe?g|gif|webp)$/i.test(meta.name) && url.searchParams.get("download") !== "1";
        // 바로 보여주는 건 이미지뿐 (형식은 확장자로 정함), 나머지는 항상 다운로드로
        const ext = meta.name.split(".").pop().toLowerCase();
        const imageType = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext];
        res.writeHead(200, {
          "content-type": inline ? imageType : "application/octet-stream",
          "content-length": meta.size,
          "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          "x-content-type-options": "nosniff",
          ...CORS,
        });
        return fs.createReadStream(file).pipe(res);
      }

      // POST /api/rooms/:id/action → 모든 변경
      if (req.method === "POST" && parts[3] === "action") {
        const body = await readBody(req);
        const { skipBroadcast, passwordChanged, ...result } = applyAction(room, body);
        if (passwordChanged) {
          // 예전 열쇠로 붙어 있던 실시간 연결을 끊음 → 각자 새 비밀번호로 다시 들어와야 함 (바꾼 사람은 새 열쇠를 바로 받음)
          save(room);
          for (const c of [...(clients.get(room.id) || [])]) c.res.end();
          return json(res, 200, { ok: true, locked: !!room.pass, key: room.pass ? roomKey(room) : "" }, { "set-cookie": keyCookie(req, room) });
        }
        if (!skipBroadcast) broadcastState(room);
        return json(res, 200, { ok: true, ...result });
      }
    }

    // 커넥터 설치 파일 내려받기 (설치 페이지 /install.html 에서 사용) — 정해진 파일만
    if (req.method === "GET" && parts[0] === "downloads" && parts[1]) {
      const allowed = { "teamroom-connector.mjs": "text/javascript; charset=utf-8", "AI팀룸.exe": "application/octet-stream", "AI팀룸v2.exe": "application/octet-stream", "사용법.md": "text/markdown; charset=utf-8", "AI팀룸-크롬확장.zip": "application/zip" };
      const name = decodeURIComponent(parts[1]);
      const file = path.join(__dirname, name.endsWith(".zip") ? "dist" : "connector", name);
      if (!allowed[name] || !fs.existsSync(file)) return json(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": allowed[name],
        "content-length": fs.statSync(file).size,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store",
      });
      return fs.createReadStream(file).pipe(res);
    }

    // 정적 파일
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        return fs.createReadStream(file).pipe(res);
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 400, { error: err.message || String(err) });
  }
});

// 30초마다: 오래 멈춰 있는 "작성 중" 답변을 완료로 바꾸고 화면에 반영
setInterval(() => {
  for (const room of rooms.values()) {
    if (pruneOld(room)) { broadcastState(room); continue; }
    if (room.messages.some((m) => m.extKey && m.status === "streaming" && now() - (m.updatedAt || m.ts) > 60000)) broadcastState(room);
  }
}, 30000);

// (클라우드에서는 HOST=127.0.0.1 로 두어, 밖에서는 HTTPS 프록시를 거쳐서만 들어오게 함)
server.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`AI 팀룸 실행 중 → http://localhost:${PORT}`);
});
