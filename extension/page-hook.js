// AI 사이트 페이지 안(MAIN)에서 실행: 사이트가 다운로드용으로 만든 파일(blob)을 잠깐 기억해 둠
// → 사이트가 다운로드 직후 그 주소를 바로 지워도, 확장이 같은 파일을 팀룸에 올릴 수 있게
// (사이트 동작은 바꾸지 않고, 만들어진 파일만 최근 20개까지 보관)
(() => {
  if (window.__aiTeamroomHook) return;
  window.__aiTeamroomHook = true;
  const keep = new Map();
  const original = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = original.apply(this, arguments);
    try {
      if (obj instanceof Blob) {
        keep.set(url, obj);
        if (keep.size > 20) keep.delete(keep.keys().next().value);
      }
    } catch {}
    return url;
  };
  // 확장(같은 탭의 content script)이 요청하면 보관한 파일을 넘겨줌
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__aiTeamroom !== "get-blob") return;
    window.postMessage({ __aiTeamroom: "blob", id: e.data.id, blob: keep.get(e.data.url) || null }, location.origin);
  });
})();
