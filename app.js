'use strict';

/* ============================================================
   CONFIG
   ============================================================ */
const CONFIG = Object.freeze({
  manifestUrl:  'data/manifest.json',
  legacyUrl:    'questions.json',       // fallback if manifest fails
  fetchTimeout: 10000,                  // ms per request
  maxRetries:   3,
  retryDelay:   600,                    // ms, doubles each attempt
  countOptions: [5, 10, 20, 30, 'ALL'],
  defaultCountIdx: 1,                   // default → 10問
});

/* ============================================================
   STATE  (single source of truth)
   ============================================================ */
const state = {
  // Loaded data
  manifest:  null,    // ManifestCategory[]
  questions: [],      // Question[] (all loaded)

  // Quiz session
  session: {
    pool:       [],   // shuffled Question[] for this run
    current:    0,
    correct:    0,
    wrong:      [],   // { q, yourIdx }
    answered:   false,
    choiceMap:  [],   // display-order → original answer index
  },

  // UI
  countIdx:          CONFIG.defaultCountIdx,
  selectedCategoryId: null,
};

/* ============================================================
   DATA SERVICE  — fetch with timeout, retry, and fallback
   ============================================================ */
const DataService = {
  /** Fetch JSON with timeout */
  async _fetch(url) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  },

  /** Fetch with exponential-backoff retry */
  async fetchRetry(url, attempt = 0) {
    try {
      return await this._fetch(url);
    } catch (err) {
      if (attempt >= CONFIG.maxRetries - 1) throw err;
      await new Promise(r =>
        setTimeout(r, CONFIG.retryDelay * Math.pow(2, attempt))
      );
      return this.fetchRetry(url, attempt + 1);
    }
  },

  /** Load manifest then all category files in parallel */
  async loadAll() {
    const manifest = await this.fetchRetry(CONFIG.manifestUrl);
    state.manifest = manifest.categories;

    const results = await Promise.allSettled(
      state.manifest.map(cat => this._loadCategory(cat))
    );

    // Warn about partial failures but don't abort if some loaded
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`Category "${state.manifest[i].name}" failed:`, r.reason);
      }
    });

    if (state.questions.length === 0) {
      throw new Error('問題データを1件も読み込めませんでした');
    }
  },

  async _loadCategory(cat) {
    const data = await this.fetchRetry(cat.file);
    const raw  = data.questions ?? (Array.isArray(data) ? data : []);
    raw.forEach(q => {
      q.categoryId   = q.categoryId   ?? cat.id;
      q.categoryName = q.categoryName ?? cat.name;
    });
    state.questions.push(...raw);
  },

  /** Fallback: load legacy flat questions.json */
  async loadLegacy() {
    const raw = await this.fetchRetry(CONFIG.legacyUrl);
    const arr = Array.isArray(raw) ? raw : (raw.questions ?? []);
    arr.forEach(q => {
      q.categoryId   = q.categoryId   ?? 'general';
      q.categoryName = q.categoryName ?? q.category ?? '一般';
    });
    state.questions = arr;
    state.manifest  = [{
      id: 'general', name: '全問題', icon: '📋', file: CONFIG.legacyUrl,
    }];
  },
};

/* ============================================================
   QUIZ ENGINE  — pure logic, no DOM
   ============================================================ */
