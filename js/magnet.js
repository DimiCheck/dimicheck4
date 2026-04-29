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

const MAGNET_QUICK_DROP_TARGETS = [
  {
    label: '화장실(물)',
    value: 'toilet',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h8v6a4 4 0 0 1-8 0V5Z"/><path d="M10 2h4"/><path d="M7 15h10"/><path d="M12 15v6"/><path d="M9 21h6"/></svg>'
  },
  {
    label: '복도',
    value: 'hallway',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4.5L16 3v18"/><path d="M16 7h3v14"/><path d="M12 13h.01"/></svg>'
  },
  {
    label: '동아리',
    value: 'club',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M3.5 20a4.5 4.5 0 0 1 9 0"/><path d="M11.5 20a4.5 4.5 0 0 1 9 0"/></svg>'
  },
  {
    label: '방과후',
    value: 'afterschool',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>'
  },
  {
    label: '프로젝트',
    value: 'project',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19h12"/><path d="M8 17V7h8v10"/><path d="M10 10h4"/><path d="M10 13h4"/><path d="M9 4h6"/></svg>'
  },
  {
    label: '조기입실',
    value: 'early',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18h16"/><path d="M6 18V9h12v9"/><path d="M8 9V6h8v3"/><path d="M9 14h6"/></svg>'
  },
  {
    label: '기타',
    value: 'etc',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>'
  },
  {
    label: '결석(조퇴)',
    value: 'absence',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V6h14v13"/><path d="M9 19v-5h6v5"/><path d="M8 10h8"/><path d="M12 6V3"/><path d="M9.5 3h5"/></svg>'
  }
];

const FAVORITE_STATUS_LABELS = {
  toilet: '화장실(물)',
  hallway: '복도',
  club: '동아리',
  afterschool: '방과후',
  project: '프로젝트',
  early: '조기입실',
  absence: '결석(조퇴)'
};
const FAVORITE_STATUS_CODES = new Set(Object.keys(FAVORITE_STATUS_LABELS));
const PLACEHOLDER_STATUS_BADGES = {
  toilet: { label: '화장실', title: '화장실(물)' },
  hallway: { label: '복도', title: '복도' },
  club: { label: '동아리', title: '동아리' },
  afterschool: { label: '방과후', title: '방과후' },
  project: { label: '프젝', title: '프로젝트' },
  early: { label: '조입', title: '조기입실' },
  etc: { label: '기타', title: '기타' },
  absence: { label: '결석', title: '결석(조퇴)' }
};
const ETC_REASON_HISTORY_KEY = 'dimicheck:board-etc-reason-history:v1';
const ETC_REASON_HISTORY_LIMIT = 12;
const ETC_REASON_HISTORY_MAX_LENGTH = 30;
let boardFavoriteStatusByNumber = Object.create(null);

const thoughtBubbleRegistry = new Map(); // number -> { element, timeoutId, expiresAt, text }
const reactionBadgeRegistry = new Map(); // number -> { element, timeoutId, expiresAt, emoji }

// Category → burst emoji
const CATEGORY_BURST_EMOJI = {
  toilet: '🚽',
  hallway: '🚪',
  club: '🧑‍🤝‍🧑',
  afterschool: '🕒',
  project: '🔥',
  early: '🛏️',
  absence: '🏠'
};

// Reaction burst effect
function spawnReactionBurst(number, emoji) {
  const magnet = document.querySelector(`.magnet[data-number="${number}"]:not(.placeholder)`);
  if (!magnet) return;

  const rect = magnet.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;

  const burst = document.createElement('div');
  burst.className = 'reaction-burst';
  document.body.appendChild(burst);

  const total = 20;
  for (let i = 0; i < total; i++) {
    const span = document.createElement('span');
    span.className = 'reaction-burst-emoji';
    span.textContent = emoji;

    const angle = Math.random() * Math.PI * 2;
    const distance = 40 + Math.random() * 100;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const duration = 400 + Math.random() * 300;

    span.style.left = `${originX}px`;
    span.style.top = `${originY}px`;
    span.style.transitionDuration = `${duration}ms`;

    burst.appendChild(span);

    requestAnimationFrame(() => {
      span.style.transform = `translate(${dx}px, ${dy}px) scale(1)`;
      span.style.opacity = '1';
      setTimeout(() => {
        span.style.opacity = '0';
      }, duration * 0.7);
    });
  }

  setTimeout(() => {
    burst.remove();
  }, 800);
}

window.spawnReactionBurst = spawnReactionBurst;

function triggerCategoryBurst(target, category) {
  if (!target) return;
  const emoji = CATEGORY_BURST_EMOJI[category];
  if (!emoji || typeof window.spawnReactionBurst !== 'function') return;
  const num = Number(target.dataset.number);
  if (!Number.isFinite(num)) return;
  window.spawnReactionBurst(num, emoji);
}

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
    const magnet = document.querySelector(`.magnet[data-number="${number}"]:not(.placeholder)`);
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
    expiresAtMs = Date.now() + 7500;
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

/* ===================== Reaction Badge System ===================== */

function removeReactionBadgeForNumber(number) {
  const entry = reactionBadgeRegistry.get(number);
  if (!entry) return;
  reactionBadgeRegistry.delete(number);
  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }

  // Restore original number text
  const magnet = document.querySelector(`.magnet[data-number="${number}"]:not(.placeholder)`);
  if (magnet && entry.originalText !== undefined) {
    magnet.textContent = entry.originalText;
  }
}

function ensureReactionBadge(magnet, emoji, expiresAtValue) {
  if (!magnet) return;
  const number = magnet.dataset.number;
  if (!number) return;

  const sanitized = String(emoji || '').trim();
  if (!sanitized) {
    removeReactionBadgeForNumber(number);
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
    expiresAtMs = Date.now() + 5000; // Default 5 seconds
  }

  const now = Date.now();
  if (expiresAtMs <= now) {
    removeReactionBadgeForNumber(number);
    return;
  }

  let entry = reactionBadgeRegistry.get(number);
  if (!entry) {
    // Save original number text
    const originalText = magnet.textContent;
    entry = { originalText: originalText, timeoutId: null, expiresAt: 0, emoji: '' };
    reactionBadgeRegistry.set(number, entry);
  }

  // Replace magnet text with emoji
  if (entry.emoji !== sanitized) {
    magnet.textContent = sanitized;
    entry.emoji = sanitized;

    // Burst effect when reaction changes
    if (typeof window.spawnReactionBurst === 'function') {
      window.spawnReactionBurst(Number(number), sanitized);
    }
  }

  entry.expiresAt = expiresAtMs;
  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }
  entry.timeoutId = window.setTimeout(() => {
    removeReactionBadgeForNumber(number);
  }, Math.max(0, expiresAtMs - now));
}

