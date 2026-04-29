(function () {
  const cosmeticsByNumber = Object.create(null);
  const dragTrailState = new WeakMap();
  const DRAG_TRAIL_INTERVAL_MS = 54;
  const MOVE_EFFECT_LIMIT_MS = 240;
  let lastMoveEffectAt = 0;

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

  function getCenterFromMagnet(magnet) {
    const rect = magnet.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      size: Math.max(rect.width, rect.height),
      width: rect.width,
      height: rect.height
    };
  }

  function captureMoveOrigin(magnet) {
    if (!magnet) return null;
    return getCenterFromMagnet(magnet);
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

  function makeEffectNode(className, x, y, options = {}) {
    const node = document.createElement('span');
    node.className = className;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    Object.entries(options.vars || {}).forEach(([key, value]) => {
      node.style.setProperty(key, value);
    });
    if (options.text) {
      node.textContent = options.text;
    }
    document.body.appendChild(node);
    const duration = Number(options.duration || 900);
    window.setTimeout(() => {
      node.remove();
    }, duration + 120);
    return node;
  }

  function burstParticles(center, options = {}) {
    const count = Number(options.count || 20);
    const color = options.color || '#ffd15a';
    const spread = Number(options.spread || 110);
    const className = options.className || 'board-cosmetic-particle board-cosmetic-particle--spark';
    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.42;
      const distance = spread * (0.42 + Math.random() * 0.68);
      makeEffectNode(className, center.x, center.y, {
        duration: options.duration || 820,
        vars: {
          '--particle-color': color,
          '--dx': `${Math.cos(angle) * distance}px`,
          '--dy': `${Math.sin(angle) * distance}px`,
          '--spin': `${Math.random() * 260 - 130}deg`
        }
      });
    }
  }

  function playImpactFlare(center, variant) {
    if (!center) return;
    const size = variant === 'wormhole'
      ? center.size * 9.2
      : variant === 'starburst'
        ? center.size * 7.6
        : center.size * 5.8;
    makeEffectNode(`board-cosmetic-impact-flare board-cosmetic-impact-flare--${variant}`, center.x, center.y, {
      duration: variant === 'wormhole' ? 1180 : 980,
      vars: { '--flare-size': `${size}px` }
    });
  }

  function playPortal(center, variant, phase) {
    if (!center) return;
    const isBlue = variant === 'wormhole';
    makeEffectNode(
      `board-cosmetic-portal board-cosmetic-portal--${isBlue ? 'wormhole' : 'starburst'} board-cosmetic-portal--${phase}`,
      center.x,
      center.y,
      {
        duration: isBlue ? 1120 : 900,
        vars: {
          '--portal-size': `${isBlue ? center.size * 8.4 : center.size * 6.8}px`
        }
      }
    );
  }

  function playShockwave(center, variant) {
    if (!center) return;
    const size = variant === 'wormhole'
      ? center.size * 10.4
      : variant === 'starburst'
        ? center.size * 8.5
        : center.size * 6.8;
    makeEffectNode(`board-cosmetic-shockwave board-cosmetic-shockwave--${variant}`, center.x, center.y, {
      duration: variant === 'wormhole' ? 1050 : 820,
      vars: { '--wave-size': `${size}px` }
    });
    makeEffectNode(`board-cosmetic-shockwave board-cosmetic-shockwave--${variant} board-cosmetic-shockwave--late`, center.x, center.y, {
      duration: variant === 'wormhole' ? 1260 : 980,
      vars: { '--wave-size': `${size * 0.74}px` }
    });
  }

  function playLightning(center) {
    if (!center) return;
    makeEffectNode('board-cosmetic-lightning', center.x, center.y - center.size * 0.45, {
      duration: 620,
      text: '⚡'
    });
  }

  function playMoveEffect(magnet, action, options = {}) {
    const equipment = getEquipmentForMagnet(magnet);
    const effect = equipment?.move_effect;
    if (!effect) return;

    const now = Date.now();
    if (now - lastMoveEffectAt < MOVE_EFFECT_LIMIT_MS) {
      return;
    }
    lastMoveEffectAt = now;

    const origin = options.origin || null;
    const destination = getCenterFromMagnet(magnet);

    if (effect === 'move_blue_swirl') {
      playPortal(origin, 'wormhole', 'exit');
      playPortal(destination, 'wormhole', 'enter');
      playImpactFlare(destination, 'wormhole');
      playShockwave(destination, 'wormhole');
      burstParticles(destination, {
        count: 46,
        color: '#54c7ff',
        spread: 235,
        duration: 1180,
        className: 'board-cosmetic-particle board-cosmetic-particle--wormhole'
      });
      burstParticles(destination, {
        count: 18,
        color: '#ffffff',
        spread: 150,
        duration: 860
      });
    } else if (effect === 'move_stardust') {
      playPortal(origin, 'starburst', 'exit');
      playImpactFlare(destination, 'starburst');
      playShockwave(destination, 'starburst');
      playLightning(destination);
      burstParticles(destination, {
        count: 48,
        color: '#ffd15a',
        spread: 205,
        duration: 1040
      });
      burstParticles(destination, {
        count: 16,
        color: '#ffffff',
        spread: 118,
        duration: 760
      });
    } else {
      playImpactFlare(destination, 'basic');
      playShockwave(destination, 'basic');
      burstParticles(destination, {
        count: 30,
        color: '#fff2a8',
        spread: 135,
        duration: 820
      });
    }

    magnet.classList.add('magnet-cosmetic-impact-pop');
    if (action === 'classroom') {
      magnet.classList.add('magnet-cosmetic-return-pop');
    }
    window.setTimeout(() => {
      magnet.classList.remove('magnet-cosmetic-impact-pop', 'magnet-cosmetic-return-pop');
    }, 520);
  }

  function makeGhost(magnet, x, y, effect) {
    const rect = magnet.getBoundingClientRect();
    const ghost = makeEffectNode(
      `board-cosmetic-drag-ghost board-cosmetic-drag-ghost--${effect}`,
      x,
      y,
      {
        duration: effect === 'neon' ? 620 : 520,
        text: magnet.dataset.number || ''
      }
    );
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
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

    if (effect === 'drag_fire_trail') {
      makeEffectNode('board-cosmetic-trail board-cosmetic-trail--fire', x, y, { duration: 760 });
      makeEffectNode('board-cosmetic-fire-pop', x + (Math.random() * 26 - 13), y + (Math.random() * 24 - 12), {
        duration: 680
      });
      makeGhost(magnet, x, y, 'fire');
      return;
    }

    if (effect === 'drag_neon_afterimage') {
      makeEffectNode('board-cosmetic-trail board-cosmetic-trail--neon', x, y, { duration: 860 });
      makeGhost(magnet, x, y, 'neon');
      makeEffectNode('board-cosmetic-neon-star', x, y, { duration: 760 });
      return;
    }

    makeEffectNode('board-cosmetic-trail board-cosmetic-trail--ribbon', x, y, { duration: 640 });
    makeGhost(magnet, x, y, 'ribbon');
  }

  window.boardCosmetics = {
    load: loadBoardCosmetics,
    applySnapshot: setCosmeticsSnapshot,
    applyUpdate: applyCosmeticsUpdate,
    applyAllAuras,
    applyAuraToMagnet,
    captureMoveOrigin,
    playMoveEffect,
    emitDragTrail
  };
  window.loadBoardCosmetics = loadBoardCosmetics;
})();
