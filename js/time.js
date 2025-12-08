/* ===================== 전체화면/시계 ===================== */
function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        document.body.classList.add('fullscreen');
      }).catch(()=>{});
    }
  }
  function exitFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().then(() => {
        document.body.classList.remove('fullscreen');
      }).catch(()=>{});
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('fullscreen');
  });

const AUTO_RETURN_SCHEDULES = [
  { key: 'club', category: 'club', minutes: 10 * 60 + 50 },
  { key: 'afterschool', category: 'afterschool', minutes: 18 * 60 + 35 }
];
const autoReturnState = Object.create(null);

function canSyncWithBackend() {
  const monitor = window.connectionMonitor;
  if (!monitor || typeof monitor.isOffline !== 'function') {
    return true;
  }
  return !monitor.isOffline();
}

const ROUTINE_ALLOWED_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
let routineData = { afterschool: {}, club: {} };
let routineLoaded = false;
let routineLoading = false;
const routinePromptState = Object.create(null);
const ROUTINE_LABELS = { afterschool: '방과후', club: '동아리' };

const SUNEUNG_MONTH = 10; // 0-indexed (11월)
const SUNEUNG_DAY = 13;
const POST_SUNEUNG_START_DAY = 14;
const POST_SUNEUNG_OFFSET_MINUTES = 10;
const POST_SUNEUNG_MESSAGE_TEXT = '10분 더 해라';
const POST_SUNEUNG_HOLD_VALUE = '10';

const WEEKDAY_PHASES = Object.freeze([
  { label: '아침 시간',    startMin: 0,              endMin: 8*60 + 15 },
  { label: '아침 자습',    startMin: 8*60 + 15,      endMin: 8*60 + 50 },
  { label: '아침 조회',    startMin: 8*60 + 50,      endMin: 9*60      },
  { label: '오전 수업 시간', startMin: 9*60,          endMin: 12*60 + 50 },
  { label: '점심 시간',    startMin: 12*60 + 50,     endMin: 13*60 + 10 },
  { label: '오후 수업 시간', startMin: 13*60,         endMin: 16*60 + 40 },
  { label: '청소 시간',    startMin: 16*60 + 40,     endMin: 17*60 },
  { label: '종례',        startMin: 17*60,          endMin: 17*60 + 10 },
  { label: '방과후 1타임', startMin: 17*60 + 10,     endMin: 17*60 + 50 },
  { label: '쉬는 시간',    startMin: 17*60 + 50,     endMin: 17*60 + 55 },
  { label: '방과후 2타임', startMin: 17*60 + 55,     endMin: 18*60 + 35 },
  { label: '저녁 시간',    startMin: 18*60 + 35,     endMin: 19*60 + 50 },
  { label: '야자 1타임',   startMin: 19*60 + 50,     endMin: 21*60 + 10 },
  { label: '쉬는 시간',    startMin: 21*60 + 10,     endMin: 21*60 + 30 },
  { label: '야자 2타임',   startMin: 21*60 + 30,     endMin: 22*60 + 50 },
  { label: '끝.',         startMin: 23*60,     endMin: 24*60     }
]);

const SUNDAY_PHASES = Object.freeze([
  { label: '수감',      startMin: 0,          endMin: 20*60 },
  { label: '야자 1타임', startMin: 20*60,     endMin: 21*60 },
  { label: '쉬는 시간',  startMin: 21*60,     endMin: 21*60 + 20 },
  { label: '야자 2타임', startMin: 21*60 + 20,endMin: 22*60 + 20 },
  { label: '끝.',       startMin: 22*60 + 30,endMin: 24*60 }
]);

const CSAT_PHASES = Object.freeze([
  { label: '아침',              startMin: 0,              endMin: 9*60 },
  { label: '오전 자율학습 1',    startMin: 9*60,          endMin: 10*60 + 20 },
  { label: '휴식 시간',         startMin: 10*60 + 20,    endMin: 10*60 + 40 },
  { label: '오전 자율학습 2',    startMin: 10*60 + 40,    endMin: 12*60 },
  { label: '중식',              startMin: 12*60,         endMin: 14*60 },
  { label: '오후 자율학습 1',    startMin: 14*60,         endMin: 16*60 },
  { label: '휴식 시간',         startMin: 16*60,         endMin: 16*60 + 20 },
  { label: '오후 자율학습 2',    startMin: 16*60 + 20,    endMin: 18*60 },
  { label: '석식',              startMin: 18*60,         endMin: 20*60 },
  { label: '야간 자율학습',      startMin: 20*60,         endMin: 22*60 + 30 },
  { label: '끝',                startMin: 22*60 + 30,    endMin: 24*60 }
]);

