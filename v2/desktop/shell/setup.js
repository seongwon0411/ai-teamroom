// 처음 실행 설정 화면
const folders = [];
const list = document.getElementById("folders");
const msg = document.getElementById("msg");

function renderFolders() {
  list.replaceChildren();
  folders.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "folder";
    const name = document.createElement("span");
    name.textContent = f;
    name.title = f;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "빼기";
    del.onclick = () => { folders.splice(i, 1); renderFolders(); };
    row.append(name, del);
    list.appendChild(row);
  });
}
window.__addFolder = (f) => { if (f && !folders.includes(f)) { folders.push(f); renderFolders(); } };
document.getElementById("pick").onclick = async () => window.__addFolder(await setupApi.pickFolder());

document.getElementById("setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const go = document.getElementById("go");
  go.disabled = true;
  msg.className = "";
  msg.textContent = "팀룸에 연결하는 중…";
  const res = await setupApi.submit({ link: document.getElementById("link").value, name: document.getElementById("name").value, password: document.getElementById("password").value, folders });
  if (res.ok) { msg.textContent = "연결됐어요. 팀룸 창을 여는 중…"; return; }
  go.disabled = false;
  msg.className = "bad";
  msg.textContent = res.error;
});
