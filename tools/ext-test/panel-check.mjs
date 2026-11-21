// 툴바 아이콘 클릭 시 사이드패널이 열리도록 설정됐는지 확인
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true, pipe: true, enableExtensions: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "teamroom-panel-")),
});
try {
  const id = await browser.installExtension(path.join(here, "..", "..", "extension"));
  await new Promise((r) => setTimeout(r, 1500));
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(id), { timeout: 10000 });
  const worker = await sw.worker();
  const behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
  const options = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
  console.log(JSON.stringify({ behavior, options }));
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await browser.close();
}
