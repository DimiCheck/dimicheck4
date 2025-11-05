/* ===================== 고정 격자 좌표/자리표 ===================== */
const gridPos = {};                  // 번호 -> {left, top}
const placeholders = new Map();      // 번호 -> 자리표 엘리먼트
var isfired = 0;
window.isMagnetDragging = false;
window.isAutoReturning = false;
window.isRoutineApplying = false;

const LONG_PRESS_DELAY = 600;        // ms before quick menu opens
const DRAG_MOVE_THRESHOLD = 8;       // px movement before drag kicks in

const MAGNET_MENU_OPTIONS = [
  { label: '교실', value: 'classroom' },
  { label: '화장실(물)', value: 'toilet' },
  { label: '복도', value: 'hallway' },
  { label: '동아리', value: 'club' },
  { label: '방과후', value: 'afterschool' },
  { label: '프로젝트', value: 'project' },
  { label: '조기입실', value: 'early' },
  { label: '기타', value: 'etc' },
  { label: '결석(조퇴)', value: 'absence' }
];

const thoughtBubbleRegistry = new Map(); // number -> { element, timeoutId, expiresAt, text }

function ensureThoughtLayer() {
  let layer = document.getElementById('thoughtLayer');
  if (!layer) {
    const container = document.getElementById('magnetContainer');
    if (!container || !container.parentElement) {
      return null;
    }
    layer = document.createElement('div');
    layer.id = 'thoughtLayer';
    layer.className = 'thought-layer';
    container.parentElement.insertBefore(layer, container.nextSibling);
  }
  return layer;
}

function positionThoughtBubble(magnet, bubble) {
  const layer = ensureThoughtLayer();
  if (!layer || !magnet || !bubble) return;
  const magnetRect = magnet.getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  const x = magnetRect.left + magnetRect.width / 2 - layerRect.left;
  const y = magnetRect.top - layerRect.top - 14;
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
}

function updateThoughtBubblePositionForMagnet(magnet) {
  if (!magnet) return;
  const number = magnet.dataset.number;
  if (!number) return;
  const entry = thoughtBubbleRegistry.get(number);
  if (!entry || !entry.element) return;
  positionThoughtBubble(magnet, entry.element);
}

function repositionThoughtBubbles() {
  thoughtBubbleRegistry.forEach((entry, number) => {
    if (!entry || !entry.element) return;
    const magnet = document.querySelector(`.magnet[data-number="${number}"]`);
    if (magnet) {
      positionThoughtBubble(magnet, entry.element);
    }
  });
}

window.repositionThoughtBubbles = repositionThoughtBubbles;
['resize', 'scroll'].forEach(eventName => {
  window.addEventListener(eventName, () => {
    window.requestAnimationFrame(repositionThoughtBubbles);
  }, { passive: true });
});

function removeThoughtBubbleForNumber(number) {
  const entry = thoughtBubbleRegistry.get(number);
  if (!entry) return;
  thoughtBubbleRegistry.delete(number);
  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }
  if (entry.element && entry.element.parentNode) {
    entry.element.remove();
  }
}

function ensureThoughtBubble(magnet, text, expiresAtValue) {
  if (!magnet) return;
  const number = magnet.dataset.number;
  if (!number) return;

  const sanitized = String(text || '').trim();
  if (!sanitized) {
    removeThoughtBubbleForNumber(number);
    return;
  }

  let expiresAtMs;
  if (typeof expiresAtValue === 'number') {
    expiresAtMs = expiresAtValue;
  } else if (expiresAtValue) {
    expiresAtMs = Date.parse(expiresAtValue);
  } else {
    expiresAtMs = NaN;
  }
  if (Number.isNaN(expiresAtMs)) {
    expiresAtMs = Date.now() + 5000;
  }

  const now = Date.now();
  if (expiresAtMs <= now) {
    removeThoughtBubbleForNumber(number);
    return;
  }

  let entry = thoughtBubbleRegistry.get(number);
  if (!entry) {
    const layer = ensureThoughtLayer();
    if (!layer) return;
    const bubble = document.createElement('div');
    bubble.className = 'thought-bubble';
    layer.appendChild(bubble);
    entry = { element: bubble, timeoutId: null, expiresAt: 0, text: '' };
    thoughtBubbleRegistry.set(number, entry);
  }

  const bubble = entry.element;
  if (!bubble) return;

  if (entry.text !== sanitized) {
    bubble.textContent = sanitized;
    entry.text = sanitized;
  }

  entry.expiresAt = expiresAtMs;
  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }
  entry.timeoutId = window.setTimeout(() => {
    removeThoughtBubbleForNumber(number);
  }, Math.max(0, expiresAtMs - now));

  positionThoughtBubble(magnet, bubble);
}

function updateMagnetThoughtBubble(magnet, data) {
  if (!magnet) return;
  const number = magnet.dataset.number;
  if (!number) return;

  const payload = (data && typeof data === 'object') ? data : null;
  const text = payload ? payload.thought : null;
  if (!text) {
    removeThoughtBubbleForNumber(number);
    return;
  }

  ensureThoughtBubble(magnet, text, payload ? payload.thoughtExpiresAt : undefined);
}

window.updateMagnetThoughtBubble = updateMagnetThoughtBubble;
window.updateThoughtBubblePositionForMagnet = updateThoughtBubblePositionForMagnet;

let magnetMenuOverlay = null;
let magnetMenuPanel = null;
let magnetMenuCurrentTarget = null;
let magnetMenuKeydownBound = false;

const magnetGroup = {
  leader: null,
  pointerId: null,
  members: [],
  offsets: new Map(),
  originals: new Map(),
  badge: null,
  active: false
};

function cancelActiveLongPress(target) {
  if (!target) return;
  const cancelFn = target.__cancelLongPress;
  if (typeof cancelFn === 'function') {
    cancelFn();
  }
}