//D
function updateMagnetReaction(magnet, data) {
  if (!magnet) return;
  const number = magnet.dataset.number;
  if (!number) return;

  const payload = (data && typeof data === 'object') ? data : null;
  const emoji = payload ? payload.reaction : null;
  if (!emoji) {
    removeReactionBadgeForNumber(number);
    return;
  }

  ensureReactionBadge(magnet, emoji, payload ? payload.reactionExpiresAt : undefined);
}

window.updateMagnetReaction = updateMagnetReaction;

let magnetMenuOverlay = null;
let magnetMenuPanel = null;
let magnetMenuCurrentTarget = null;
let magnetMenuKeydownBound = false;
let magnetMenuActionsHost = null;
let magnetMenuLastOrigin = null;
let magnetQuickDropOverlay = null;
let magnetQuickDropActiveAction = null;
let magnetQuickDropFrameId = null;
let magnetMultiSelectToggleButton = null;
let magnetMultiSelectHint = null;
let magnetMultiSelectHintTimer = null;
let etcReasonShortcutButton = null;
let etcReasonPopover = null;
let etcReasonPopoverList = null;
let etcReasonPopoverEntries = [];
let magnetMultiSelectEnabled = false;
const magnetMultiSelected = new Set();
const MAGNET_QUICK_DROP_CANCEL_ACTION = 'cancel';
const MAGNET_MULTI_SELECT_HINT_KEY = 'dimicheck:board-multi-select-hint-seen';

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

function getValidMultiSelectedMagnets() {
  const selected = [];
  magnetMultiSelected.forEach(magnet => {
    if (!magnet || !document.body.contains(magnet) || magnet.classList.contains('placeholder')) {
      magnetMultiSelected.delete(magnet);
      return;
    }
    selected.push(magnet);
  });
  return selected;
}

function updateMagnetMultiSelectToggle() {
  const selectedCount = getValidMultiSelectedMagnets().length;
  if (magnetMultiSelectToggleButton) {
    magnetMultiSelectToggleButton.classList.toggle('is-active', magnetMultiSelectEnabled);
    const label = magnetMultiSelectEnabled ? '다중 선택 중' : '다중 선택';
    magnetMultiSelectToggleButton.innerHTML = `
      <span>${label}</span>
      <span class="magnet-multi-select-toggle__count">${selectedCount}</span>
    `;
    magnetMultiSelectToggleButton.setAttribute('aria-pressed', String(magnetMultiSelectEnabled));
  }
  document.body.classList.toggle('magnet-multi-select-mode', magnetMultiSelectEnabled);
}

function setMagnetMultiSelected(magnet, selected) {
  if (!magnet || magnet.classList.contains('placeholder')) return;
  if (selected) {
    magnetMultiSelected.add(magnet);
  } else {
    magnetMultiSelected.delete(magnet);
  }
  magnet.classList.toggle('magnet-multi-selected', selected);
  updateMagnetMultiSelectToggle();
}

function clearMagnetMultiSelection() {
  magnetMultiSelected.forEach(magnet => {
    if (magnet) {
      magnet.classList.remove('magnet-multi-selected');
    }
  });
  magnetMultiSelected.clear();
  updateMagnetMultiSelectToggle();
}

function setMagnetMultiSelectMode(enabled) {
  magnetMultiSelectEnabled = Boolean(enabled);
  clearMagnetGroup({ restore: true });
  hideMagnetQuickDropOverlay();
  if (!magnetMultiSelectEnabled) {
    clearMagnetMultiSelection();
    hideMagnetMultiSelectHint();
  }
  updateMagnetMultiSelectToggle();
  if (magnetMultiSelectEnabled) {
    showMagnetMultiSelectHintOnce();
  }
}

function ensureMagnetMultiSelectToggle() {
  if (magnetMultiSelectToggleButton) {
    positionMagnetMultiSelectToggle();
    return magnetMultiSelectToggleButton;
  }
  const container = document.getElementById('magnetContainer');
  if (!container) return null;

  magnetMultiSelectToggleButton = document.createElement('button');
  magnetMultiSelectToggleButton.type = 'button';
  magnetMultiSelectToggleButton.className = 'magnet-multi-select-toggle';
  magnetMultiSelectToggleButton.setAttribute('aria-pressed', 'false');
  magnetMultiSelectToggleButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setMagnetMultiSelectMode(!magnetMultiSelectEnabled);
  });
  magnetMultiSelectToggleButton.addEventListener('mousedown', event => event.stopPropagation());
  magnetMultiSelectToggleButton.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
  container.appendChild(magnetMultiSelectToggleButton);
  updateMagnetMultiSelectToggle();
  positionMagnetMultiSelectToggle();
  return magnetMultiSelectToggleButton;
}