const Quiz = {
  /** Fisher-Yates shuffle (non-mutating) */
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  /** Build the question pool for a session */
  buildPool(mode, catId, countIdx) {
    const countOpt = CONFIG.countOptions[countIdx];
    const source   = (mode === 'category' && catId)
      ? state.questions.filter(q => q.categoryId === catId)
      : state.questions;

    const shuffled = this.shuffle(source);
    return countOpt === 'ALL' ? shuffled : shuffled.slice(0, Math.min(countOpt, shuffled.length));
  },

  /** Current accuracy (0-100) */
  rate() {
    const { current, correct } = state.session;
    return current === 0 ? 0 : Math.round((correct / current) * 100);
  },

  /** Emoji + label for final score */
  rating(pct) {
    if (pct === 100) return { emoji: '🏆', label: '完璧！全問正解！' };
    if (pct >= 90)   return { emoji: '🎉', label: '素晴らしい出来です！' };
    if (pct >= 80)   return { emoji: '😊', label: '合格ライン突破！' };
    if (pct >= 60)   return { emoji: '📚', label: 'もう少し頑張ろう！' };
    return                  { emoji: '💪', label: '復習して再挑戦！' };
  },

  /** Per-category correct/total for results screen */
  categoryStats() {
    const { pool, wrong } = state.session;
    const wrongIds = new Set(wrong.map(w => w.q.id));
    const map = {};
    pool.forEach(q => {
      if (!map[q.categoryName]) map[q.categoryName] = { total: 0, correct: 0 };
      map[q.categoryName].total++;
      if (!wrongIds.has(q.id)) map[q.categoryName].correct++;
    });
    return map;
  },
};

/* ============================================================
   UI  — all DOM manipulation in one place
   ============================================================ */
const el = id => document.getElementById(id);