function clearMagnetGroup(options = {}) {
  const { restore = false } = options;
  const leader = magnetGroup.leader;
  const members = magnetGroup.members.slice();
  const allMagnets = leader ? [leader, ...members] : members;

  if (magnetGroup.badge) {
    magnetGroup.badge.remove();
    magnetGroup.badge = null;
  }

  cancelActiveLongPress(leader);

  if (restore) {
    allMagnets.forEach(restoreMagnetState);
  }

  if (leader) {
    leader.classList.remove('magnet-group-leader');
    leader.style.zIndex = '';
  }
  members.forEach(member => {
    member.classList.remove('magnet-group-member');
    member.style.zIndex = '';
  });

  magnetGroup.leader = null;
  magnetGroup.pointerId = null;
  magnetGroup.members = [];
  magnetGroup.offsets = new Map();
  magnetGroup.originals = new Map();
  magnetGroup.active = false;
}

function updateGroupBadge() {
  if (!magnetGroup.leader) return;
  if (magnetGroup.badge) {
    magnetGroup.badge.remove();
    magnetGroup.badge = null;
  }
  const total = magnetGroup.members.length + 1;
  if (total <= 1) return;
  const badge = document.createElement('div');
  badge.className = 'magnet-group-badge';
  badge.textContent = total;
  magnetGroup.leader.appendChild(badge);
  magnetGroup.badge = badge;
}

function startMagnetGroup(leader, pointerId) {
  clearMagnetGroup({ restore: true });
  magnetGroup.leader = leader;
  magnetGroup.pointerId = pointerId;
  magnetGroup.members = [];
  magnetGroup.offsets = new Map();
  magnetGroup.originals = new Map();
  magnetGroup.active = true;
  storeOriginalState(leader);
  leader.classList.add('magnet-group-leader');
  leader.style.zIndex = '1200';
  updateGroupBadge();
}

function storeOriginalState(magnet) {
  if (!magnet || magnetGroup.originals.has(magnet)) return;
  magnetGroup.originals.set(magnet, {
    parent: magnet.parentElement,
    nextSibling: magnet.nextSibling,
    attached: magnet.classList.contains('attached'),
    left: magnet.style.left || '',
    top: magnet.style.top || ''
  });
}

function restoreMagnetState(magnet) {
  const snapshot = magnetGroup.originals.get(magnet);
  if (!snapshot) return;
  const { parent, nextSibling, attached, left, top } = snapshot;
  if (parent) {
    if (nextSibling && nextSibling.parentElement === parent) {
      parent.insertBefore(magnet, nextSibling);
    } else {
      parent.appendChild(magnet);
    }
  }
  if (attached) {
    magnet.classList.add('attached');
  } else {
    magnet.classList.remove('attached');
  }
  magnet.style.left = left;
  magnet.style.top = top;
  magnet.style.transform = 'translate(0,0)';
}

function getMagnetPosition(el) {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  if (!Number.isNaN(left) && !Number.isNaN(top)) {
    return { left, top };
  }
  const container = document.getElementById('magnetContainer');
  if (!container) return { left: 0, top: 0 };
  const rect = el.getBoundingClientRect();
  const crect = container.getBoundingClientRect();
  return { left: rect.left - crect.left, top: rect.top - crect.top };
}

function setMagnetPosition(el, left, top) {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.transform = 'translate(0,0)';
  if (typeof window.updateThoughtBubblePositionForMagnet === 'function') {
    window.updateThoughtBubblePositionForMagnet(el);
  }
}

function addMagnetToGroup(magnet) {
  if (!magnetGroup.leader || magnet === magnetGroup.leader) return;
  if (magnetGroup.members.includes(magnet)) return;
  const container = document.getElementById('magnetContainer');
  if (!container) return;

  cancelActiveLongPress(magnetGroup.leader);
  storeOriginalState(magnet);

  magnet.classList.remove('attached');
  magnet.classList.add('magnet-group-member');
  if (magnet.parentElement !== container) {
    container.appendChild(magnet);
  }
  const offsetIndex = magnetGroup.members.length + 1;
  const offset = { dx: offsetIndex * 6, dy: offsetIndex * 8 };
  magnetGroup.members.push(magnet);
  magnetGroup.offsets.set(magnet, offset);
  magnet.style.zIndex = String(1200 - offsetIndex);
  updateGroupFollowerPositions(magnetGroup.leader);
  updateGroupBadge();
}

function updateGroupFollowerPositions(leader) {
  if (magnetGroup.leader !== leader) return;
  const leaderPos = getMagnetPosition(leader);
  magnetGroup.members.forEach((member, index) => {
    const offset = magnetGroup.offsets.get(member) || { dx: (index + 1) * 6, dy: (index + 1) * 8 };
    setMagnetPosition(member, leaderPos.left + offset.dx, leaderPos.top + offset.dy);
  });
}

function getGroupedMagnets(includeLeader = true) {
  if (!magnetGroup.leader) return [];
  const others = magnetGroup.members.slice();
  return includeLeader ? [magnetGroup.leader, ...others] : others;
}
function ensureMagnetQuickMenuElements() {
  if (magnetMenuOverlay && magnetMenuPanel) {
    return magnetMenuOverlay;
  }

  magnetMenuOverlay = document.createElement('div');
  magnetMenuOverlay.id = 'magnetQuickMenuOverlay';
  magnetMenuOverlay.className = 'magnet-quick-menu-overlay';
  magnetMenuOverlay.hidden = true;

  magnetMenuPanel = document.createElement('div');
  magnetMenuPanel.className = 'magnet-quick-menu';
  magnetMenuPanel.setAttribute('role', 'menu');
  magnetMenuOverlay.appendChild(magnetMenuPanel);

  MAGNET_MENU_OPTIONS.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'magnet-quick-menu__item';
    btn.dataset.action = opt.value;
    btn.setAttribute('role', 'menuitem');
    btn.textContent = opt.label;
    magnetMenuPanel.appendChild(btn);
  });

  magnetMenuOverlay.addEventListener('click', (event) => {
    if (event.target === magnetMenuOverlay) {
      closeMagnetQuickMenu();
    }
  });

  magnetMenuPanel.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    event.stopPropagation();
    handleMagnetQuickMenuSelect(btn.dataset.action);
  });

  if (!magnetMenuKeydownBound) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && magnetMenuOverlay && !magnetMenuOverlay.hidden) {
        closeMagnetQuickMenu();
      }
    });
    magnetMenuKeydownBound = true;
  }

  document.body.appendChild(magnetMenuOverlay);
  return magnetMenuOverlay;
}