function hasSeenMagnetMultiSelectHint() {
  try {
    return localStorage.getItem(MAGNET_MULTI_SELECT_HINT_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function markMagnetMultiSelectHintSeen() {
  try {
    localStorage.setItem(MAGNET_MULTI_SELECT_HINT_KEY, '1');
  } catch (error) {
    // localStorage can be blocked; the hint still self-dismisses for this page view.
  }
}

function ensureMagnetMultiSelectHint() {
  if (magnetMultiSelectHint) return magnetMultiSelectHint;
  const container = document.getElementById('magnetContainer');
  if (!container) return null;

  magnetMultiSelectHint = document.createElement('div');
  magnetMultiSelectHint.className = 'magnet-multi-select-hint';
  magnetMultiSelectHint.hidden = true;
  magnetMultiSelectHint.innerHTML = `
    <button type="button" class="magnet-multi-select-hint__close" aria-label="다중 선택 도움말 닫기">&times;</button>
    <div>자석을 클릭해 여러 개 선택한 뒤, 선택한 자석 중 하나를 끌어 함께 이동할 수 있습니다.</div>
  `;
  magnetMultiSelectHint.querySelector('.magnet-multi-select-hint__close')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideMagnetMultiSelectHint({ persist: true });
  });
  container.appendChild(magnetMultiSelectHint);
  return magnetMultiSelectHint;
}

function positionMagnetMultiSelectHint() {
  if (!magnetMultiSelectHint || magnetMultiSelectHint.hidden || !magnetMultiSelectToggleButton) return;
  const container = document.getElementById('magnetContainer');
  if (!container) return;

  const containerRect = container.getBoundingClientRect();
  const buttonRect = magnetMultiSelectToggleButton.getBoundingClientRect();
  const hintRect = magnetMultiSelectHint.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(
    Math.max(0, buttonRect.left - containerRect.left + buttonRect.width / 2 - hintRect.width / 2),
    Math.max(0, containerRect.width - hintRect.width)
  );
  const top = Math.max(0, buttonRect.top - containerRect.top - hintRect.height - gap);
  magnetMultiSelectHint.style.left = `${left}px`;
  magnetMultiSelectHint.style.top = `${top}px`;
}

function hideMagnetMultiSelectHint(options = {}) {
  const { persist = false } = options;
  if (magnetMultiSelectHintTimer) {
    clearTimeout(magnetMultiSelectHintTimer);
    magnetMultiSelectHintTimer = null;
  }
  if (persist) {
    markMagnetMultiSelectHintSeen();
  }
  if (!magnetMultiSelectHint) return;
  magnetMultiSelectHint.classList.remove('is-visible');
  magnetMultiSelectHint.hidden = true;
}

function showMagnetMultiSelectHintOnce() {
  if (hasSeenMagnetMultiSelectHint()) return;
  const hint = ensureMagnetMultiSelectHint();
  if (!hint) return;
  hint.hidden = false;
  requestAnimationFrame(() => {
    positionMagnetMultiSelectHint();
    hint.classList.add('is-visible');
  });
  if (magnetMultiSelectHintTimer) {
    clearTimeout(magnetMultiSelectHintTimer);
  }
  magnetMultiSelectHintTimer = window.setTimeout(() => {
    hideMagnetMultiSelectHint({ persist: true });
  }, 5000);
}

function positionMagnetMultiSelectToggle() {
  const container = document.getElementById('magnetContainer');
  if (!container || !magnetMultiSelectToggleButton) return;
  const bounds = getMagnetClassroomBounds(container);
  if (!bounds) return;
  const top = Math.max(0, bounds.top - 46);
  magnetMultiSelectToggleButton.style.left = `${bounds.left}px`;
  magnetMultiSelectToggleButton.style.top = `${top}px`;
  positionMagnetMultiSelectHint();
}

function startMagnetGroupFromMultiSelection(leader) {
  if (!leader || leader.classList.contains('placeholder')) return;
  if (!magnetMultiSelected.has(leader)) {
    setMagnetMultiSelected(leader, true);
  }

  const container = document.getElementById('magnetContainer');
  if (!container) return;

  const selected = getValidMultiSelectedMagnets();
  const members = selected.filter(magnet => magnet !== leader);
  clearMagnetGroup({ restore: false });

  magnetGroup.leader = leader;
  magnetGroup.pointerId = 'multi-select';
  magnetGroup.members = [];
  magnetGroup.offsets = new Map();
  magnetGroup.originals = new Map();
  magnetGroup.active = true;
  storeOriginalState(leader);

  const leaderPos = getMagnetPosition(leader);
  leader.classList.add('magnet-group-leader');
  leader.style.zIndex = '1200';
  leader.classList.add('magnet-group-converging');

  members.forEach((member, index) => {
    storeOriginalState(member);
    member.classList.remove('attached');
    member.classList.add('magnet-group-member', 'magnet-group-converging');
    if (member.parentElement !== container) {
      container.appendChild(member);
    }
    magnetGroup.members.push(member);
    const offset = { dx: (index + 1) * 6, dy: (index + 1) * 8 };
    magnetGroup.offsets.set(member, offset);
    setMagnetPosition(member, leaderPos.left + offset.dx, leaderPos.top + offset.dy);
    member.style.zIndex = String(1200 - (index + 1));
  });

  updateGroupBadge();
  window.setTimeout(() => {
    leader.classList.remove('magnet-group-converging');
    members.forEach(member => member.classList.remove('magnet-group-converging'));
  }, 180);
}

function normalizeFavoriteStatusAction(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return FAVORITE_STATUS_CODES.has(normalized) ? normalized : null;
}

function getBoardFavoriteAction(number) {
  const key = String(number || '').trim();
  return normalizeFavoriteStatusAction(boardFavoriteStatusByNumber[key]);
}

function applyBoardFavoriteSnapshot(favorites) {
  const next = Object.create(null);
  if (favorites && typeof favorites === 'object') {
    Object.entries(favorites).forEach(([number, status]) => {
      const normalizedStatus = normalizeFavoriteStatusAction(status);
      const key = String(number || '').trim();
      if (!key || !normalizedStatus) return;
      next[key] = normalizedStatus;
    });
  }
  boardFavoriteStatusByNumber = next;
  if (magnetMenuCurrentTarget) {
    renderMagnetQuickMenuOptions(magnetMenuCurrentTarget);
    highlightMagnetQuickMenuSelection(resolveMagnetQuickMenuState(magnetMenuCurrentTarget));
  }
}

function applyBoardFavoriteUpdate(studentNumber, favoriteStatus) {
  const key = String(studentNumber || '').trim();
  if (!key) return;
  const normalizedStatus = normalizeFavoriteStatusAction(favoriteStatus);
  if (!normalizedStatus) {
    delete boardFavoriteStatusByNumber[key];
  } else {
    boardFavoriteStatusByNumber[key] = normalizedStatus;
  }
  if (magnetMenuCurrentTarget && String(magnetMenuCurrentTarget.dataset.number || '') === key) {
    renderMagnetQuickMenuOptions(magnetMenuCurrentTarget);
    highlightMagnetQuickMenuSelection(resolveMagnetQuickMenuState(magnetMenuCurrentTarget));
  }
}

async function loadBoardFavorites() {
  if (!grade || !section) return {};
  try {
    const res = await fetch(`/api/classes/favorites?grade=${grade}&section=${section}`, {
      credentials: 'include',
      cache: 'no-store'
    });
    if (!res.ok) {
      throw new Error(`favorites load failed: ${res.status}`);
    }
    const payload = await res.json();
    applyBoardFavoriteSnapshot(payload && payload.favorites);
    return boardFavoriteStatusByNumber;
  } catch (err) {
    console.warn('[favorites] load failed', err);
    applyBoardFavoriteSnapshot({});
    return boardFavoriteStatusByNumber;
  }
}

window.loadBoardFavorites = loadBoardFavorites;
window.applyBoardFavoriteUpdate = applyBoardFavoriteUpdate;

function buildMagnetMenuOptions(target) {
  const favoriteAction = target ? getBoardFavoriteAction(target.dataset.number) : null;
  const items = [];
  if (favoriteAction) {
    items.push({
      label: `★ 즐겨찾기 · ${FAVORITE_STATUS_LABELS[favoriteAction]}`,
      value: favoriteAction,
      favorite: true
    });
  }
  MAGNET_MENU_OPTIONS.forEach((option) => {
    if (favoriteAction && option.value === favoriteAction) {
      return;
    }
    items.push({ ...option, favorite: false });
  });
  return items;
}

function renderMagnetQuickMenuOptions(target) {
  if (!magnetMenuActionsHost) return;
  const options = buildMagnetMenuOptions(target);
  magnetMenuActionsHost.innerHTML = '';
  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'magnet-quick-menu__item';
    if (opt.favorite) {
      btn.classList.add('magnet-quick-menu__item--favorite');
    }
    btn.dataset.action = opt.value;
    btn.setAttribute('role', 'menuitem');
    btn.textContent = opt.label;
    magnetMenuActionsHost.appendChild(btn);
  });
  requestAnimationFrame(() => {
    if (magnetMenuLastOrigin) {
      positionMagnetQuickMenu(magnetMenuLastOrigin.clientX, magnetMenuLastOrigin.clientY);
    }
  });
}