const UI = {
  /* ---------- Overlays ---------- */
  showLoading(msg = '読み込み中…') {
    el('loading-msg').textContent = msg;
    el('overlay-loading').hidden  = false;
  },
  hideLoading() { el('overlay-loading').hidden = true; },

  showError(msg, onRetry) {
    el('error-msg').textContent = msg;
    el('overlay-error').hidden  = false;
    el('btn-error-retry').onclick = () => {
      el('overlay-error').hidden = true;
      onRetry();
    };
  },

  /* ---------- Screen switching ---------- */
  show(name) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.toggle('active', s.id === `screen-${name}`);
    });
  },

  /* ---------- Start screen ---------- */
  renderStart() {
    el('stat-total').textContent = `${state.questions.length}問`;
    el('stat-cats').textContent  = `${state.manifest?.length ?? 0}カテゴリ`;
    el('count-display').textContent = this._countLabel();

    this._buildCategoryChips();
    this._bindModeRadios();
  },

  _countLabel() {
    const v = CONFIG.countOptions[state.countIdx];
    return v === 'ALL' ? '全問' : `${v}問`;
  },

  _buildCategoryChips() {
    const cats = state.manifest ?? [];
    const row  = el('row-category-mode');
    const wrap = el('cat-chips');

    if (cats.length <= 1) { row.style.display = 'none'; return; }
    row.style.display = '';

    wrap.innerHTML = '';
    cats.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'cat-chip' + (state.selectedCategoryId === cat.id ? ' is-selected' : '');
      btn.textContent = `${cat.icon ?? ''} ${cat.name}`;
      btn.dataset.id  = cat.id;
      btn.addEventListener('click', () => {
        state.selectedCategoryId = cat.id;
        wrap.querySelectorAll('.cat-chip').forEach(c =>
          c.classList.toggle('is-selected', c.dataset.id === cat.id)
        );
      });
      wrap.appendChild(btn);
    });
  },

  _bindModeRadios() {
    const update = () => {
      const mode = document.querySelector('input[name="mode"]:checked')?.value;
      const show = mode === 'category';
      el('cat-chips').hidden = !show;
      if (!show) state.selectedCategoryId = null;
    };
    document.querySelectorAll('input[name="mode"]').forEach(r => {
      r.removeEventListener('change', update);
      r.addEventListener('change', update);
    });
    update();
  },

  /* ---------- Quiz screen ---------- */
  renderQuestion() {
    const sess  = state.session;
    const q     = sess.pool[sess.current];
    const total = sess.pool.length;
    const idx   = sess.current + 1;

    // Header
    el('qn-idx').textContent   = idx;
    el('qn-total').textContent = total;
    el('qn-rate').textContent  = Quiz.rate();
    const pct = ((idx - 1) / total) * 100;
    el('progress-fill').style.width = `${pct}%`;
    el('progress-fill').closest('[role=progressbar]')?.setAttribute('aria-valuenow', pct);

    // Question
    el('qn-cat').textContent  = q.categoryName;
    el('qn-text').textContent = q.question;

    // Shuffle choices
    const choiceMap = Quiz.shuffle([0, 1, 2, 3]);
    sess.choiceMap  = choiceMap;
    sess.answered   = false;

    // Close feedback sheet
    el('feedback-sheet').classList.remove('is-open');

    // Scroll question to top
    const body = el('quiz-scroll');
    if (body) body.scrollTop = 0;

    // Render choices
    const letters   = ['A', 'B', 'C', 'D'];
    const container = el('choices');
    container.innerHTML = '';

    choiceMap.forEach((origIdx, pos) => {
      const btn = document.createElement('button');
      btn.className   = 'choice-btn';
      btn.dataset.orig = origIdx;
      btn.innerHTML = `
        <span class="choice-letter">${letters[pos]}</span>
        <span>${q.choices[origIdx]}</span>
      `;
      btn.addEventListener('click', () => App.handleAnswer(origIdx));
      container.appendChild(btn);
    });
  },

  renderFeedback(isCorrect, q, yourIdx) {
    // Style choice buttons
    document.querySelectorAll('.choice-btn').forEach(btn => {
      const orig = Number(btn.dataset.orig);
      if (orig === q.answer)       btn.classList.add('is-correct');
      else if (orig === yourIdx)   btn.classList.add('is-wrong');
      else                         btn.classList.add('is-dim');
      btn.disabled = true;
    });

    // Feedback sheet
    const res = el('fb-result');
    res.textContent = isCorrect ? '✓ 正解！' : '✗ 不正解';
    res.className   = `fb-result ${isCorrect ? 'fb-result--correct' : 'fb-result--wrong'}`;

    el('fb-exp').textContent = q.explanation;
    el('feedback-sheet').classList.add('is-open');

    // Live score update
    const { correct, current } = state.session;
    el('qn-rate').textContent = Math.round((correct / (current + 1)) * 100);
  },

  /* ---------- Result screen ---------- */
  renderResult() {
    const { pool, correct } = state.session;
    const total = pool.length;
    const pct   = Math.round((correct / total) * 100);
    const { emoji, label } = Quiz.rating(pct);

    el('res-emoji').textContent   = emoji;
    el('res-title').textContent   = label;
    el('res-correct').textContent = correct;
    el('res-total').textContent   = total;
    el('res-pct').textContent     = `${pct}%`;

    // Ring animation
    const circ = 314.159;
    const ring  = el('ring-val');
    ring.style.strokeDashoffset = circ;
    ring.style.stroke = pct >= 80 ? 'var(--clr-success)'
                       : pct >= 60 ? 'var(--clr-warning)'
                       : 'var(--clr-danger)';
    // Double rAF ensures transition runs after display:flex
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ring.style.strokeDashoffset = circ - (pct / 100) * circ;
    }));

    // Category breakdown
    const stats  = Quiz.categoryStats();
    const html   = Object.entries(stats).map(([name, { total: t, correct: c }]) => {
      const p   = Math.round((c / t) * 100);
      const cls = p >= 80 ? 'hi' : p >= 60 ? 'mid' : 'lo';
      return `
        <div class="cat-row">
          <span class="cat-row__name">${name}</span>
          <div class="cat-row__bar-wrap">
            <div class="cat-row__bar cat-row__bar--${cls}" style="width:${p}%"></div>
          </div>
          <span class="cat-row__score">${c}/${t}</span>
        </div>`;
    }).join('');
    el('cat-breakdown').innerHTML = html || '<p style="color:var(--clr-text-3);font-size:.85rem;text-align:center;padding:8px 0">カテゴリ情報なし</p>';

    el('btn-review').hidden = state.session.wrong.length === 0;
  },

  /* ---------- Review screen ---------- */
  renderReview() {
    const { wrong } = state.session;
    el('review-count').textContent = `${wrong.length}問`;

    if (wrong.length === 0) {
      el('review-list').innerHTML = `
        <div class="empty">
          <div class="empty__icon">🎉</div>
          <p class="empty__msg">間違えた問題はありません！<br>素晴らしい結果です。</p>
        </div>`;
      return;
    }

    el('review-list').innerHTML = wrong.map(({ q, yourIdx }, i) => `
      <div class="review-card">
        <div class="review-card__head">
          <p class="review-card__meta">問${i + 1} · ${q.categoryName}</p>
          <p class="review-card__q">${q.question}</p>
        </div>
        <div class="review-answers">
          <div class="review-ans-row">
            <span class="ans-tag ans-tag--wrong">あなた</span>
            <span>${q.choices[yourIdx]}</span>
          </div>
          <div class="review-ans-row">
            <span class="ans-tag ans-tag--correct">正解</span>
            <span>${q.choices[q.answer]}</span>
          </div>
        </div>
        <p class="review-card__exp">${q.explanation}</p>
      </div>
    `).join('');
  },
};

