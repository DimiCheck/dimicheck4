(function () {
  const cosmeticsByNumber = Object.create(null);
  const dragTrailState = new WeakMap();
  const MAX_PARTICLES_PER_EFFECT = 14;
  const DRAG_TRAIL_INTERVAL_MS = 72;

  function normalizeNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1 || number > 99) return null;
    return String(number);
  }

  function normalizeEquipment(equipment) {
    if (!equipment || typeof equipment !== 'object') {
      return { move_effect: null, drag_effect: null, aura_effect: null };
    }
    return {
      move_effect: equipment.move_effect || null,
      drag_effect: equipment.drag_effect || null,
      aura_effect: equipment.aura_effect || null
    };
  }

  function getMagnetNumber(magnet) {
    return normalizeNumber(magnet?.dataset?.number);
  }

  function getEquipmentForMagnet(magnet) {
    const number = getMagnetNumber(magnet);
    if (!number) return null;
    return cosmeticsByNumber[number] || null;
  }

  function setCosmeticsSnapshot(snapshot) {
    Object.keys(cosmeticsByNumber).forEach((key) => {
      delete cosmeticsByNumber[key];
    });
    if (snapshot && typeof snapshot === 'object') {
      Object.entries(snapshot).forEach(([number, equipment]) => {
        const normalizedNumber = normalizeNumber(number);
        if (!normalizedNumber) return;
        cosmeticsByNumber[normalizedNumber] = normalizeEquipment(equipment);
      });
    }
    applyAllAuras();
  }

  function applyCosmeticsUpdate(studentNumber, equipment) {
    const number = normalizeNumber(studentNumber);
    if (!number) return;
    const normalized = normalizeEquipment(equipment);
    if (!normalized.move_effect && !normalized.drag_effect && !normalized.aura_effect) {
      delete cosmeticsByNumber[number];
    } else {
      cosmeticsByNumber[number] = normalized;
    }
    applyAuraToMagnet(document.querySelector(`.magnet[data-number="${number}"]:not(.placeholder)`));
  }

  async function loadBoardCosmetics() {
    const grade = window.boardGrade;
    const section = window.boardSection;
    if (!grade || !section) return;
    try {
      const res = await fetch(`/api/classes/cosmetics?grade=${grade}&section=${section}`, {
        credentials: 'include',
        cache: 'no-store'
      });
      if (!res.ok) {
        console.warn('[board cosmetics] load failed', res.status);
        return;
      }
      const payload = await res.json();
      setCosmeticsSnapshot(payload?.cosmetics || {});
    } catch (error) {
      console.warn('[board cosmetics] load failed', error);
    }
  }

  function applyAllAuras() {
    document.querySelectorAll('.magnet:not(.placeholder)').forEach(applyAuraToMagnet);
  }

  function applyAuraToMagnet(magnet) {
    if (!magnet) return;
    const equipment = getEquipmentForMagnet(magnet);
    const aura = equipment?.aura_effect || '';
    magnet.classList.toggle('magnet-cosmetic-aura-soft-glow', aura === 'aura_soft_glow');
    if (aura) {
      magnet.dataset.cosmeticAura = aura;
    } else {
      delete magnet.dataset.cosmeticAura;
    }
  }

  function getCenterFromMagnet(magnet) {
    const rect = magnet.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      size: Math.max(rect.width, rect.height)
    };
  }

  function makeParticle(x, y, className, options = {}) {
    const particle = document.createElement('span');
    particle.className = className;
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    if (options.color) {
      particle.style.setProperty('--particle-color', options.color);
    }
    if (options.dx !== undefined) {
      particle.style.setProperty('--dx', `${options.dx}px`);
    }
    if (options.dy !== undefined) {
      particle.style.setProperty('--dy', `${options.dy}px`);
    }
    document.body.appendChild(particle);
    const duration = Number(options.duration || 680);
    window.setTimeout(() => {
      particle.remove();
    }, duration + 80);
    return particle;
  }

  function playMoveEffect(magnet, action) {
    const equipment = getEquipmentForMagnet(magnet);
    const effect = equipment?.move_effect;
    if (!effect) return;
    const center = getCenterFromMagnet(magnet);
    const count = effect === 'move_blue_swirl' ? 10 : MAX_PARTICLES_PER_EFFECT;
    const color = effect === 'move_blue_swirl' ? '#55b9ff' : effect === 'move_stardust' ? '#ffd15a' : '#fff2a8';
    const className = effect === 'move_blue_swirl'
      ? 'board-cosmetic-particle board-cosmetic-particle--swirl'
      : 'board-cosmetic-particle board-cosmetic-particle--spark';

    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.35;
      const distance = 24 + Math.random() * (effect === 'move_blue_swirl' ? 44 : 34);
      makeParticle(center.x, center.y, className, {
        color,
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance,
        duration: effect === 'move_blue_swirl' ? 760 : 620
      });
    }

    if (action === 'classroom') {
      magnet.classList.add('magnet-cosmetic-return-pop');
      window.setTimeout(() => {
        magnet.classList.remove('magnet-cosmetic-return-pop');
      }, 360);
    }
  }

  function emitDragTrail(magnet, clientX, clientY) {
    const equipment = getEquipmentForMagnet(magnet);
    const effect = equipment?.drag_effect;
    if (!effect) return;
    const now = Date.now();
    const last = dragTrailState.get(magnet) || 0;
    if (now - last < DRAG_TRAIL_INTERVAL_MS) return;
    dragTrailState.set(magnet, now);

    const rect = magnet.getBoundingClientRect();
    const x = Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2;
    const y = Number.isFinite(clientY) ? clientY : rect.top + rect.height / 2;
    const className = [
      'board-cosmetic-trail',
      effect === 'drag_fire_trail' ? 'board-cosmetic-trail--fire' : '',
      effect === 'drag_neon_afterimage' ? 'board-cosmetic-trail--neon' : ''
    ].filter(Boolean).join(' ');
    makeParticle(x, y, className, {
      duration: effect === 'drag_neon_afterimage' ? 560 : 460
    });
  }

  window.boardCosmetics = {
    load: loadBoardCosmetics,
    applySnapshot: setCosmeticsSnapshot,
    applyUpdate: applyCosmeticsUpdate,
    applyAllAuras,
    applyAuraToMagnet,
    playMoveEffect,
    emitDragTrail
  };
  window.loadBoardCosmetics = loadBoardCosmetics;
})();
