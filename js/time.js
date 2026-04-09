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
const APRIL_FOOLS_MONTH = 3; // 0-indexed (4월)
const APRIL_FOOLS_DAY = 1;
const APRIL_FOOLS_SESSION_SCALE_MS = 4 * 60 * 1000;
const APRIL_FOOLS_SESSION_START_REAL_MS = Date.now();
const CLOCK_RENDER_INTERVAL_MS = 50;
const APRIL_FOOLS_BSOD_STORAGE_KEY = 'dimicheck:april-fools-bsod';
const APRIL_FOOLS_BSOD_WINDOWS = Object.freeze([
  { id: 'evening-1', startMin: 17 * 60 + 20, endMin: 19 * 60 + 40 },
  { id: 'evening-2', startMin: 20 * 60 + 10, endMin: 22 * 60 + 50 },
]);

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
let aprilFoolsBanyaPlayedKey = null;
let aprilFoolsBanyaAudio = null;
let lastSecondHandDeg = null;
let aprilFoolsBsodShowTimer = null;
let aprilFoolsBsodHideTimer = null;

function getRandomInt(min, max) {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

function isAprilFoolsDay(now) {
  return now.getMonth() === APRIL_FOOLS_MONTH && now.getDate() === APRIL_FOOLS_DAY;
}

function getFireworksOptions(now = new Date()) {
  if (!isAprilFoolsDay(now)) {
    return {};
  }

  return {
    intensity: 90,
    particles: 180,
    traceSpeed: 20,
    explosion: 10,
    traceLength: 6,
    delay: { min: 6, max: 18 },
    rocketsPoint: { min: 10, max: 90 },
  };
}

window.createBoardFireworks = function createBoardFireworks(container) {
  if (!container || !window.Fireworks) {
    return null;
  }
  return new Fireworks.default(container, getFireworksOptions(new Date()));
};

function getAprilFoolsDayKey(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getAprilFoolsBsodState(now = new Date()) {
  const dayKey = getAprilFoolsDayKey(now);
  try {
    const raw = localStorage.getItem(APRIL_FOOLS_BSOD_STORAGE_KEY);
    if (!raw) {
      return { dayKey, shownSlots: [] };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.dayKey !== dayKey) {
      return { dayKey, shownSlots: [] };
    }
    return {
      dayKey,
      shownSlots: Array.isArray(parsed.shownSlots) ? parsed.shownSlots : [],
    };
  } catch (_) {
    return { dayKey, shownSlots: [] };
  }
}

function setAprilFoolsBsodState(state) {
  try {
    localStorage.setItem(APRIL_FOOLS_BSOD_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {
    // ignore storage failures
  }
}

function getDisplayedClockTime(now) {
  if (!isAprilFoolsDay(now)) {
    return now;
  }

  const sessionElapsedMs = Math.max(0, now.getTime() - APRIL_FOOLS_SESSION_START_REAL_MS);
  const extraMs = Math.round((sessionElapsedMs * sessionElapsedMs) / APRIL_FOOLS_SESSION_SCALE_MS);
  return new Date(now.getTime() + extraMs);
}

function isEndPhaseLabel(label) {
  return label === '끝.' || label === '끝';
}

function playAprilFoolsBanya(now) {
  if (!isAprilFoolsDay(now)) {
    return;
  }

  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (aprilFoolsBanyaPlayedKey === dayKey) {
    return;
  }
  aprilFoolsBanyaPlayedKey = dayKey;

  try {
    if (!aprilFoolsBanyaAudio) {
      aprilFoolsBanyaAudio = new Audio('/banya.mp3');
      aprilFoolsBanyaAudio.preload = 'auto';
    }
    aprilFoolsBanyaAudio.currentTime = 0;
    const playResult = aprilFoolsBanyaAudio.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch((error) => {
        console.warn('[AprilFools] Failed to play banya.mp3', error);
      });
    }
  } catch (error) {
    console.warn('[AprilFools] Failed to initialize banya.mp3', error);
  }
}

function minutesOfCurrentTime(now) {
  return now.getHours() * 60 + now.getMinutes();
}

function getNextAprilFoolsBsodWindow(now = new Date()) {
  const state = getAprilFoolsBsodState(now);
  const nowMinutes = minutesOfCurrentTime(now);
  return APRIL_FOOLS_BSOD_WINDOWS.find((windowConfig) => {
    if (state.shownSlots.includes(windowConfig.id)) {
      return false;
    }
    return nowMinutes < windowConfig.endMin;
  }) || null;
}

function hideAprilFoolsBsod({ scheduleNext = true } = {}) {
  const overlay = document.getElementById('aprilFoolsBsodOverlay');
  if (overlay) {
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
  }

  if (aprilFoolsBsodHideTimer) {
    clearTimeout(aprilFoolsBsodHideTimer);
    aprilFoolsBsodHideTimer = null;
  }

  if (scheduleNext) {
    scheduleAprilFoolsBsod();
  }
}

function showAprilFoolsBsod() {
  const now = new Date();
  if (!isAprilFoolsDay(now)) {
    return;
  }

  const state = getAprilFoolsBsodState(now);
  const activeWindow = APRIL_FOOLS_BSOD_WINDOWS.find((windowConfig) => {
    const nowMinutes = minutesOfCurrentTime(now);
    return nowMinutes >= windowConfig.startMin && nowMinutes < windowConfig.endMin;
  });
  if (!activeWindow || state.shownSlots.includes(activeWindow.id)) {
    return;
  }

  if (document.hidden) {
    scheduleAprilFoolsBsod();
    return;
  }

  const overlay = document.getElementById('aprilFoolsBsodOverlay');
  if (!overlay) {
    return;
  }

  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  setAprilFoolsBsodState({
    dayKey: state.dayKey,
    shownSlots: [...state.shownSlots, activeWindow.id],
  });

  const visibleMs = getRandomInt(3500, 7000);
  aprilFoolsBsodHideTimer = setTimeout(() => {
    hideAprilFoolsBsod({ scheduleNext: true });
  }, visibleMs);
}

function scheduleAprilFoolsBsod() {
  const now = new Date();
  if (!isAprilFoolsDay(now)) {
    return;
  }

  const nextWindow = getNextAprilFoolsBsodWindow(now);
  if (!nextWindow) {
    return;
  }

  if (aprilFoolsBsodShowTimer) {
    clearTimeout(aprilFoolsBsodShowTimer);
  }

  const nowMinutes = minutesOfCurrentTime(now);
  const currentMsOfDay = ((nowMinutes * 60) + now.getSeconds()) * 1000 + now.getMilliseconds();
  const startMsOfDay = nextWindow.startMin * 60 * 1000;
  const endMsOfDay = nextWindow.endMin * 60 * 1000;
  const earliestMs = Math.max(currentMsOfDay + 15_000, startMsOfDay);

  if (earliestMs >= endMsOfDay) {
    return;
  }

  const targetMsOfDay = getRandomInt(earliestMs, endMsOfDay - 1);
  const nextDelayMs = Math.max(1_000, targetMsOfDay - currentMsOfDay);
  aprilFoolsBsodShowTimer = setTimeout(() => {
    aprilFoolsBsodShowTimer = null;
    showAprilFoolsBsod();
  }, nextDelayMs);
}

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

function setManualSchedule() {
  // legacy no-op: 시간표는 항상 요일 기준 자동 적용
  localStorage.removeItem('manualSchedule');
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
  // 기존 수동 오버라이드 값이 남아 있으면 정리
  localStorage.removeItem('manualSchedule');

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
  const displayNow = getDisplayedClockTime(now);
  const hourNumber = displayNow.getHours();
  const minuteNumber = displayNow.getMinutes();
  const secondNumber = displayNow.getSeconds();
  const millisecondNumber = displayNow.getMilliseconds();

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
    `${months[displayNow.getMonth()]} ${displayNow.getDate()}일 ${days[displayNow.getDay()]}`;

  // ===== 2) 아날로그 바늘 =====
  const preciseSeconds = secondNumber + (millisecondNumber / 1000);
  const preciseMinutes = minuteNumber + (preciseSeconds / 60);
  const preciseHours = (hourNumber % 12) + (preciseMinutes / 60);
  const hoursDeg = preciseHours * 30;
  const minutesDeg = preciseMinutes * 6;
  const secondsDeg = preciseSeconds * 6;
  document.getElementById('hourHand').style.transform   = `translateX(-50%) rotate(${hoursDeg}deg)`;
  document.getElementById('minuteHand').style.transform = `translateX(-50%) rotate(${minutesDeg}deg)`;
  const sh = document.getElementById('secondHand');
  const wrapped = lastSecondHandDeg !== null && secondsDeg + 180 < lastSecondHandDeg;
  sh.style.transition = wrapped ? 'none' : `transform ${CLOCK_RENDER_INTERVAL_MS}ms linear`;
  sh.style.transform = `translateX(-50%) rotate(${secondsDeg}deg)`;
  lastSecondHandDeg = secondsDeg;

  // ===== 3) 구간(phase) 정의 & 찾기 =====
  const phases = getPhasesForDate(now);
  const tstatEl = document.getElementById('tstat');
  const pb = document.getElementById('progressbar');
  if (pb) pb.max = 100;

  const actualHourNumber = now.getHours();
  const actualMinuteNumber = now.getMinutes();
  const actualSecondNumber = now.getSeconds();
  const curMin = actualHourNumber * 60 + actualMinuteNumber;
  let phase = null;
  for (const p of phases) {
    if (curMin >= p.startMin && curMin < p.endMin) { phase = p; break; }
  }

  const countdownState = getCountdownState(now, actualHourNumber, actualMinuteNumber, actualSecondNumber);
  const countdownActive = countdownState.type !== 'none';

  // ===== 4) 특수 카운트다운 & 상태 텍스트 =====
  if (countdownActive) {
    tstatEl.textContent = countdownState.label;
    setCountdownOverlay(countdownState.label, { animate: countdownState.animate });
  } else {
    hideCountdownOverlay();
    tstatEl.textContent = phase ? phase.label : '';
  }

  if (phase && isEndPhaseLabel(phase.label)) {
    // 하루 종료 연출 (한 번만)
    if (typeof isfired !== 'undefined' && isfired === 0) {
      isfired = 1;
      const container = document.querySelector('.fireworks');
      if (container && window.Fireworks) {
        const fireworks = window.createBoardFireworks
          ? window.createBoardFireworks(container)
          : new Fireworks.default(container);
        fireworks.start();
      }
    }
    playAprilFoolsBanya(now);
  }

  // ===== 6) 프로그레스 바(구간 진행률) =====
  if (pb) {
    if (!phase || countdownActive) {
      // 구간 없음 또는 카운트다운 구간에서는 진행률 0으로
      pb.value = 0;
      pb.title = '';
      pb.style.setProperty('--p', 0); 
    } else {
      const nowSec   = actualHourNumber * 3600 + actualMinuteNumber * 60 + actualSecondNumber;
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

let boardNoticesCache = [];
let boardNoticeRenderKey = '';
const BOARD_NOTICE_POPUP_MS = 5000;
let boardNoticePopupTimer = null;
let boardNoticePopupAnimation = null;

function getBoardPopupSeenStorageKey() {
  return `dimicheck:boardPopupNotice:${grade}-${section}`;
}

function hasSeenBoardPopup(noticeId) {
  if (!noticeId) return false;
  try {
    return localStorage.getItem(getBoardPopupSeenStorageKey()) === String(noticeId);
  } catch (_) {
    return false;
  }
}

function markBoardPopupSeen(noticeId) {
  if (!noticeId) return;
  try {
    localStorage.setItem(getBoardPopupSeenStorageKey(), String(noticeId));
  } catch (_) {
    // ignore
  }
}

function hideBoardNoticePopup() {
  const overlay = document.getElementById('boardNoticePopup');
  const bar = document.getElementById('boardNoticePopupBar');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (boardNoticePopupTimer) {
    clearTimeout(boardNoticePopupTimer);
    boardNoticePopupTimer = null;
  }
  if (boardNoticePopupAnimation && typeof boardNoticePopupAnimation.cancel === 'function') {
    boardNoticePopupAnimation.cancel();
  }
  boardNoticePopupAnimation = null;
  if (bar) {
    bar.style.transform = 'scaleX(1)';
  }
}

function showBoardNoticePopup(notice) {
  if (!notice?.popup || !notice?.id || hasSeenBoardPopup(notice.id)) {
    return;
  }

  const overlay = document.getElementById('boardNoticePopup');
  const teacherEl = document.getElementById('boardNoticePopupTeacher');
  const textEl = document.getElementById('boardNoticePopupText');
  const bar = document.getElementById('boardNoticePopupBar');
  if (!overlay || !teacherEl || !textEl || !bar) return;

  markBoardPopupSeen(notice.id);
  hideBoardNoticePopup();

  teacherEl.textContent = String(notice.teacherName || '선생님');
  textEl.textContent = String(notice.text || '');
  overlay.hidden = false;
  bar.style.transform = 'scaleX(1)';

  boardNoticePopupAnimation = bar.animate(
    [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
    { duration: BOARD_NOTICE_POPUP_MS, easing: 'linear', fill: 'forwards' }
  );

  boardNoticePopupTimer = window.setTimeout(() => {
    hideBoardNoticePopup();
  }, BOARD_NOTICE_POPUP_MS);
}

function mergeBoardNoticeCache(incoming) {
  const list = Array.isArray(incoming) ? incoming : [];
  const map = new Map();
  [...list, ...boardNoticesCache].forEach((notice) => {
    const id = Number(notice?.id || 0);
    if (!id || map.has(id)) return;
    map.set(id, notice);
  });
  boardNoticesCache = Array.from(map.values())
    .sort((a, b) => Number(b?.createdAtMs || 0) - Number(a?.createdAtMs || 0))
    .slice(0, 120);
}

function formatBoardNoticeTime(createdAtMs) {
  if (!createdAtMs) return '';
  const date = new Date(createdAtMs);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function renderBoardNotices(notices = boardNoticesCache) {
  const container = document.getElementById('boardNoticeList');
  if (!container) return;

  const now = Date.now();
  if (!Array.isArray(notices) || !notices.length) {
    if (boardNoticeRenderKey === 'empty') {
      return;
    }
    boardNoticeRenderKey = 'empty';
    container.innerHTML = '<div class="empty">등록된 공지가 없습니다.</div>';
    return;
  }

  const renderKey = notices.map((notice) => {
    const createdAtMs = Number(notice?.createdAtMs || 0);
    const ageMs = createdAtMs > 0 ? Math.max(0, now - createdAtMs) : Number.MAX_SAFE_INTEGER;
    const showGlow = ageMs <= 10_000;
    const showDot = ageMs > 10_000 && ageMs <= 10 * 60 * 1000;
    return [
      String(notice?.id || ''),
      String(createdAtMs || ''),
      showGlow ? '1' : '0',
      showDot ? '1' : '0',
      String(notice?.teacherName || ''),
      String(notice?.text || ''),
    ].join(':');
  }).join('|');

  if (boardNoticeRenderKey === renderKey) {
    return;
  }
  boardNoticeRenderKey = renderKey;

  container.innerHTML = notices.map((notice) => {
    const createdAtMs = Number(notice?.createdAtMs || 0);
    const ageMs = createdAtMs > 0 ? Math.max(0, now - createdAtMs) : Number.MAX_SAFE_INTEGER;
    const showGlow = ageMs <= 10_000;
    const showDot = ageMs > 10_000 && ageMs <= 10 * 60 * 1000;
    const safeTeacher = String(notice?.teacherName || '선생님')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const safeText = String(notice?.text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    return `
      <div class="board-notice-item${showGlow ? ' notice-glow' : ''}">
        <div>${showDot ? '<span class="board-notice-dot" aria-hidden="true"></span>' : ''}${safeText}</div>
        <div class="board-notice-meta">${safeTeacher} · ${formatBoardNoticeTime(createdAtMs)}</div>
      </div>
    `;
  }).join('');
}

async function loadBoardNotices() {
  if (!grade || !section) return;
  try {
    const response = await fetch(`/api/classes/notices?grade=${grade}&section=${section}&mode=board`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) return;
    const payload = await response.json();
    boardNoticesCache = Array.isArray(payload?.notices) ? payload.notices : [];
    renderBoardNotices(boardNoticesCache);
    const popupNotice = boardNoticesCache.find((notice) => notice?.popup && !hasSeenBoardPopup(notice.id));
    if (popupNotice) {
      showBoardNoticePopup(popupNotice);
    }
  } catch (error) {
    console.warn('[board notice] load failed', error);
  }
}

async function initBoard() {
  await createMagnetsFromServer(grade, section);
  await loadState(grade, section);
  await loadBoardNotices();
  await loadRoutineData(true);
  updateAttendance();
  updateEtcReasonPanel();
  document.body.classList.toggle('april-fools-fireworks', isAprilFoolsDay(new Date()));
  updateClock();
  document.getElementById('boardNoticePopup')?.addEventListener('click', hideBoardNoticePopup);
  if (isAprilFoolsDay(new Date())) {
    scheduleAprilFoolsBsod();
    document.addEventListener('visibilitychange', () => {
      if (!isAprilFoolsDay(new Date())) {
        return;
      }
      if (document.hidden) {
        hideAprilFoolsBsod({ scheduleNext: false });
        if (aprilFoolsBsodShowTimer) {
          clearTimeout(aprilFoolsBsodShowTimer);
          aprilFoolsBsodShowTimer = null;
        }
      } else if (!aprilFoolsBsodShowTimer) {
        scheduleAprilFoolsBsod();
      }
    });
  }
  setInterval(updateClock, CLOCK_RENDER_INTERVAL_MS);
  setInterval(() => renderBoardNotices(boardNoticesCache), 1000);
}

let boardSocket = null;
let boardRealtimeConnected = false;

function connectBoardRealtime() {
  if (!window.io || !grade || !section) return;
  if (boardSocket) {
    try {
      boardSocket.disconnect();
    } catch (err) {
      console.warn('[board realtime] disconnect failed', err);
    }
    boardSocket = null;
  }

  const namespace = `/ws/classes/${grade}/${section}`;
  boardSocket = io(namespace, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
  });

  boardSocket.on('connect', () => {
    boardRealtimeConnected = true;
    console.log('[board realtime] connected', namespace);
  });

  boardSocket.on('disconnect', () => {
    boardRealtimeConnected = false;
    console.warn('[board realtime] disconnected', namespace);
  });

  boardSocket.on('connect_error', (error) => {
    boardRealtimeConnected = false;
    console.warn('[board realtime] connection error', error);
  });

  boardSocket.on('state_updated', async (payload) => {
    if (Number(payload?.grade) !== Number(grade) || Number(payload?.section) !== Number(section)) {
      return;
    }
    try {
      if (payload?.wallpaper && typeof window.applyBoardWallpaperEntry === 'function') {
        window.applyBoardWallpaperEntry(payload.wallpaper);
      }
      const currentLocalState = ensureLocalBoardState(grade, section);
      const parsed = {
        magnets: payload?.magnets || {},
        marquee: Object.prototype.hasOwnProperty.call(payload || {}, 'marquee')
          ? (payload?.marquee ?? null)
          : (currentLocalState?.marquee ?? null),
      };
      const applyResult = await applyBoardStatePayload(parsed, { grade, section });
      if (applyResult.applied) {
        updateLocalBoardState(grade, section, {
          magnets: applyResult.magnets,
          marquee: applyResult.marquee,
          markDirty: false,
        });
      }
    } catch (err) {
      console.warn('[board realtime] apply failed, falling back to loadState', err);
      loadState(grade, section, { ignoreOffline: true, forceSync: true });
    }
  });

  boardSocket.on('notice_created', (notice) => {
    mergeBoardNoticeCache([notice]);
    renderBoardNotices(boardNoticesCache);
    showBoardNoticePopup(notice);
  });
}

window.forceResyncState = async function forceResyncState() {
  if (grade == null || section == null) {
    return;
  }
  try {
    await saveState(grade, section);
    if (typeof window.flushBoardStateSync === 'function') {
      await window.flushBoardStateSync();
    }
    await loadState(grade, section, { ignoreOffline: true, forceSync: true });
    await loadRoutineData(true);
  } catch (err) {
    console.warn('forceResyncState failed:', err);
  }
};

initBoard();
connectBoardRealtime();

setInterval(() => {
  if (
    canSyncWithBackend() &&
    !boardRealtimeConnected &&
    !window.isMagnetDragging &&
    !window.isAutoReturning &&
    !window.isRoutineApplying
  ) {
    if (typeof window.hasPendingBoardSync === 'function' && window.hasPendingBoardSync(grade, section)) {
      return;
    }
    loadState(grade, section);
  }
}, 30000);

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

setInterval(() => {
  if (!canSyncWithBackend()) {
    return;
  }
  loadBoardNotices();
}, 60000);