const DEFAULT_PHASE_CONFIG = {
  weekday: WEEKDAY_PHASES,
  sunday: SUNDAY_PHASES,
  csat: CSAT_PHASES,
};

let phaseConfig = { default: DEFAULT_PHASE_CONFIG, grades: {} };
let phaseConfigPromise = null;
const PHASE_CONFIG_URL = '/timetable-phases.json';

function parseTimeToMinutes(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const hm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (hm) {
      const h = Number(hm[1]);
      const m = Number(hm[2]);
      if (!Number.isNaN(h) && !Number.isNaN(m) && m < 60) {
        return h * 60 + m;
      }
    }
  }
  return NaN;
}

function normalizePhaseEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const start = parseTimeToMinutes(entry.startMin);
  const end = parseTimeToMinutes(entry.endMin);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const label = typeof entry.label === 'string' ? entry.label : '';
  return { label, startMin: start, endMin: end };
}

function normalizePhaseMap(map) {
  if (!map || typeof map !== 'object') return null;
  const out = {};
  ['weekday', 'sunday', 'csat'].forEach((key) => {
    if (Array.isArray(map[key])) {
      const arr = map[key].map(normalizePhaseEntry).filter(Boolean);
      if (arr.length) out[key] = arr;
    }
  });
  return Object.keys(out).length ? out : null;
}

function mergePhaseConfig(json) {
  const cfg = { default: DEFAULT_PHASE_CONFIG, grades: {} };
  const def = normalizePhaseMap(json && json.default);
  if (def) {
    cfg.default = { ...DEFAULT_PHASE_CONFIG, ...def };
  }
  if (json && json.grades && typeof json.grades === 'object') {
    Object.entries(json.grades).forEach(([gradeKey, map]) => {
      const normalized = normalizePhaseMap(map);
      if (normalized) {
        cfg.grades[String(gradeKey)] = { ...cfg.default, ...normalized };
      }
    });
  }
  return cfg;
}