function positionMagnetQuickMenu(x, y) {
  if (!magnetMenuPanel) return;

  const offset = 12;
  const { innerWidth, innerHeight } = window;

  // Force layout to get accurate size
  const panelRect = magnetMenuPanel.getBoundingClientRect();
  let left = x + offset;
  let top = y + offset;

  if (left + panelRect.width > innerWidth - offset) {
    left = innerWidth - panelRect.width - offset;
  }
  if (top + panelRect.height > innerHeight - offset) {
    top = innerHeight - panelRect.height - offset;
  }
  if (left < offset) left = offset;
  if (top < offset) top = offset;

  magnetMenuPanel.style.left = `${left}px`;
  magnetMenuPanel.style.top = `${top}px`;
}

function openMagnetQuickMenu(target, origin) {
  clearMagnetGroup({ restore: true });
  const overlay = ensureMagnetQuickMenuElements();
  magnetMenuCurrentTarget = target;
  overlay.hidden = false;

  const { clientX = 0, clientY = 0 } = origin || {};
  positionMagnetQuickMenu(clientX, clientY);

  const currentAction = resolveMagnetQuickMenuState(target);
  highlightMagnetQuickMenuSelection(currentAction);

  const firstButton = magnetMenuPanel.querySelector('button');
  if (firstButton) {
    firstButton.focus({ preventScroll: true });
  }
}

function closeMagnetQuickMenu() {
  if (magnetMenuOverlay) {
    magnetMenuOverlay.hidden = true;
  }
  magnetMenuCurrentTarget = null;
}

function handleMagnetQuickMenuSelect(action) {
  const target = magnetMenuCurrentTarget;
  closeMagnetQuickMenu();
  if (!target) return;
  applyMagnetQuickAction(target, action);
}

function applyMagnetQuickAction(target, action, options = {}) {
  const container = document.getElementById('magnetContainer');
  if (!container || !target) return;

  const { skipSave = false, deferReasonDialog = false } = options;

  if (action === 'classroom') {
    target.classList.remove('attached');
    container.appendChild(target);
    snapToHome(target);
    if (target.dataset.reason) {
      delete target.dataset.reason;
      target.classList.remove('has-reason');
    }
  } else {
    const sectionEl = document.querySelector(`.board-section[data-category="${action}"] .section-content`);
    if (!sectionEl) return;

    target.classList.add('attached');
    target.style.left = '';
    target.style.top = '';
    target.style.transform = '';
    sectionEl.appendChild(target);
    sortSection(sectionEl);

    if (action === 'etc') {
      if (!target.dataset.reason && !deferReasonDialog) {
        openReasonDialog(target);
      }
    } else if (target.dataset.reason) {
      delete target.dataset.reason;
      target.classList.remove('has-reason');
    }
  }

  updateAttendance();
  updateMagnetOutline();
  updateEtcReasonPanel();
  if (typeof window.updateThoughtBubblePositionForMagnet === 'function') {
    window.updateThoughtBubblePositionForMagnet(target);
  }
  if (!skipSave) {
    saveState(grade, section);
  }
}

function resolveMagnetQuickMenuState(target) {
  if (!target) return 'classroom';
  if (!target.classList.contains('attached')) {
    return 'classroom';
  }
  const section = target.closest('.board-section');
  if (!section) return 'classroom';
  return section.dataset.category || 'classroom';
}

function highlightMagnetQuickMenuSelection(action) {
  if (!magnetMenuPanel) return;
  const items = magnetMenuPanel.querySelectorAll('.magnet-quick-menu__item');
  items.forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.action === action);
  });
}

function returnCategoryToClassroom(category) {
  const sectionEl = document.querySelector(`.board-section[data-category="${category}"] .section-content`);
  const container = document.getElementById('magnetContainer');
  if (!sectionEl || !container) return 0;

  const magnets = Array.from(sectionEl.querySelectorAll('.magnet'));
  if (!magnets.length) {
    return 0;
  }

  window.isAutoReturning = true;

  magnets.forEach(magnet => {
    magnet.classList.remove('attached');
    container.appendChild(magnet);
    snapToHome(magnet);
    if (magnet.dataset.reason) {
      delete magnet.dataset.reason;
      magnet.classList.remove('has-reason');
    }
  });

  sortAllSections();
  updateAttendance();
  updateMagnetOutline();
  updateEtcReasonPanel();

  if (typeof renderReasonButtons === 'function') {
    renderReasonButtons();
  }

  const savePromise = saveState(grade, section);
  if (savePromise && typeof savePromise.finally === 'function') {
    savePromise.finally(() => {
      window.isAutoReturning = false;
    });
  } else {
    window.isAutoReturning = false;
  }

  return magnets.length;
}

function moveMagnetToCategoryByNumber(number, category) {
  const magnet = document.querySelector(`.magnet[data-number="${number}"]`);
  if (!magnet) {
    console.warn('[routine] magnet not found for number', number);
    return false;
  }
  console.log('[routine] moving magnet', { number, category });
  applyMagnetQuickAction(magnet, category);
  return true;
}

