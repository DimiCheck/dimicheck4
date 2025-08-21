async function saveState(grade, section) {
  const magnets = {};
  document.querySelectorAll('.magnet:not(.placeholder)').forEach(m => {
    const num = m.dataset.number;
    const data = {};
    if (m.dataset.reason) data.reason = m.dataset.reason;
    if (m.classList.contains('attached')) {
      const sec = m.closest('.board-section');
      data.attachedTo = sec ? sec.dataset.category : null;
    } else {
      data.attachedTo = null;
      data.left = parseFloat(m.style.left) || 0;
      data.top  = parseFloat(m.style.top)  || 0;
    }
    magnets[num] = data;
  });

  try {
    await fetch(`/api/classes/state/save?grade=${grade}&section=${section}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magnets })
    });
  } catch (e) {
    console.warn("saveState failed:", e);
  }
}

async function fetchMagnetConfig(grade, section) {
  try {
    const res = await fetch(`/api/classes/config?grade=${grade}&section=${section}`);
    if (!res.ok) throw new Error("config load failed");
    return await res.json();  // { end: 31, skipNumbers: [12, 20, 25] }
  } catch (e) {
    console.error("fetchMagnetConfig failed:", e);
    return { end: 30, skipNumbers: [] }; // 기본값 fallback
  }
}

async function loadState(grade, section) {
  try {
    const res = await fetch(`/api/classes/state/load?grade=${grade}&section=${section}`);
    if (!res.ok) throw new Error("로드 실패");
    const parsed = await res.json();
    const magnets = parsed.magnets || {};

    // 자석 반영
    Object.entries(magnets).forEach(([num, data]) => {
      const el = document.querySelector(`.magnet[data-number="${num}"]`);
      if (!el) return;

      if (data.attachedTo) {
        const sec = document.querySelector(`.board-section[data-category="${data.attachedTo}"] .section-content`);
        if (sec) {
          el.classList.add("attached");
          if (data.reason) {
            el.dataset.reason = data.reason.trim();   // ✅ reason 저장
            el.classList.add("has-reason");
          } else {
            delete el.dataset.reason;                 // ✅ reason 없을 때는 삭제
            el.classList.remove("has-reason");
          }
          sec.appendChild(el);
        }
      }
    });

    // ✅ 끝나고 기타 패널 갱신
    updateEtcReasonPanel();
    sortAllSections();

  } catch (e) {
    console.error("loadState error:", e);
  }
}