function resolveMagnetTapAction(target) {
  const currentAction = resolveMagnetQuickMenuState(target);
  if (currentAction === 'classroom') {
    return getBoardFavoriteAction(target.dataset.number) || 'toilet';
  }
  return 'classroom';
}

function handleMagnetTapAction(target) {
  if (!target) return false;
  const action = resolveMagnetTapAction(target);
  if (!action) return false;
  applyMagnetQuickAction(target, action);
  return true;
}

function returnMagnetToClassroomByNumber(number, options = {}) {
  const magnet = document.querySelector(`.magnet[data-number="${number}"]:not(.placeholder)`);
  if (!magnet) return false;
  applyMagnetQuickAction(magnet, 'classroom', options);
  return true;
}

window.returnMagnetToClassroomByNumber = returnMagnetToClassroomByNumber;

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

  // 프로필 헤더 섹션 추가
  const profileHeader = document.createElement('div');
  profileHeader.className = 'magnet-menu-profile';
  profileHeader.id = 'magnetMenuProfile';
  magnetMenuPanel.appendChild(profileHeader);

  // 구분선 추가
  const separator = document.createElement('div');
  separator.className = 'magnet-menu-separator';
  magnetMenuPanel.appendChild(separator);

  magnetMenuActionsHost = document.createElement('div');
  magnetMenuActionsHost.className = 'magnet-quick-menu__actions';
  magnetMenuPanel.appendChild(magnetMenuActionsHost);

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

function repositionMagnetQuickMenu() {
  if (!magnetMenuLastOrigin) return;
  positionMagnetQuickMenu(magnetMenuLastOrigin.clientX, magnetMenuLastOrigin.clientY);
}

async function loadMagnetProfile(studentNumber, grade, section) {
  try {
    const res = await fetch(
      `/api/classes/chat/profile/${studentNumber}?grade=${grade}&section=${section}`,
      { credentials: 'include' }
    );

    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('Failed to load magnet profile:', err);
    return null;
  }
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return '방금';
  if (diffMins < 60) return `${diffMins}분 전`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}시간 전`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}일 전`;
}

function renderMagnetMenuProfile(profile, studentNumber) {
  const container = document.getElementById('magnetMenuProfile');
  if (!container) return;

  container.innerHTML = '';

  // 아바타와 닉네임을 담을 컨테이너
  const avatarContainer = document.createElement('div');
  avatarContainer.style.display = 'flex';
  avatarContainer.style.flexDirection = 'column';
  avatarContainer.style.alignItems = 'center';
  avatarContainer.style.gap = '8px';

  // 아바타
  const avatar = document.createElement('div');
  avatar.className = 'magnet-menu-avatar';

  if (profile && profile.avatar) {
    const { imageUrl, bgColor, emoji } = profile.avatar;

    if (imageUrl) {
      avatar.classList.add('has-image');
      avatar.style.backgroundImage = `url(${imageUrl})`;
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
    } else if (bgColor) {
      avatar.style.background = `linear-gradient(135deg, ${bgColor}, ${bgColor}dd)`;
    }

    if (emoji && !imageUrl) {
      const emojiEl = document.createElement('span');
      emojiEl.className = 'avatar-emoji';
      emojiEl.textContent = emoji;
      avatar.appendChild(emojiEl);
    } else if (!imageUrl) {
      avatar.textContent = String(studentNumber).padStart(2, '0');
    }
  } else {
    avatar.textContent = String(studentNumber).padStart(2, '0');
    avatar.classList.add(`avatar-color-${studentNumber % 10}`);
  }

  // 닉네임
  const nickname = document.createElement('div');
  nickname.className = 'magnet-menu-nickname';
  nickname.textContent = (profile && profile.nickname) || `${studentNumber}번`;

  avatarContainer.appendChild(avatar);
  avatarContainer.appendChild(nickname);
  container.appendChild(avatarContainer);

  // 마지막 메시지 (있으면)
  if (profile && profile.lastMessage) {
    const lastMsgContainer = document.createElement('div');
    lastMsgContainer.className = 'magnet-menu-last-message';

    const msgText = document.createElement('div');
    msgText.className = 'last-message-text';
    msgText.textContent = profile.lastMessage;

    const msgTime = document.createElement('div');
    msgTime.className = 'last-message-time';
    msgTime.textContent = formatTimeAgo(profile.lastMessageAt);

    lastMsgContainer.appendChild(msgText);
    lastMsgContainer.appendChild(msgTime);
    container.appendChild(lastMsgContainer);
  } else {
    // 메시지 없음
    const noMsg = document.createElement('div');
    noMsg.className = 'magnet-menu-no-message';
    noMsg.textContent = '메시지를 보낸 적이 없습니다';
    container.appendChild(noMsg);
  }
  requestAnimationFrame(repositionMagnetQuickMenu);
}

async function openMagnetQuickMenu(target, origin) {
  clearMagnetGroup({ restore: true });
  const overlay = ensureMagnetQuickMenuElements();
  magnetMenuCurrentTarget = target;
  magnetMenuLastOrigin = {
    clientX: Number(origin?.clientX) || 0,
    clientY: Number(origin?.clientY) || 0
  };
  overlay.hidden = false;

  renderMagnetQuickMenuOptions(target);
  repositionMagnetQuickMenu();
  const currentAction = resolveMagnetQuickMenuState(target);
  highlightMagnetQuickMenuSelection(currentAction);

  // 프로필 로딩 및 렌더링
  const studentNumber = parseInt(target.dataset.number, 10);
  if (studentNumber && grade && section) {
    const profile = await loadMagnetProfile(studentNumber, grade, section);
    renderMagnetMenuProfile(profile, studentNumber);
  }

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
  magnetMenuLastOrigin = null;
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
    triggerCategoryBurst(target, action);

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
  updatePlaceholderStatusBadges();
  if (typeof window.updateThoughtBubblePositionForMagnet === 'function') {
    window.updateThoughtBubblePositionForMagnet(target);
  }
  if (window.boardCosmetics && typeof window.boardCosmetics.playMoveEffect === 'function') {
    window.boardCosmetics.playMoveEffect(target, action);
  }
  if (!skipSave) {
    saveState(grade, section);
  }
}