window.moveMagnetToCategoryByNumber = moveMagnetToCategoryByNumber;

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

const grade = getQueryParam("grade");
const section = getQueryParam("section");

function createPlaceholder(num) {
  if (placeholders.has(num)) return;
  const pos = gridPos[num];
  if (!pos) return;
  const p = document.createElement('div');
  p.className = 'magnet placeholder';
  p.textContent = num;
  p.style.left = pos.left + 'px';
  p.style.top  = pos.top  + 'px';
  p.style.background = 'linear-gradient(135deg,#666,#444)';
  p.style.opacity = '0.5';
  p.style.cursor = 'pointer';
  p.style.pointerEvents = 'auto';
  p.style.boxShadow = 'none';
  p.setAttribute('role', 'button');
  p.setAttribute('aria-label', `${num}번 자석 위치 찾기`);
  p.tabIndex = 0;
  p.addEventListener('click', () => highlightMagnetByNumber(num));
  p.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      highlightMagnetByNumber(num);
    }
  });
  document.getElementById('magnetContainer').appendChild(p);
  placeholders.set(num, p);
}

/* ===================== 자석 생성 ===================== */
function createMagnets(end = 31, skipNumbers = [12]) {
  const container = document.getElementById('magnetContainer');
  const rows = 7, cols = 5, size = 50, gap = 15;
  let n = 1;
  const allowed = new Set();
  for (let i=1; i<=end; i++) if (!(skipNumbers||[]).includes(i)) allowed.add(i);

  function getColorClass(num) {
    const bands = ['color-red','color-orange','color-yellow','color-green','color-blue','color-purple'];
    return bands[num%6];
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      while (!allowed.has(n) && n < end){n++;}
      if (n > end){break;}

      const x = c * (size + gap) + 50;
      const y = r * (size + gap) + 500;
      gridPos[n] = { left: x, top: y };

      // 항상 회색 자리표 생성 (배경)
      createPlaceholder(n);

      const m = document.createElement('div');
      m.className = 'magnet';
      const colorClass = getColorClass(r);
      if (colorClass) m.classList.add(colorClass);

      m.textContent = n;
      m.dataset.number = n;
      m.style.left = x + 'px';
      m.style.top  = y + 'px';

      container.appendChild(m);
      addDragFunctionality(m);

      n++;
    }
  }

  const total = container.querySelectorAll('.magnet:not(.placeholder)').length;
  const tc = document.getElementById('total-count');
  if (tc) tc.textContent = `${total}명`;

  updateMagnetOutline();
}

/* ===================== 외곽선 ===================== */
function ensureMagnetOutline() {
  const container = document.getElementById('magnetContainer');
  let outline = document.getElementById('magnetOutline');
  if (!outline) {
    outline = document.createElement('div');
    outline.id = 'magnetOutline';
    outline.className = 'magnet-outline';
    container.appendChild(outline);
  }
  return outline;
}

function updateMagnetOutline() {
  const container = document.getElementById('magnetContainer');
  const outline = ensureMagnetOutline();
  const nodes = container.querySelectorAll('.magnet:not(.attached)');

  if (!nodes.length) {
    outline.style.display = 'none';
    return;
  }

  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
  nodes.forEach(m => {
    const left = parseFloat(m.style.left) || 0;
    const top  = parseFloat(m.style.top)  || 0;
    const w = m.offsetWidth  || 50;
    const h = m.offsetHeight || 50;
    minL = Math.min(minL, left);
    minT = Math.min(minT, top);
    maxR = Math.max(maxR, left + w);
    maxB = Math.max(maxB, top  + h);
  });

  const pad = 8;
  outline.style.display = 'block';
  outline.style.left   = (minL - pad) + 'px';
  outline.style.top    = (minT - pad) + 'px';
  outline.style.width  = (maxR - minL + pad * 2) + 'px';
  outline.style.height = (maxB - minT + pad * 2) + 'px';
}

/* ===================== 출결 계산 ===================== */
function updateAttendance() {
  const total = document.querySelectorAll('.magnet:not(.placeholder)').length;
  const excluded = new Set(['toilet', 'hallway']);

  let absentCount = 0;
  let NabsentCount = 0;
  document.querySelectorAll('.board-section').forEach(section => {
    const cat = section.dataset.category;
    const content = section.querySelector('.section-content');
    if (!content) return;

    const n = content.querySelectorAll('.magnet:not(.placeholder)').length;
    if (!excluded.has(cat)) NabsentCount += n;
    absentCount += n;
  });

  document.getElementById('total-count').textContent   = `${total}명`;
  document.getElementById('absent-count').textContent  = `${NabsentCount}명`;
  document.getElementById('present-count').textContent = `${total - NabsentCount}명`;
  document.getElementById('class-count').textContent   = `${total - absentCount}명`;
}

/* ===================== 섹션 정렬 & 기타 사유 패널 ===================== */
function sortSection(contentEl) {
  const mags = Array.from(contentEl.querySelectorAll('.magnet'))
    .sort((a, b) => (+a.dataset.number) - (+b.dataset.number));
  mags.forEach(m => contentEl.appendChild(m));
}
function sortAllSections() {
  document.querySelectorAll('.section-content').forEach(sortSection);
}

