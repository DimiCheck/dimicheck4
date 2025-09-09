// ========== 공통 스토리지 헬퍼 (참고 코드 호환 + 폴백) ==========
function saveTimetableData(key, value){
  try{
    if (typeof saveData === 'function') return saveData(key, value);
    localStorage.setItem(key, (typeof value === 'string') ? value : JSON.stringify(value));
  }catch(_){}
}
function loadTimetableData(key){
  try{
    if (typeof loadData === 'function') return loadData(key);
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try{ return JSON.parse(raw); }catch(_){ return raw; }
  }catch(_){ return null; }
}
// 오타/대소문자 안전장치
window.loadTimetabledata = loadTimetableData;
window.saveTimetabledata = saveTimetableData;

// ========== 게임 FAB 토글 및 메뉴 동작 ==========
(function () {
  const fab = document.getElementById('gameFab');
  const menu = document.getElementById('gameMenu');
  const gomoku = document.getElementById('gomokuItem');
  const speedt = document.getElementById('speedTest');
  const circlet = document.getElementById('circleItem');
  const fireworksBtn = document.getElementById('fireworksItem');
  let menuFireworks = null;
  let fwStopTimer = null;

  if (!fab || !menu) return;

  function closeMenu() {
    menu.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu(e) {
    e.stopPropagation();
    const isOpen = menu.classList.toggle('open');
    fab.setAttribute('aria-expanded', String(isOpen));
  }

  fab.addEventListener('click', toggleMenu);
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('open')) return;
    const t = e.target;
    if (t === fab || fab.contains(t) || menu.contains(t)) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  if (gomoku) gomoku.addEventListener('click', () => { window.location.href = 'gomoku.html'; });
  if (speedt) speedt.addEventListener('click', () => { window.location.href = 'speed.html'; });
  if (circlet) circlet.addEventListener('click', () => { window.location.href = 'circle.html'; });

  if (fireworksBtn) {
    fireworksBtn.addEventListener('click', () => {
      const container = document.querySelector('.fireworks');
      if (!container || !window.Fireworks) return;
      if (!menuFireworks) menuFireworks = new Fireworks.default(container);
      menuFireworks.start();
      if (fwStopTimer) clearTimeout(fwStopTimer);
      fwStopTimer = setTimeout(() => {
        try {
          if (menuFireworks && typeof menuFireworks.stop === 'function') menuFireworks.stop(true);
        } catch (_) {}
      }, 3500);
      closeMenu();
    });
  }
})();

// ========== 아날로그 시계 눌렀을 때 ==========
$(".analog-clock")
  .on("mousedown touchstart", function () { $(".ultraman").show(); })
  .on("mouseup mouseleave touchend touchcancel", function () { $(".ultraman").hide(); });