function ensureMagnetQuickDropOverlay() {
  if (magnetQuickDropOverlay) {
    return magnetQuickDropOverlay;
  }

  const container = document.getElementById('magnetContainer');
  if (!container) return null;

  magnetQuickDropOverlay = document.createElement('div');
  magnetQuickDropOverlay.id = 'magnetQuickDropOverlay';
  magnetQuickDropOverlay.className = 'magnet-quick-drop-overlay';
  magnetQuickDropOverlay.setAttribute('aria-hidden', 'true');
  magnetQuickDropOverlay.hidden = true;

  MAGNET_QUICK_DROP_TARGETS.forEach(option => {
    const cell = document.createElement('div');
    cell.className = 'magnet-quick-drop-cell';
    cell.dataset.action = option.value;
    cell.innerHTML = `
      <span class="magnet-quick-drop-cell__icon">${option.icon}</span>
      <span class="magnet-quick-drop-cell__label">${option.label}</span>
    `;
    magnetQuickDropOverlay.appendChild(cell);
  });

  const cancelCell = document.createElement('div');
  cancelCell.className = 'magnet-quick-drop-cell magnet-quick-drop-cell--cancel';
  cancelCell.dataset.action = MAGNET_QUICK_DROP_CANCEL_ACTION;
  cancelCell.innerHTML = `
    <span class="magnet-quick-drop-cell__icon">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 5 10l4-4"/><path d="M5 10h9a5 5 0 0 1 0 10h-3"/></svg>
    </span>
    <span class="magnet-quick-drop-cell__label">교실로 복귀</span>
  `;
  magnetQuickDropOverlay.appendChild(cancelCell);

  container.appendChild(magnetQuickDropOverlay);
  return magnetQuickDropOverlay;
}

function getMagnetClassroomBounds(container) {
  const nodes = Array.from(container.querySelectorAll('.magnet.placeholder'));
  const containerRect = container.getBoundingClientRect();
  let minLeft = Number.POSITIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  let maxBottom = Number.NEGATIVE_INFINITY;

  nodes.forEach(node => {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    minLeft = Math.min(minLeft, rect.left - containerRect.left);
    minTop = Math.min(minTop, rect.top - containerRect.top);
    maxRight = Math.max(maxRight, rect.right - containerRect.left);
    maxBottom = Math.max(maxBottom, rect.bottom - containerRect.top);
  });

  if (!Number.isFinite(minLeft)) {
    Object.values(gridPos).forEach(pos => {
      if (!pos) return;
      minLeft = Math.min(minLeft, pos.left);
      minTop = Math.min(minTop, pos.top);
      maxRight = Math.max(maxRight, pos.left + 56);
      maxBottom = Math.max(maxBottom, pos.top + 56);
    });
  }

  if (!Number.isFinite(minLeft)) return null;

  const padding = 12;
  const minPanelWidth = 260;
  const minPanelHeight = 320;
  const rawLeft = Math.max(0, minLeft - padding);
  const rawTop = Math.max(0, minTop - padding);
  const rawWidth = Math.max(0, maxRight - minLeft + padding * 2);
  const rawHeight = Math.max(0, maxBottom - minTop + padding * 2);
  const width = Math.min(containerRect.width, Math.max(minPanelWidth, rawWidth));
  const height = Math.min(containerRect.height, Math.max(minPanelHeight, rawHeight));
  const left = Math.min(rawLeft, Math.max(0, containerRect.width - width));
  const top = Math.min(rawTop, Math.max(0, containerRect.height - height));

  return {
    left,
    top,
    width,
    height,
  };
}

function positionMagnetQuickDropOverlay(overlay) {
  const container = document.getElementById('magnetContainer');
  if (!container || !overlay) return;
  const bounds = getMagnetClassroomBounds(container);
  if (!bounds) return;
  overlay.style.left = `${bounds.left}px`;
  overlay.style.top = `${bounds.top}px`;
  overlay.style.width = `${bounds.width}px`;
  overlay.style.height = `${bounds.height}px`;
}

function showMagnetQuickDropOverlay() {
  const overlay = ensureMagnetQuickDropOverlay();
  if (!overlay) return;
  positionMagnetQuickDropOverlay(overlay);
  overlay.hidden = false;
  if (magnetQuickDropFrameId !== null) {
    cancelAnimationFrame(magnetQuickDropFrameId);
  }
  magnetQuickDropFrameId = requestAnimationFrame(() => {
    magnetQuickDropFrameId = null;
    if (!overlay.hidden) {
      overlay.classList.add('is-visible');
    }
  });
}

function hideMagnetQuickDropOverlay() {
  if (!magnetQuickDropOverlay) return;
  if (magnetQuickDropFrameId !== null) {
    cancelAnimationFrame(magnetQuickDropFrameId);
    magnetQuickDropFrameId = null;
  }
  magnetQuickDropOverlay.classList.remove('is-visible');
  magnetQuickDropOverlay.querySelectorAll('.magnet-quick-drop-cell.is-hovered').forEach(cell => {
    cell.classList.remove('is-hovered');
  });
  magnetQuickDropOverlay.hidden = true;
  magnetQuickDropActiveAction = null;
}

function setMagnetQuickDropHover(action) {
  if (!magnetQuickDropOverlay || magnetQuickDropOverlay.hidden) return;
  magnetQuickDropActiveAction = action || null;
  magnetQuickDropOverlay.querySelectorAll('.magnet-quick-drop-cell').forEach(cell => {
    cell.classList.toggle('is-hovered', Boolean(action) && cell.dataset.action === action);
  });
}

function getMagnetQuickDropActionAt(clientX, clientY) {
  if (!magnetQuickDropOverlay || magnetQuickDropOverlay.hidden) return null;
  const cells = magnetQuickDropOverlay.querySelectorAll('.magnet-quick-drop-cell');
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const rect = cell.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return cell.dataset.action || null;
    }
  }
  return null;
}

function shouldShowMagnetQuickDropFor(magnet) {
  return Boolean(
    magnet &&
    !magnet.classList.contains('placeholder') &&
    !magnet.classList.contains('attached')
  );
}

function applyMagnetQuickDropAction(action, magnets) {
  if (!action || !Array.isArray(magnets) || !magnets.length) return false;
  const nextAction = action === MAGNET_QUICK_DROP_CANCEL_ACTION ? 'classroom' : action;
  const targets = magnets.filter(Boolean);
  const shouldDeferReason = nextAction === 'etc' && targets.length > 1;
  const groupReasonTargets = shouldDeferReason ? targets : null;
  const needsReasonPrompt = shouldDeferReason
    ? groupReasonTargets.some(magnet => {
        const reason = (magnet.dataset.reason || '').trim();
        return reason.length === 0;
      })
    : false;

  targets.forEach(magnet => {
    applyMagnetQuickAction(magnet, nextAction, {
      skipSave: true,
      deferReasonDialog: shouldDeferReason
    });
  });
  updateAttendance();
  updateMagnetOutline();
  updateEtcReasonPanel();
  updatePlaceholderStatusBadges();
  saveState(grade, section);
  if (shouldDeferReason && needsReasonPrompt && groupReasonTargets && groupReasonTargets.length) {
    openReasonDialog(groupReasonTargets);
  }
  return true;
}