// ✅ 같은 사유끼리 한 줄에: [사유] -> [번호들]로 그룹핑
// ✅ 기타 사유 패널 렌더링 (배지 색을 자석과 동일하게 동기화)
function updateEtcReasonPanel() {
  const list = document.getElementById('reasonList');
  if (!list) return;

  const etcContent = document.querySelector('[data-category="etc"] .section-content');
  const items = etcContent ? Array.from(etcContent.querySelectorAll('.magnet')) : [];

  // 그룹핑: reason -> [numbers]
  const groups = new Map();
  items.forEach(m => {
    const num = Number(m.dataset.number);
    const reason = (m.dataset.reason && m.dataset.reason.trim()) || '(이유 미입력)';
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(num);
  });

  // --- Easter Egg Trigger & Cleanup ---
  let shouldSaveState = false;

  // Iterate over a copy of keys, as we might delete from the map
  for (const reason of [...groups.keys()]) {
    const nums = groups.get(reason);

    // !폭죽 command
    if (reason === '!폭죽') {
      const container = document.querySelector('.fireworks');
      if (container && window.Fireworks) {
        const fireworks = new Fireworks.default(container);
        fireworks.start();
        setTimeout(() => fireworks.stop(true), 7000);
      }
      nums.forEach(n => {
        const mag = document.querySelector(`.magnet[data-number="${n}"][data-reason="${reason}"]`);
        if (mag) {
          delete mag.dataset.reason;
          mag.classList.remove('has-reason');
          shouldSaveState = true;
        }
      });
      groups.delete(reason);
    }

    // !image command
    else if (reason.startsWith('!image ')) {
      const imageUrl = reason.substring(7).trim();
      if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
        const img = document.createElement('img');
        img.src = imageUrl;
        img.style.position = 'fixed';
        img.style.top = '50%';
        img.style.left = '50%';
        img.style.transform = 'translate(-50%, -50%)';
        img.style.maxWidth = '80%';
        img.style.maxHeight = '80%';
        img.style.zIndex = '10000';
        img.style.border = '5px solid white';
        img.style.boxShadow = '0 0 20px rgba(0,0,0,0.5)';
        img.onerror = () => { img.remove(); };
        document.body.appendChild(img);
        setTimeout(() => { img.remove(); }, 3000);
      }
      nums.forEach(n => {
        const mag = document.querySelector(`.magnet[data-number="${n}"][data-reason="${reason}"]`);
        if (mag) {
          delete mag.dataset.reason;
          mag.classList.remove('has-reason');
          shouldSaveState = true;
        }
      });
      groups.delete(reason);
    }

    else if (reason.startsWith('!imagem ')) {
      const imageUrl = reason.substring(7).trim();
      if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
        const img = document.createElement('img');
        img.src = imageUrl;
        img.style.position = 'fixed';
        img.style.top = '50%';
        img.style.left = '50%';
        img.style.transform = 'translate(-50%, -50%)';
        img.style.maxWidth = '80%';
        img.style.maxHeight = '80%';
        img.style.zIndex = '10000';
        img.style.border = '5px solid white';
        img.style.boxShadow = '0 0 20px rgba(0,0,0,0.5)';
        img.onerror = () => { img.remove(); };
        document.body.appendChild(img);
        setTimeout(() => { img.remove(); }, 60000);
      }
      nums.forEach(n => {
        const mag = document.querySelector(`.magnet[data-number="${n}"][data-reason="${reason}"]`);
        if (mag) {
          delete mag.dataset.reason;
          mag.classList.remove('has-reason');
          shouldSaveState = true;
        }
      });
      groups.delete(reason);
    }
  }

  if (shouldSaveState) {
    saveState(grade, section);
  }
  // --- End of Easter Egg ---

  // 정렬: 사유(한글 알파) -> 번호 오름차순
  const collator = new Intl.Collator('ko');
  const entries = Array.from(groups.entries()).sort((a, b) => collator.compare(a[0], b[0]));
  entries.forEach(([_, nums]) => nums.sort((a,b)=>a-b));

  // 렌더링
  list.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.textContent = '현재 등록된 기타 사유가 없습니다.';
    empty.style.opacity = '0.7';
    list.appendChild(empty);
    return;
  }

  entries.forEach(([reason, nums]) => {
    const row = document.createElement('div');
    row.className = 'reason-item';

    const badges = document.createElement('div');
    badges.className = 'badges';

    nums.forEach(n => {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = n;

      // 🔗 자석 DOM 찾아서 스타일/클래스 동기화
      const mag = document.querySelector(`.magnet[data-number="${n}"]`);
      if (mag) {
        // 1) color-* 클래스 복사
        mag.classList.forEach(cls => {
          if (cls.startsWith('color-')) b.classList.add(cls);
        });

        // 2) 실제 렌더된 스타일 복사
        const cs = getComputedStyle(mag);
        const bgImg = cs.backgroundImage;
        const bgCol = cs.backgroundColor;
        const fgCol = cs.color;

        if (bgImg && bgImg !== 'none') {
          b.style.backgroundImage = bgImg;
          b.style.backgroundColor = 'transparent';
        } else {
          b.style.backgroundImage = 'none';
          b.style.backgroundColor = bgCol;
        }
        b.style.color = fgCol;
      }

      badges.appendChild(b);
    });

    const text = document.createElement('div');
    text.className = 'reason-text';

    if (reason === '여우사이') {
      text.textContent = '🦊 ' + reason;
    } else if (reason === '자퇴') {
      text.textContent = '😭 ' + reason;
    } else {
      text.textContent = reason;
    }

    row.appendChild(badges);
    row.appendChild(text);
    list.appendChild(row);
  });
}

/* ===================== 유틸: 원래 자리로 스냅 ===================== */
function snapToHome(el) {
  const pos = gridPos[+el.dataset.number];
  if (!pos) return;
  el.style.left = pos.left + 'px';
  el.style.top  = pos.top  + 'px';
  el.style.transform = 'translate(0,0)';
  if (typeof window.updateThoughtBubblePositionForMagnet === 'function') {
    window.updateThoughtBubblePositionForMagnet(el);
  }
}