/* ============================================================
   APP  — orchestrates data, quiz, and UI
   ============================================================ */
const App = {
  async init() {
    UI.showLoading('問題データを読み込み中…');
    try {
      await DataService.loadAll();
    } catch (manifestErr) {
      console.warn('Manifest load failed, trying legacy fallback:', manifestErr);
      try {
        await DataService.loadLegacy();
      } catch (legacyErr) {
        UI.hideLoading();
        UI.showError(
          'ネットワークエラーが発生しました。\nページを再読み込みするか、しばらく経ってから再試行してください。',
          () => App.init()
        );
        return;
      }
    }

    UI.hideLoading();
    UI.renderStart();
    UI.show('start');
    el('btn-start').disabled = false;

    this._bindEvents();
  },

  _bindEvents() {
    el('btn-start').addEventListener('click', () => this.startQuiz());
    el('btn-next').addEventListener('click',  () => this.nextQuestion());
    el('btn-retry').addEventListener('click', () => this.startQuiz());
    el('btn-review').addEventListener('click', () => {
      UI.renderReview();
      UI.show('review');
    });
    el('btn-to-start').addEventListener('click', () => {
      UI.renderStart();
      UI.show('start');
    });
    el('btn-review-back').addEventListener('click', () => UI.show('result'));

    // Count stepper
    el('btn-plus').addEventListener('click', () => {
      state.countIdx = Math.min(state.countIdx + 1, CONFIG.countOptions.length - 1);
      el('count-display').textContent = UI._countLabel();
    });
    el('btn-minus').addEventListener('click', () => {
      state.countIdx = Math.max(state.countIdx - 1, 0);
      el('count-display').textContent = UI._countLabel();
    });
  },

  startQuiz() {
    const mode = document.querySelector('input[name="mode"]:checked')?.value ?? 'all';
    const catId = mode === 'category' ? state.selectedCategoryId : null;

    if (mode === 'category' && !catId) {
      alert('カテゴリを選択してください。');
      return;
    }

    const pool = Quiz.buildPool(mode, catId, state.countIdx);
    if (pool.length === 0) {
      alert('出題できる問題がありません。');
      return;
    }

    Object.assign(state.session, {
      pool,
      current:  0,
      correct:  0,
      wrong:    [],
      answered: false,
      choiceMap: [],
    });

    UI.show('quiz');
    UI.renderQuestion();
  },

  handleAnswer(chosenOrigIdx) {
    const sess = state.session;
    if (sess.answered) return;
    sess.answered = true;

    const q         = sess.pool[sess.current];
    const isCorrect = chosenOrigIdx === q.answer;

    if (isCorrect) {
      sess.correct++;
    } else {
      sess.wrong.push({ q, yourIdx: chosenOrigIdx });
    }

    UI.renderFeedback(isCorrect, q, chosenOrigIdx);
  },

  nextQuestion() {
    const sess = state.session;

    // Advance progress bar to completed state
    const done = (sess.current + 1) / sess.pool.length * 100;
    el('progress-fill').style.width = `${done}%`;

    sess.current++;

    if (sess.current >= sess.pool.length) {
      UI.renderResult();
      UI.show('result');
    } else {
      UI.renderQuestion();
    }
  },
};

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => App.init());
