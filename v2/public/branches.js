// 프로젝트 현황 › 브랜치: GitHub(원격) 브랜치와 각자 PC의 로컬 브랜치를 나란히 보여 줌 — project.js 다음에 불러옴
// 자료는 각자 PC의 커넥터가 올린 것(room.git). 원격 브랜치는 "그 PC가 마지막으로 받아 온 시점" 기준임
(() => {
  const el = $("#branch-view");
  let projView = "flow";
  const LANE_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6", "#ec4899", "#64748b"];
  const short = (h) => String(h || "").slice(0, 7);
  const stripRemote = (n) => n.replace(/^[^/]+\//, ""); // origin/main → main

  function setProjView(v) {
    projView = v;
    document.querySelectorAll(".proj-tabs .ptab").forEach((b) => b.classList.toggle("active", b.dataset.projview === v));
    $("#flow-bar").hidden = $("#flow-body").hidden = v !== "flow";
    el.hidden = v !== "branch";
    if (v === "branch") render(); else window.dispatchEvent(new Event("resize"));
  }

  // 한 사람의 로컬 브랜치가 원격과 어떤 관계인지
  function localState(b, remoteSha) {
    if (b.gone) return { cls: "warn", text: "원격에서 지워진 브랜치" };
    if (!b.upstream) {
      if (!remoteSha) return { cls: "warn", text: "내 PC에만 있음 · 아직 안 올림" };
      return short(b.sha) === short(remoteSha) ? { cls: "ok", text: "원격과 같음" } : { cls: "warn", text: "원격과 다름 (연결 안 됨)" };
    }
    if (b.ahead && b.behind) return { cls: "bad", text: `갈라짐 · ↑${b.ahead} 안 올림 · ↓${b.behind} 안 받음` };
    if (b.ahead) return { cls: "warn", text: `↑${b.ahead}개 아직 안 올림 (push 필요)` };
    if (b.behind) return { cls: "warn", text: `↓${b.behind}개 뒤처짐 (pull 필요)` };
    return { cls: "ok", text: "원격과 같음" };
  }

  // PR 상태 표시: 초안 / 검토 대기 / 승인됨 / 수정 요청 / 병합됨 / 닫힘
  function prChip(p) {
    const st = p.state === "MERGED" ? ["merged", "병합됨"] : p.state === "CLOSED" ? ["closed", "닫힘"] : p.draft ? ["draft", "초안"]
      : p.review === "APPROVED" ? ["ok", "승인됨"] : p.review === "CHANGES_REQUESTED" ? ["bad", "수정 요청"] : ["open", "검토 대기"];
    const inner = `PR #${p.number} · ${st[1]}`;
    return p.url ? `<a class="pr-chip ${st[0]}" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title)}">${inner} ↗</a>` : `<span class="pr-chip ${st[0]}">${inner}</span>`;
  }
  function repoHTML(name, reports) {
    reports.sort((a, b) => (a.memberId === me ? -1 : b.memberId === me ? 1 : 0));
    // 원격 브랜치: 가장 최근에 올린 사람의 정보를 쓰고, PC마다 다르게 보이면 표시
    const remote = new Map();
    for (const r of [...reports].sort((a, b) => a.at - b.at)) for (const b of r.branches) {
      if (b.kind !== "remote") continue;
      const n = stripRemote(b.name);
      const prev = remote.get(n);
      // (PC마다 받아 온 시점이 다르면, 커밋 시각이 가장 늦은 쪽을 최신 원격으로 봄)
      const differs = (prev?.differs || false) || !!(prev && short(prev.sha) !== short(b.sha));
      remote.set(n, { ...(prev && prev.ts > b.ts ? prev : b), name: n, differs });
    }
    const names = new Set(remote.keys());
    for (const r of reports) for (const b of r.branches) if (b.kind === "local") names.add(b.name);
    const lastTs = (n) => Math.max(remote.get(n)?.ts || 0, ...reports.map((r) => r.branches.find((b) => b.kind === "local" && b.name === n)?.ts || 0));
    // GitHub PR: 가장 최근에 받아 온 PC의 목록을 씀
    const prs = [...reports].filter((r) => r.prs).sort((a, b) => b.at - a.at)[0]?.prs || [];
    for (const p of prs) if (p.state === "OPEN") names.add(p.head);
    // 열린 PR이 있는 브랜치인지 (PR이 있으면 그 브랜치는 GitHub에 반드시 있음 — 아무 PC도 안 받아 왔을 뿐)
    const openPR = (n) => prs.some((p) => p.head === n && p.state === "OPEN");
    const rows = [...names].sort((a, b) => (/^(main|master)$/.test(b) - /^(main|master)$/.test(a)) || lastTs(b) - lastTs(a));

    const head = `<tr><th>브랜치</th><th>☁️ GitHub (원격)</th>${reports.map((r) => { const m = member(r.memberId); return `<th><span class="wn-dot" style="background:${m.color}"></span> ${esc(m.name)}${r.memberId === me ? " (나)" : ""}의 PC<span class="muted small"> · ${timeAgo(r.at)} 기준</span></th>`; }).join("")}</tr>`;
    const body = rows.map((n) => {
      const rb = remote.get(n);
      const cells = reports.map((r) => {
        const b = r.branches.find((x) => x.kind === "local" && x.name === n);
        if (!b) {
          // 로컬 브랜치는 없지만, 이 PC가 원격 내용을 받아 뒀는지는 따로 봄 (git fetch 를 하면 내용은 받아지고 로컬 브랜치는 안 생김)
          const got = r.branches.find((x) => x.kind === "remote" && stripRemote(x.name) === n);
          if (!rb) return openPR(n) ? '<td class="none"><div class="br-state warn">아직 안 받음 (fetch 필요)</div></td>' : '<td class="none">—</td>';
          if (!got) return '<td class="none"><div class="br-state warn">아직 안 받음 (fetch 필요)</div><div class="muted small">이 PC는 이 브랜치가 있는지 모르는 상태예요</div></td>';
          if (short(got.sha) !== short(rb.sha)) return '<td class="none"><div class="br-state warn">새 커밋을 안 받음 (fetch 필요)</div><div class="muted small">예전 내용까지만 받아 둠</div></td>';
          return '<td class="none"><div class="br-state got">받아 둠 · 최신</div><div class="muted small">내용은 이 PC에 있어요. 직접 작업할 때만 checkout 하면 됩니다</div></td>';
        }
        let st = localState(b, rb?.sha);
        // 이 PC가 알고 있는 원격이 최신이 아니면(다른 팀원이 그 뒤에 올림) 알려 줌
        const mineRemote = r.branches.find((x) => x.kind === "remote" && stripRemote(x.name) === n);
        if (st.cls === "ok" && rb && mineRemote && short(mineRemote.sha) !== short(rb.sha)) st = { cls: "warn", text: "원격에 새 커밋 있음 · 받아 오기(pull) 필요" };
        const cur = r.current === n;
        return `<td class="${cur ? "cur" : ""}">
          <div class="br-state ${st.cls}">${st.text}</div>
          <div class="br-commit"><code>${esc(short(b.sha))}</code> ${esc(b.subject)}</div>
          <div class="muted small">${esc(b.author)} · ${timeAgo(b.ts)}${cur ? ` · <b class="br-cur">★ 지금 이 브랜치</b>${r.dirty ? ` · 저장 안 한 변경 ${r.dirty}개` : ""}` : ""}</div></td>`;
      }).join("");
      return `<tr><th class="br-name">🌿 ${esc(n)}${prs.filter((p) => p.head === n).map((p) => `<div>${prChip(p)}</div>`).join("")}</th>
        <td>${rb ? `<div class="br-commit"><code>${esc(short(rb.sha))}</code> ${esc(rb.subject)}</div><div class="muted small">${esc(rb.author)} · ${timeAgo(rb.ts)}${rb.differs ? ' · <span class="br-state warn">PC마다 다르게 보임 (받아 온 시점 차이)</span>' : ""}</div>` : openPR(n) ? '<div class="br-state warn">GitHub에는 있음 · 아직 아무 PC도 안 받아 옴</div><div class="muted small">PR은 GitHub에서 바로 읽고, 브랜치는 각 PC가 받아 온 것만 보여서 그래요. git fetch 하면 나타납니다</div>' : '<span class="none">원격에 없음</span>'}</td>${cells}</tr>`;
    }).join("");

    return `<section class="repo">
      <h3>📦 ${esc(name)}</h3>
      <div class="br-scroll"><table class="br-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <h4>풀 리퀘스트(PR) <span class="muted small">${reports.some((r) => r.prs) ? "GitHub에서 읽어 옴" : "GitHub CLI(gh)가 로그인된 PC가 있으면 표시돼요"}</span></h4>
      ${prs.length ? `<div class="pr-list">${[...prs].sort((a, b) => b.updatedAt - a.updatedAt).map((p) => `<div class="pr-row">${prChip(p)}<span class="pr-title">${esc(p.title)}</span><span class="muted small">🌿 ${esc(p.head)} → ${esc(p.base)} · ${esc(p.author)}가 올림${p.state === "MERGED" && p.mergedBy ? ` · <b>${esc(p.mergedBy)}</b>가 ${timeAgo(p.mergedAt)}에 병합` : ` · ${timeAgo(p.updatedAt)}`}</span></div>`).join("")}</div>` : `<p class="muted small">PR이 없어요</p>`}
      <h4>커밋 그래프 <span class="muted small">최근 커밋 · 팀원들의 PC에서 본 것을 합침</span></h4>
      ${graphHTML(reports)}
    </section>`;
  }

  // 커밋 그래프: 최신이 위. 줄(레인)은 "이 줄에서 다음에 나올 커밋"을 따라가며 배정
  function graphHTML(reports) {
    const commits = new Map();
    for (const r of reports) for (const c of r.commits) if (!commits.has(short(c.h))) commits.set(short(c.h), { ...c, h: short(c.h), p: c.p.map(short), tags: [] });
    // 어느 브랜치의 끝인지 표시 (원격 / 누구의 로컬)
    const seen = new Set();
    for (const r of reports) for (const b of r.branches) {
      const c = commits.get(short(b.sha));
      if (!c) continue;
      const label = b.kind === "remote" ? `☁️ ${b.name}` : `${member(r.memberId).name}: ${b.name}`;
      if (seen.has(`${c.h}|${label}`)) continue;
      seen.add(`${c.h}|${label}`);
      c.tags.push({ label, remote: b.kind === "remote", color: member(r.memberId).color, current: b.kind === "local" && r.current === b.name });
    }
    const list = [...commits.values()].sort((a, b) => b.ct - a.ct).slice(0, 60);
    if (!list.length) return `<p class="muted small">커밋 정보가 아직 없어요</p>`;
    const ROW = 30, LANE = 18, PAD = 14;
    const lanes = []; // 각 줄이 기다리는 커밋
    list.forEach((c, row) => {
      let lane = lanes.indexOf(c.h);
      if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; }
      lanes.forEach((h, i) => { if (h === c.h && i !== lane) lanes[i] = null; }); // 같은 커밋을 기다리던 다른 줄은 여기서 합쳐짐
      c.lane = lane; c.row = row;
      lanes[lane] = c.p[0] || null;
      for (const p of c.p.slice(1)) if (!lanes.includes(p)) { const free = lanes.indexOf(null); if (free < 0) lanes.push(p); else lanes[free] = p; }
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    });
    const maxLane = Math.max(...list.map((c) => c.lane));
    const X = (l) => PAD + l * LANE, Y = (r) => r * ROW + ROW / 2;
    const byH = new Map(list.map((c) => [c.h, c]));
    const paths = [];
    for (const c of list) for (const ph of c.p) {
      const p = byH.get(ph);
      const color = LANE_COLORS[(p ? Math.max(c.lane, p.lane) : c.lane) % LANE_COLORS.length];
      if (!p) { paths.push(`<path d="M${X(c.lane)},${Y(c.row)} V${list.length * ROW}" stroke="${color}" stroke-dasharray="3 4"/>`); continue; }
      if (p.lane === c.lane) paths.push(`<path d="M${X(c.lane)},${Y(c.row)} V${Y(p.row)}" stroke="${color}"/>`);
      else paths.push(`<path d="M${X(c.lane)},${Y(c.row)} C${X(c.lane)},${Y(c.row) + ROW * 0.8} ${X(p.lane)},${Y(c.row) + ROW * 0.2} ${X(p.lane)},${Y(c.row) + ROW} V${Y(p.row)}" stroke="${color}"/>`);
    }
    const dots = list.map((c) => `<circle cx="${X(c.lane)}" cy="${Y(c.row)}" r="${c.p.length > 1 ? 4 : 5}" fill="${c.p.length > 1 ? "var(--panel)" : LANE_COLORS[c.lane % LANE_COLORS.length]}" stroke="${LANE_COLORS[c.lane % LANE_COLORS.length]}" stroke-width="2"/>`).join("");
    const w = PAD * 2 + maxLane * LANE;
    const rows = list.map((c) => `<div class="cg-row" style="height:${ROW}px">
      ${c.tags.map((t) => `<span class="cg-tag ${t.remote ? "remote" : ""}" ${t.remote ? "" : `style="--c:${t.color}"`}>${t.current ? "★ " : ""}${esc(t.label)}</span>`).join("")}
      <span class="cg-subject">${esc(c.s)}</span><span class="muted small cg-meta"><code>${esc(c.h)}</code> · ${esc(c.an)} · ${timeAgo(c.ct)}</span></div>`).join("");
    return `<div class="cg"><svg width="${w}" height="${list.length * ROW}" class="cg-svg" fill="none" stroke-width="2">${paths.join("")}${dots}</svg><div class="cg-rows" style="margin-left:${w}px">${rows}</div></div>`;
  }

  function render() {
    if (!room || projView !== "branch" || el.hidden) return;
    const reports = Object.values(room.git || {}).filter((r) => room.members[r.memberId]);
    if (!reports.length) {
      el.innerHTML = `<div class="graph-empty" style="position:static;padding:60px 20px"><b>아직 브랜치 정보가 없어요</b><p>팀룸 창(커넥터)을 켜 두면, 팀 폴더가 git 저장소일 때 로컬·원격 브랜치 상태가 자동으로 올라옵니다.</p></div>`;
      return;
    }
    const groups = new Map();
    for (const r of reports) { const k = r.repo || r.folder; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const scroll = el.scrollTop;
    el.innerHTML = `<p class="muted small br-note">각자 PC가 올린 정보를 나란히 놓은 화면입니다. 원격(GitHub) 브랜치는 각 PC가 마지막으로 <code>git fetch</code>/<code>pull</code> 한 시점 기준이에요.</p>` + [...groups].map(([n, rs]) => repoHTML(n, rs)).join("");
    el.scrollTop = scroll;
  }

  document.addEventListener("click", (e) => { const t = e.target.closest("[data-projview]"); if (t) setProjView(t.dataset.projview); });
  const prev = window.renderProject;
  window.renderProject = () => { prev?.(); render(); };
})();