function highlightMagnetByNumber(number) {
  const magnet = document.querySelector(`.magnet[data-number="${number}"]:not(.placeholder)`);
  if (!magnet) return;

  if (typeof magnet.scrollIntoView === 'function') {
    try {
      magnet.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch (err) {
      magnet.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }

  if (magnet.__highlightTimer) {
    clearTimeout(magnet.__highlightTimer);
    magnet.__highlightTimer = null;
  }

  if (magnet.__highlightAnimation && typeof magnet.__highlightAnimation.cancel === 'function') {
    magnet.__highlightAnimation.cancel();
  }

  if (!magnet.dataset.highlightPrevZ) {
    magnet.dataset.highlightPrevZ = magnet.style.zIndex || '';
  }
  magnet.style.zIndex = '1400';

  magnet.classList.remove('magnet-highlight');
  void magnet.offsetWidth;
  magnet.classList.add('magnet-highlight');

  try {
    const animation = magnet.animate([
      { transform: 'translate3d(0,0,0) scale(1)', offset: 0 },
      { transform: 'translate3d(0,-14px,0) scale(1.07)', offset: 0.25 },
      { transform: 'translate3d(0,0,0) scale(0.96)', offset: 0.5 },
      { transform: 'translate3d(0,-8px,0) scale(1.04)', offset: 0.75 },
      { transform: 'translate3d(0,0,0) scale(1)', offset: 1 }
    ], {
      duration: 900,
      easing: 'ease-out'
    });
    magnet.__highlightAnimation = animation;
    const clearAnimationRef = () => {
      if (magnet.__highlightAnimation === animation) {
        delete magnet.__highlightAnimation;
      }
    };
    animation.addEventListener('finish', clearAnimationRef);
    animation.addEventListener('cancel', clearAnimationRef);
  } catch (err) {
    // Web Animations API not supported; fallback to no-op bounce
  }

  magnet.__highlightTimer = setTimeout(() => {
    magnet.classList.remove('magnet-highlight');
    const prev = magnet.dataset.highlightPrevZ || '';
    magnet.style.zIndex = prev;
    delete magnet.dataset.highlightPrevZ;
    delete magnet.__highlightTimer;
  }, 1200);
}

window.highlightMagnetByNumber = highlightMagnetByNumber;

/* ===================== 드래그 ===================== */
function addDragFunctionality(el) {
  const container = document.getElementById('magnetContainer');
  if (!container) return;

  let isPointerDown = false;
  let isDragging = false;
  let didPrepareForDrag = false;
  let longPressTimer = null;
  let longPressTriggered = false;
  let startClientX = 0;
  let startClientY = 0;
  let pressClientX = 0;
  let pressClientY = 0;
  let startLeft = 0;
  let startTop = 0;
  let activeTouchId = null;

  function getTouchFromList(touchList) {
    if (!touchList || !touchList.length) return null;
    if (activeTouchId !== null) {
      for (let i = 0; i < touchList.length; i++) {
        const touch = touchList[i];
        if (touch.identifier === activeTouchId) {
          return touch;
        }
      }
    }
    return touchList[0];
  }

  function getClientPosition(evt) {
    if (evt.type.startsWith('touch')) {
      const touch = getTouchFromList(evt.changedTouches) || getTouchFromList(evt.touches);
      if (touch) {
        return { clientX: touch.clientX, clientY: touch.clientY };
      }
      return null;
    }
    return { clientX: evt.clientX, clientY: evt.clientY };
  }

  function clearLongPressTimer() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  el.__cancelLongPress = clearLongPressTimer;

  function resetInteractionState() {
    isPointerDown = false;
    isDragging = false;
    didPrepareForDrag = false;
    window.isMagnetDragging = false;
    activeTouchId = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.board-section').forEach(sec => sec.classList.remove('drag-over'));
  }

  function triggerLongPress(x, y) {
    longPressTriggered = true;
    clearLongPressTimer();
    resetInteractionState();
    openMagnetQuickMenu(el, { clientX: x, clientY: y });
  }

  function prepareForDrag(clientX, clientY) {
    if (didPrepareForDrag) return;
    didPrepareForDrag = true;

    if (el.classList.contains('attached')) {
      const rect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      el.classList.remove('attached');
      container.appendChild(el);

      const newLeft = rect.left - containerRect.left;
      const newTop = rect.top - containerRect.top;

      el.style.left = `${newLeft}px`;
      el.style.top = `${newTop}px`;
      el.style.transform = 'translate(0,0)';
      if (typeof window.updateThoughtBubblePositionForMagnet === 'function') {
        window.updateThoughtBubblePositionForMagnet(el);
      }

      startLeft = newLeft;
      startTop = newTop;
      startClientX = clientX;
      startClientY = clientY;

      updateAttendance();
      updateMagnetOutline();
      updateEtcReasonPanel();
      saveState(grade, section);
    }
  }

  function dragStart(e) {
    if (e.type === 'mousedown' && e.button !== 0) return;

    const isTouchStart = e.type === 'touchstart';
    const pointerType = e.pointerType || (isTouchStart ? 'touch' : 'mouse');

    if (pointerType === 'touch' || pointerType === 'pen') {
      if (!magnetGroup.leader) {
        startMagnetGroup(el, e.pointerId !== undefined ? e.pointerId : 'touch');
      } else if (magnetGroup.leader === el) {
        magnetGroup.active = true;
      } else if (magnetGroup.active) {
        const totalTouches = e.touches ? e.touches.length : 0;
        if (totalTouches > 1 || magnetGroup.members.length > 0) {
          addMagnetToGroup(el);
          if (isTouchStart && e.cancelable) {
            e.preventDefault();
          }
          return;
        }
      }
    } else if (magnetGroup.leader && magnetGroup.leader !== el) {
      clearMagnetGroup();
    }

    const pos = getClientPosition(e);
    if (!pos) return;

    if (isTouchStart) {
      const source = (e.changedTouches && e.changedTouches.length)
        ? e.changedTouches
        : e.touches;
      if (source && source.length) {
        activeTouchId = source[source.length - 1].identifier;
      }
    } else {
      activeTouchId = null;
    }

    clearLongPressTimer();
    isPointerDown = true;
    isDragging = false;
    didPrepareForDrag = false;
    longPressTriggered = false;

    startClientX = pos.clientX;
    startClientY = pos.clientY;
    pressClientX = pos.clientX;
    pressClientY = pos.clientY;
    startLeft = parseFloat(el.style.left) || 0;
    startTop = parseFloat(el.style.top) || 0;

    longPressTimer = setTimeout(() => triggerLongPress(pos.clientX, pos.clientY), LONG_PRESS_DELAY);

    if (e.type === 'touchstart' && e.cancelable) {
      e.preventDefault();
    }
  }

  function drag(e) {
    if (!isPointerDown && !isDragging) return;
    const pos = getClientPosition(e);
    if (!pos) return;

    if (e.cancelable) e.preventDefault();
    if (longPressTriggered) return;

    const { clientX, clientY } = pos;

    if (!isDragging) {
      const moveX = Math.abs(clientX - pressClientX);
      const moveY = Math.abs(clientY - pressClientY);
      if (moveX > DRAG_MOVE_THRESHOLD || moveY > DRAG_MOVE_THRESHOLD) {
        clearLongPressTimer();
        prepareForDrag(clientX, clientY);
        isDragging = true;
        window.isMagnetDragging = true;
        el.classList.add('dragging');
      } else {
        return;
      }
    }

    const deltaX = clientX - startClientX;
    const deltaY = clientY - startClientY;
    const containerRect = container.getBoundingClientRect();

    let newX = startLeft + deltaX;
    let newY = startTop + deltaY;

    const maxX = containerRect.width - el.offsetWidth;
    const maxY = containerRect.height - el.offsetHeight;

    if (newX < 0) newX = 0;
    if (newY < 0) newY = 0;
    if (newX > maxX) newX = maxX;
    if (newY > maxY) newY = maxY;

    el.style.left = `${newX}px`;
    el.style.top = `${newY}px`;
    el.style.transform = 'translate(0,0)';
    updateGroupFollowerPositions(el);
    if (typeof window.updateThoughtBubblePositionForMagnet === 'function') {
      window.updateThoughtBubblePositionForMagnet(el);
    }

    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    document.querySelectorAll('.board-section').forEach(sec => {
      const sr = sec.getBoundingClientRect();
      if (cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom) {
        sec.classList.add('drag-over');
      } else {
        sec.classList.remove('drag-over');
      }
    });

    updateMagnetOutline();
  }

  function dropMagnet() {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    let targetSection = null;
    document.querySelectorAll('.board-section').forEach(sec => {
      const sr = sec.getBoundingClientRect();
      if (cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom) {
        targetSection = sec;
      }
    });

    const isGroupLeader = magnetGroup.leader === el;
    const magnetsToHandle = isGroupLeader ? getGroupedMagnets(true) : [el];

    if (targetSection) {
      const category = targetSection.dataset.category;
      if (category) {
        const isGroupAction = magnetsToHandle.length > 1;
        const shouldDeferReason = category === 'etc' && isGroupAction;
        const groupReasonTargets = shouldDeferReason ? magnetsToHandle.filter(Boolean) : null;
        const needsReasonPrompt = shouldDeferReason
          ? groupReasonTargets.some(magnet => {
              const reason = (magnet.dataset.reason || '').trim();
              return reason.length === 0;
            })
          : false;

        magnetsToHandle.forEach(magnet => {
          applyMagnetQuickAction(magnet, category, {
            skipSave: true,
            deferReasonDialog: shouldDeferReason
          });
        });
        updateAttendance();
        updateMagnetOutline();
        updateEtcReasonPanel();
        saveState(grade, section);

        if (shouldDeferReason && needsReasonPrompt && groupReasonTargets && groupReasonTargets.length) {
          openReasonDialog(groupReasonTargets);
        }
      }
    } else {
      magnetsToHandle.forEach(magnet => {
        snapToHome(magnet);
        if (magnet.dataset.reason) {
          delete magnet.dataset.reason;
          magnet.classList.remove('has-reason');
        }
      });
      updateAttendance();
      updateMagnetOutline();
      updateEtcReasonPanel();
      saveState(grade, section);
    }

    if (isGroupLeader) {
      clearMagnetGroup();
    }
  }

  function dragEnd(e) {
    if (e && e.type && e.type.startsWith('touch') && activeTouchId !== null) {
      const changes = e.changedTouches;
      let relevant = false;
      if (changes) {
        for (let i = 0; i < changes.length; i++) {
          if (changes[i].identifier === activeTouchId) {
            relevant = true;
            break;
          }
        }
      }
      if (!relevant) {
        return;
      }
    }

    if (!isPointerDown && !isDragging && !longPressTriggered) {
      clearLongPressTimer();
      return;
    }

    clearLongPressTimer();

    if (longPressTriggered) {
      longPressTriggered = false;
      resetInteractionState();
      return;
    }

    if (magnetGroup.leader === el) {
      magnetGroup.active = false;
    }

    if (isDragging) {
      dropMagnet();
    }

    if (!isDragging && magnetGroup.leader === el) {
      clearMagnetGroup({ restore: true });
    }

    resetInteractionState();
  }


  function handlePointerCancel(e) {
    if (e && e.type && e.type.startsWith('touch') && activeTouchId !== null) {
      const changes = e.changedTouches;
      let relevant = false;
      if (changes) {
        for (let i = 0; i < changes.length; i++) {
          if (changes[i].identifier === activeTouchId) {
            relevant = true;
            break;
          }
        }
      }
      if (!relevant) {
        return;
      }
    }

    clearLongPressTimer();
    if (isDragging) {
      snapToHome(el);
      if (el.dataset.reason) {
        delete el.dataset.reason;
        el.classList.remove('has-reason');
      }
      updateAttendance();
      updateMagnetOutline();
      updateEtcReasonPanel();
      saveState(grade, section);
    }
    if (magnetGroup.leader === el) {
      magnetGroup.active = false;
      clearMagnetGroup();
    }
    longPressTriggered = false;
    resetInteractionState();
  }


  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  el.addEventListener('mousedown', dragStart);
  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', dragEnd);

  el.addEventListener('touchstart', dragStart, { passive: false });
  document.addEventListener('touchmove', drag, { passive: false });
  document.addEventListener('touchend', dragEnd);
  document.addEventListener('touchcancel', handlePointerCancel);
}

/* ===================== 이유 모달 ===================== */
let currentReasonTargets = [];

/* 현재 DOM에 존재하는 이유 수집(중복 제거 + 정렬) */
function collectExistingReasons() {
  const set = new Set();
  document.querySelectorAll('.magnet.has-reason, .magnet[data-reason]').forEach(m => {
    const r = (m.dataset.reason || '').trim();
    if (r) set.add(r);
  });
  const collator = new Intl.Collator('ko');
  return Array.from(set).sort((a, b) => collator.compare(a, b));
}

/* 모달 내 버튼 호스트를 보장(없으면 생성해서 textarea 아래에 붙임) */
function ensureReasonButtonsHost() {
  const dialog = document.querySelector('#reasonOverlay .dialog');
  if (!dialog) return null;

  // 이미 있으면 그대로 사용
  let wrap = document.getElementById('reasonQuickWrap');
  let host = document.getElementById('reasonButtons');
  if (wrap && host) return host;

  // 없으면 생성
  wrap = document.createElement('div');
  wrap.id = 'reasonQuickWrap';
  wrap.className = 'reason-quick';
  wrap.style.marginTop = '10px';

  const title = document.createElement('div');
  title.className = 'reason-quick__title';
  title.textContent = '빠른 선택';
  title.style.fontSize = '14px';
  title.style.opacity = '.8';
  title.style.marginBottom = '6px';

  host = document.createElement('div');
  host.id = 'reasonButtons';
  host.className = 'reason-quick__grid';
  host.style.display = 'flex';
  host.style.flexWrap = 'wrap';
  host.style.gap = '8px';

  wrap.appendChild(title);
  wrap.appendChild(host);

  const textarea = dialog.querySelector('#reasonInput');
  if (textarea && textarea.parentElement) {
    textarea.parentElement.insertBefore(wrap, textarea.nextSibling);
  } else {
    dialog.appendChild(wrap);
  }

  return host;
}

/* 빠른 선택 버튼 렌더링(이유가 생길 때마다 자동 갱신) */
function renderReasonButtons() {
  const host = ensureReasonButtonsHost();
  if (!host) return;

  const list = collectExistingReasons();
  host.innerHTML = '';

  list.forEach(reason => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reason-btn';        // ✅ 인라인 스타일 제거, 클래스만
    btn.textContent = reason;
    btn.addEventListener('click', () => {
      const input = document.getElementById('reasonInput');
      if (input) input.value = reason;
      host.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
    });
    host.appendChild(btn);
  });
}

/* 모달 열기 */
function openReasonDialog(targetOrTargets) {
  const overlay = document.getElementById('reasonOverlay');
  const input = document.getElementById('reasonInput');
  if (!overlay) return;

  const targets = Array.isArray(targetOrTargets)
    ? targetOrTargets.filter(Boolean)
    : [targetOrTargets].filter(Boolean);
  currentReasonTargets = targets;

  if (!targets.length) {
    overlay.hidden = true;
    return;
  }

  if (input) {
    const reasons = targets.map(t => (t.dataset.reason || '').trim());
    const first = reasons[0] || '';
    const allSame = reasons.every(reason => reason === first);
    input.value = allSame ? first : '';
  }

  // 버튼 갱신
  renderReasonButtons();

  // 표시 & 포커스
  overlay.hidden = false;
  setTimeout(() => input && input.focus(), 0);
}

/* 모달 닫기 */
function closeReasonDialog() {
  const overlay = document.getElementById('reasonOverlay');
  if (overlay) overlay.hidden = true;
  currentReasonTargets = [];
}

/* 저장 */
document.getElementById('reasonSave').addEventListener('click', () => {
  const input = document.getElementById('reasonInput');
  const text = input ? input.value.trim() : '';

  if (currentReasonTargets.length) {
    currentReasonTargets.forEach(target => {
      if (!target) return;
      if (text) {
        target.dataset.reason = text;
        target.classList.add('has-reason');
      } else {
        delete target.dataset.reason;
        target.classList.remove('has-reason');
      }
    });
  }
  closeReasonDialog();
  sortAllSections();
  updateEtcReasonPanel();
  saveState(grade, section);

  // 새 이유가 생겼을 수 있으니 버튼 재렌더(모달 외부에서도 최신 유지)
  renderReasonButtons();
});

/* 취소 */
document.getElementById('reasonCancel').addEventListener('click', () => {
  closeReasonDialog();
  updateEtcReasonPanel();
  renderReasonButtons();
});

/* 오버레이 클릭 닫기 */
document.getElementById('reasonOverlay').addEventListener('mousedown', (e) => {
  if (e.target.id === 'reasonOverlay') {
    closeReasonDialog();
    updateEtcReasonPanel();
    renderReasonButtons();
  }
});

/* ESC 닫기 */
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('reasonOverlay');
  if (e.key === 'Escape' && overlay && !overlay.hidden) {
    closeReasonDialog();
    updateEtcReasonPanel();
    renderReasonButtons();
  }
});
