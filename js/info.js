(function() {
    const modal = document.getElementById('infoModal');

    const infoFab = document.getElementById('infoFab');
    const infoMenu = document.getElementById('infoMenu');

    // --- 공통 이벤트 리스너 ---
    function closeInfoMenu() {
      infoMenu.classList.remove('open');
      infoFab.setAttribute('aria-expanded', 'false');
    }

    infoFab.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = infoMenu.classList.toggle('open');
      infoFab.setAttribute('aria-expanded', String(isOpen));
    });

    document.addEventListener('click', (e) => {
      if (!infoMenu.classList.contains('open')) return;
      const t = e.target;
      if (t === infoFab || infoFab.contains(t) || infoMenu.contains(t)) return;
      closeInfoMenu();
    });

    // --- 시간표 변경 모달 ---
    const scheduleModal = document.getElementById('scheduleModal');
    const scheduleModalClose = document.getElementById('scheduleModalClose');
    const scheduleChangeItem = document.getElementById('scheduleChangeItem');

    function openScheduleModal() {
      if (scheduleModal) {
        scheduleModal.style.display = 'flex';
      }
    }

    function closeScheduleModal() {
      if (scheduleModal) {
        scheduleModal.style.display = 'none';
      }
    }

    if (scheduleChangeItem && scheduleModal) {
      scheduleChangeItem.addEventListener('click', function(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        closeInfoMenu();
        openScheduleModal();
        return false;
      }, false);
    }

    if (scheduleModalClose && scheduleModal) {
      scheduleModalClose.addEventListener('click', function() {
        closeScheduleModal();
      }, false);
    }

    // 모달 배경 클릭시 닫기
    if (scheduleModal) {
      scheduleModal.addEventListener('click', function(e) {
        if (e.target === scheduleModal) {
          closeScheduleModal();
        }
      }, false);
    }

    // 시간표 항목 클릭
    const scheduleItems = document.querySelectorAll('.schedule-item');
    for (var i = 0; i < scheduleItems.length; i++) {
      scheduleItems[i].addEventListener('click', function() {
        const scheduleType = this.getAttribute('data-schedule');
        if (typeof setManualSchedule === 'function') {
          setManualSchedule(scheduleType);
        }
        closeScheduleModal();
        // 즉시 시계 업데이트
        if (typeof updateClock === 'function') {
          updateClock();
        }
      }, false);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!modal.hidden) modal.hidden = true;
        else if (!scheduleModal.hidden) scheduleModal.hidden = true;
        else closeInfoMenu();
      }
    });
  })();