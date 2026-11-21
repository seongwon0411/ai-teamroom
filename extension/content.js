// ChatGPT / Claude / Gemini 페이지 안에서 실행 — 화면의 대화를 읽어 확장으로 전달하고, 피드백을 입력창에 넣어줌
// ※ 각 사이트 화면 구조(선택자)가 바뀌면 SITES 부분만 고치면 됩니다. (desktop/preload/ai-preload.js 와 같은 규칙)
(() => {
  // 같은 탭에 두 번 들어가지 않게 (확장을 새로고침하면 예전 것은 끊긴 상태라 새로 실행)
  if (globalThis.__aiTeamroomAlive?.()) return;
  globalThis.__aiTeamroomAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="중지"]',
    'button[aria-label*="중단"]',
  ];
  // "생성 중지" 버튼이 있으면 AI가 답변 작성 중 (음성·녹음 중지 버튼은 제외)
  const NOT_GENERATION = /음성|voice|녹음|record|dictat|받아쓰기|마이크|mic|읽기|read aloud/i;
  const hasStopButton = () => STOP_SELECTORS.some((s) =>
    [...document.querySelectorAll(s)].some((b) => !NOT_GENERATION.test(`${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`)));
  // 화면 낭독용 머리말("나의 말:", "내가 한 말:", "ChatGPT 답변:" 등)은 빼고 본문만
  const SPEAKER_WORDS = "You said|ChatGPT said|Claude said|Gemini said|나의 말|내가 한 말|내 메시지|ChatGPT(?:의)?\\s*(?:말|답변|응답)";
  const SPEAKER_LABEL = new RegExp(`^\\s*(?:${SPEAKER_WORDS})\\s*:?\\s*`, "i");
  const USER_LABEL = /You said|나의 말|내가 한 말|내 메시지/i;
  const textOf = (el) => ((el?.innerText || "").trim() || (el?.textContent || "").trim()).replace(SPEAKER_LABEL, "").trim();
  const topLevel = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));

  // ───── 자동 탐지: 사이트가 화면 구조 이름을 바꿔도, 값이 "user"/"assistant"인 속성을 찾아 메시지를 구분 ─────
  const ROLE_VALUES = { user: "user", assistant: "assistant", human: "user", ai: "assistant", model: "assistant", bot: "assistant" };
  let autoAttr = null; // 찾아낸 속성 이름 (예: data-message-role)
  function discoverRoleAttr() {
    const counts = new Map();
    const scope = document.querySelector("main") || document.body;
    for (const el of scope.querySelectorAll("*")) {
      for (const a of el.attributes) {
        if (a.name === "class" || a.name === "style" || a.name === "id") continue;
        const v = a.value.toLowerCase();
        if (!Object.hasOwn(ROLE_VALUES, v)) continue;
        const r = ROLE_VALUES[v];
        const c = counts.get(a.name) || { user: 0, assistant: 0 };
        c[r]++;
        counts.set(a.name, c);
      }
    }
    // 질문(user)과 답변이 모두 있는 속성 중 가장 많이 쓰인 것
    let best = null;
    for (const [name, c] of counts) {
      if (c.user && c.assistant && (!best || c.user + c.assistant > best.n)) best = { name, n: c.user + c.assistant };
    }
    return best?.name || null;
  }
  // 표시(머리말·역할 속성)가 붙은 요소에서 본문이 들어 있는 상자까지 위로 올라감
  // 단, 다른 메시지 표시까지 품은 상자(=대화 전체)까지는 올라가지 않음
  function climbToContent(el, markers) {
    let box = el;
    while (textOf(box) === "" && box.parentElement) {
      const p = box.parentElement;
      if (markers.some((o) => o !== el && p.contains(o))) break;
      box = p;
    }
    return box;
  }
  // 화면 낭독기용 머리말("나의 말:" / "내가 한 말:" / "ChatGPT 답변:")로 메시지를 찾는 방법
  const LABEL_RE = new RegExp(`^(?:${SPEAKER_WORDS})\\s*:?$`, "i");
  function speakerLabels() {
    const scope = document.querySelector("main") || document.body;
    return [...scope.querySelectorAll("h1,h2,h3,h4,h5,h6,span,div,p")].filter((el) => el.children.length === 0 && LABEL_RE.test(el.textContent.trim()));
  }
  function labelMessages() {
    const labels = speakerLabels();
    return labels.map((label, i) => {
      const box = climbToContent(label, labels);
      return {
        extId: box?.id || `l${i}`, box, // (바깥 상자의 id를 쓰면 여러 메시지가 같은 id가 되어 서로 덮어씀)
        role: USER_LABEL.test(label.textContent) ? "user" : "assistant",
        text: textOf(box),
      };
    }).filter((m) => m.text);
  }
  // ───── AI가 만든 파일·이미지 수집 (링크와 이름만; 일반 웹 출처 링크는 제외) ─────
  const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|tsv|zip|txt|md|py|ipynb|js|ts|json|html?|hwp|hwpx|png|jpe?g|gif|webp|svg|mp3|mp4)(\?|#|$)/i;
  function filesIn(box) {
    const files = [];
    const seen = new Set();
    const push = (f) => { if (!seen.has(f.url) && files.length < 10) { seen.add(f.url); files.push(f); } };
    for (const a of box.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!/^https?:/i.test(href)) continue;
      const looksFile = a.hasAttribute("download") || FILE_EXT.test(href) || /\/(download|files?|attachments?)\//i.test(href) || /sandbox|oaiusercontent|googleusercontent\.com\/.*(download|file)/i.test(href);
      if (!looksFile) continue;
      const name = (a.getAttribute("download") || a.textContent || "").trim() || decodeURIComponent(href.split("?")[0].split("/").pop() || "파일");
      push({ kind: "file", name: name.slice(0, 100), url: href });
    }
    // 링크 없이 파일 카드만 있는 경우 (예: ChatGPT가 만든 pptx 카드) → 이름만 먼저 표시, 다운로드하면 팀룸에 올라감
    // (본문에 파일 이름이 "언급"만 된 경우는 제외: 이름 옆에 PowerPoint·Excel 같은 파일 종류가 붙은 카드만)
    const TYPE_LABEL = /^(PowerPoint|Excel|Word|PDF|CSV|ZIP|Text|텍스트|문서|스프레드시트|프레젠테이션|파일|File|Document|Spreadsheet|Presentation|Python|Markdown|JSON|이미지|Image)$/i;
    for (const el of box.querySelectorAll("div,span,p,strong,b")) {
      if (el.children.length || el.closest("pre, code, [data-d-streaming-word]") || el.hasAttribute("data-d-streaming-word")) continue;
      const t = (el.textContent || "").trim();
      if (!(t.length <= 140 && /^[^\n\\/]+\.(pptx?|docx?|xlsx?|pdf|csv|zip|hwpx?|txt|md|py|ipynb|json)$/i.test(t))) continue;
      const card = el.parentElement?.parentElement || el.parentElement;
      const labels = [...(card?.querySelectorAll("*") || [])].filter((x) => !x.children.length).map((x) => (x.textContent || "").trim());
      const isCard = labels.some((s) => TYPE_LABEL.test(s)) || !!el.closest("button, [role=button], a");
      if (isCard && !files.some((f) => f.name === t) && files.length < 10) files.push({ kind: "pending", name: t, url: "" });
    }
    for (const img of box.querySelectorAll("img")) {
      const w = img.naturalWidth || img.width;
      if (w < 120 || !/^https?:/i.test(img.currentSrc || img.src)) continue; // 아이콘·프로필 사진 제외
      push({ kind: "image", name: (img.alt || "이미지").slice(0, 100), url: img.currentSrc || img.src });
    }
    return files;
  }

  // 진단용: 표시 요소 주변 구조(태그·속성 이름만, 대화 내용은 제외)
  function structureSample() {
    const el = (autoAttr && document.querySelector(`[${CSS.escape(autoAttr)}]`)) || speakerLabels()[0];
    if (!el) return null;
    const desc = (e) => `${e.tagName.toLowerCase()}[${[...e.attributes].map((a) => a.name).filter((n) => n !== "class" && n !== "style").join(",")}]`;
    const chain = [];
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) chain.push(`${desc(e)}(${e.children.length})`);
    return chain.join(" < ");
  }
  function autoMessages() {
    if (!autoAttr || !document.querySelector(`[${CSS.escape(autoAttr)}]`)) autoAttr = discoverRoleAttr();
    if (!autoAttr) return labelMessages();
    const els = topLevel([...document.querySelectorAll(`[${CSS.escape(autoAttr)}]`)].filter((el) => Object.hasOwn(ROLE_VALUES, el.getAttribute(autoAttr).toLowerCase())));
    const found = els.map((el, i) => ({
      box: climbToContent(el, els),
      extId: el.id || el.getAttribute("data-message-id") || el.querySelector("[data-message-id]")?.getAttribute("data-message-id") || `a${i}`,
      role: ROLE_VALUES[el.getAttribute(autoAttr).toLowerCase()],
      text: textOf(climbToContent(el, els)),
    })).filter((m) => m.text);
    // 역할 표시는 있는데 본문을 못 찾으면 머리말 방식으로 한 번 더 시도
    return found.length ? found : labelMessages();
  }

  const SITES = {
    chatgpt: {
      match: () => /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname),
      // 로그인: /c/<ID>, 로그인 없이: /uc/<ID>
      convId: () => location.pathname.match(/\/u?c\/([\w-]+)/)?.[1] || null,
      messages() {
        // ⓪ 현재(2026-11 확인) 구조: <ol data-conversation-transcript> 안의 <li data-message-role="user|assistant" id=…>
        const items = [...document.querySelectorAll("li[data-message-role]")];
        if (items.length) {
          return items.map((li, i) => ({
            extId: li.id || `i${i}`, box: li,
            role: li.getAttribute("data-message-role"),
            text: textOf(li.querySelector("[data-user-message-bubble], [data-assistant-markdown-root], [data-assistant-markdown]") || li),
          })).filter((m) => m.role === "user" || m.role === "assistant");
        }
        // ① 예전 구조: 메시지마다 작성자 표시
        let els = topLevel([...document.querySelectorAll("[data-message-author-role]")]);
        let roleOf = (el) => el.getAttribute("data-message-author-role");
        // ② 대화 한 턴(질문/답변) 단위로 묶인 구조
        if (!els.length || els.every((el) => !textOf(el))) {
          els = topLevel([...document.querySelectorAll('article[data-turn], [data-testid^="conversation-turn-"]')]);
          roleOf = (el) => {
            const t = el.getAttribute("data-turn") || el.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role");
            if (t) return t;
            const label = el.querySelector(".sr-only, h5, h6")?.textContent || "";
            return USER_LABEL.test(label) ? "user" : "assistant";
          };
        }
        const found = els.map((el, i) => ({
          extId: el.getAttribute("data-message-id") || el.querySelector("[data-message-id]")?.getAttribute("data-message-id") || el.getAttribute("data-testid") || `i${i}`, box: el,
          role: roleOf(el),
          text: textOf(el),
        })).filter((m) => m.role === "user" || m.role === "assistant");
        // ③ 아는 구조가 하나도 없으면 자동 탐지
        return found.length ? found : autoMessages();
      },
      // 읽지 못했을 때 원인 파악용: 화면에 어떤 구조가 있는지 개수만 보고 (대화 내용은 보내지 않음)
      probe() {
        const n = (s) => document.querySelectorAll(s).length;
        return {
          messageRole: n("li[data-message-role]"), transcript: n("[data-conversation-transcript]"),
          authorRole: n("[data-message-author-role]"), turnArticle: n("article[data-turn]"),
          turnTestid: n('[data-testid^="conversation-turn-"]'), article: n("main article"),
          markdown: n(".markdown"), prose: n(".prose"),
          autoAttr: discoverRoleAttr(), labels: speakerLabels().length, main: n("main"), path: location.pathname.split("/").slice(0, 2).join("/"),
          sample: structureSample(),
        };
      },
      streaming: hasStopButton,
      input: () => document.querySelector("#prompt-textarea") || document.querySelector('textarea[name="prompt"]') || document.querySelector("form textarea") || document.querySelector('[contenteditable="true"]'),
    },
    claude: {
      match: () => location.hostname === "claude.ai",
      convId: () => location.pathname.match(/\/chat\/([\w-]+)/)?.[1] || null,
      messages() {
        // 질문: data-testid="user-message" / 답변: 작성 중 표시(data-is-streaming)가 붙은 상자 또는 font-claude-* 상자
        const USER = '[data-testid="user-message"]';
        const ANSWER = '[data-is-streaming], .font-claude-response, .font-claude-message, [data-testid="assistant-message"], [data-message-author="assistant"]';
        let els = topLevel([...document.querySelectorAll(`${USER}, ${ANSWER}`)]);
        // 답변 상자 안에 질문이 들어 있는 구조면(대화 전체를 감싸는 경우) 질문만 따로
        els = els.filter((el) => el.matches(USER) || !el.querySelector(USER));
        let found = els.map((el, i) => ({
          extId: `i${i}`, box: el,
          role: el.matches(USER) || el.querySelector(USER) ? "user" : "assistant",
          text: textOf(el),
        })).filter((m) => m.text);
        // 답변을 하나도 못 찾았으면 자동 탐지 결과로 보충
        if (found.length && !found.some((m) => m.role === "assistant")) {
          const auto = autoMessages();
          if (auto.some((m) => m.role === "assistant")) found = auto;
        }
        return found.length ? found : autoMessages();
      },
      probe() {
        const n = (s) => document.querySelectorAll(s).length;
        return {
          userMsg: n('[data-testid="user-message"]'), streamingBox: n("[data-is-streaming]"),
          fontResponse: n(".font-claude-response"), fontMessage: n(".font-claude-message"),
          renderCount: n("[data-test-render-count]"), prose: n(".prose"), markdown: n(".markdown, [class*='markdown']"),
          autoAttr: discoverRoleAttr(), labels: speakerLabels().length, sample: structureSample(),
        };
      },
      streaming: () => !!document.querySelector('[data-is-streaming="true"]') || hasStopButton(),
      input: () => document.querySelector('div[contenteditable="true"]'),
    },
    gemini: {
      match: () => location.hostname === "gemini.google.com",
      convId: () => location.pathname.match(/\/app\/([\w-]+)/)?.[1] || null,
      messages() {
        return [...document.querySelectorAll("user-query, model-response")].map((el, i) => ({
          extId: `i${i}`, box: el,
          role: el.tagName.toLowerCase() === "user-query" ? "user" : "assistant",
          text: textOf(el).replace(/^(You said|말씀하신 내용)\s*/i, ""),
        }));
      },
      streaming: hasStopButton,
      input: () => document.querySelector('rich-textarea div[contenteditable="true"]') || document.querySelector('div[contenteditable="true"]'),
    },
    // 자동 테스트용 가짜 AI 페이지 (테스트 빌드에서만 이 페이지에 주입됨)
    mockai: {
      match: () => location.pathname.startsWith("/mock-ai"),
      convId: () => new URLSearchParams(location.search).get("c"),
      // ?site=claude 면 Claude 읽기 방식으로 테스트
      messages() { return (new URLSearchParams(location.search).get("site") === "claude" ? SITES.claude : SITES.chatgpt).messages(); },
      probe() { return SITES.claude.probe(); },
      streaming: () => !!document.querySelector('[data-testid="stop-button"]'),
      input: () => document.querySelector("#prompt-textarea"),
    },
  };

  const found = Object.entries(SITES).find(([, s]) => s.match());
  if (!found) return;
  const [source, site] = found;

  const send = (msg) => { try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); } };

  const liveConvs = new Set(); // 이 탭에서 실제로 AI가 답변을 생성하는 걸 본 대화
  let newChatLive = false;
  let tempConvId = null;
  let lastConvId = null;
  let noAnswerSince = 0;
  const renames = new Map(); // 진짜 대화 ID -> 그 전에 쓰던 임시 ID
  let stableConv = null; // 메시지 ID 고정용
  let stableIds = [];
  let lastSent = "";
  let timer = null;

  function snapshot() {
    timer = null;
    try {
      // 본문 상자에서 AI가 만든 파일·이미지도 함께 수집 (상자 자체는 보내지 않음)
      const messages = site.messages().filter((m) => m.text).map(({ box, ...m }) => ({ ...m, files: box ? filesIn(box) : [] }));
      // 로그인 없이 쓰거나 임시 채팅이면 주소에 대화 ID가 없음 → 이 화면 동안 쓸 임시 ID 부여
      let convId = site.convId();
      if (!convId && messages.length) convId = tempConvId ||= `tmp-${Math.random().toString(36).slice(2, 10)}`;
      if (!convId) tempConvId = null; // 새 채팅 화면으로 돌아가면 다음 대화는 새 ID
      // 보낸 직후엔 주소에 ID가 없다가(임시 ID) 곧 진짜 ID가 생김 → 같은 대화로 이어 붙이도록 알림
      if (lastConvId?.startsWith("tmp-") && convId && !convId.startsWith("tmp-") && convId !== lastConvId) {
        renames.set(convId, lastConvId);
        if (liveConvs.has(lastConvId)) liveConvs.add(convId);
        stableConv = convId; // 메시지 ID 고정 정보도 그대로 이어감
        tempConvId = null;
      }
      if (convId) lastConvId = convId;
      // 질문은 읽히는데 AI 답변이 8초 넘게 하나도 안 읽히면 → 답변 화면 구조를 못 찾는 것 (진단 표시)
      const onlyQuestions = messages.some((m) => m.role === "user") && !messages.some((m) => m.role === "assistant") && !site.streaming();
      if (onlyQuestions) noAnswerSince ||= Date.now(); else noAnswerSince = 0;
      const missingAnswer = !!noAnswerSince && Date.now() - noAnswerSince > 8000;
      // 사이트가 보낸 직후의 임시 ID를 나중에 진짜 ID로 바꿔도 같은 메시지로 취급 (같은 자리·같은 역할이면 처음 ID 유지)
      if (convId) {
        if (stableConv !== convId) { stableConv = convId; stableIds = []; }
        messages.forEach((m, i) => {
          const prev = stableIds[i];
          if (prev && prev.role === m.role) m.extId = prev.id;
          else stableIds[i] = { id: m.extId, role: m.role };
        });
      }
      const streaming = site.streaming();
      if (streaming) {
        if (convId) liveConvs.add(convId);
        else newChatLive = true;
      }
      if (convId && newChatLive) { liveConvs.add(convId); newChatLive = false; }
      if (streaming) {
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") last.streaming = true;
      }
      // 대화 제목: 페이지 제목이 사이트 기본 문구(예: "ChatGPT: Chat, Work…")면 첫 질문으로 대신함
      let convTitle = document.title.replace(/\s*[-|]\s*(ChatGPT|Claude|Gemini|Mock AI).*$/i, "").trim();
      if (!convTitle || /^(ChatGPT|Claude|Gemini|Google Gemini|새 채팅|New chat)\b/i.test(convTitle)) {
        convTitle = (messages.find((m) => m.role === "user")?.text || "").split("\n")[0].slice(0, 40);
      }
      const snap = {
        source, convId, live: !!(convId && liveConvs.has(convId)), streaming,
        renameFrom: convId ? renames.get(convId) : undefined,
        convTitle,
        messages,
        // 대화방인데 메시지를 하나도 못 읽은 경우 → 화면 구조가 바뀐 것 (진단 정보 첨부)
        unreadable: (messages.length === 0 && (!!convId || streaming)) || missingAnswer,
        missingAnswer,
        probe: (messages.length === 0 && (convId || streaming)) || missingAnswer ? site.probe?.() : undefined,
      };
      const key = JSON.stringify(snap);
      if (key !== lastSent) { lastSent = key; Promise.resolve(send({ type: "snapshot", snap })).then((r) => r && updateAskCard(r, snap)); }
    } catch (err) {
      send({ type: "scrape-error", error: String(err) });
    }
  }
  const schedule = () => { if (!timer) timer = setTimeout(snapshot, 400); };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["data-is-streaming", "data-testid"],
  });
  setInterval(schedule, 1500);
  schedule();

  // 지금 보고 있는 AI 탭이 어느 것인지 확장에 알림 (피드백을 넣을 곳)
  const hello = () => { if (document.visibilityState === "visible") send({ type: "focus" }); };
  document.addEventListener("visibilitychange", hello);
  window.addEventListener("focus", hello);
  hello();

  // 팀원 피드백을 입력창에 넣기 (전송은 사용자가 직접)
  // ───── 새 대화마다 "팀룸에 공유할까요?" 카드 (AI 화면 오른쪽 아래) ─────
  let askHost = null;
  let askKey = null;
  function hideAskCard(key) {
    if (askHost && (!key || key === askKey)) { askHost.remove(); askHost = null; askKey = null; }
  }
  function updateAskCard(r, snap) {
    if (!r.ask) { if (r.key && r.decision !== "undecided") hideAskCard(r.key); return; }
    if (askHost && askKey === r.key) return;
    hideAskCard();
    askKey = r.key;
    askHost = document.createElement("div");
    askHost.id = "ai-teamroom-ask";
    askHost.style.cssText = "position:fixed;right:calc(var(--ai-teamroom-dock, 0px) + 24px);bottom:110px;z-index:2147483647";
    const root = askHost.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      .card{font:14px/1.5 "Malgun Gothic",system-ui,sans-serif;background:#fff;color:#1d2330;border:1px solid #e4e7ec;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:14px 16px;width:280px}
      .t{font-weight:700;margin-bottom:2px}
      .s{color:#6b7280;font-size:12.5px;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .b{display:flex;gap:8px}
      button{flex:1;border-radius:9px;padding:7px 0;font:inherit;cursor:pointer;border:1px solid #e4e7ec;background:#fff;color:#1d2330}
      .yes{background:#4f46e5;border-color:#4f46e5;color:#fff;font-weight:600}
      @media (prefers-color-scheme: dark){
        .card{background:#171a21;color:#e6e8ee;border-color:#2a2f3a}
        button{background:#171a21;color:#e6e8ee;border-color:#2a2f3a}
        .yes{background:#6d6cf7;border-color:#6d6cf7;color:#fff}
      }
    </style>
    <div class="card">
      <div class="t">🤝 이 대화를 팀룸에 공유할까요?</div>
      <div class="s"></div>
      <div class="b"><button class="yes">공유하기</button><button class="no">비공개</button></div>
    </div>`;
    root.querySelector(".s").textContent = snap.convTitle || "새 대화";
    const choose = (share) => { send({ type: "decide", key: askKey, share }); hideAskCard(); };
    root.querySelector(".yes").onclick = () => choose(true);
    root.querySelector(".no").onclick = () => choose(false);
    document.documentElement.appendChild(askHost);
  }
  // ───── AI 화면 오른쪽에 팀룸을 붙여서 한 화면으로 (크롬 확장에서만) ─────
  // 팀룸은 우리 페이지라 어디든 넣을 수 있음 → AI 사이트 안에 오른쪽 패널로 표시하고 AI 화면은 왼쪽으로 좁힘
  const isExtension = (() => { try { return !!chrome.runtime?.id && !!chrome.runtime.getURL; } catch { return false; } })();
  if (isExtension && window.top === window) setupDock();
  function setupDock() {
    const WIDTH_KEY = "dockWidth";
    const OPEN_KEY = "dockOpen";
    let width = 420;
    let open = true;
    const host = document.createElement("div");
    host.id = "ai-teamroom-dock";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{all:initial}
      .dock{position:fixed;top:0;right:0;height:100vh;z-index:2147483646;display:flex;background:#f5f6f8;border-left:1px solid #e4e7ec;box-shadow:-4px 0 16px rgba(0,0,0,.06)}
      .grip{width:6px;cursor:ew-resize;background:transparent}
      .grip:hover{background:#c7d2fe}
      iframe{border:0;height:100%;flex:1;background:#f5f6f8}
      .tab{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483646;writing-mode:vertical-rl;font:600 13px "Malgun Gothic",system-ui,sans-serif;
        background:#4f46e5;color:#fff;border:0;border-radius:10px 0 0 10px;padding:14px 7px;cursor:pointer;box-shadow:-2px 2px 10px rgba(0,0,0,.15)}
      .close{position:absolute;top:6px;left:-30px;width:26px;height:26px;border-radius:50%;border:1px solid #e4e7ec;background:#fff;cursor:pointer;font-size:14px;line-height:1}
      @media (prefers-color-scheme: dark){.dock{background:#0f1115;border-color:#2a2f3a}iframe{background:#0f1115}.close{background:#171a21;color:#e6e8ee;border-color:#2a2f3a}}
    </style>
    <div class="dock"><button class="close" title="팀룸 접기">▸</button><div class="grip" title="드래그해서 폭 조절"></div><iframe allow="clipboard-write" title="AI 팀룸"></iframe></div>
    <button class="tab" title="팀룸 펼치기">🤝 팀룸</button>`;
    const dock = root.querySelector(".dock");
    const tab = root.querySelector(".tab");
    const frame = root.querySelector("iframe");
    // AI 화면이 팀룸에 가리지 않도록 페이지 폭을 줄임
    const style = document.createElement("style");
    style.id = "ai-teamroom-dock-space";
    const apply = () => {
      dock.style.width = `${width}px`;
      dock.style.display = open ? "flex" : "none";
      tab.style.display = open ? "none" : "block";
      style.textContent = open
        ? `html{width:calc(100% - ${width}px)!important;min-width:0!important;overflow-x:hidden}body{width:100%!important;min-width:0!important}`
        : "";
      document.documentElement.style.setProperty("--ai-teamroom-dock", open ? `${width}px` : "0px");
      if (open && !frame.src) frame.src = chrome.runtime.getURL("sidepanel.html") + "?dock=1";
      window.dispatchEvent(new Event("resize"));
    };
    const save = () => { try { chrome.storage.local.set({ [WIDTH_KEY]: width, [OPEN_KEY]: open }); } catch {} };
    root.querySelector(".close").onclick = () => { open = false; apply(); save(); };
    tab.onclick = () => { open = true; apply(); save(); };
    // 폭 조절 (왼쪽 가장자리 드래그)
    root.querySelector(".grip").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      frame.style.pointerEvents = "none";
      const move = (ev) => { width = Math.min(Math.max(window.innerWidth + (open ? width : 0) - ev.clientX, 300), 900); apply(); };
      const up = () => { frame.style.pointerEvents = ""; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); save(); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    try {
      chrome.storage.local.get([WIDTH_KEY, OPEN_KEY], (v) => {
        if (v?.[WIDTH_KEY]) width = v[WIDTH_KEY];
        if (v?.[OPEN_KEY] === false) open = false;
        apply();
      });
    } catch { apply(); }
    const mount = () => {
      if (!document.getElementById(host.id)) document.documentElement.appendChild(host);
      if (!document.getElementById(style.id)) document.head?.appendChild(style);
    };
    mount();
    // 사이트가 화면을 다시 그리며 지워도 다시 붙임
    setInterval(mount, 2000);
  }

  // page-hook.js(페이지 안)가 보관해 둔 다운로드 파일 넘겨받기
  function blobFromPage(url) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window || e.data?.__aiTeamroom !== "blob" || e.data.id !== reqId) return;
        window.removeEventListener("message", onMsg);
        resolve(e.data.blob instanceof Blob ? e.data.blob : null);
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ __aiTeamroom: "get-blob", id: reqId, url }, location.origin);
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve(null); }, 3000);
    });
  }

  // 확장 뒤쪽에서 직접 받을 수 없는 파일(페이지 안에서만 열리는 blob 주소 등)은 이 화면에서 받아 팀룸에 올림
  try {
    chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if (m?.type !== "fetch-upload") return;
      (async () => {
        let blob = null;
        let why = "";
        // ① 이 화면에서 다시 받기 (사이트 로그인 쿠키 포함)
        try {
          const res = await fetch(m.url, { credentials: "include" });
          if (res.ok) blob = await res.blob();
          else why = `다시 받기 실패(HTTP ${res.status})`;
        } catch (e) { why = "다시 받기 실패(주소 만료)"; }
        // ② 사이트가 다운로드용으로 만들어 둔 파일(blob)을 페이지에서 넘겨받기
        if (!blob && m.url.startsWith("blob:")) blob = await blobFromPage(m.url);
        if (!blob) { reply({ ok: false, error: why || "파일을 찾지 못함" }); return; }
        try {
          const r = await fetch(m.uploadUrl, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
          reply({ ok: r.ok, error: r.ok ? "" : `팀룸 업로드 실패(HTTP ${r.status})` });
        } catch {
          reply({ ok: false, error: "팀룸 서버에 연결 안 됨" });
        }
      })();
      return true;
    });
  } catch {}

  // 패널 등 다른 곳에서 결정하면 카드 닫기 (데스크톱 앱에서는 chrome이 없어 건너뜀)
  try { chrome.runtime.onMessage.addListener((m) => { if (m?.type === "decision") hideAskCard(m.key); }); } catch {}

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "insert-text") return;
    const el = site.input();
    if (!el) { reply({ ok: false }); return; }
    el.focus();
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, (el.value ? el.value + "\n\n" : "") + msg.text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, msg.text);
    }
    reply({ ok: true });
  });
})();
