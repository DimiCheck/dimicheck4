// reset.js
document.addEventListener("DOMContentLoaded", () => {
  const resetButton = document.getElementById("resetButton");
  if (!resetButton) return;

  // 단일 클릭: 결석/조퇴 제외 초기화
  resetButton.addEventListener("click", () => {
    const magnets = document.querySelectorAll(".magnet:not(.placeholder)");
    magnets.forEach(m => {
      // 결석/조퇴 섹션에 붙어 있는 경우는 제외
      const parentSection = m.closest(".board-section");
      if (
        parentSection &&
        (parentSection.dataset.category === "absence" ||
         parentSection.dataset.category === "early")
      ) {
        return; // 제외
      }
      
      snapToHome(m);
      delete m.dataset.reason;
      m.classList.remove("has-reason", "attached");
      document.getElementById("magnetContainer").appendChild(m);
    });

    updateAttendance();
    updateMagnetOutline();
    updateEtcReasonPanel();
    saveState(grade, section);
  });

  // 더블 클릭: 완전 전체 초기화
  resetButton.addEventListener("dblclick", () => {
    const magnets = document.querySelectorAll(".magnet:not(.placeholder)");
    magnets.forEach(m => {
      snapToHome(m);
      delete m.dataset.reason;
      m.classList.remove("has-reason", "attached");
      document.getElementById("magnetContainer").appendChild(m);
    });

    updateAttendance();
    updateMagnetOutline();
    updateEtcReasonPanel();
    localStorage.removeItem("magnets");
    saveState(grade, section);
  });
});