async function loadPhaseConfig() {
  if (phaseConfigPromise) return phaseConfigPromise;
  phaseConfigPromise = fetch(PHASE_CONFIG_URL, { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((json) => {
      phaseConfig = mergePhaseConfig(json);
      updateClock();
      return phaseConfig;
    })
    .catch((err) => {
      console.warn('Failed to load timetable-phases.json, using defaults.', err);
      phaseConfig = { default: DEFAULT_PHASE_CONFIG, grades: {} };
      return phaseConfig;
    });
  return phaseConfigPromise;
}

loadPhaseConfig();

const countdownOverlayEl = document.getElementById('countdownOverlay');
const countdownNumberEl = document.getElementById('countdownNumber');

function isPostSuneungPeriod(now) {
  const postStart = new Date(now.getFullYear(), SUNEUNG_MONTH, POST_SUNEUNG_START_DAY);
  return now >= postStart;
}

function isPostSuneungSpecialDay(now) {
  return (
    now.getMonth() === SUNEUNG_MONTH &&
    now.getDate() === POST_SUNEUNG_START_DAY
  );
}

// 수동으로 선택된 시간표 저장
let manualScheduleOverride = null;

function setManualSchedule(scheduleType) {
  if (scheduleType === null || scheduleType === 'auto') {
    manualScheduleOverride = null;
    localStorage.removeItem('manualSchedule');
  } else {
    manualScheduleOverride = scheduleType;
    localStorage.setItem('manualSchedule', scheduleType);
  }
}

function getManualSchedule() {
  if (manualScheduleOverride !== null) {
    return manualScheduleOverride;
  }
  const stored = localStorage.getItem('manualSchedule');
  if (stored) {
    manualScheduleOverride = stored;
    return stored;
  }
  return null;
}

function getGradePhaseMap() {
  const gradeKey = typeof window.boardGrade === 'string' && window.boardGrade ? window.boardGrade : null;
  if (gradeKey && phaseConfig.grades && phaseConfig.grades[gradeKey]) {
    return phaseConfig.grades[gradeKey];
  }
  return phaseConfig.default || DEFAULT_PHASE_CONFIG;
}

function getPhaseSet(scheduleType) {
  const map = getGradePhaseMap();
  const fromConfig = map && map[scheduleType];
  const fallback = DEFAULT_PHASE_CONFIG[scheduleType] || [];
  return Array.isArray(fromConfig) && fromConfig.length ? fromConfig : fallback;
}

function getPhasesForDate(now) {
  // 수동으로 설정된 시간표가 있으면 그것을 사용
  const manual = getManualSchedule();
  if (manual === 'weekday') {
    return getPhaseSet('weekday');
  } else if (manual === 'sunday') {
    return getPhaseSet('sunday');
  } else if (manual === 'csat') {
    return getPhaseSet('csat');
  }

  // 자동 모드: 요일에 따라 선택
  const base = now.getDay() === 0 ? getPhaseSet('sunday') : getPhaseSet('weekday');
  if (!isPostSuneungPeriod(now)) {
    return base;
  }
  return base.map((phase) => {
    if (phase.label !== '끝.') {
      return phase;
    }
    const shiftedStart = Math.min(phase.startMin + POST_SUNEUNG_OFFSET_MINUTES, 24 * 60);
    return { ...phase, startMin: shiftedStart };
  });
}

function getCountdownTarget(now) {
  // 현재 적용된 시간표의 "끝" 구간 시작 시간을 가져옴
  const phases = getPhasesForDate(now);
  const endPhase = phases.find(p => p.label === '끝.' || p.label === '끝');

  if (!endPhase) {
    // 기본값 (fallback)
    const isSunday = now.getDay() === 0;
    return isSunday
      ? { hour: 22, minute: 19 }
      : { hour: 22, minute: 49 };
  }

  // "끝" 구간 시작 시간 (분 단위)에서 1분을 빼서 카운트다운 시작 시간 계산
  const endStartMin = endPhase.startMin;
  const countdownMin = endStartMin - 1;

  return {
    hour: Math.floor(countdownMin / 60),
    minute: countdownMin % 60
  };
}

function setCountdownOverlay(content, { animate = true } = {}) {
  if (!countdownOverlayEl || !countdownNumberEl) {
    return;
  }
  countdownNumberEl.textContent = content;
  countdownOverlayEl.classList.add('visible');
  countdownOverlayEl.setAttribute('aria-hidden', 'false');
  countdownNumberEl.classList.remove('pulse');
  if (animate) {
    void countdownNumberEl.offsetWidth;
    countdownNumberEl.classList.add('pulse');
  }
}

function hideCountdownOverlay() {
  if (!countdownOverlayEl || !countdownNumberEl) {
    return;
  }
  if (countdownOverlayEl.classList.contains('visible')) {
    countdownOverlayEl.classList.remove('visible');
    countdownOverlayEl.setAttribute('aria-hidden', 'true');
  }
  countdownNumberEl.textContent = '';
  countdownNumberEl.classList.remove('pulse');
}

function getCountdownState(now, hourNumber, minuteNumber, secondNumber) {
  if (isPostSuneungSpecialDay(now)) {
    if (hourNumber === 22 && minuteNumber === 49 && secondNumber >= 50) {
      return { type: 'hold', label: POST_SUNEUNG_HOLD_VALUE, animate: false };
    }
    if (hourNumber === 22 && minuteNumber === 50 && secondNumber < 10) {
      return { type: 'message', label: POST_SUNEUNG_MESSAGE_TEXT, animate: false };
    }
  }

  const target = getCountdownTarget(now);
  if (
    hourNumber === target.hour &&
    minuteNumber === target.minute &&
    secondNumber >= 50
  ) {
    return {
      type: 'final',
      label: String(60 - secondNumber),
      animate: true
    };
  }

  return { type: 'none', label: '', animate: false };
}

function normalizeRoutineData(value) {
  if (!value || typeof value !== 'object') {
    return { afterschool: {}, club: {} };
  }
  const normalizeMap = (raw) => {
    if (!raw || typeof raw !== 'object') return {};
    const map = {};
    for (const day of ROUTINE_ALLOWED_DAYS) {
      const list = raw[day];
      if (!list) continue;
      const numbers = Array.isArray(list) ? list : [list];
      const cleaned = [];
      numbers.forEach((item) => {
        const num = Number(item);
        if (Number.isInteger(num) && num >= 1 && num <= 99 && !cleaned.includes(num)) {
          cleaned.push(num);
        }
      });
      if (cleaned.length) {
        cleaned.sort((a, b) => a - b);
        map[day] = cleaned;
      }
    }
    return map;
  };
  return {
    afterschool: normalizeMap(value.afterschool),
    club: normalizeMap(value.changdong || value.club)
  };
}

async function loadRoutineData(force = false) {
  if (routineLoading) return;
  if (!force && routineLoaded) return;
  const monitor = window.connectionMonitor;
  if (monitor && typeof monitor.isOffline === 'function' && monitor.isOffline()) {
    return;
  }
  routineLoading = true;
  try {
    const res = await fetch(`/api/classes/routine?grade=${grade}&section=${section}`, {
      credentials: 'include'
    });
    if (!res.ok) return;
    const data = await res.json();
    routineData = normalizeRoutineData(data);
    routineLoaded = true;
  } catch (err) {
    console.warn('루틴 정보를 불러오지 못했습니다:', err);
  } finally {
    routineLoading = false;
  }
}

function formatParticipantList(participants) {
  return participants.map((num) => `${String(num).padStart(2, '0')}번`).join(', ');
}

function getDayKey(date) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

let routinePromptOverlay = null;
let routinePromptTitle = null;
let routinePromptMessage = null;
let routinePromptDetails = null;
let routinePromptButtons = null;
let routinePromptActive = null;

function ensureRoutinePromptElements() {
  if (routinePromptOverlay) {
    return {
      overlay: routinePromptOverlay,
      titleEl: routinePromptTitle,
      messageEl: routinePromptMessage,
      detailsEl: routinePromptDetails,
      buttonsEl: routinePromptButtons
    };
  }

  const styleId = 'routinePromptStyles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
.routine-prompt-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.35);
  z-index: 4000;
}
.routine-prompt-overlay[hidden] {
  display: none;
}
.routine-prompt {
  width: min(420px, 92vw);
  border-radius: 16px;
  padding: 24px;
  background: var(--card, #1f2937);
  color: var(--text, #e2e8f0);
  box-shadow: 0 30px 60px rgba(15, 23, 42, 0.35);
  display: flex;
  flex-direction: column;
  gap: 18px;
}
@media (prefers-color-scheme: light) {
  .routine-prompt {
    background: rgba(255, 255, 255, 0.96);
    color: #0f172a;
    box-shadow: 0 24px 48px rgba(15, 23, 42, 0.12);
  }
}
.routine-prompt__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.routine-prompt__message {
  margin: 0;
  font-size: 15px;
  line-height: 1.5;
}
.routine-prompt__details {
  font-size: 14px;
  color: var(--muted, #94a3b8);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
@media (prefers-color-scheme: light) {
  .routine-prompt__details {
    color: #5b6475;
  }
}
.routine-prompt__detail-item {
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
}
@media (prefers-color-scheme: light) {
  .routine-prompt__detail-item {
    background: rgba(15, 23, 42, 0.08);
  }
}
.routine-prompt__buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.routine-btn {
  min-width: 88px;
  padding: 10px 18px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  transition: transform 0.1s ease, box-shadow 0.2s ease, border-color 0.2s ease;
}
.routine-btn:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.35);
}
.routine-btn:active {
  transform: translateY(1px);
}
.routine-btn--cancel {
  border-color: rgba(148, 163, 184, 0.45);
}
@media (prefers-color-scheme: light) {
  .routine-btn--cancel {
    border-color: rgba(100, 116, 139, 0.4);
  }
}
.routine-btn--confirm {
  background: #2563eb;
  color: #fff;
  border: 0;
}
.routine-btn--confirm:hover {
  background: #1d4ed8;
}
`;
    document.head.appendChild(style);
  }

  const overlay = document.createElement('div');
  overlay.className = 'routine-prompt-overlay';
  overlay.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'routine-prompt';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const titleEl = document.createElement('h2');
  titleEl.className = 'routine-prompt__title';

  const messageEl = document.createElement('p');
  messageEl.className = 'routine-prompt__message';

  const detailsEl = document.createElement('div');
  detailsEl.className = 'routine-prompt__details';
  detailsEl.hidden = true;

  const buttonsEl = document.createElement('div');
  buttonsEl.className = 'routine-prompt__buttons';

  dialog.appendChild(titleEl);
  dialog.appendChild(messageEl);
  dialog.appendChild(detailsEl);
  dialog.appendChild(buttonsEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      triggerRoutinePromptCancel();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) {
      triggerRoutinePromptCancel();
    }
  });

  routinePromptOverlay = overlay;
  routinePromptTitle = titleEl;
  routinePromptMessage = messageEl;
  routinePromptDetails = detailsEl;
  routinePromptButtons = buttonsEl;

  return {
    overlay,
    titleEl,
    messageEl,
    detailsEl,
    buttonsEl
  };
}

function renderRoutineModal({ title, message, detailItems = [], buttons = [] }) {
  const { overlay, titleEl, messageEl, detailsEl, buttonsEl } = ensureRoutinePromptElements();
  titleEl.textContent = title;
  messageEl.textContent = message;

  detailsEl.innerHTML = '';
  if (detailItems.length) {
    detailsEl.hidden = false;
    detailItems.forEach((item) => {
      const detail = document.createElement('div');
      detail.className = 'routine-prompt__detail-item';
      detail.textContent = item;
      detailsEl.appendChild(detail);
    });
  } else {
    detailsEl.hidden = true;
  }

  buttonsEl.innerHTML = '';
  buttons.forEach((def) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `routine-btn ${def.variant === 'confirm' ? 'routine-btn--confirm' : 'routine-btn--cancel'}`;
    btn.textContent = def.label;
    btn.addEventListener('click', () => def.onClick(), { once: true });
    buttonsEl.appendChild(btn);
  });

  overlay.hidden = false;
  const firstButton = buttonsEl.querySelector('button');
  if (firstButton) {
    setTimeout(() => firstButton.focus(), 0);
  }
}

function closeRoutinePrompt() {
  if (!routinePromptOverlay) return;
  routinePromptOverlay.hidden = true;
  routinePromptActive = null;
}

function triggerRoutinePromptCancel() {
  if (routinePromptActive && typeof routinePromptActive.onCancel === 'function') {
    const handler = routinePromptActive.onCancel;
    routinePromptActive = null;
    handler();
  } else {
    closeRoutinePrompt();
  }
}

function openRoutineDecision({ label, participants, onConfirm, onCancel }) {
  const participantLine = participants.length ? `대상: ${formatParticipantList(participants)}` : '';
  routinePromptActive = {
    onCancel: () => {
      closeRoutinePrompt();
      if (onCancel) onCancel();
    }
  };
  renderRoutineModal({
    title: '루틴 적용',
    message: `${label} 루틴을 적용할까요?`,
    detailItems: participantLine ? [participantLine] : [],
    buttons: [
      {
        label: '취소',
        variant: 'cancel',
        onClick: () => {
          const handler = routinePromptActive ? routinePromptActive.onCancel : null;
          routinePromptActive = null;
          if (handler) {
            handler();
          } else {
            closeRoutinePrompt();
          }
        }
      },
      {
        label: '적용',
        variant: 'confirm',
        onClick: () => {
          routinePromptActive = null;
          if (onConfirm) onConfirm();
        }
      }
    ]
  });
}

function showRoutineSummary(label, participants, result) {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  const movedList = participants.filter((num) => !missing.includes(num));
  const detailItems = [];
  if (movedList.length) {
    detailItems.push(`이동 완료: ${formatParticipantList(movedList)}`);
  }
  if (missing.length) {
    detailItems.push(`미이동: ${formatParticipantList(missing)}`);
  }
  if (!detailItems.length) {
    detailItems.push('이동할 대상이 없습니다.');
  }

  console.log('[routine] summary', { label, moved: movedList.length, missing });
  routinePromptActive = {
    onCancel: () => {
      closeRoutinePrompt();
    }
  };

  renderRoutineModal({
    title: `${label} 루틴 적용 완료`,
    message: `${label} 루틴이 적용되었습니다.`,
    detailItems,
    buttons: [
      {
        label: '확인',
        variant: 'confirm',
        onClick: () => {
          routinePromptActive = null;
          closeRoutinePrompt();
        }
      }
    ]
  });
}

function showRoutinePrompt(category, participants, stateKey) {
  if (!Array.isArray(participants) || !participants.length) return;
  if (window.isMagnetDragging || window.isAutoReturning || window.isRoutineApplying) {
    return;
  }

  routinePromptState[stateKey] = 'shown';
  const label = ROUTINE_LABELS[category] || '루틴';
  console.log('[routine] prompt', { category, participants, stateKey });
  openRoutineDecision({
    label,
    participants,
    onConfirm: () => {
      const result = applyRoutineAssignment(category, participants);
      routinePromptState[stateKey] = 'done';
      if (!result) {
        closeRoutinePrompt();
        return;
      }
      showRoutineSummary(label, participants, result);
    },
    onCancel: () => {
      console.log('[routine] prompt cancelled', stateKey);
      routinePromptState[stateKey] = 'done';
    }
  });
}

function applyRoutineAssignment(category, participants) {
  if (typeof window.moveMagnetToCategoryByNumber !== 'function') {
    console.warn('moveMagnetToCategoryByNumber helper 없음');
    return null;
  }
  if (!Array.isArray(participants) || !participants.length) return { moved: 0, missing: [] };

  window.isRoutineApplying = true;
  const missing = [];
  let moved = 0;
  try {
    participants.forEach((num) => {
      if (window.moveMagnetToCategoryByNumber(num, category)) {
        moved += 1;
      } else {
        missing.push(num);
      }
    });
  } finally {
    window.isRoutineApplying = false;
  }

  console.log('[routine] apply result', { category, moved, missing });
  return { moved, missing };
}

const ROUTINE_PROMPTS = [
  { key: 'afterschool', category: 'afterschool', startMinutes: 17 * 60 + 5, endMinutes: 18 * 60 + 35 },
  { key: 'club', category: 'club', startMinutes: 19 * 60 + 45, endMinutes: 22 * 60 + 50 }
];

function checkRoutinePrompts(now) {
  if (!routineLoaded) return;
  const dayKey = getDayKey(now);
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const currentMinutes = minutesOfDay(now);

  ROUTINE_PROMPTS.forEach((prompt) => {
    const map = routineData[prompt.category] || {};
    const participants = map[dayKey] || [];
    if (!participants.length) return;

    const { startMinutes } = prompt;
    if (currentMinutes < startMinutes) {
      return;
    }

    const stateKey = `${prompt.key}-${todayKey}`;
    if (routinePromptState[stateKey] === 'done' || routinePromptState[stateKey] === 'shown') return;

    showRoutinePrompt(prompt.category, participants, stateKey);
  });
}

function updateClock() {
  const now = new Date();
  const hourNumber = now.getHours();
  const minuteNumber = now.getMinutes();
  const secondNumber = now.getSeconds();

  checkAutoReturn(now);
  checkRoutinePrompts(now);

  // ===== 1) 디지털 시계 =====
  const h = String(hourNumber).padStart(2, '0');
  const m = String(minuteNumber).padStart(2, '0');
  const s = String(secondNumber).padStart(2, '0');
  document.getElementById('hours').textContent = h;
  document.getElementById('minutes').textContent = m;
  document.getElementById('seconds').textContent = s;

  const days = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
  const months = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  document.getElementById('date').textContent =
    `${months[now.getMonth()]} ${now.getDate()}일 ${days[now.getDay()]}`;

  // ===== 2) 아날로그 바늘 =====
  const hoursDeg = (hourNumber % 12) * 30 + (minuteNumber * 0.5);
  const minutesDeg = minuteNumber * 6 + (secondNumber * 0.1);
  const secondsDeg = secondNumber * 6;
  document.getElementById('hourHand').style.transform   = `translateX(-50%) rotate(${hoursDeg}deg)`;
  document.getElementById('minuteHand').style.transform = `translateX(-50%) rotate(${minutesDeg}deg)`;
  document.getElementById('secondHand').style.transform = `translateX(-50%) rotate(${secondsDeg}deg)`;
  const sh = document.getElementById('secondHand');
  sh.style.transition = 'transform 0.5s cubic-bezier(0.4, 0.0, 0.2, 1)';
  if (secondNumber === 59) { // 59.5초에 베지어 없애고 각도 초기화
    setTimeout(() => {
      sh.style.transition = '';
      sh.style.transform = 'translateX(-50%) rotate(-6deg)';
    }, 500);
  }

  // ===== 3) 구간(phase) 정의 & 찾기 =====
  const phases = getPhasesForDate(now);
  const tstatEl = document.getElementById('tstat');
  const pb = document.getElementById('progressbar');
  if (pb) pb.max = 100;

  const curMin = hourNumber * 60 + minuteNumber;
  let phase = null;
  for (const p of phases) {
    if (curMin >= p.startMin && curMin < p.endMin) { phase = p; break; }
  }

  const countdownState = getCountdownState(now, hourNumber, minuteNumber, secondNumber);
  const countdownActive = countdownState.type !== 'none';

  // ===== 4) 특수 카운트다운 & 상태 텍스트 =====
  if (countdownActive) {
    tstatEl.textContent = countdownState.label;
    setCountdownOverlay(countdownState.label, { animate: countdownState.animate });
  } else {
    hideCountdownOverlay();
    tstatEl.textContent = phase ? phase.label : '';
  }

  if (phase && phase.label === '끝.') {
    // 하루 종료 연출 (한 번만)
    if (typeof isfired !== 'undefined' && isfired === 0) {
      isfired = 1;
      const container = document.querySelector('.fireworks');
      if (container && window.Fireworks) {
        const fireworks = new Fireworks.default(container);
        fireworks.start();
      }
    }
  }

  // ===== 6) 프로그레스 바(구간 진행률) =====
  if (pb) {
    if (!phase || countdownActive) {
      // 구간 없음 또는 카운트다운 구간에서는 진행률 0으로
      pb.value = 0;
      pb.title = '';
      pb.style.setProperty('--p', 0); 
    } else {
      const nowSec   = hourNumber * 3600 + minuteNumber * 60 + secondNumber;
      const startSec = phase.startMin * 60;
      const endSec   = phase.endMin * 60;

      const sh = String((phase.startMin-(phase.startMin%60))/60).padStart(2, '0');
      const sm = String(phase.startMin%60).padStart(2, '0');

      const eh = String((phase.endMin-(phase.endMin%60))/60).padStart(2, '0');
      const em = String(phase.endMin%60).padStart(2, '0');

      document.getElementById('start-time').innerHTML = `${sh}:${sm}`  ;
      document.getElementById('end-time').innerHTML = `${eh}:${em}`;
      const total    = Math.max(1, endSec - startSec);
      const elapsed  = Math.min(Math.max(0, nowSec - startSec), total);
      const percent  = Math.round((elapsed / total) * 100);
      pb.value = percent; // 0~100
      pb.title = `${phase.label} · ${percent}% 진행`;
      pb.style.setProperty('--p', percent);
    }
  }
}

function checkAutoReturn(now) {
  if (typeof returnCategoryToClassroom !== 'function') {
    return;
  }

  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

  AUTO_RETURN_SCHEDULES.forEach(schedule => {
    const targetMinutes = schedule.minutes;
    const stateKey = `${todayKey}-${schedule.key}`;

    if (minutesOfDay >= targetMinutes) {
      if (autoReturnState[schedule.key] !== stateKey) {
        returnCategoryToClassroom(schedule.category);
        autoReturnState[schedule.key] = stateKey;
      }
    }
  });
}

async function createMagnetsFromServer(grade, section) {
  const config = await fetchMagnetConfig(grade, section);
  const end = config.end || 30;
  const skipNumbers = config.skipNumbers || [];
  createMagnets(end, skipNumbers);
}

async function initBoard() {
  await createMagnetsFromServer(grade, section);
  await loadState(grade, section);
  await loadRoutineData(true);
  updateAttendance();
  updateEtcReasonPanel();
  updateClock();
  setInterval(updateClock, 1000);
}

window.forceResyncState = async function forceResyncState() {
  if (grade == null || section == null) {
    return;
  }
  try {
    await saveState(grade, section);
    await loadState(grade, section, { ignoreOffline: true });
    await loadRoutineData(true);
  } catch (err) {
    console.warn('forceResyncState failed:', err);
  }
};

initBoard();

setInterval(() => {
  if (
    canSyncWithBackend() &&
    !window.isMagnetDragging &&
    !window.isAutoReturning &&
    !window.isRoutineApplying
  ) {
    loadState(grade, section);
  }
}, 1000);

setInterval(() => {
  if (
    canSyncWithBackend() &&
    !window.isMagnetDragging &&
    !window.isAutoReturning &&
    !window.isRoutineApplying
  ) {
    loadRoutineData(true);
  }
}, 5 * 60 * 1000);
