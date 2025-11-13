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
    console.log('info.js 로드됨');
    const scheduleModal = document.getElementById('scheduleModal');
    const scheduleModalClose = document.getElementById('scheduleModalClose');
    const scheduleChangeItem = document.getElementById('scheduleChangeItem');

    console.log('scheduleModal:', scheduleModal);
    console.log('scheduleModalClose:', scheduleModalClose);
    console.log('scheduleChangeItem:', scheduleChangeItem);

    if (scheduleChangeItem && scheduleModal) {
      console.log('시간표 변경 버튼 이벤트 리스너 등록');
      scheduleChangeItem.addEventListener('click', (e) => {
        console.log('시간표 변경 버튼 클릭됨!');
        e.preventDefault();
        e.stopPropagation();
        closeInfoMenu();
        scheduleModal.hidden = false;
        console.log('시간표 변경 모달 열림');
      });
    } else {
      console.error('시간표 변경 요소를 찾을 수 없음:', {
        scheduleChangeItem: !!scheduleChangeItem,
        scheduleModal: !!scheduleModal
      });
    }

    if (scheduleModalClose && scheduleModal) {
      scheduleModalClose.addEventListener('click', () => {
        scheduleModal.hidden = true;
        console.log('시간표 변경 모달 닫힘');
      });
    }

    // 모달 배경 클릭시 닫기
    if (scheduleModal) {
      scheduleModal.addEventListener('click', (e) => {
        if (e.target === scheduleModal) {
          scheduleModal.hidden = true;
        }
      });
    }

    // 시간표 항목 클릭
    const scheduleItems = document.querySelectorAll('.schedule-item');
    console.log('시간표 항목 개수:', scheduleItems.length);
    scheduleItems.forEach(item => {
      item.addEventListener('click', () => {
        const scheduleType = item.getAttribute('data-schedule');
        console.log('시간표 선택:', scheduleType);
        if (typeof setManualSchedule === 'function') {
          setManualSchedule(scheduleType);
        }
        if (scheduleModal) {
          scheduleModal.hidden = true;
        }
        // 즉시 시계 업데이트
        if (typeof updateClock === 'function') {
          updateClock();
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!modal.hidden) modal.hidden = true;
        else if (!scheduleModal.hidden) scheduleModal.hidden = true;
        else closeInfoMenu();
      }
    });
  })();