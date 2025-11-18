/**
 * gif-picker.js - KLIPY API GIF 검색 및 전송 기능
 */

class GifPickerManager {
  constructor() {
    this.modal = null;
    this.searchInput = null;
    this.gifGrid = null;
    this.grade = null;
    this.section = null;
    this.studentNumber = null;
    this.currentQuery = '';
    this.currentPage = 1;
    this.isLoading = false;

    // KLIPY API 설정
    this.API_KEY = null;
    this.API_BASE = 'https://api.klipy.com/api/v1';
  }

  async loadApiKey() {
    try {
      const res = await fetch('/api/classes/chat/config', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        this.API_KEY = data.klipyApiKey;
      }
    } catch (err) {
      console.error('Failed to load KLIPY API key:', err);
    }
  }

  async init(grade, section, studentNumber) {
    this.grade = grade;
    this.section = section;
    this.studentNumber = studentNumber;

    // API 키 로드
    await this.loadApiKey();

    this.modal = document.getElementById('gifModal');
    this.searchInput = document.getElementById('gifSearchInput');
    this.gifGrid = document.getElementById('gifGrid');

    // 검색 이벤트
    this.searchInput?.addEventListener('input', (e) => {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this.searchGifs(e.target.value);
      }, 500);
    });

    // 닫기 버튼
    document.getElementById('gifCloseBtn')?.addEventListener('click', () => {
      this.close();
    });

    // 무한 스크롤
    this.gifGrid?.addEventListener('scroll', () => {
      if (this.isLoading) return;

      const { scrollTop, scrollHeight, clientHeight } = this.gifGrid;
      if (scrollTop + clientHeight >= scrollHeight - 100) {
        this.loadMore();
      }
    });
  }

  async open() {
    if (!this.API_KEY) {
      this.showToast('GIF 기능을 사용할 수 없습니다');
      return;
    }

    if (this.modal) {
      this.modal.hidden = false;
      this.loadTrending();
    }
  }

  close() {
    if (this.modal) {
      this.modal.hidden = true;
      this.gifGrid.innerHTML = '';
      this.searchInput.value = '';
      this.currentQuery = '';
      this.currentPage = 1;
    }
  }

  async loadTrending() {
    this.isLoading = true;
    this.gifGrid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">로딩 중...</div>';

    try {
      const url = `${this.API_BASE}/${this.API_KEY}/gifs/trending?page=1&per_page=24&customer_id=${this.studentNumber}`;
      const res = await fetch(url);

      if (!res.ok) throw new Error('Failed to load GIFs');

      const data = await res.json();

      if (data.result && data.data && data.data.data) {
        this.renderGifs(data.data.data);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      console.error('Failed to load trending GIFs:', err);
      this.gifGrid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">GIF를 불러올 수 없습니다</div>';
    } finally {
      this.isLoading = false;
    }
  }

  async searchGifs(query) {
    if (!query.trim()) {
      this.loadTrending();
      return;
    }

    this.currentQuery = query;
    this.currentPage = 1;
    this.isLoading = true;
    this.gifGrid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">검색 중...</div>';

    try {
      const url = `${this.API_BASE}/${this.API_KEY}/gifs/search?page=1&per_page=24&q=${encodeURIComponent(query)}&customer_id=${this.studentNumber}`;
      const res = await fetch(url);

      if (!res.ok) throw new Error('Failed to search GIFs');

      const data = await res.json();

      if (data.result && data.data && data.data.data) {
        if (data.data.data.length === 0) {
          this.gifGrid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">검색 결과가 없습니다</div>';
        } else {
          this.renderGifs(data.data.data);
        }
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      console.error('Failed to search GIFs:', err);
      this.gifGrid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">검색 실패</div>';
    } finally {
      this.isLoading = false;
    }
  }

  async loadMore() {
    if (!this.currentQuery) return;

    this.currentPage++;
    this.isLoading = true;

    try {
      const url = `${this.API_BASE}/${this.API_KEY}/gifs/search?page=${this.currentPage}&per_page=24&q=${encodeURIComponent(this.currentQuery)}&customer_id=${this.studentNumber}`;
      const res = await fetch(url);

      if (!res.ok) throw new Error('Failed to load more GIFs');

      const data = await res.json();

      if (data.result && data.data && data.data.data) {
        this.renderGifs(data.data.data, true);
      }
    } catch (err) {
      console.error('Failed to load more GIFs:', err);
    } finally {
      this.isLoading = false;
    }
  }

  renderGifs(gifs, append = false) {
    if (!append) {
      this.gifGrid.innerHTML = '';
    }

    gifs.forEach(gif => {
      const item = document.createElement('div');
      item.className = 'gif-item';
      item.style.cssText = 'cursor:pointer;border-radius:8px;overflow:hidden;position:relative;background:var(--card)';

      // 미리보기 이미지 (작은 크기)
      const img = document.createElement('img');
      img.src = gif.file.sm.webp?.url || gif.file.sm.gif?.url;
      img.alt = gif.title;
      img.style.cssText = 'width:100%;height:auto;display:block';
      img.loading = 'lazy';

      item.appendChild(img);

      // 클릭 시 GIF 전송
      item.addEventListener('click', async () => {
        await this.sendGif(gif);
      });

      this.gifGrid.appendChild(item);
    });
  }

  async sendGif(gif) {
    if (!this.grade || !this.section) {
      this.showToast('로그인 정보가 없습니다');
      return;
    }

    // GIF URL (HD 품질 사용)
    const gifUrl = gif.file.hd.gif?.url || gif.file.md.gif?.url;

    if (!gifUrl) {
      this.showToast('GIF를 전송할 수 없습니다');
      return;
    }

    try {
      // 채팅 메시지로 전송
      const res = await fetch(
        `/api/classes/chat/send?grade=${this.grade}&section=${this.section}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            message: gif.title || 'GIF',
            imageUrl: gifUrl
          })
        }
      );

      if (!res.ok) {
        throw new Error('Failed to send GIF');
      }

      // KLIPY API에 공유 이벤트 기록
      this.trackShare(gif.slug);

      // 모달 닫기
      this.close();

      // 채팅 페이지 새로고침
      if (window.chatPage) {
        await window.chatPage.loadMessages();
        window.chatPage.scrollToBottom();
      }

      this.showToast('GIF를 전송했습니다!');
    } catch (err) {
      console.error('Failed to send GIF:', err);
      this.showToast('GIF 전송 실패');
    }
  }

  async trackShare(slug) {
    try {
      const url = `${this.API_BASE}/${this.API_KEY}/gifs/share/${slug}`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: String(this.studentNumber),
          q: this.currentQuery || 'trending'
        })
      });
    } catch (err) {
      console.error('Failed to track share:', err);
    }
  }

  showToast(message) {
    if (window.chatPage) {
      window.chatPage.showToast(message);
    }
  }
}

// 전역 인스턴스
window.gifPickerManager = new GifPickerManager();
