// AI 팀룸 — 팀원들이 각자의 AI와 작업하는 과정을 실시간으로 공유하는 서버
// 실행: npm install && npm start  →  http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
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
    pruneOld(room);
    rooms.set(rid, room);
    return room;
  }
  return null;
}

const saveTimers = new Map();
function save(room) {
  clearTimeout(saveTimers.get(room.id));
  saveTimers.set(
    room.id,
    setTimeout(() => fs.writeFile(roomFile(room.id), JSON.stringify(room), () => {}), 300),
  );
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
function pruneOld(room) {
  if (!RETENTION_HOURS) return false;
  const cut = now() - RETENTION_HOURS * 3600e3;
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
    retentionHours: RETENTION_HOURS,
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

function broadcast(room, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients.get(room.id) || []) c.res.write(data);
}
function broadcastState(room) {
  save(room);
  broadcast(room, { type: "state", room: publicRoom(room) });
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
  let added = 0;
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
    if (!existing) {
      if (!text.trim()) continue;
      const msg = {
        id: id(), authorId: me.id, role: em.role, text, status,
        provider: a.source, model: convTitle || "앱 대화", source: a.source,
        convId: a.convId, convTitle, extKey, ts: now(), updatedAt: now(), files,
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
  if (added) {
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
  "access-control-allow-headers": "content-type",
};
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...CORS });
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
      const room = newRoom(body.name);
      rooms.set(room.id, room);
      save(room);
      return json(res, 200, { id: room.id });
    }

    if (req.method === "OPTIONS" && parts[0] === "api") {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
      const room = getRoom(parts[2]);
      if (!room) return json(res, 404, { error: "방을 찾을 수 없습니다" });

      // GET /api/rooms/:id/events → 실시간 스트림(SSE)
      if (req.method === "GET" && parts[3] === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...CORS });
        res.write(": connected\n\n");
        const client = { res, memberId: url.searchParams.get("memberId") };
        if (!clients.has(room.id)) clients.set(room.id, new Set());
        clients.get(room.id).add(client);
        broadcastState(room);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
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
        const { skipBroadcast, ...result } = applyAction(room, body);
        if (!skipBroadcast) broadcastState(room);
        return json(res, 200, { ok: true, ...result });
      }
    }

    // 커넥터 설치 파일 내려받기 (설치 페이지 /install.html 에서 사용) — 정해진 파일만
    if (req.method === "GET" && parts[0] === "downloads" && parts[1]) {
      const allowed = { "teamroom-connector.mjs": "text/javascript; charset=utf-8", "AI팀룸.exe": "application/octet-stream", "사용법.md": "text/markdown; charset=utf-8", "AI팀룸-크롬확장.zip": "application/zip" };
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

server.listen(PORT, () => {
  console.log(`AI 팀룸 실행 중 → http://localhost:${PORT}`);
});
