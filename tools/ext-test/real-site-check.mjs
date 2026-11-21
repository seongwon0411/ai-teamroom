// 실제 chatgpt.com(로그인 없이)에서 확장이 대화를 읽어 팀룸에 올리는지 확인
// 사용: node real-site-check.mjs [팀룸서버] [보낼 메시지]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.argv[2] || "http://localhost:3000";
const message = process.argv[3] || "하이";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: false, pipe: true, enableExtensions: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-real-")),
  args: ["--no-first-run", "--no-default-browser-check", "--window-size=1500,900"],
  defaultViewport: null,
});
const out = {};
try {
  const extId = await browser.installExtension(path.join(here, "..", "..", "extension"));
  const { id: roomId } = await (await fetch(`${server}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "실제 사이트 확인" }) })).json();

  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector("#room-url", { visible: true });
  await panel.type("#room-url", `${server}/?room=${roomId}`);
  await panel.click("#connect-form button");
  let frame = null;
  for (let i = 0; i < 30 && !frame; i++) { await wait(500); frame = panel.frames().find((f) => f.url().startsWith(server)); }
  await frame.waitForSelector("#join-name", { visible: true });
  await frame.type("#join-name", "실사이트");
  await frame.evaluate(() => document.querySelector("#join-form").requestSubmit());
  await wait(1500);

  const gpt = await browser.newPage();
  await gpt.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  await wait(6000);
  out.afterLoadConv = await panel.$eval("#conv", (e) => e.textContent);
  const input = await gpt.$('textarea[name="prompt"], #prompt-textarea, [contenteditable="true"]');
  out.inputFound = !!input;
  if (input) {
    await input.click();
    await gpt.keyboard.type(message);
    await gpt.keyboard.press("Enter");
    await wait(5000);
    // 새 대화 → "공유할까요?" 카드에서 공유하기
    out.askCard = await gpt.evaluate(() => {
      const b = document.getElementById("ai-teamroom-ask")?.shadowRoot?.querySelector(".yes");
      if (b) b.click();
      return !!b;
    });
    await wait(7000);
  }
  out.afterChatConv = await panel.$eval("#conv", (e) => e.textContent);
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(extId));
  const worker = await sw.worker();
  out.session = await worker.evaluate(async () => {
    const s = await chrome.storage.session.get(null);
    return { snapTabs: Object.keys(s.snaps || {}).length, snaps: Object.values(s.snaps || {}).map((x) => ({ source: x.source, convId: x.convId, live: x.live, n: x.messages?.length, unreadable: x.unreadable, probe: x.probe })), aiTab: s.aiTab, sync: s.sync, errors: s.errors || null };
  });
  const st = await (await fetch(`${server}/api/rooms/${roomId}/state`)).json();
  out.serverMessages = st.messages.map((m) => `${m.role}:${m.text.slice(0, 30)}`);
  out.url = gpt.url();
  out.screenshot = path.join(os.tmpdir(), "teamroom-real-chatgpt.png");
  await gpt.bringToFront();
  await wait(1500);
  await gpt.screenshot({ path: out.screenshot });
} catch (e) {
  out.error = String(e.stack || e);
} finally {
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
}