document.addEventListener('visibilitychange', () => {
  hideMagnetQuickDropOverlay();
  closeEtcReasonPopover();
});

window.addEventListener('resize', () => {
  positionMagnetMultiSelectToggle();
  if (magnetQuickDropOverlay && !magnetQuickDropOverlay.hidden) {
    positionMagnetQuickDropOverlay(magnetQuickDropOverlay);
  }
  positionEtcReasonPopover();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (etcReasonPopover && !etcReasonPopover.hidden) {
    closeEtcReasonPopover();
    return;
  }
  if (!magnetMultiSelectEnabled) return;
  if (getValidMultiSelectedMagnets().length) {
    clearMagnetMultiSelection();
  } else {
    setMagnetMultiSelectMode(false);
  }
});

document.addEventListener('click', (event) => {
  if (!etcReasonPopover || etcReasonPopover.hidden) return;
  const target = event.target;
  if (
    etcReasonPopover.contains(target) ||
    (etcReasonShortcutButton && etcReasonShortcutButton.contains(target))
  ) {
    return;
  }
  closeEtcReasonPopover();
});

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
  updatePlaceholderStatusBadges();

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
  const magnet = document.querySelector(`.magnet[data-number="${number}"]:not(.placeholder)`);
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
window.boardGrade = grade;
window.boardSection = section;

function createPlaceholder(num) {
  if (placeholders.has(num)) return;
  const pos = gridPos[num];
  if (!pos) return;
  const p = document.createElement('div');
  p.className = 'magnet placeholder';
  p.textContent = num;
  p.dataset.placeholderNumber = String(num);
  p.style.left = pos.left + 'px';
  p.style.top  = pos.top  + 'px';
  p.setAttribute('role', 'button');
  p.setAttribute('aria-label', `${num}번 자석을 교실로 복귀`);
  p.tabIndex = 0;
  p.addEventListener('click', () => returnMagnetToClassroomByNumber(num));
  p.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      returnMagnetToClassroomByNumber(num);
    }
  });
  document.getElementById('magnetContainer').appendChild(p);
  placeholders.set(num, p);
}

/* ===================== 자석 생성 ===================== */
function createMagnets(end = 31, skipNumbers = [12]) {
  const container = document.getElementById('magnetContainer');
  const rows = 7, cols = 5, size = 56, gap = 18;
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
      if (window.boardCosmetics && typeof window.boardCosmetics.applyAuraToMagnet === 'function') {
        window.boardCosmetics.applyAuraToMagnet(m);
      }

      n++;
    }
  }

  const total = container.querySelectorAll('.magnet:not(.placeholder)').length;
  const tc = document.getElementById('total-count');
  if (tc) tc.textContent = `${total}명`;

  ensureMagnetMultiSelectToggle();
  updatePlaceholderStatusBadges();
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
function ensureSectionCountIndicator(section) {
  if (!section || section.dataset.category === 'etc') return null;
  const title = section.querySelector('.section-title');
  if (!title) return null;

  let indicator = title.querySelector('.section-count-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'section-count-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    title.appendChild(indicator);
  }
  return indicator;
}

function updateSectionCountIndicator(section, count) {
  const indicator = ensureSectionCountIndicator(section);
  if (!indicator) return;

  if (!count) {
    indicator.hidden = true;
    indicator.textContent = '';
    indicator.removeAttribute('title');
    return;
  }

  indicator.hidden = false;
  indicator.textContent = `${count}명`;
  indicator.title = `${count}명`;
}

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
    updateSectionCountIndicator(section, n);
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

function formatEtcReasonText(reason) {
  if (reason === '여우사이') return '🦊 ' + reason;
  if (reason === '자퇴') return '😭 ' + reason;
  return reason;
}

function createReasonRow(reason, nums) {
  const row = document.createElement('div');
  row.className = 'reason-item';

  const badges = document.createElement('div');
  badges.className = 'badges';

  nums.forEach(n => {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = n;

    const mag = document.querySelector(`.magnet[data-number="${n}"]:not(.placeholder)`);
    if (mag) {
      mag.classList.forEach(cls => {
        if (cls.startsWith('color-')) b.classList.add(cls);
      });

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
  text.textContent = formatEtcReasonText(reason);
  text.title = reason;

  row.appendChild(badges);
  row.appendChild(text);
  return row;
}

function clearPlaceholderStatusBadge(placeholder) {
  if (!placeholder) return;
  placeholder.classList.remove('has-status-badge');
  placeholder.removeAttribute('data-status-category');
  placeholder.removeAttribute('title');
  const badge = placeholder.querySelector('.placeholder-status-badge');
  if (badge) {
    badge.remove();
  }
  const number = placeholder.dataset.placeholderNumber || placeholder.textContent.trim();
  if (number) {
    placeholder.setAttribute('aria-label', `${number}번 자석을 교실로 복귀`);
  }
}

function setPlaceholderStatusBadge(placeholder, category, magnet) {
  const config = PLACEHOLDER_STATUS_BADGES[category];
  if (!placeholder || !config) return;
  let badge = placeholder.querySelector('.placeholder-status-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'placeholder-status-badge';
    placeholder.appendChild(badge);
  }

  const number = placeholder.dataset.placeholderNumber || placeholder.textContent.trim();
  const reason = category === 'etc' ? (magnet?.dataset?.reason || '').trim() : '';
  const title = reason ? `${config.title} · ${reason}` : config.title;

  badge.textContent = category === 'etc' && reason
    ? (reason.length <= 3 ? reason : `${reason.slice(0, 2)}..`)
    : config.label;
  placeholder.classList.add('has-status-badge');
  placeholder.dataset.statusCategory = category;
  placeholder.title = title;
  placeholder.setAttribute('aria-label', `${number}번 자석 현재 위치: ${title}. 클릭하면 교실로 복귀`);
}

function updatePlaceholderStatusBadges() {
  placeholders.forEach(placeholder => clearPlaceholderStatusBadge(placeholder));

  document.querySelectorAll('.board-section[data-category]').forEach(section => {
    const category = section.dataset.category;
    if (!PLACEHOLDER_STATUS_BADGES[category]) return;
    section.querySelectorAll('.section-content .magnet:not(.placeholder)').forEach(magnet => {
      const number = Number(magnet.dataset.number);
      if (!Number.isFinite(number)) return;
      const placeholder = placeholders.get(number);
      setPlaceholderStatusBadge(placeholder, category, magnet);
    });
  });
}

window.updatePlaceholderStatusBadges = updatePlaceholderStatusBadges;

function ensureEtcReasonShortcut() {
  if (etcReasonShortcutButton && etcReasonPopover && etcReasonPopoverList) {
    return true;
  }

  const section = document.querySelector('.board-section[data-category="etc"]');
  const title = section?.querySelector('.section-title');
  if (!section || !title) return false;

  if (!etcReasonShortcutButton) {
    etcReasonShortcutButton = document.createElement('button');
    etcReasonShortcutButton.type = 'button';
    etcReasonShortcutButton.className = 'etc-reason-shortcut';
    etcReasonShortcutButton.hidden = true;
    etcReasonShortcutButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (etcReasonPopover && !etcReasonPopover.hidden) {
        closeEtcReasonPopover();
      } else {
        openEtcReasonPopover();
      }
    });
    etcReasonShortcutButton.addEventListener('mousedown', event => event.stopPropagation());
    etcReasonShortcutButton.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
    title.appendChild(etcReasonShortcutButton);
  }

  if (!etcReasonPopover) {
    etcReasonPopover = document.createElement('div');
    etcReasonPopover.className = 'etc-reason-popover';
    etcReasonPopover.hidden = true;
    etcReasonPopover.innerHTML = `
      <div class="etc-reason-popover__title">기타 사유</div>
      <div class="etc-reason-popover__list"></div>
    `;
    etcReasonPopover.addEventListener('click', event => event.stopPropagation());
    etcReasonPopoverList = etcReasonPopover.querySelector('.etc-reason-popover__list');
    document.body.appendChild(etcReasonPopover);
  }

  return Boolean(etcReasonShortcutButton && etcReasonPopover && etcReasonPopoverList);
}

function renderEtcReasonPopoverList() {
  if (!etcReasonPopoverList) return;
  etcReasonPopoverList.innerHTML = '';
  etcReasonPopoverEntries.forEach(([reason, nums]) => {
    etcReasonPopoverList.appendChild(createReasonRow(reason, nums));
  });
}

function positionEtcReasonPopover() {
  if (!etcReasonShortcutButton || !etcReasonPopover || etcReasonPopover.hidden) return;

  const buttonRect = etcReasonShortcutButton.getBoundingClientRect();
  const popoverRect = etcReasonPopover.getBoundingClientRect();
  const margin = 12;
  const gap = 10;
  let left = buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2;
  let top = buttonRect.top - popoverRect.height - gap;

  left = Math.max(margin, Math.min(left, window.innerWidth - popoverRect.width - margin));
  if (top < margin) {
    top = Math.min(window.innerHeight - popoverRect.height - margin, buttonRect.bottom + gap);
    etcReasonPopover.classList.add('is-below');
  } else {
    etcReasonPopover.classList.remove('is-below');
  }
  etcReasonPopover.style.left = `${Math.max(margin, left)}px`;
  etcReasonPopover.style.top = `${Math.max(margin, top)}px`;
}

function openEtcReasonPopover() {
  if (!ensureEtcReasonShortcut() || !etcReasonPopoverEntries.length) return;
  renderEtcReasonPopoverList();
  etcReasonPopover.hidden = false;
  etcReasonShortcutButton.classList.add('is-open');
  etcReasonShortcutButton.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    positionEtcReasonPopover();
    etcReasonPopover.classList.add('is-visible');
  });
}

