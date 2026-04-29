class ShopController {
  constructor() {
    this.state = null;
    this.activeSlot = 'move_effect';
    this.busy = false;
    this.toastTimer = null;
    this.slotLabels = {
      move_effect: '이동',
      drag_effect: '드래그',
      aura_effect: '오라'
    };
  }

  init() {
    this.cacheElements();
    this.bindEvents();
    this.load();
  }

  cacheElements() {
    this.walletCoins = document.getElementById('walletCoins');
    this.walletLevel = document.getElementById('walletLevel');
    this.equippedStrip = document.getElementById('equippedStrip');
    this.shopGrid = document.getElementById('shopGrid');
    this.toast = document.getElementById('shopToast');
    this.tabButtons = document.querySelectorAll('[data-tab]');
  }

  bindEvents() {
    this.tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        this.activeSlot = button.dataset.tab || 'move_effect';
        this.render();
      });
    });

    this.shopGrid?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action][data-item-key]');
      if (!button || this.busy) return;
      const itemKey = button.dataset.itemKey;
      const action = button.dataset.action;
      if (action === 'buy') {
        this.buy(itemKey);
      } else if (action === 'equip') {
        this.equip(itemKey);
      } else if (action === 'unequip') {
        this.equip(null, button.dataset.slot);
      }
    });
  }

  async load() {
    try {
      const res = await fetch('/api/shop/me', { credentials: 'include', cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      if (!res.ok) {
        throw new Error(`상점 정보를 불러오지 못했습니다. (${res.status})`);
      }
      this.state = await res.json();
      this.render();
    } catch (error) {
      console.error('[Shop] load failed', error);
      this.showToast(error.message || '상점 정보를 불러오지 못했습니다.');
    }
  }

  async buy(itemKey) {
    this.busy = true;
    this.render();
    try {
      const res = await fetch('/api/shop/buy', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemKey })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(this.humanizeError(error.error, res.status));
      }
      const payload = await res.json();
      this.state.wallet = payload.wallet || this.state.wallet;
      this.state.owned = payload.owned || this.state.owned;
      this.showToast('구매했습니다.');
    } catch (error) {
      this.showToast(error.message || '구매하지 못했습니다.');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async equip(itemKey, explicitSlot = null) {
    const item = itemKey ? this.findItem(itemKey) : null;
    const slot = explicitSlot || item?.slot;
    if (!slot) return;
    this.busy = true;
    this.render();
    try {
      const res = await fetch('/api/shop/equip', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, itemKey })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(this.humanizeError(error.error, res.status));
      }
      const payload = await res.json();
      this.state.equipment = payload.equipment || this.state.equipment;
      this.showToast(itemKey ? '장착했습니다.' : '장착을 해제했습니다.');
    } catch (error) {
      this.showToast(error.message || '장착하지 못했습니다.');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  findItem(itemKey) {
    return (this.state?.catalog || []).find((item) => item.key === itemKey) || null;
  }

  isOwned(itemKey) {
    return new Set(this.state?.owned || []).has(itemKey);
  }

  isEquipped(item) {
    return this.state?.equipment?.[item.slot] === item.key;
  }

  formatPrice(item) {
    const price = Number(item.price || 0);
    return price > 0 ? `${price.toLocaleString('ko-KR')} 코인` : '기본 제공';
  }

  humanizeError(error, status) {
    if (error === 'not enough coins') return '코인이 부족합니다.';
    if (error === 'already owned') return '이미 보유한 아이템입니다.';
    if (error === 'item not owned') return '먼저 구매해야 합니다.';
    if (error === 'invalid item') return '사용할 수 없는 아이템입니다.';
    if (status === 403) return '권한이 없습니다.';
    return error || '요청을 처리하지 못했습니다.';
  }

  render() {
    if (!this.state) {
      if (this.shopGrid) {
        this.shopGrid.innerHTML = '<div class="empty-state">상점을 불러오는 중입니다.</div>';
      }
      return;
    }
    this.renderWallet();
    this.renderTabs();
    this.renderEquipped();
    this.renderItems();
  }

  renderWallet() {
    const wallet = this.state.wallet || {};
    if (this.walletCoins) {
      const coins = Number(wallet.coins || 0);
      this.walletCoins.textContent = `${coins.toLocaleString('ko-KR')} 코인`;
    }
    if (this.walletLevel) {
      const level = Number(wallet.level || 1);
      const xp = Number(wallet.xp || 0);
      this.walletLevel.textContent = `Lv. ${level} · ${xp.toLocaleString('ko-KR')} XP`;
    }
  }

  renderTabs() {
    this.tabButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === this.activeSlot);
    });
  }

  renderEquipped() {
    if (!this.equippedStrip) return;
    const equipment = this.state.equipment || {};
    this.equippedStrip.innerHTML = Object.keys(this.slotLabels).map((slot) => {
      const item = this.findItem(equipment[slot]);
      const name = item ? item.name : '없음';
      return `
        <div class="equipped-card">
          <span>${this.slotLabels[slot]}</span>
          <strong>${this.escapeHtml(name)}</strong>
        </div>
      `;
    }).join('');
  }

  renderItems() {
    if (!this.shopGrid) return;
    const items = (this.state.catalog || []).filter((item) => item.slot === this.activeSlot);
    if (!items.length) {
      this.shopGrid.innerHTML = '<div class="empty-state">아직 준비된 아이템이 없습니다.</div>';
      return;
    }
    this.shopGrid.innerHTML = items.map((item, index) => this.renderItemCard(item, index)).join('');
  }

  renderItemCard(item, index) {
    const owned = this.isOwned(item.key);
    const equipped = this.isEquipped(item);
    const canBuy = !owned && Number(item.price || 0) > 0;
    const disabled = this.busy ? 'disabled' : '';
    let action = '';

    if (equipped) {
      action = `<button class="action-btn equipped" type="button" disabled>장착됨</button>
        <button class="action-btn secondary" type="button" data-action="unequip" data-slot="${item.slot}" data-item-key="${item.key}" ${disabled}>해제</button>`;
    } else if (owned) {
      action = `<button class="action-btn" type="button" data-action="equip" data-item-key="${item.key}" ${disabled}>장착</button>`;
    } else {
      action = `<button class="action-btn" type="button" data-action="buy" data-item-key="${item.key}" ${disabled || (!canBuy ? 'disabled' : '')}>구매</button>`;
    }

    return `
      <article class="item-card" style="animation-delay:${Math.min(index * 45, 180)}ms">
        <div class="preview" data-preview="${this.escapeHtml(item.preview || 'spark')}"></div>
        <div class="item-body">
          <div class="item-top">
            <h2 class="item-name">${this.escapeHtml(item.name)}</h2>
            <span class="rarity" data-rarity="${this.escapeHtml(item.rarity || 'basic')}">${this.escapeHtml(item.rarity || 'basic')}</span>
          </div>
          <p class="item-desc">${this.escapeHtml(item.description || '')}</p>
          <div class="item-actions">
            <div class="price">${this.escapeHtml(this.formatPrice(item))}</div>
            ${action}
          </div>
        </div>
      </article>
    `;
  }

  showToast(message) {
    if (!this.toast) return;
    this.toast.textContent = message;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.classList.remove('show');
    }, 2400);
  }

  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const controller = new ShopController();
  controller.init();
});
