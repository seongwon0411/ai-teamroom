// 크롬 확장 자동 테스트: 실제 크롬에 확장을 설치하고 가짜 AI 페이지로 공유·피드백 흐름을 확인
// 사용법: node test.mjs <팀룸서버주소 예: http://localhost:3000> [결과폴더]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const outDir = process.argv[3] || path.join(os.tmpdir(), "teamroom-ext-test");
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// 테스트용 사본: 가짜 AI 페이지에도 content script가 들어가도록 manifest 수정
const extSrc = path.join(here, "..", "..", "extension");
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-ext-"));
// (fs.cpSync는 한글 경로에서 Node가 비정상 종료되는 문제가 있어 직접 복사)
(function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.writeFileSync(d, fs.readFileSync(s));
  }
})(extSrc, extDir);
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
manifest.content_scripts[0].matches.push(`${server}/mock-ai.html*`);
manifest.host_permissions.push(`${server}/*`);
manifest.web_accessible_resources[0].matches.push(`${server}/*`);
manifest.content_scripts[1].matches.push(`${server}/mock-ai.html*`);
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (name, ok, detail = "") => { steps.push({ name, ok, detail }); console.log(ok ? "✅" : "❌", name, detail); };
const api = async (roomId, body) => (await fetch(`${server}/api/rooms/${roomId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const state = async (roomId) => (await fetch(`${server}/api/rooms/${roomId}/state`)).json();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-chrome-")),
  args: ["--no-first-run", "--no-default-browser-check"],
});
try {
  // 사용자 상황 재현: 확장을 설치(또는 새로고침)하기 "전에" 이미 열려 있던 AI 탭
  const early = await browser.newPage();
  await early.goto(`${server}/mock-ai.html`);
  const extId = await browser.installExtension(extDir);
  step("확장 설치", !!extId, extId);

  const { id: roomId } = await (await fetch(`${server}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "확장 테스트방" }) })).json();
  const roomUrl = `${server}/?room=${roomId}`;

  // 사이드패널 화면(탭으로 열어서 테스트)
  const panel = await browser.newPage();
  await panel.setViewport({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector("#room-url", { visible: true, timeout: 10000 }); // 확장이 막 켜질 때는 화면이 늦게 뜸
  await panel.type("#room-url", roomUrl);
  await panel.click("#connect-form button");
  let roomFrame = null;
  for (let i = 0; i < 30 && !roomFrame; i++) {
    await wait(500);
    roomFrame = panel.frames().find((f) => f.url().startsWith(server));
  }
  step("초대 링크 연결", !!roomFrame, roomFrame ? "" : await panel.$eval("#connect-error", (e) => e.textContent));

  await roomFrame.waitForSelector("#join-name", { visible: true, timeout: 5000 });
  await roomFrame.type("#join-name", "확장테스터");
  await roomFrame.evaluate(() => document.querySelector("#join-form").requestSubmit());
  await wait(2000);
  let st = await state(roomId);
  const me = Object.values(st.members).find((m) => m.name === "확장테스터");
  step("팀룸 입장 (사이드패널 안)", !!me);
  // 앞쪽 테스트들은 "묻지 않고 자동 공유" 모드로 진행 (묻기 모드는 맨 뒤에서 따로 확인)
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "setConfig", patch: { askEachChat: false } }));

  // 미리 열려 있던 탭(F5 안 함)에서 대화해도 자동 연결되어 공유되는지
  await early.bringToFront();
  await early.type("#prompt-textarea", "미리 열린 탭 질문");
  await early.click("#send");
  await wait(7000);
  st = await state(roomId);
  step("확장보다 먼저 열린 탭도 자동 연결 (F5 불필요)", st.messages.some((m) => m.text === "미리 열린 탭 질문"));
  step("먼저 열린 탭에도 다운로드 파일 보관 도우미 연결", await early.evaluate(() => !!window.__aiTeamroomHook));
  await early.close();
  const convText0 = await panel.$eval("#conv", (e) => e.textContent);

  // AI 탭에서 대화
  const ai = await browser.newPage();
  await ai.goto(`${server}/mock-ai.html`);
  await ai.bringToFront();
  await wait(800);
  await ai.type("#prompt-textarea", "SWOT 분석 예시 보여줘");
  await ai.click("#send");
  await wait(1500);
  st = await state(roomId);
  step("생성 중 실시간 공유", st.messages.some((m) => m.source === "mockai" && m.status === "streaming"));
  await wait(5000);
  st = await state(roomId);
  const synced = st.messages.filter((m) => m.source === "mockai" && m.text.includes("SWOT"));
  step("대화 자동 공유", synced.length === 2 && synced.every((m) => m.status === "done" && m.authorId === me?.id),
    synced.map((m) => `${m.role}:${m.text.slice(0, 18)}`).join(" | "));

  const panelConv = await panel.$eval("#conv", (e) => e.textContent);
  step("사이드패널에 공유 상태 표시", panelConv.includes("공유 중"), panelConv.trim());

  // 예전 대화를 열기만 한 경우 공유되지 않아야 함 (생성 없이 메시지가 있는 화면)
  const ai2 = await browser.newPage();
  await ai2.goto(`${server}/mock-ai.html?c=oldchat123`);
  await ai2.evaluate(() => {
    for (const [role, text] of [["user", "개인적인 예전 질문"], ["assistant", "예전 답변"]]) {
      const el = document.createElement("div");
      el.setAttribute("data-message-author-role", role);
      el.textContent = text;
      document.getElementById("thread").appendChild(el);
    }
  });
  await wait(2500);
  st = await state(roomId);
  step("열어보기만 한 예전 대화는 비공개", !st.messages.some((m) => m.text.includes("개인적인 예전 질문")));
  await ai2.close();
  await ai.bringToFront();
  await wait(800);

  // 팀원 피드백 → 내 AI 입력창
  const other = await api(roomId, { type: "join", name: "지영" });
  const aiMsg = synced.find((m) => m.role === "assistant");
  await api(roomId, { type: "comment", memberId: other.member.id, messageId: aiMsg.id, quote: "", text: "약점(W) 항목을 더 구체적으로 써줘" });
  await wait(2000);
  await roomFrame.evaluate(() => document.querySelector("[data-apply]").click());
  await wait(1500);
  const inputVal = await ai.$eval("#prompt-textarea", (e) => e.value);
  step("피드백 → AI 입력창 자동 입력", inputVal.includes("약점(W) 항목을 더 구체적으로"), inputVal.slice(0, 50).replace(/\n/g, " "));
  st = await state(roomId);
  step("피드백 반영 처리", st.comments.some((c) => c.resolved && c.appliedInMessageId === "external"));

  // 한글 입력 (실제 키 입력 이벤트로 피드백 창에 입력)
  await roomFrame.evaluate(() => document.querySelector("[data-fb]").click());
  await roomFrame.type("#fb-text", "한글 입력 테스트입니다");
  const fbVal = await roomFrame.$eval("#fb-text", (e) => e.value);
  step("팀룸 한글 입력", fbVal === "한글 입력 테스트입니다", fbVal);

  // ChatGPT의 다른 화면 구조(질문/답변이 턴 단위 article로 묶이고 "나의 말:" 머리말이 붙는 구조)도 읽는지
  const ai3 = await browser.newPage();
  await ai3.goto(`${server}/mock-ai.html?c=turnstyle1`);
  await ai3.bringToFront();
  await ai3.evaluate(async () => {
    const stop = document.createElement("button");
    stop.setAttribute("data-testid", "stop-button");
    document.getElementById("f").appendChild(stop);
    document.getElementById("thread").innerHTML =
      '<article data-turn="user" data-testid="conversation-turn-1"><h5 class="sr-only">나의 말:</h5><div>새 구조 질문</div></article>' +
      '<article data-turn="assistant" data-testid="conversation-turn-2"><h6 class="sr-only">ChatGPT의 말:</h6><div class="markdown">새 구조 답변</div></article>';
    await new Promise((r) => setTimeout(r, 1500));
    stop.remove();
  });
  await wait(2500);
  st = await state(roomId);
  step("다른 화면 구조(턴 단위)도 읽기", st.messages.some((m) => m.text === "새 구조 질문" && m.role === "user") && st.messages.some((m) => m.text === "새 구조 답변" && m.role === "assistant"),
    st.messages.slice(-2).map((m) => `${m.role}:${m.text}`).join(" | "));

  // 알 수 없는 이름의 구조도 자동 탐지로 읽는지 (① 역할 속성 이름이 바뀐 경우 ② 머리말만 있는 경우)
  const liveFill = async (page, html) => page.evaluate(async (h) => {
    const stop = document.createElement("button");
    stop.setAttribute("data-testid", "stop-button");
    document.getElementById("f").appendChild(stop);
    document.getElementById("thread").innerHTML = h;
    await new Promise((r) => setTimeout(r, 1500));
    stop.remove();
  }, html);
  await ai3.goto(`${server}/mock-ai.html?c=auto1`);
  await liveFill(ai3, '<div data-zz-speaker="user"><p>자동탐지 질문</p></div><div data-zz-speaker="assistant"><p>자동탐지 답변</p></div>');
  await ai3.goto(`${server}/mock-ai.html?c=label1`);
  await liveFill(ai3, '<section><h5 class="sr-only">나의 말:</h5><div>머리말 질문</div></section><section><h6 class="sr-only">ChatGPT의 말:</h6><div>머리말 답변</div></section>');
  // 로그인한 ChatGPT처럼 "내가 한 말:" / "ChatGPT 답변:" 머리말 + 본문이 옆 상자에 있는 구조
  await ai3.goto(`${server}/mock-ai.html?c=login1`);
  await liveFill(ai3, '<article><h5 class="sr-only">내가 한 말:</h5><div><div>로그인 질문</div></div></article><article><h6 class="sr-only">ChatGPT 답변:</h6><div><p>로그인 답변</p></div></article>');
  // 역할 속성이 머리말 요소에만 붙어 있는 구조 (본문은 형제 상자)
  await ai3.goto(`${server}/mock-ai.html?c=login2`);
  await liveFill(ai3, '<section><h5 data-qq-author="user">내가 한 말:</h5><div>속성 질문</div></section><section><h6 data-qq-author="assistant">ChatGPT 답변:</h6><div>속성 답변</div></section>');
  // 음성 중지 버튼이 계속 있어도 "작성 중"으로 오해하지 않는지
  await ai3.goto(`${server}/mock-ai.html?c=voice1`);
  await liveFill(ai3, '<li data-message-role="user" id="v1"><div data-user-message-bubble>음성버튼 질문</div></li><li data-message-role="assistant" id="v2"><div data-assistant-markdown-root>음성버튼 답변</div></li>');
  await ai3.evaluate(() => { const b = document.createElement("button"); b.setAttribute("aria-label", "음성 모드 중지"); document.body.appendChild(b); });
  await wait(2500);
  st = await state(roomId);
  const has = (t, r) => st.messages.some((m) => m.text === t && m.role === r);
  step("로그인 화면: '내가 한 말/ChatGPT 답변' 머리말 옆 본문 읽기", has("로그인 질문", "user") && has("로그인 답변", "assistant"),
    st.messages.filter((m) => m.convId === "login1").map((m) => `${m.role}:${m.text}`).join(" | "));
  step("로그인 화면: 역할 속성이 머리말에만 있어도 본문 읽기", has("속성 질문", "user") && has("속성 답변", "assistant"),
    st.messages.filter((m) => m.convId === "login2").map((m) => `${m.role}:${m.text}`).join(" | "));
  step("음성 중지 버튼을 '작성 중'으로 오해하지 않음", st.messages.some((m) => m.text === "음성버튼 답변" && m.status === "done"));
  step("자동 탐지: 역할 속성 이름이 달라도 읽기", has("자동탐지 질문", "user") && has("자동탐지 답변", "assistant"));
  step("자동 탐지: 머리말(나의 말/ChatGPT의 말)로 읽기", has("머리말 질문", "user") && has("머리말 답변", "assistant"));

  // Claude 구조: 질문 data-testid="user-message", 답변은 data-is-streaming 상자
  await ai3.goto(`${server}/mock-ai.html?c=cl1&site=claude`);
  await liveFill(ai3, '<div data-testid="user-message"><p>자기소개 ppt 만들어줘</p></div><div data-is-streaming="false"><div class="standard-markdown"><p>클로드 답변입니다</p></div></div>');
  await wait(2500);
  st = await state(roomId);
  step("Claude: 질문과 답변 모두 읽기", st.messages.some((m) => m.convId === "cl1" && m.role === "user" && m.text === "자기소개 ppt 만들어줘") && st.messages.some((m) => m.convId === "cl1" && m.role === "assistant" && m.text === "클로드 답변입니다"));
  // 답변을 못 찾으면 경고 (질문만 있는 경우)
  await ai3.goto(`${server}/mock-ai.html?c=cl2&site=claude`);
  await ai3.bringToFront();
  await liveFill(ai3, '<div data-testid="user-message"><p>질문만 있음</p></div><section><p>알 수 없는 답변 구조</p></section>');
  await wait(11000);
  const missWarn = await panel.$eval("#conv", (e) => e.textContent);
  step("답변을 못 찾으면 '질문만 읽었어요' 경고 + 진단", missWarn.includes("AI 답변을 찾지 못했어요"), missWarn.slice(0, 50));

  // 로그인 없이 쓰는 ChatGPT처럼 주소에 대화 ID가 없어도 공유되는지
  await ai3.goto(`${server}/mock-ai.html?noid=1`);
  await ai3.bringToFront();
  await ai3.type("#prompt-textarea", "hi");
  await ai3.click("#send");
  await wait(6000);
  st = await state(roomId);
  step("대화 ID 없는 채팅(비로그인)도 공유", st.messages.some((m) => m.text === "hi" && m.role === "user" && m.convId?.startsWith("tmp-")));

  // 읽을 수 없는 화면이면 패널에 경고가 떠야 함 (거짓 "공유 중" 표시 금지)
  await ai3.evaluate(() => { document.getElementById("thread").innerHTML = "<section>알 수 없는 구조</section>"; history.replaceState(null, "", "?c=unknown1"); });
  await wait(2500);
  const warnText = await panel.$eval("#conv", (e) => e.textContent);
  step("못 읽는 화면은 경고 표시", warnText.includes("읽지 못했어요"), warnText.slice(0, 60));
  // ───── 새 대화마다 "공유할까요?" 묻기 ─────
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "setConfig", patch: { askEachChat: true } }));
  const cardButton = (page, cls) => page.evaluate((c) => {
    const host = document.getElementById("ai-teamroom-ask");
    const b = host?.shadowRoot?.querySelector(`.${c}`);
    if (b) b.click();
    return !!b;
  }, cls);
  await ai3.goto(`${server}/mock-ai.html?c=ask1`);
  await ai3.bringToFront();
  await liveFill(ai3, `<li data-message-role="user" id="q1"><div data-user-message-bubble>묻기 질문</div></li>` +
    `<li data-message-role="assistant" id="q2"><div data-assistant-markdown-root>보고서 완성했어요 <a href="${server}/files/report.pdf" download>report.pdf</a><img src="${server}/test-image.png" alt="차트"></div></li>`);
  await wait(2000);
  st = await state(roomId);
  const cardShown = await ai3.evaluate(() => !!document.getElementById("ai-teamroom-ask"));
  step("새 대화: '공유할까요?' 카드 표시, 고르기 전엔 공유 안 됨", cardShown && !st.messages.some((m) => m.convId === "ask1"));
  await cardButton(ai3, "yes");
  await wait(2000);
  st = await state(roomId);
  const askMsgs = st.messages.filter((m) => m.convId === "ask1");
  step("'공유하기' 누르면 지금까지 내용 공유", askMsgs.length === 2 && !(await ai3.evaluate(() => !!document.getElementById("ai-teamroom-ask"))));
  const withFiles = askMsgs.find((m) => m.role === "assistant");
  step("AI가 만든 파일·이미지도 함께 공유", withFiles?.files?.some((f) => f.kind === "file" && f.name === "report.pdf") && withFiles?.files?.some((f) => f.kind === "image"),
    JSON.stringify(withFiles?.files?.map((f) => `${f.kind}:${f.name}`)));
  // ChatGPT처럼 링크 없는 "파일 카드" → 이름만 먼저 표시, 다운로드하면 팀룸에 실제 파일이 올라감
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-dl-"));
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });
  await ai3.evaluate((srv) => {
    const li = document.getElementById("q2");
    li.querySelector("[data-assistant-markdown-root]").insertAdjacentHTML("beforeend",
      `<p>참고로 <span data-d-streaming-word>hello.txt</span> 처럼 이름만 언급</p><div class="file-card"><div>보고서_최종.pptx</div><div>PowerPoint</div></div>`);
  }, server);
  await wait(2500);
  st = await state(roomId);
  const ask1Files = st.messages.find((m) => m.convId === "ask1" && m.role === "assistant")?.files || [];
  const pendingOk = ask1Files.some((f) => f.kind === "pending" && f.name === "보고서_최종.pptx");
  const mentionIgnored = !ask1Files.some((f) => f.name === "hello.txt");
  step("링크 없는 파일 카드: 이름 먼저 표시 (본문에 언급만 된 이름은 제외)", pendingOk && mentionIgnored, JSON.stringify(ask1Files.map((f) => `${f.kind}:${f.name}`)));
  await ai3.evaluate((srv) => {
    const a = document.createElement("a");
    a.href = `${srv}/test-image.png?dl=1`;
    a.download = "보고서_최종.pptx";
    document.body.appendChild(a);
    a.click();
  }, server);
  await wait(5000);
  st = await state(roomId);
  const hostedFile = st.messages.find((m) => m.convId === "ask1" && m.role === "assistant")?.files?.find((f) => f.hosted && f.name === "보고서_최종.pptx");
  let downloadOk = false;
  if (hostedFile) downloadOk = (await fetch(server + hostedFile.url)).status === 200;
  step("AI 화면에서 다운로드하면 같은 파일이 팀룸에 자동 업로드 (원래 답변에 붙음)", !!hostedFile && downloadOk,
    JSON.stringify(st.messages.find((m) => m.convId === "ask1" && m.role === "assistant")?.files?.map((f) => `${f.kind}${f.hosted ? "(올림)" : ""}:${f.name}`)));

  // ChatGPT식 다운로드: 메모리 속 임시 파일(blob)을 만들고 받자마자 바로 지움 → 그래도 팀룸에 올라가야 함
  await ai3.evaluate(() => {
    const blob = new Blob(["blob 내용입니다"], { type: "text/plain" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = "블롭자료.txt";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 50);
  });
  await wait(5000);
  st = await state(roomId);
  const blobFile = st.messages.flatMap((m) => m.files || []).find((f) => f.hosted && f.name === "블롭자료.txt");
  const blobBody = blobFile ? await (await fetch(server + blobFile.url)).text() : "";
  step("임시 파일(blob) 다운로드도 팀룸에 업로드 (바로 지워져도)", blobBody === "blob 내용입니다", blobBody || "없음");

  // 팀룸 화면에도 첨부가 보이는지
  await wait(2000);
  const chipShown = await roomFrame.evaluate(() => [...document.querySelectorAll(".file-chip")].some((a) => a.textContent.includes("report.pdf")) && !!document.querySelector(".files .imgs img"));
  step("팀룸 화면에 첨부 파일·이미지 표시", chipShown);

  await ai3.goto(`${server}/mock-ai.html?c=ask2`);
  await liveFill(ai3, '<li data-message-role="user" id="p1"><div data-user-message-bubble>비밀 질문</div></li><li data-message-role="assistant" id="p2"><div data-assistant-markdown-root>비밀 답변</div></li>');
  await wait(2000);
  await cardButton(ai3, "no");
  await wait(2000);
  st = await state(roomId);
  const panelText = await panel.$eval("#conv", (e) => e.textContent);
  step("'비공개' 누르면 공유 안 됨 + 패널에 비공개 표시", !st.messages.some((m) => m.convId === "ask2") && panelText.includes("비공개"), panelText.slice(0, 40));
  // 패널에서 나중에 "공유하기"로 바꿀 수 있는지
  await panel.evaluate(() => document.querySelector('#conv [data-decide="1"]')?.click());
  await wait(2500);
  st = await state(roomId);
  step("패널에서 나중에 공유로 변경", st.messages.some((m) => m.convId === "ask2" && m.text === "비밀 질문"));
  await ai3.close();

  // 팀룸에서 파일 직접 올리기
  const upFile = path.join(dlDir, "팀원자료.txt");
  fs.writeFileSync(upFile, "직접 올린 자료입니다");
  const input = await roomFrame.$(".col.mine .upload-btn input");
  await input.uploadFile(upFile);
  await wait(2500);
  st = await state(roomId);
  const manual = st.messages.find((m) => m.text === "📎 파일 공유: 팀원자료.txt");
  const manualBody = manual ? await (await fetch(server + manual.files[0].url)).text() : "";
  step("팀룸에서 파일 직접 올리기 → 팀원이 받을 수 있음", manualBody === "직접 올린 자료입니다", manualBody);

  // AI 화면 안에 팀룸이 오른쪽에 붙는지 (한 화면)
  const ai4 = await browser.newPage();
  await ai4.setViewport({ width: 1500, height: 850 });
  await ai4.goto(`${server}/mock-ai.html?c=dock1`);
  await ai4.bringToFront();
  let dockRoom = null;
  for (let i = 0; i < 30 && !dockRoom; i++) { await wait(500); dockRoom = ai4.frames().find((f) => f.url().startsWith(server) && f.url().includes("embed=1")); }
  const dockInfo = await ai4.evaluate(() => {
    const host = document.getElementById("ai-teamroom-dock");
    const dock = host?.shadowRoot?.querySelector(".dock");
    return { present: !!dock, dockWidth: dock ? Math.round(dock.getBoundingClientRect().width) : 0, pageWidth: Math.round(document.documentElement.getBoundingClientRect().width), viewport: innerWidth };
  });
  step("AI 화면 오른쪽에 팀룸 패널이 붙음 (AI 화면은 왼쪽으로 좁아짐)", dockInfo.present && dockInfo.dockWidth >= 300 && dockInfo.pageWidth <= dockInfo.viewport - 300, JSON.stringify(dockInfo));
  let dockMe = null;
  if (dockRoom) {
    await wait(2500);
    dockMe = await dockRoom.evaluate(() => document.querySelector(".col.mine .col-title b")?.textContent || (document.querySelector("#join-dialog")?.open ? "입장창 뜸" : null));
  }
  step("붙은 팀룸에서도 같은 사람으로 자동 입장 (다시 입장 안 함)", !!dockMe && dockMe.includes("확장테스터"), dockMe);
  await ai4.screenshot({ path: path.join(outDir, "dock.png") });
  // 접기 → 탭 버튼만 남고 AI 화면이 다시 넓어짐
  await ai4.evaluate(() => document.getElementById("ai-teamroom-dock").shadowRoot.querySelector(".close").click());
  await wait(500);
  const collapsed = await ai4.evaluate(() => ({ pageWidth: Math.round(document.documentElement.getBoundingClientRect().width), viewport: innerWidth, tab: getComputedStyle(document.getElementById("ai-teamroom-dock").shadowRoot.querySelector(".tab")).display }));
  step("팀룸 접기/펼치기", collapsed.pageWidth >= collapsed.viewport - 20 && collapsed.tab !== "none", JSON.stringify(collapsed));
  await ai4.evaluate(() => document.getElementById("ai-teamroom-dock").shadowRoot.querySelector(".tab").click());
  await ai4.close();

  // AI 열기 버튼: 같은 창에 ChatGPT 탭을 열어줌
  const before = (await browser.pages()).length;
  await panel.evaluate(() => document.querySelector('[data-ai="chatgpt"]').click());
  await wait(2500);
  const pages = await browser.pages();
  const opened = pages.find((p) => p.url().includes("chatgpt.com"));
  step("패널의 'ChatGPT' 버튼으로 AI 열기", pages.length === before + 1 && !!opened, opened?.url());
  if (opened) await opened.close();

  await panel.screenshot({ path: path.join(outDir, "panel.png") });
  await ai.screenshot({ path: path.join(outDir, "ai.png") });
} catch (err) {
  step("테스트 오류", false, String(err.stack || err));
} finally {
  await browser.close();
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(steps, null, 2));
  console.log(steps.every((s) => s.ok) ? "\n모두 통과" : "\n실패 있음");
}