function closeEtcReasonPopover() {
  if (etcReasonShortcutButton) {
    etcReasonShortcutButton.classList.remove('is-open');
    etcReasonShortcutButton.setAttribute('aria-expanded', 'false');
  }
  if (!etcReasonPopover) return;
  etcReasonPopover.classList.remove('is-visible', 'is-below');
  etcReasonPopover.hidden = true;
}

function renderEtcReasonShortcut(entries) {
  etcReasonPopoverEntries = Array.isArray(entries) ? entries : [];
  if (!ensureEtcReasonShortcut()) return;

  const count = etcReasonPopoverEntries.reduce((total, [, nums]) => total + nums.length, 0);
  if (!count) {
    etcReasonShortcutButton.hidden = true;
    closeEtcReasonPopover();
    return;
  }

  etcReasonShortcutButton.hidden = false;
  etcReasonShortcutButton.innerHTML = `<span>사유 ${count}</span><span aria-hidden="true">›</span>`;
  etcReasonShortcutButton.setAttribute('aria-expanded', String(Boolean(etcReasonPopover && !etcReasonPopover.hidden)));
  if (etcReasonPopover && !etcReasonPopover.hidden) {
    renderEtcReasonPopoverList();
    positionEtcReasonPopover();
  }
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
        const fireworks = window.createBoardFireworks
          ? window.createBoardFireworks(container)
          : new Fireworks.default(container);
        fireworks.start();
        setTimeout(() => fireworks.stop(true), 7000);
      }
      nums.forEach(n => {
        const mag = document.querySelector(`.magnet[data-number="${n}"][data-reason="${reason}"]:not(.placeholder)`);
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
        const mag = document.querySelector(`.magnet[data-number="${n}"][data-reason="${reason}"]:not(.placeholder)`);
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
        const mag = document.querySelector(`.magnet[data-number="${n}"][data-reason="${reason}"]:not(.placeholder)`);
        if (mag) {
          delete mag.dataset.reason;
          mag.classList.remove('has-reason');
          shouldSaveState = true;
        }
      });
      groups.delete(reason);
    }

    // Deprecated seasonal commands: remove reason tag only (no visual effect).
    else if (reason === '!snow' || reason === '!christmas') {
      nums.forEach(n => {
        const mag = document.querySelector(`.magnet[data-number="${n}"][data-reason="${reason}"]:not(.placeholder)`);
        if (mag) {
          delete mag.dataset.reason;
          mag.classList.remove('has-reason');
          shouldSaveState = true;
        }
      });
      groups.delete(reason);
    }

    else if (reason === '!reload') {
      window.location.reload();
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
    renderEtcReasonShortcut(entries);
    const empty = document.createElement('div');
    empty.textContent = '현재 등록된 기타 사유가 없습니다.';
    empty.style.opacity = '0.7';
    list.appendChild(empty);
    return;
  }

  entries.forEach(([reason, nums]) => {
    list.appendChild(createReasonRow(reason, nums));
  });
  renderEtcReasonShortcut(entries);
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
  let quickDropEligible = false;
  let multiSelectWasSelectedAtPress = false;

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
    quickDropEligible = false;
    multiSelectWasSelectedAtPress = false;
    window.isMagnetDragging = false;
    activeTouchId = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.board-section').forEach(sec => sec.classList.remove('drag-over'));
    hideMagnetQuickDropOverlay();
  }

  function triggerLongPress(x, y) {
    longPressTriggered = true;
    clearLongPressTimer();
    hideMagnetQuickDropOverlay();
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
      updatePlaceholderStatusBadges();
      saveState(grade, section);
    }
  }

  function dragStart(e) {
    if (e.type === 'mousedown' && e.button !== 0) return;
    closeEtcReasonPopover();

    const isTouchStart = e.type === 'touchstart';
    const pointerType = e.pointerType || (isTouchStart ? 'touch' : 'mouse');

    if (!magnetMultiSelectEnabled && (pointerType === 'touch' || pointerType === 'pen')) {
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
    } else if (!magnetMultiSelectEnabled && magnetGroup.leader && magnetGroup.leader !== el) {
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
    quickDropEligible = shouldShowMagnetQuickDropFor(el);
    multiSelectWasSelectedAtPress = magnetMultiSelected.has(el);
    if (magnetMultiSelectEnabled && !multiSelectWasSelectedAtPress) {
      setMagnetMultiSelected(el, true);
    }

    startClientX = pos.clientX;
    startClientY = pos.clientY;
    pressClientX = pos.clientX;
    pressClientY = pos.clientY;
    startLeft = parseFloat(el.style.left) || 0;
    startTop = parseFloat(el.style.top) || 0;

    if (!magnetMultiSelectEnabled) {
      longPressTimer = setTimeout(() => triggerLongPress(pos.clientX, pos.clientY), LONG_PRESS_DELAY);
    }

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
        if (magnetMultiSelectEnabled) {
          hideMagnetMultiSelectHint({ persist: true });
          startMagnetGroupFromMultiSelection(el);
        }
        isDragging = true;
        window.isMagnetDragging = true;
        el.classList.add('dragging');
        if (quickDropEligible) {
          showMagnetQuickDropOverlay();
        }
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
    if (quickDropEligible) {
      setMagnetQuickDropHover(getMagnetQuickDropActionAt(clientX, clientY));
    }
    if (window.boardCosmetics && typeof window.boardCosmetics.emitDragTrail === 'function') {
      window.boardCosmetics.emitDragTrail(el, clientX, clientY);
    }

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
    const quickDropAction = quickDropEligible ? magnetQuickDropActiveAction : null;

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
        updatePlaceholderStatusBadges();
        saveState(grade, section);

        if (shouldDeferReason && needsReasonPrompt && groupReasonTargets && groupReasonTargets.length) {
          openReasonDialog(groupReasonTargets);
        }
      }
    } else if (applyMagnetQuickDropAction(quickDropAction, magnetsToHandle)) {
      // Quick-drop handled; keep right-side board sections as the higher-priority drop target.
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
      updatePlaceholderStatusBadges();
      saveState(grade, section);
    }

    if (isGroupLeader) {
      clearMagnetGroup();
    }
    hideMagnetQuickDropOverlay();
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

    let handledTapAction = false;
    if (isDragging) {
      dropMagnet();
      if (magnetMultiSelectEnabled) {
        setMagnetMultiSelectMode(false);
      }
    } else if (isPointerDown && magnetMultiSelectEnabled) {
      if (multiSelectWasSelectedAtPress) {
        setMagnetMultiSelected(el, false);
      }
      handledTapAction = true;
    } else if (
      isPointerDown &&
      !longPressTriggered &&
      (!magnetGroup.leader || magnetGroup.leader === el) &&
      magnetGroup.members.length === 0
    ) {
      handledTapAction = handleMagnetTapAction(el);
    }

    if (!isDragging && magnetGroup.leader === el) {
      clearMagnetGroup({ restore: !handledTapAction });
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
    if (magnetMultiSelectEnabled && isDragging) {
      setMagnetMultiSelectMode(false);
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

function normalizeReasonHistoryText(reason) {
  const text = String(reason || '').trim();
  if (!text || text.length > ETC_REASON_HISTORY_MAX_LENGTH) return '';
  if (text.startsWith('!')) return '';
  return text;
}

function loadReasonHistory() {
  try {
    const raw = localStorage.getItem(ETC_REASON_HISTORY_KEY);
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(item => {
        const text = normalizeReasonHistoryText(item?.text);
        if (!text) return null;
        const usedAt = Number(item?.usedAt);
        const count = Number(item?.count);
        return {
          text,
          usedAt: Number.isFinite(usedAt) ? usedAt : 0,
          count: Number.isFinite(count) && count > 0 ? count : 1
        };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function saveReasonHistory(history) {
  try {
    localStorage.setItem(ETC_REASON_HISTORY_KEY, JSON.stringify(history));
  } catch (_) {
    // localStorage can be blocked; reason saving should still succeed.
  }
}

function rememberReasonHistory(reason) {
  const text = normalizeReasonHistoryText(reason);
  if (!text) return;

  const now = Date.now();
  const history = loadReasonHistory();
  const existing = history.find(item => item.text === text);
  if (existing) {
    existing.usedAt = now;
    existing.count += 1;
  } else {
    history.push({ text, usedAt: now, count: 1 });
  }

  history.sort((a, b) => (b.usedAt - a.usedAt) || (b.count - a.count) || a.text.localeCompare(b.text, 'ko'));
  saveReasonHistory(history.slice(0, ETC_REASON_HISTORY_LIMIT));
}

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

function collectReasonSuggestions() {
  const suggestions = [];
  const seen = new Set();

  collectExistingReasons().forEach(reason => {
    if (!seen.has(reason)) {
      seen.add(reason);
      suggestions.push(reason);
    }
  });

  loadReasonHistory()
    .sort((a, b) => (b.usedAt - a.usedAt) || (b.count - a.count) || a.text.localeCompare(b.text, 'ko'))
    .forEach(item => {
      if (!seen.has(item.text)) {
        seen.add(item.text);
        suggestions.push(item.text);
      }
    });

  return suggestions.slice(0, ETC_REASON_HISTORY_LIMIT);
}

function setReasonQuickVisibility(host, isVisible) {
  const wrap = host?.closest?.('.reason-quick');
  if (wrap) {
    wrap.hidden = !isVisible;
  }
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

  const list = collectReasonSuggestions();
  host.innerHTML = '';
  setReasonQuickVisibility(host, list.length > 0);

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
  rememberReasonHistory(text);

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
  updatePlaceholderStatusBadges();
  saveState(grade, section);

  // 새 이유가 생겼을 수 있으니 버튼 재렌더(모달 외부에서도 최신 유지)
  renderReasonButtons();
});

/* 취소 */
document.getElementById('reasonCancel').addEventListener('click', () => {
  closeReasonDialog();
  updateEtcReasonPanel();
  updatePlaceholderStatusBadges();
  renderReasonButtons();
});

/* 오버레이 클릭 닫기 */
document.getElementById('reasonOverlay').addEventListener('mousedown', (e) => {
  if (e.target.id === 'reasonOverlay') {
    closeReasonDialog();
    updateEtcReasonPanel();
    updatePlaceholderStatusBadges();
    renderReasonButtons();
  }
});

/* ESC 닫기 */
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('reasonOverlay');
  if (e.key === 'Escape' && overlay && !overlay.hidden) {
    closeReasonDialog();
    updateEtcReasonPanel();
    updatePlaceholderStatusBadges();
    renderReasonButtons();
  }
});
