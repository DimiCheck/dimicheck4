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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!modal.hidden) modal.hidden = true;
        else closeInfoMenu();
      }
    });
  })();