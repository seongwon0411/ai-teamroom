// 프로젝트 현황: 작업 흐름도 (상태 5가지 · 선후관계 · 막힌 이유) — app.js 다음에 불러옴
// app.js의 room · me · act · esc · member · toast · $ 를 그대로 씀
(() => {
  const STATUS = {
    planned: { label: "계획됨", color: "#94a3b8" },
    doing: { label: "진행 중", color: "#3b82f6" },
    review: { label: "검토 중", color: "#a855f7" },
    blocked: { label: "차단됨", color: "#ef4444" },
    done: { label: "완료", color: "#22c55e" },
  };
  const ORDER = ["planned", "doing", "review", "blocked", "done"];
  const NODE_W = 240, NODE_H = 116, GAP_X = 90, GAP_Y = 26;
  const svg = $("#graph-svg"), vp = $("#graph-vp"), box = $("#graph");
  const view = { k: 1, x: 40, y: 40, fitted: false }; // 확대 배율과 이동 위치
  let mainView = "chat";
  let selected = null; // 자세히 보고 있는 작업 ID
  let layoutSize = { w: 0, h: 0 };
  const works = () => room?.work || [];
  const lines = (t) => String(t || "").split("\n").map((s) => s.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean);

  // ───── 보기 전환 (대화 / 프로젝트 현황) ─────
  function setMainView(v) {
    mainView = v;
    document.querySelectorAll("#view-switch .vtab").forEach((b) => b.classList.toggle("active", b.dataset.mainview === v));
    const chat = v === "chat";
    $("#project").hidden = chat;
    $(".workspace").hidden = !chat;
    $("#source-filter").hidden = !chat;
    $("#ai-launch").classList.toggle("off", !chat);
    if (!chat) { render(); if (!view.fitted) showLatest(); }
  }

  // ───── 배치: 가로 = 시간 (왼쪽이 오래된 것, 오른쪽이 최신) · 세로 = 담당자별 줄 ─────
  //  · 가로 위치는 그 작업이 "마지막으로 움직인 날" (병합됐으면 병합한 날, 아니면 마지막 커밋·수정한 날)
  //  · 작업이 없는 날은 건너뜀 (빈 칸을 두지 않음) → 위쪽 날짜 표시로 간격을 알 수 있음
  //  · 같은 날 안에서 이어지는 작업(A 위에서 B)은 A를 왼쪽 칸, B를 오른쪽 칸에 둠
  const COL_W = NODE_W + 44, DAY_GAP = 40, LANE_PAD = 18, HEAD_H = 46, LABEL_W = 96;
  const timeOf = (w) => w.at || w.updatedAt || w.ts || 0;
  const dayOf = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const laneOf = (w) => (w.ownerId && room.members[w.ownerId] ? w.ownerId : "~" + (w.ownerName || ""));
  let deco = { days: [], lanes: [] }; // 날짜 머리글 · 담당자 줄 (그릴 때 씀)
  function layout(list) {
    const byId = new Map(list.map((w) => [w.id, w]));
    const day = new Map(list.map((w) => [w.id, dayOf(timeOf(w))]));
    // 같은 날 안에서의 칸 (앞 작업이 같은 날이면 그 오른쪽 칸)
    const sub = new Map();
    const subOf = (w, seen = new Set()) => {
      if (sub.has(w.id)) return sub.get(w.id);
      if (seen.has(w.id)) return 0;
      seen.add(w.id);
      const s = Math.max(-1, ...(w.deps || []).map((id) => (byId.has(id) && day.get(id) === day.get(w.id) ? subOf(byId.get(id), seen) : -1))) + 1;
      sub.set(w.id, s);
      return s;
    };
    list.forEach((w) => subOf(w));
    // 날짜별 가로 위치
    const dayX = new Map();
    const days = [];
    let x = LABEL_W;
    for (const d of [...new Set(day.values())].sort((a, b) => a - b)) {
      const cols = Math.max(...list.filter((w) => day.get(w.id) === d).map((w) => sub.get(w.id))) + 1;
      dayX.set(d, x);
      days.push({ t: d, x, w: cols * COL_W - (COL_W - NODE_W) });
      x += cols * COL_W - (COL_W - NODE_W) + DAY_GAP;
    }
    // 담당자 줄: 나 → 다른 참여자(들어온 순서) → 팀룸에 없는 이름
    const laneKeys = [...new Set(list.map(laneOf))].sort((a, b) => {
      const rank = (k) => (k === me ? 0 : room.members[k] ? 1 : 2);
      return rank(a) - rank(b) || (room.members[a]?.joinedAt || 0) - (room.members[b]?.joinedAt || 0) || (a > b ? 1 : -1);
    });
    const pos = new Map();
    const lanes = [];
    let y = HEAD_H;
    for (const key of laneKeys) {
      const mine = list.filter((w) => laneOf(w) === key).sort((a, b) => timeOf(a) - timeOf(b));
      const stack = new Map(); // "날짜:칸" → 쌓인 개수
      for (const w of mine) {
        const cell = `${day.get(w.id)}:${sub.get(w.id)}`, row = stack.get(cell) || 0;
        stack.set(cell, row + 1);
        pos.set(w.id, { x: dayX.get(day.get(w.id)) + sub.get(w.id) * COL_W, y: y + LANE_PAD + row * (NODE_H + GAP_Y) });
      }
      const h = Math.max(1, ...stack.values()) * (NODE_H + GAP_Y) - GAP_Y + LANE_PAD * 2;
      const m = room.members[key];
      lanes.push({ y, h, name: m ? m.name : key.slice(1) || "담당 미정", color: m ? m.color : "#94a3b8", count: mine.length });
      y += h;
    }
    deco = { days, lanes };
    layoutSize = { w: Math.max(LABEL_W + NODE_W, x - DAY_GAP), h: y };
    return pos;
  }
  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  function dayLabel(t) {
    const d = new Date(t), diff = Math.round((dayOf(Date.now()) - t) / 864e5);
    const base = `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
    return diff === 0 ? `오늘 · ${base}` : diff === 1 ? `어제 · ${base}` : base;
  }
  function decoHTML() {
    const { days, lanes } = deco, W = layoutSize.w, H = layoutSize.h;
    return lanes.map((l, i) => `<rect class="lane-band ${i % 2 ? "alt" : ""}" x="0" y="${l.y}" width="${W}" height="${l.h}"></rect>`).join("")
      + days.map((d, i) => `${i ? `<line class="day-line" x1="${d.x - DAY_GAP / 2}" y1="8" x2="${d.x - DAY_GAP / 2}" y2="${H}"></line>` : ""}<text class="day-head ${dayOf(Date.now()) === d.t ? "today" : ""}" x="${d.x + 2}" y="26">${esc(dayLabel(d.t))}</text>`).join("")
      + `<text class="axis-note" x="${W}" y="26" text-anchor="end">최신 →</text>`
      + lanes.map((l) => `<g class="lane-label" data-y="${l.y}"><rect x="0" y="${l.y + 8}" width="${LABEL_W - 14}" height="26" rx="13"></rect><circle cx="14" cy="${l.y + 21}" r="5" fill="${l.color}"></circle><text x="25" y="${l.y + 25.5}">${esc(l.name.length > 5 ? l.name.slice(0, 5) + "…" : l.name)}</text></g>`).join("");
  }

  // PR 상태 (GitHub에서 읽은 사실)
  function prInfo(p) {
    if (!p) return null;
    return p.state === "MERGED" ? { cls: "merged", text: "병합됨" } : p.state === "CLOSED" ? { cls: "closed", text: "닫힘" } : p.draft ? { cls: "draft", text: "초안" }
      : p.review === "APPROVED" ? { cls: "ok", text: "승인됨" } : p.review === "CHANGES_REQUESTED" ? { cls: "bad", text: "수정 요청" } : { cls: "open", text: "검토 대기" };
  }
  // 로컬·원격 비교 결과 중 가장 눈여겨볼 한 줄 (문제가 있는 쪽 우선)
  const syncLine = (w) => { const l = w.sync || []; const x = l.find((v) => v.level === "warn") || l[0]; return x ? { ...x, label: (x.who ? x.who + ": " : "") + x.text } : null; };
  // 담당: 팀룸 참여자면 그 사람, 아니면 git에 적힌 작성자 이름 그대로 (팀룸에 없는 사람이거나 아직 누구인지 못 맞춘 경우)
  const ownerOf = (w) => (w.ownerId && room.members[w.ownerId] ? member(w.ownerId) : { name: w.ownerName || "담당 미정", color: "#94a3b8", unknown: true });
  function nodeHTML(w) {
    const s = STATUS[w.status] || STATUS.planned;
    const m = ownerOf(w);
    const notInMain = w.status === "done" && w.pending; // 완료라고 적혔지만 main에는 아직 없음
    const done = lines(w.done).length, remaining = lines(w.remaining).length, problems = lines(w.problems).length;
    const waiting = (w.deps || []).some((id) => { const d = works().find((x) => x.id === id); return d?.status !== "done" || d?.pending; }) && w.status !== "done";
    return `<div xmlns="http://www.w3.org/1999/xhtml" class="wnode st-${w.status} ${notInMain ? "st-pending" : ""} ${selected === w.id ? "sel" : ""}" data-work="${w.id}" style="--sc:${s.color}">
      <div class="wn-top"><span class="wn-status">${s.label}${notInMain ? ` · ${esc(w.pending)}` : ""}</span>${w.statusBy ? '<span class="wn-flag" title="사람이 직접 정한 상태">✋</span>' : ""}${problems ? `<span class="wn-flag warn" title="문제 ${problems}건">⚠ ${problems}</span>` : ""}${waiting ? '<span class="wn-flag" title="먼저 끝나야 하는 작업이 남아 있음">⏳</span>' : ""}${evidenceFor(w).length ? '<span class="wn-flag" title="이 작업의 근거 대화가 공유되어 있음">💬</span>' : ""}${(w.sync || []).filter((v) => v.current && v.who !== m.name).map((v) => `<span class="wn-flag" title="${esc(v.who)}님이 이 브랜치를 열어 보고 있음 (담당은 아님)">👀 ${esc(v.who)}</span>`).join("")}</div>
      <div class="wn-title">${esc(w.title)}</div>
      ${(() => { const p = prInfo(w.pr), y = syncLine(w); return p || y || w.branch ? `<div class="wn-git">${p ? `<span class="pr-chip ${p.cls}">PR #${w.pr.number} · ${p.text}</span>` : ""}${y ? `<span class="wn-sync ${y.level}" title="${esc((w.sync || []).map((v) => (v.who ? v.who + ": " : "") + v.text).join(" / "))}">${esc(y.label)}</span>` : w.branch ? `<span class="wn-sync">🌿 ${esc(w.branch)}</span>` : ""}</div>` : ""; })()}
      <div class="wn-meta"><span class="wn-dot" style="background:${m.color}"></span>${esc(m.name)}${w.ai ? ` · ${esc(w.ai)}` : ""}${done + remaining ? `<span class="wn-prog">${done}/${done + remaining}</span>` : ""}</div>
    </div>`;
  }

  function render() {
    if (!room) return;
    const list = works();
    // 위쪽 탭의 개수·경고
    $("#work-count").textContent = list.length;
    const blocked = list.filter((w) => w.status === "blocked").length;
    $("#work-alert").textContent = blocked ? `⛔ 막힌 작업 ${blocked}개` : "";
    if (mainView !== "project") return;

    $("#proj-legend").innerHTML = ORDER.map((k) => `<span class="lg"><span class="lg-dot" style="background:${STATUS[k].color}"></span>${STATUS[k].label} <b>${list.filter((w) => w.status === k).length}</b>${k === "done" && list.some((w) => w.status === "done" && w.pending) ? ` <span class="lg-pending">(그중 ${list.filter((w) => w.status === "done" && w.pending).length}개는 main에 없음)</span>` : ""}</span>`).join("");
    const owner = $("#work-owner");
    const cur = owner.value || me;
    owner.innerHTML = Object.values(room.members).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
    owner.value = room.members[cur] ? cur : me;

    const empty = $("#graph-empty");
    empty.hidden = list.length > 0;
    if (!list.length) empty.innerHTML = `<b>아직 작업이 없어요</b><p>위에서 작업을 추가하거나, 각자의 AI(Claude Code·Codex·Gemini)가 현황을 적으면 여기에 자동으로 나타납니다.</p>`;

    const pos = layout(list);
    const edges = [];
    for (const w of list) for (const d of w.deps || []) {
      const a = pos.get(d), b = pos.get(w.id);
      if (!a || !b) continue;
      const dep = list.find((x) => x.id === d);
      // 보통은 앞 작업(왼쪽) → 뒤 작업(오른쪽). 앞 작업이 더 나중에 움직였으면(예: 기반 브랜치가 나중에 병합됨) 화살표가 왼쪽을 향함
      const fwd = b.x >= a.x, s = fwd ? 1 : -1;
      const x1 = fwd ? a.x + NODE_W : a.x, y1 = a.y + NODE_H / 2, x2 = fwd ? b.x : b.x + NODE_W, y2 = b.y + NODE_H / 2, c = Math.max(40, Math.abs(x2 - x1) / 2);
      // 앞 작업이 끝났으면 실선, 아직이면 점선 / 앞 작업이 막혀 있으면 빨간색
      edges.push(`<path class="wedge ${dep.status === "done" && !dep.pending ? "ok" : ""} ${dep.status === "blocked" ? "bad" : ""}" d="M${x1},${y1} C${x1 + s * c},${y1} ${x2 - s * c},${y2} ${x2 - s * 3},${y2}" marker-end="url(#arrow)"></path>`);
    }
    vp.innerHTML = decoHTML() + edges.join("") + list.map((w) => { const p = pos.get(w.id); return `<foreignObject x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}">${nodeHTML(w)}</foreignObject>`; }).join("");
    applyView();
    renderDetail();
  }

  // ───── 확대·축소(마우스가 가리키는 곳 기준) · 끌어서 이동 ─────
  function applyView() {
    vp.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    $("#zoom-label").textContent = `${Math.round(view.k * 100)}%`;
    // 담당자 이름표는 옆으로 밀어도 화면 왼쪽에 붙어 있게
    const lx = Math.max(0, (10 - view.x) / view.k);
    vp.querySelectorAll(".lane-label").forEach((g) => g.setAttribute("transform", `translate(${lx},0)`));
  }
  // 처음 열 때: 전체를 작게 보여 주는 대신, 읽을 수 있는 크기로 가장 최근(오른쪽 끝)을 보여 줌
  function showLatest() {
    const r = box.getBoundingClientRect();
    if (!r.width || !works().length) return;
    const whole = Math.min((r.width - 80) / layoutSize.w, (r.height - 90) / layoutSize.h);
    if (whole >= 0.55) return fit();
    const k = Math.min(1, Math.max(0.55, (r.height - 60) / layoutSize.h));
    view.k = k;
    view.x = r.width - 40 - layoutSize.w * k;
    view.y = 20;
    view.fitted = true;
    applyView();
  }
  function zoomAt(px, py, factor) {
    const k = Math.min(2.5, Math.max(0.2, view.k * factor));
    // 가리키는 점(px,py) 아래에 있던 그림의 위치가 확대 뒤에도 같은 자리에 오도록 이동값을 맞춤
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }
  function fit() {
    const r = box.getBoundingClientRect();
    if (!r.width || !works().length) return;
    const k = Math.min(1.2, Math.max(0.2, Math.min((r.width - 80) / layoutSize.w, (r.height - 90) / layoutSize.h)));
    view.k = k;
    view.x = (r.width - layoutSize.w * k) / 2;
    view.y = Math.max(30, (r.height - layoutSize.h * k) / 2);
    view.fitted = true;
    applyView();
  }
  box.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  let drag = null;
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".zoom, .graph-hint")) return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, work: e.target.closest("[data-work]")?.dataset.work || null };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    box.classList.add("dragging");
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    applyView();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    box.classList.remove("dragging");
    try { box.releasePointerCapture(e.pointerId); } catch {}
    // 끌지 않고 눌렀다 뗀 경우 = 클릭: 작업이면 자세히 보기, 빈 곳이면 닫기
    if (!d.moved) { selected = d.work; render(); }
  };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  // ───── 자세히 보기 (오른쪽) ─────
  const listHTML = (t, emptyText) => { const l = lines(t); return l.length ? `<ul>${l.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted small">${emptyText}</p>`; };
  function renderDetail() {
    const panel = $("#work-detail");
    const w = works().find((x) => x.id === selected);
    panel.hidden = !w;
    if (!w) return;
    // 글을 고치는 중이면 다시 그리지 않음 (입력하던 내용이 날아가지 않게)
    if (panel.dataset.work === w.id && panel.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName)) return;
    panel.dataset.work = w.id;
    const m = ownerOf(w);
    const others = works().filter((x) => x.id !== w.id);
    const aiNote = w.statusBy && w.aiStatus ? `<p class="muted small">✋ ${esc(member(w.statusBy).name)}님이 직접 정한 상태예요. ${w.source === "git" ? "브랜치·PR 기준 상태는" : "AI가 적은 상태는"} <b>${STATUS[w.aiStatus]?.label || w.aiStatus}</b> <button class="link" data-follow-ai="${w.id}">${w.source === "git" ? "자동 상태 따르기" : "AI가 적은 대로 따르기"}</button></p>` : "";
    panel.innerHTML = `
      <div class="wd-head"><h3>${esc(w.title)}</h3><button class="x" data-close-work title="닫기">×</button></div>
      <div class="wd-meta"><span class="wn-dot" style="background:${m.color}"></span>${esc(m.name)}${w.ai ? ` · ${esc(w.ai)}` : ""}${w.folder ? ` · ${esc(w.folder)}` : ""}${w.branch ? ` · 🌿 ${esc(w.branch)}` : ""}
        <span class="muted small">${w.source === "ai" ? `AI가 ${timeAgo(w.reportedAt || w.updatedAt)}에 적음` : w.source === "git" ? "브랜치·PR에서 자동으로 만든 작업" : "직접 추가한 작업"}</span></div>
      ${!w.ownerId && w.ownerName ? `<p class="wd-who">git에 적힌 작성자 <b>${esc(w.ownerName)}</b>가 팀룸의 누구인지 몰라요. <select data-author="${esc(w.ownerName)}"><option value="">누구인가요?</option>${Object.values(room.members).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></p>` : ""}
      ${w.pr || (w.sync || []).length ? `<div class="wd-git">
        ${w.pr ? `<div>${(() => { const p = prInfo(w.pr); const inner = `PR #${w.pr.number} · ${p.text}`; return w.pr.url ? `<a class="pr-chip ${p.cls}" href="${esc(w.pr.url)}" target="_blank" rel="noopener">${inner} ↗</a>` : `<span class="pr-chip ${p.cls}">${inner}</span>`; })()} <span class="muted small">${esc(w.branch || "")} → ${esc(w.pr.base || "")} · ${esc(w.pr.author || "")}가 올림${w.pr.state === "MERGED" && w.pr.mergedBy ? ` · ${esc(w.pr.mergedBy)}가 ${timeAgo(w.pr.mergedAt)}에 병합` : ""}</span></div>` : ""}
        ${(w.sync || []).map((v) => `<div class="wd-sync"><span class="br-state ${v.level}">${esc(v.text)}</span> ${v.who ? esc(v.who) + "의 PC" : ""}${v.current ? ` · <b class="br-cur">★ ${v.who === m.name ? "지금 작업 중" : "열어 보는 중"}</b>${v.dirty ? ` · 저장 안 한 변경 ${v.dirty}개` : ""}` : ""}</div>`).join("")}
        <p class="muted small">이 칸은 AI가 적은 게 아니라 실제 브랜치와 GitHub를 비교한 결과예요.</p>
      </div>` : ""}
      <label class="wd-row">상태
        <select data-work-status="${w.id}">${ORDER.map((k) => `<option value="${k}" ${w.status === k ? "selected" : ""}>${STATUS[k].label}</option>`).join("")}</select></label>
      ${w.status === "done" && w.pending ? `<p class="wd-pending">⚠ 완료로 표시됐지만 <b>${esc(w.pending)}</b> 상태예요. 팀원은 아직 이 작업의 결과를 받을 수 없습니다.</p>` : ""}
      ${aiNote}
      ${w.status === "blocked" || w.blockReason ? `<div class="wd-block">
        <b>⛔ 막힌 이유</b><textarea data-work-text="blockReason" rows="2" placeholder="왜 진행하지 못하나요?">${esc(w.blockReason || "")}</textarea>
        <b>풀리는 조건</b><textarea data-work-text="unblock" rows="2" placeholder="무엇이 해결되면 다시 진행할 수 있나요? 누가 해야 하나요?">${esc(w.unblock || "")}</textarea>
        ${(() => { const hit = works().filter((x) => (x.deps || []).includes(w.id)); return hit.length ? `<p class="small">이 작업을 기다리는 작업: ${hit.map((x) => `<b>${esc(x.title)}</b>`).join(", ")}</p>` : ""; })()}
      </div>` : ""}
      <h4>🎯 목적</h4>${w.goal ? `<p>${esc(w.goal)}</p>` : `<p class="muted small">아직 적힌 내용이 없어요</p>`}
      <h4>✅ 지금까지 한 일</h4>${listHTML(w.done, "아직 없어요")}
      <h4>📌 남은 일</h4>${listHTML(w.remaining, "아직 없어요")}
      <h4>⚠ 문제점</h4>${listHTML(w.problems, "적힌 문제가 없어요")}
      <h4>⏮ 먼저 끝나야 하는 작업</h4>
      ${others.length ? `<div class="wd-deps">${others.map((x) => `<label><input type="checkbox" data-dep="${x.id}" ${(w.deps || []).includes(x.id) ? "checked" : ""}/> <span class="lg-dot" style="background:${STATUS[x.status]?.color}"></span>${esc(x.title)} <span class="muted small">${esc(member(x.ownerId).name)}</span></label>`).join("")}</div>` : `<p class="muted small">다른 작업이 없어요</p>`}
      <div class="wd-actions">
        ${(() => { const ev = evidenceFor(w); return ev.length ? ev.map((h, i) => `<button data-evidence="${w.id}" data-evidence-index="${i}" title="${esc(h.title)}">💬 근거 대화${ev.length > 1 ? ` ${i + 1}` : ""} <span class="muted small">${esc(member(h.memberId).name)}${h.byPR ? " · 이 PR을 만든 대화" : " · 이 브랜치의 대화"}</span></button>`).join("") : `<span class="muted small">💬 이 작업과 짝이 맞는 공유 대화 없음</span>`; })()}
        ${w.branch ? `<button data-show-branch>🌿 브랜치 탭에서 보기</button>` : ""}
        <button class="danger" data-del-work="${w.id}">작업 삭제</button>
      </div>`;
  }

  // 근거 대화: 이 작업과 "짝이 맞는" 공유 대화들 — 그 대화에서 이 작업의 PR을 만들었거나, 이 작업의 브랜치에서 진행한 대화
  // (같은 폴더의 아무 대화나 보여 주지 않음. 짝이 맞는 대화가 팀룸에 없으면 근거 대화가 없는 것)
  function evidenceFor(w) {
    const meta = room.convMeta || {};
    const hits = [];
    for (const [key, m] of Object.entries(meta)) {
      const byPR = !!w.pr && (m.prs || []).some((p) => p.n === w.pr.number && (!w.repo || !p.repo || p.repo === w.repo));
      // 그 대화가 작업한 브랜치들 중에 있거나, (작업 기록이 없는 대화면) 마지막에 있던 브랜치
      const byBranch = !!w.branch && ((m.branches || []).includes(w.branch) || (!(m.branches || []).length && m.branch === w.branch));
      if (!byPR && !byBranch) continue;
      const [memberId, source, ...rest] = key.split(":");
      const convId = rest.join(":");
      const msgs = room.messages.filter((x) => x.authorId === memberId && x.source === source && x.convId === convId);
      if (!msgs.length) continue; // 공유하지 않았거나 이미 지워진 대화
      const last = msgs[msgs.length - 1];
      // 대화 안에서 이 작업을 한 부분: 이 작업의 PR을 만들었거나 이 브랜치에서 작업한 첫 질문 (없으면 대화의 끝)
      const part = msgs.find((x) => (w.pr && (x.workPRs || []).includes(w.pr.number)) || (w.branch && (x.workBranches || []).includes(w.branch)));
      hits.push({ memberId, title: last.convTitle || "", last, target: part || last, exact: !!part, ts: Math.max(...msgs.map((x) => x.updatedAt || x.ts)), byPR, mine: memberId === w.ownerId });
    }
    // PR로 짝지어진 것 → 담당자의 대화 → 최근 순
    return hits.sort((a, b) => b.byPR - a.byPR || b.mine - a.mine || b.ts - a.ts);
  }
  function showEvidence(w, index = 0) {
    const hit = evidenceFor(w)[index];
    if (!hit) { toast("이 작업과 짝이 맞는 공유 대화가 없어요"); return; }
    setMainView("chat");
    jumpTo(hit.target.id);
  }

  // ───── 누르기·입력 처리 ─────
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-mainview], [data-zoom], [data-close-work], [data-del-work], [data-evidence], [data-follow-ai], [data-show-branch]");
    if (!t) return;
    const d = t.dataset;
    if (d.mainview) setMainView(d.mainview);
    else if (d.showBranch !== undefined) document.querySelector('[data-projview="branch"]')?.click();
    else if (d.zoom) {
      const r = box.getBoundingClientRect();
      if (d.zoom === "fit") fit();
      else if (d.zoom === "reset") zoomAt(r.width / 2, r.height / 2, 1 / view.k);
      else zoomAt(r.width / 2, r.height / 2, d.zoom === "in" ? 1.25 : 0.8);
    } else if (d.closeWork !== undefined) { selected = null; render(); }
    else if (d.delWork) { if (confirm("이 작업을 현황에서 삭제할까요?")) { selected = null; act({ type: "workDelete", workId: d.delWork }); } }
    else if (d.evidence) showEvidence(works().find((x) => x.id === d.evidence), Number(d.evidenceIndex) || 0);
    else if (d.followAi) act({ type: "workUpdate", workId: d.followAi, followAI: true });
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.author) { if (t.value) act({ type: "setAuthor", author: t.dataset.author, who: t.value }); return; }
    if (t.dataset.workStatus) act({ type: "workUpdate", workId: t.dataset.workStatus, status: t.value });
    else if (t.dataset.dep) {
      const w = works().find((x) => x.id === selected);
      if (!w) return;
      const deps = new Set(w.deps || []);
      t.checked ? deps.add(t.dataset.dep) : deps.delete(t.dataset.dep);
      act({ type: "workUpdate", workId: w.id, deps: [...deps] }).then(() => {
        // 서로 기다리게 되는 연결은 서버가 받아 주지 않음 → 알려 줌
        if (t.checked && !(works().find((x) => x.id === w.id)?.deps || []).includes(t.dataset.dep)) toast("그 작업이 이미 이 작업을 기다리고 있어서 연결할 수 없어요");
      });
    } else if (t.dataset.workText && selected) act({ type: "workUpdate", workId: selected, [t.dataset.workText]: t.value });
  });
  $("#work-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("#work-title").value.trim();
    if (!title) return;
    act({ type: "workAdd", title, ownerId: $("#work-owner").value });
    $("#work-title").value = "";
  });
  window.addEventListener("resize", () => { if (mainView === "project" && !view.fitted) showLatest(); });

  window.renderProject = render;
  window.setMainView = setMainView;
  if (room) render();
})();
