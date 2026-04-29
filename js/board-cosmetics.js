(function () {
  const cosmeticsByNumber = Object.create(null);
  const dragTrailState = new WeakMap();
  const DRAG_TRAIL_INTERVAL_MS = 70;
  const MOVE_EFFECT_LIMIT_MS = 240;
  const TRAIL_POINT_LIMIT = 14;
  const TRAIL_PARTICLE_LIMIT = 48;
  const TRAIL_DPR_LIMIT = 1.5;
  const TRAIL_CONFIG = {
    ribbon: { keepMs: 440, baseWidth: 20 },
    fire: { keepMs: 660, baseWidth: 29 },
    neon: { keepMs: 620, baseWidth: 25 },
    comet: { keepMs: 900, baseWidth: 31 }
  };
  let lastMoveEffectAt = 0;
  let trailCanvas = null;
  let trailCtx = null;
  let trailDpr = 1;
  let trailWidth = 0;
  let trailHeight = 0;
  let trailRaf = 0;
  let trailResizeBound = false;
  let trailBudgetScale = 1;
  let lastTrailFrameAt = 0;
  let slowTrailFrameCount = 0;
  const activeTrails = new Map();

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
      : variant === 'supernova'
        ? center.size * 11.4
      : variant === 'starburst'
        ? center.size * 7.6
        : center.size * 5.8;
    makeEffectNode(`board-cosmetic-impact-flare board-cosmetic-impact-flare--${variant}`, center.x, center.y, {
      duration: variant === 'supernova' ? 1240 : variant === 'wormhole' ? 1180 : 980,
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
      : variant === 'supernova'
        ? center.size * 13.2
      : variant === 'starburst'
        ? center.size * 8.5
        : center.size * 6.8;
    makeEffectNode(`board-cosmetic-shockwave board-cosmetic-shockwave--${variant}`, center.x, center.y, {
      duration: variant === 'supernova' ? 1160 : variant === 'wormhole' ? 1050 : 820,
      vars: { '--wave-size': `${size}px` }
    });
    makeEffectNode(`board-cosmetic-shockwave board-cosmetic-shockwave--${variant} board-cosmetic-shockwave--late`, center.x, center.y, {
      duration: variant === 'supernova' ? 1380 : variant === 'wormhole' ? 1260 : 980,
      vars: { '--wave-size': `${size * 0.74}px` }
    });
  }

  function playSupernovaCore(center) {
    if (!center) return;
    makeEffectNode('board-cosmetic-supernova-core', center.x, center.y, {
      duration: 1180,
      vars: { '--supernova-size': `${center.size * 3.2}px` }
    });
    makeEffectNode('board-cosmetic-supernova-rays', center.x, center.y, {
      duration: 1240,
      vars: { '--supernova-ray-size': `${center.size * 8.8}px` }
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

    if (effect === 'move_supernova') {
      playPortal(origin, 'starburst', 'exit');
      playSupernovaCore(destination);
      playImpactFlare(destination, 'supernova');
      playShockwave(destination, 'supernova');
      burstParticles(destination, {
        count: 58,
        color: '#fff4b8',
        spread: 255,
        duration: 1160
      });
      burstParticles(destination, {
        count: 34,
        color: '#79d8ff',
        spread: 220,
        duration: 1240,
        className: 'board-cosmetic-particle board-cosmetic-particle--supernova'
      });
      burstParticles(destination, {
        count: 22,
        color: '#ff7a4f',
        spread: 185,
        duration: 980
      });
    } else if (effect === 'move_blue_swirl') {
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

  function nowMs() {
    return window.performance && typeof window.performance.now === 'function'
      ? window.performance.now()
      : Date.now();
  }

  function ensureTrailCanvas() {
    if (!trailCanvas) {
      trailCanvas = document.createElement('canvas');
      trailCanvas.className = 'board-cosmetic-trail-canvas';
      trailCanvas.setAttribute('aria-hidden', 'true');
      document.body.appendChild(trailCanvas);
    }
    if (!trailCtx) {
      trailCtx = trailCanvas.getContext('2d');
    }
    resizeTrailCanvas();
    if (!trailResizeBound) {
      window.addEventListener('resize', resizeTrailCanvas);
      trailResizeBound = true;
    }
    return trailCtx;
  }

  function resizeTrailCanvas() {
    if (!trailCanvas) return;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    const dpr = Math.min(TRAIL_DPR_LIMIT, Math.max(1, window.devicePixelRatio || 1));
    if (width === trailWidth && height === trailHeight && dpr === trailDpr) return;
    trailWidth = width;
    trailHeight = height;
    trailDpr = dpr;
    trailCanvas.width = Math.max(1, Math.round(width * dpr));
    trailCanvas.height = Math.max(1, Math.round(height * dpr));
    trailCanvas.style.width = `${width}px`;
    trailCanvas.style.height = `${height}px`;
    if (trailCtx) {
      trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function normalizeDragEffect(effect) {
    if (effect === 'drag_fire_trail') return 'fire';
    if (effect === 'drag_neon_afterimage') return 'neon';
    if (effect === 'drag_comet_tail') return 'comet';
    return 'ribbon';
  }

  function getOrCreateTrail(number, effect) {
    let trail = activeTrails.get(number);
    if (!trail) {
      trail = {
        effect,
        points: [],
        particles: [],
        lastSeen: 0,
        lastGhostAt: 0
      };
      activeTrails.set(number, trail);
    }
    trail.effect = effect;
    return trail;
  }

  function trimTrail(trail, now, config) {
    trail.points = trail.points
      .filter((point) => now - point.t <= config.keepMs)
      .slice(-TRAIL_POINT_LIMIT);
    trail.particles = trail.particles.filter((particle) => now - particle.t <= particle.life);
    if (trail.particles.length > TRAIL_PARTICLE_LIMIT) {
      trail.particles.splice(0, trail.particles.length - TRAIL_PARTICLE_LIMIT);
    }
  }

  function unitVector(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length, length };
  }

  function addTrailParticles(trail, point, previousPoint, now) {
    const effect = trail.effect;
    const direction = previousPoint ? unitVector(previousPoint, point) : { x: 1, y: 0, length: 1 };
    const back = { x: -direction.x, y: -direction.y };
    const perp = { x: -direction.y, y: direction.x };
    const speedBoost = Math.min(1.5, Math.max(0.65, direction.length / 24));
    const counts = { ribbon: 1, fire: 3, neon: 1, comet: 2 };
    const count = Math.max(1, Math.round((counts[effect] || 1) * trailBudgetScale));

    for (let i = 0; i < count; i += 1) {
      const side = (Math.random() - 0.5) * (effect === 'comet' ? 38 : effect === 'fire' ? 30 : 22);
      const backSpeed = (effect === 'comet' ? 0.18 : effect === 'fire' ? 0.12 : 0.09) * speedBoost;
      const drift = (Math.random() - 0.5) * (effect === 'fire' ? 0.12 : 0.06);
      const colors = {
        ribbon: ['#ffffff', '#fff2a8', '#ffd15a'],
        fire: ['#fff8b8', '#ffd15a', '#ff7a2f', '#ff351f'],
        neon: ['#ffffff', '#55e9ff', '#ff5cf2'],
        comet: ['#ffffff', '#b9f6ff', '#82b6ff', '#d7b7ff']
      };
      trail.particles.push({
        x: point.x + perp.x * side,
        y: point.y + perp.y * side,
        vx: back.x * (0.08 + Math.random() * backSpeed) + perp.x * drift,
        vy: back.y * (0.08 + Math.random() * backSpeed) + perp.y * drift - (effect === 'fire' ? 0.055 + Math.random() * 0.055 : 0),
        t: now,
        life: effect === 'comet' ? 560 + Math.random() * 260 : effect === 'fire' ? 360 + Math.random() * 220 : 420 + Math.random() * 180,
        size: effect === 'comet' ? 2 + Math.random() * 4.2 : effect === 'fire' ? 2.4 + Math.random() * 5.2 : 1.8 + Math.random() * 3.2,
        color: colors[effect][Math.floor(Math.random() * colors[effect].length)],
        spin: Math.random() * Math.PI
      });
    }
  }

  function scheduleTrailFrame() {
    if (trailRaf) return;
    trailRaf = window.requestAnimationFrame(renderTrailFrame);
  }

  function drawTrailLayer(ctx, points, now, config, options) {
    if (points.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = options.composite || 'source-over';
    ctx.shadowColor = options.shadowColor || options.color;
    ctx.shadowBlur = options.blur || 0;

    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const point = points[i];
      const age = Math.max(0, Math.min(1, (now - point.t) / config.keepMs));
      const position = i / Math.max(1, points.length - 1);
      const alpha = options.alpha * (1 - age) * (0.18 + position * 0.82);
      if (alpha <= 0.02) continue;
      const width = options.width * (0.24 + position * 0.96) * (1 - age * 0.52);
      const wobble = options.wobble && trailBudgetScale > 0.72
        ? Math.sin(point.t * 0.045 + i * 1.7) * options.wobble * (1 - position * 0.35)
        : 0;
      const direction = unitVector(prev, point);
      const controlX = prev.x + (-direction.y * wobble);
      const controlY = prev.y + (direction.x * wobble);

      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(1, width);
      ctx.strokeStyle = typeof options.color === 'function'
        ? options.color(position, age, i)
        : options.color;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.quadraticCurveTo(controlX, controlY, point.x, point.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTrailShape(ctx, trail, now) {
    const config = TRAIL_CONFIG[trail.effect] || TRAIL_CONFIG.ribbon;
    const points = trail.points;
    if (trail.effect === 'fire') {
      drawTrailLayer(ctx, points, now, config, {
        width: config.baseWidth * 2.3,
        color: 'rgba(255, 58, 24, 0.34)',
        shadowColor: 'rgba(255, 72, 24, 0.8)',
        blur: 18,
        alpha: 0.8,
        wobble: 12,
        composite: 'lighter'
      });
      drawTrailLayer(ctx, points, now, config, {
        width: config.baseWidth * 1.12,
        color: (position) => position > 0.72 ? '#fff7b0' : position > 0.42 ? '#ffd15a' : '#ff5a24',
        shadowColor: '#ff7a2f',
        blur: 7,
        alpha: 0.95,
        wobble: 8,
        composite: 'lighter'
      });
      return;
    }

    if (trail.effect === 'comet') {
      drawTrailLayer(ctx, points, now, config, {
        width: config.baseWidth * 2.6,
        color: 'rgba(95, 190, 255, 0.3)',
        shadowColor: 'rgba(111, 206, 255, 0.9)',
        blur: 20,
        alpha: 0.82,
        wobble: 4,
        composite: 'lighter'
      });
      drawTrailLayer(ctx, points, now, config, {
        width: config.baseWidth * 1.28,
        color: (position) => position > 0.78 ? '#ffffff' : position > 0.42 ? '#b8f4ff' : '#8a9bff',
        shadowColor: '#8ddfff',
        blur: 9,
        alpha: 0.92,
        wobble: 2,
        composite: 'lighter'
      });
      if (trailBudgetScale > 0.74) {
        drawTrailLayer(ctx, points, now, config, {
          width: config.baseWidth * 0.38,
          color: '#ffffff',
          shadowColor: '#ffffff',
          blur: 4,
          alpha: 0.94,
          composite: 'lighter'
        });
      }
      return;
    }

    if (trail.effect === 'neon') {
      drawTrailLayer(ctx, points, now, config, {
        width: config.baseWidth * 1.9,
        color: 'rgba(80, 229, 255, 0.35)',
        shadowColor: '#55e9ff',
        blur: 14,
        alpha: 0.76,
        composite: 'lighter'
      });
      drawTrailLayer(ctx, points, now, config, {
        width: config.baseWidth * 0.92,
        color: (position) => position > 0.5 ? '#ff5cf2' : '#55e9ff',
        shadowColor: '#ff5cf2',
        blur: 7,
        alpha: 0.9,
        composite: 'lighter'
      });
      return;
    }

    drawTrailLayer(ctx, points, now, config, {
      width: config.baseWidth * 1.6,
      color: 'rgba(255, 240, 160, 0.38)',
      shadowColor: '#fff2a8',
      blur: 11,
      alpha: 0.72,
      composite: 'lighter'
    });
    drawTrailLayer(ctx, points, now, config, {
      width: config.baseWidth * 0.72,
      color: '#fff8c8',
      shadowColor: '#ffffff',
      blur: 4,
      alpha: 0.82,
      composite: 'lighter'
    });
  }

  function drawSpark(ctx, x, y, size, alpha, color, spin) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, size * 0.34);
    ctx.shadowColor = color;
    ctx.shadowBlur = trailBudgetScale > 0.74 ? size * 1.4 : 0;
    ctx.beginPath();
    ctx.moveTo(-size, 0);
    ctx.lineTo(size, 0);
    ctx.moveTo(0, -size);
    ctx.lineTo(0, size);
    ctx.stroke();
    ctx.restore();
  }

  function drawTrailParticles(ctx, trail, now) {
    trail.particles.forEach((particle) => {
      const age = (now - particle.t) / particle.life;
      if (age < 0 || age > 1) return;
      const x = particle.x + particle.vx * (now - particle.t);
      const y = particle.y + particle.vy * (now - particle.t) + (trail.effect === 'fire' ? Math.sin(age * 8 + particle.spin) * 10 : 0);
      const alpha = (1 - age) * (trail.effect === 'fire' ? (0.5 + Math.sin(age * Math.PI) * 0.5) : 1);
      if (trail.effect === 'comet' && age > 0.2 && Math.random() < 0.3 * trailBudgetScale) {
        drawSpark(ctx, x, y, particle.size * (1 - age * 0.42), alpha, particle.color, particle.spin + age * 2);
        return;
      }

      const radius = particle.size * (1 - age * 0.55);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = particle.color;
      ctx.shadowBlur = trailBudgetScale > 0.7 ? radius * 1.8 : 0;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  function renderTrailFrame() {
    trailRaf = 0;
    const ctx = ensureTrailCanvas();
    if (!ctx) return;
    const now = nowMs();
    if (lastTrailFrameAt) {
      const delta = now - lastTrailFrameAt;
      if (delta > 28) {
        slowTrailFrameCount += 1;
      } else {
        slowTrailFrameCount = Math.max(0, slowTrailFrameCount - 1);
      }
      if (slowTrailFrameCount >= 4) {
        trailBudgetScale = Math.max(0.55, trailBudgetScale - 0.12);
        slowTrailFrameCount = 0;
      } else if (delta < 20 && trailBudgetScale < 1) {
        trailBudgetScale = Math.min(1, trailBudgetScale + 0.025);
      }
    }
    lastTrailFrameAt = now;
    ctx.clearRect(0, 0, trailWidth, trailHeight);

    activeTrails.forEach((trail, number) => {
      const config = TRAIL_CONFIG[trail.effect] || TRAIL_CONFIG.ribbon;
      trimTrail(trail, now, config);
      drawTrailShape(ctx, trail, now);
      drawTrailParticles(ctx, trail, now);
      const stillAlive = trail.points.length > 1 || trail.particles.length > 0 || now - trail.lastSeen < config.keepMs;
      if (!stillAlive) {
        activeTrails.delete(number);
      }
    });

    if (activeTrails.size) {
      scheduleTrailFrame();
    } else {
      ctx.clearRect(0, 0, trailWidth, trailHeight);
      lastTrailFrameAt = 0;
      slowTrailFrameCount = 0;
    }
  }

  function emitDragTrail(magnet, clientX, clientY) {
    const equipment = getEquipmentForMagnet(magnet);
    const rawEffect = equipment?.drag_effect;
    if (!rawEffect) return;
    const now = nowMs();
    const last = dragTrailState.get(magnet) || 0;
    if (now - last < DRAG_TRAIL_INTERVAL_MS) return;
    dragTrailState.set(magnet, now);

    const number = getMagnetNumber(magnet);
    if (!number) return;
    const rect = magnet.getBoundingClientRect();
    const point = {
      x: Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2,
      y: Number.isFinite(clientY) ? clientY : rect.top + rect.height / 2,
      t: now
    };
    const effect = normalizeDragEffect(rawEffect);
    const config = TRAIL_CONFIG[effect] || TRAIL_CONFIG.ribbon;
    ensureTrailCanvas();
    const trail = getOrCreateTrail(number, effect);
    const previousPoint = trail.points[trail.points.length - 1] || null;
    if (previousPoint && Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y) < 3) {
      return;
    }
    trail.points.push(point);
    trail.lastSeen = now;
    trimTrail(trail, now, config);
    addTrailParticles(trail, point, previousPoint, now);

    if ((effect === 'neon' || effect === 'fire') && trailBudgetScale > 0.68 && now - trail.lastGhostAt > 190) {
      makeGhost(magnet, point.x, point.y, effect);
      trail.lastGhostAt = now;
    }

    scheduleTrailFrame();
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