// ========== 급식 정보 표시 기능 ==========
(function () {
  const foodItem = document.getElementById('foodItem');
  if (!foodItem) return;

  foodItem.addEventListener('click', fetchAndShowMeal);

  function todayStrDash(){
    const t=new Date();
    const y=t.getFullYear(), m=String(t.getMonth()+1).padStart(2,'0'), d=String(t.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }

  async function fetchAndShowMeal() {
    const date = todayStrDash();
    const url = `https://api.xn--299a1v27nvthhjj.com/meal/${date}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      createMealModal(data, date);
    } catch (err) {
      console.error('Fetch error:', err);
      alert('급식 정보를 불러오는 데 실패했습니다.');
    }
  }

  function createMealModal(data) {
    // 기존 같은 종류 모달 제거
    document.querySelector('.modal-overlay.meal')?.remove();

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    const fallbackDate = `${yyyy}-${mm}-${dd}`;

    // 참고 CSS와 동일한 클래스 사용!
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay meal';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const head = document.createElement('div');
    head.className = 'modal-head';

    const title = document.createElement('h3');
    title.className = 'modal-title';
    title.textContent = `${(data && data.date) ? data.date : fallbackDate} 급식 정보`;

    const closeButton = document.createElement('button');
    closeButton.className = 'modal-close';
    closeButton.textContent = '×';

    const mealGrid = document.createElement('div');
    mealGrid.className = 'meal-grid';

    const safeList = (txt) =>
        (typeof txt === 'string' && txt.trim().length)
        ? txt.replaceAll('/', '\n').split('\n').map(s => s.trim()).filter(Boolean)
        : [];

    const mkCard = (label, items) => {
        const card = document.createElement('div');
        card.className = 'meal-card';
        const h3 = document.createElement('h3');
        h3.textContent = label;

        if (items.length) {
        const ul = document.createElement('ul');
        ul.innerHTML = items.map(s => `<li>${s}</li>`).join('');
        card.append(h3, ul);
        } else {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '정보 없음';
        card.append(h3, empty);
        }
        return card;
    };

    const breakfast = mkCard('아침', safeList(data?.breakfast));
    const lunch     = mkCard('점심', safeList(data?.lunch));
    const dinner    = mkCard('저녁', safeList(data?.dinner));

    mealGrid.append(breakfast, lunch, dinner);
    head.append(title, closeButton);
    modal.append(head, mealGrid);
    overlay.append(modal);
    document.body.append(overlay);

    // 애니메이션용
    requestAnimationFrame(() => overlay.classList.add('visible'));

    // 닫기
    const close = () => {
        overlay.classList.remove('visible');
        overlay.addEventListener('transitionend', () => overlay.remove(), { once:true });
    };
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

  function createMealCard(title, menuText) {
    const card = document.createElement('div');
    card.className = 'meal-card';

    const cardTitle = document.createElement('h3');
    cardTitle.className = 'meal-card-title';
    cardTitle.textContent = title;

    const cardMenu = document.createElement('pre'); // 줄바꿈 보존
    cardMenu.className = 'meal-card-menu';
    cardMenu.textContent = menuText;

    card.append(cardTitle, cardMenu);
    return card;
  }

  function closeModal(overlay) {
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  }
})();

// ========== 시간표 표시 기능 ==========
document.addEventListener('DOMContentLoaded', () => {
  const timeItem = document.getElementById('timeItem');
  if (!timeItem) return;

  const timetableModal = document.getElementById('timetableModal');
  if (!timetableModal) return;

  const modalClose = timetableModal.querySelector('.modal-close');
  const gradeSelector = document.getElementById('gradeSelector');
  const classSelector = document.getElementById('classSelector');
  const timetableContainer = document.getElementById('timetableContainer');

  const ATPT_OFCDC_SC_CODE = 'J10';     // 경기도교육청
  const SD_SCHUL_CODE      = '7530560'; // 한국디지털미디어고등학교
  const API_KEY            = 'da82433f0f3a4351bda4ca9a0f11fc7d';

  let isInitialized = false;

  // 날짜 유틸
  function formatDate(date){
    const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,'0'), d=String(date.getDate()).padStart(2,'0');
    return `${y}${m}${d}`;
  }
  function getWeekDays(){
    const today = new Date();
    const dow = today.getDay(); // 0=일
    const monday = new Date(today);
    monday.setDate(today.getDate() - dow + (dow === 0 ? -6 : 1));
    const arr = [];
    for (let i=0;i<5;i++){
      const d = new Date(monday);
      d.setDate(monday.getDate()+i);
      arr.push(formatDate(d));
    }
    return arr;
  }

  // 과목 정규화 (참고 코드와 동일한 우선순위)
  function normalizeSubject(r){
    return r?.ITRT_CNTNT || r?.SUBJECT || r?.SUB_NM || '';
  }

  // 주간 데이터 유효성 검사 (래핑/비래핑 모두 허용)
  function isValidWeeklyData(candidate, expectedWeekStart){
    if (!candidate) return false;
    let data = candidate;
    if (!Array.isArray(candidate) && candidate.data){
      if (expectedWeekStart && candidate.weekStart && String(candidate.weekStart) !== String(expectedWeekStart)) {
        return false;
      }
      data = candidate.data;
    }
    if (!Array.isArray(data)) return false;
    if (data.length !== 5) return false;
    if (!data.every(d => Array.isArray(d))) return false;
    const hasAny = data.some(d => Array.isArray(d) && d.length > 0);
    if (!hasAny) return false;
    const looksReasonable = data.every(day => day.every(r => r && typeof r === 'object' && ('PERIO' in r || 'ITRT_CNTNT' in r || 'SUBJECT' in r)));
    return looksReasonable;
  }
  function unwrapWeekly(candidate){
    if (!candidate) return null;
    if (Array.isArray(candidate)) return candidate;
    if (candidate && Array.isArray(candidate.data)) return candidate.data;
    return null;
  }

  function renderTimetable(data){
    const days = ['월','화','수','목','금'];
    const maxPeriod = 7;

    let html = '<table><thead><tr><th>교시</th>';
    for (const d of days) html += `<th>${d}</th>`;
    html += '</tr></thead><tbody>';

    for (let period=1; period<=maxPeriod; period++){
      html += `<tr><td>${period}</td>`;
      for (let di=0; di<5; di++){
        const dayData = data[di] || [];
        // 같은 교시에 다수 행(분반) -> 과목 중복 제거 후 줄바꿈
        const rowList = dayData.filter(item => Number(item.PERIO) === period);
        const cell = rowList.length
          ? Array.from(new Set(rowList.map(normalizeSubject).filter(Boolean))).join('<br>')
          : '';
        html += `<td>${cell}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    timetableContainer.innerHTML = html;
  }

  async function fetchTimetable(grade, classNum){
    timetableContainer.innerHTML = '<p>시간표를 불러오는 중입니다...</p>';
    const weekDays = getWeekDays();
    const weekStart = weekDays[0];
    const cacheKey = `timetable_${grade}_${classNum}_${weekStart}`;

    // 캐시 우선
    const cached = loadTimetableData(cacheKey);
    if (isValidWeeklyData(cached, weekStart)){
      renderTimetable(unwrapWeekly(cached));
      return;
    }

    try{
      const reqs = weekDays.map(date => {
        const url = new URL('https://open.neis.go.kr/hub/hisTimetable');
        const params = {
          KEY: API_KEY, Type: 'json',
          ATPT_OFCDC_SC_CODE, SD_SCHUL_CODE,
          GRADE: grade, CLASS_NM: classNum, ALL_TI_YMD: date
        };
        Object.entries(params).forEach(([k,v]) => url.searchParams.append(k, v));
        return fetch(url);
      });

      const resps = await Promise.all(reqs);
      const results = await Promise.all(resps.map(r => r.json().catch(() => ({}))));

      const weekly = results.map(obj => (obj.hisTimetable && obj.hisTimetable[1] && obj.hisTimetable[1].row) ? obj.hisTimetable[1].row : []);
      if (!isValidWeeklyData(weekly, weekStart)) throw new Error('수신한 시간표 데이터가 비정상입니다.');

      const wrapped = { weekStart, savedAt: Date.now(), grade, classNum, data: weekly };
      saveTimetableData(cacheKey, wrapped);
      renderTimetable(weekly);
    }catch(err){
      console.error('Failed to fetch timetable:', err);
      timetableContainer.innerHTML = '<p>시간표를 불러오는데 실패했습니다. 다시 시도해주세요.</p>';
    }
  }

  function initTimetablePopup(){
    if (isInitialized) return;

    for (let i=1;i<=3;i++){
      const o=document.createElement('option'); o.value=String(i); o.textContent=`${i}학년`; gradeSelector.appendChild(o);
    }
    for (let i=1;i<=6;i++){
      const o=document.createElement('option'); o.value=String(i); o.textContent=`${i}반`; classSelector.appendChild(o);
    }

    // URL 파라미터 우선 → 없으면 저장된 값 → 마지막 기본값
    const urlParams = new URLSearchParams(window.location.search);
    const urlGrade = urlParams.get('grade');
    const urlClass = urlParams.get('section');

    const lastGrade = String(urlGrade ?? loadTimetableData('last_grade') ?? '1');
    const lastClass = String(urlClass ?? loadTimetableData('last_class') ?? '1');

    gradeSelector.value = lastGrade;
    classSelector.value = lastClass;

    gradeSelector.addEventListener('change', updateTimetable);
    classSelector.addEventListener('change', updateTimetable);

    isInitialized = true;
  }

  function updateTimetable(){
    const grade   = gradeSelector.value;
    const classNo = classSelector.value;
    saveTimetableData('last_grade', grade);
    saveTimetableData('last_class', classNo);
    fetchTimetable(grade, classNo);
  }

  function openModal(){
    initTimetablePopup();
    timetableModal.hidden = false;
    document.body.style.overflow = 'hidden';
    updateTimetable();
  }
  function closeModal(){
    timetableModal.hidden = true;
    document.body.style.overflow = 'auto';
  }

  timeItem.addEventListener('click', openModal);
  modalClose?.addEventListener('click', closeModal);
  timetableModal.addEventListener('click', (e) => { if (e.target === timetableModal) closeModal(); });
});