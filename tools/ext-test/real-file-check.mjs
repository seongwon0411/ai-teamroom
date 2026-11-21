// 실제 chatgpt.com(로그인 없이)에서 파일을 만들게 하고, 다운로드가 어떤 형태로 오는지 + 팀룸 업로드 결과 확인
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.argv[2] || "http://localhost:3000";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { downloads: [] };

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: false, pipe: true, enableExtensions: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-file-")),
  args: ["--no-first-run", "--no-default-browser-check", "--window-size=1500,900"],
  defaultViewport: null,
});
try {
  const extId = await browser.installExtension(path.join(here, "..", "..", "extension"));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-realdl-"));
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });
  cdp.on("Browser.downloadWillBegin", (e) => out.downloads.push({ url: e.url.slice(0, 120), name: e.suggestedFilename }));

  const { id: roomId } = await (await fetch(`${server}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "파일 확인" }) })).json();
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector("#room-url", { visible: true });
  await panel.type("#room-url", `${server}/?room=${roomId}`);
  await panel.click("#connect-form button");
  let frame = null;
  for (let i = 0; i < 30 && !frame; i++) { await wait(500); frame = panel.frames().find((f) => f.url().startsWith(server)); }
  await frame.waitForSelector("#join-name", { visible: true });
  await frame.type("#join-name", "파일테스트");
  await frame.evaluate(() => document.querySelector("#join-form").requestSubmit());
  await wait(1500);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "setConfig", patch: { askEachChat: false } }));

  const gpt = await browser.newPage();
  await gpt.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  await wait(6000);
  const input = await gpt.$('textarea[name="prompt"], #prompt-textarea');
  await input.click();
  await gpt.keyboard.type("파이썬으로 'hello team' 한 줄이 들어간 hello.txt 파일을 만들어서 다운로드할 수 있게 해줘");
  await gpt.keyboard.press("Enter");
  // 답변·파일 생성 대기
  for (let i = 0; i < 24; i++) {
    await wait(5000);
    const busy = await gpt.evaluate(() => !!document.querySelector('button[aria-label*="중단"], button[aria-label*="Stop" i]'));
    if (!busy && i > 2) break;
  }
  // 마지막 답변 안의 링크·버튼 구조 기록 (내용 제외)
  out.lastAnswer = await gpt.evaluate(() => {
    const items = [...document.querySelectorAll("li[data-message-role='assistant']")];
    const li = items[items.length - 1];
    if (!li) return null;
    const desc = (e) => `${e.tagName.toLowerCase()}[${[...e.attributes].map((a) => `${a.name}=${a.value.slice(0, 50)}`).filter((s) => !s.startsWith("class=") && !s.startsWith("style=")).join(" ")}] "${(e.textContent || "").trim().slice(0, 40)}"`;
    return {
      links: [...li.querySelectorAll("a")].map(desc).slice(0, 8),
      buttons: [...li.querySelectorAll("button")].map(desc).filter((s) => /txt|파일|다운|download/i.test(s)).slice(0, 8),
      fileText: [...li.querySelectorAll("*")].filter((e) => !e.children.length && /\.txt\b/.test(e.textContent || "")).map(desc).slice(0, 5),
    };
  });
  // 파일 링크/카드 클릭해서 다운로드
  const clicked = await gpt.evaluate(() => {
    const items = [...document.querySelectorAll("li[data-message-role='assistant']")];
    const li = items[items.length - 1];
    const target = [...(li?.querySelectorAll("a, button, [role=button]") || [])].find((e) => /hello\.txt|다운로드|download/i.test(e.textContent || "") || /sandbox|download|files/i.test(e.getAttribute("href") || ""));
    if (target) { target.click(); return (target.textContent || "").trim().slice(0, 40); }
    return null;
  });
  out.clicked = clicked;
  await wait(8000);
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(extId));
  const worker = await sw.worker();
  out.fileEvent = await worker.evaluate(async () => (await chrome.storage.session.get("fileEvent")).fileEvent || null);
  out.downloadedFiles = fs.readdirSync(dlDir);
  const st = await (await fetch(`${server}/api/rooms/${roomId}/state`)).json();
  out.roomFiles = st.messages.flatMap((m) => (m.files || []).map((f) => `${m.role}:${f.kind}${f.hosted ? "(올림)" : ""}:${f.name}`));
  out.roomMessages = st.messages.map((m) => `${m.role}:${m.text.slice(0, 40).replace(/\n/g, " ")}`);
} catch (e) {
  out.error = String(e.stack || e);
} finally {
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
}
