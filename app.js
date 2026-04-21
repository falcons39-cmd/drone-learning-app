'use strict';

// ===== State =====
const state = {
  questions: [],
  shuffled: [],
  current: 0,
  correct: 0,
  wrong: [],        // { question, yourAnswer, correctAnswer }
};

// ===== DOM refs =====
const $ = id => document.getElementById(id);
const screens = {
  start:  $('screen-start'),
  quiz:   $('screen-quiz'),
  result: $('screen-result'),
  review: $('screen-review'),
};

// ===== Screen navigation =====
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ===== Load questions =====
async function loadQuestions() {
  const res = await fetch('questions.json');
  if (!res.ok) throw new Error('Failed to load questions.json');
  return res.json();
}

// ===== Shuffle (Fisher-Yates) =====
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===== Start quiz =====
function startQuiz() {
  state.shuffled = shuffle(state.questions);
  state.current = 0;
  state.correct = 0;
  state.wrong = [];
  showScreen('quiz');
  renderQuestion();
}

// ===== Render question =====
function renderQuestion() {
  const q = state.shuffled[state.current];
  const total = state.shuffled.length;
  const idx = state.current + 1;

  $('q-current').textContent = idx;
  $('q-total').textContent = total;
  $('progress-bar').style.width = `${((idx - 1) / total) * 100}%`;
  $('score-rate').textContent = idx === 1 ? 0 :
    Math.round((state.correct / (idx - 1)) * 100);

  $('q-category').textContent = q.category;
  $('q-text').textContent = q.question;

  // Shuffle choices while tracking correct answer index
  const indices = shuffle([0, 1, 2, 3]);
  const choicesEl = $('choices');
  choicesEl.innerHTML = '';

  const labels = ['A', 'B', 'C', 'D'];

  indices.forEach((origIdx, position) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.innerHTML = `
      <span class="choice-label">${labels[position]}</span>
      <span>${q.choices[origIdx]}</span>
    `;
    btn.addEventListener('click', () => handleAnswer(origIdx, q, indices, btn));
    choicesEl.appendChild(btn);
  });

  // Hide feedback
  const fb = $('feedback');
  fb.classList.add('hidden');
}

// ===== Handle answer =====
function handleAnswer(chosenOrigIdx, q, shuffledIndices, clickedBtn) {
  const allBtns = $('choices').querySelectorAll('.choice-btn');
  allBtns.forEach(b => (b.disabled = true));

  const isCorrect = chosenOrigIdx === q.answer;

  // Mark buttons
  allBtns.forEach((btn, pos) => {
    const origIdx = shuffledIndices[pos];
    if (origIdx === q.answer) {
      btn.classList.add('correct');
    } else if (btn === clickedBtn && !isCorrect) {
      btn.classList.add('wrong');
    }
  });

  if (isCorrect) {
    state.correct++;
  } else {
    state.wrong.push({
      question: q,
      yourAnswer: chosenOrigIdx,
      correctAnswer: q.answer,
    });
  }

  // Show feedback
  const fb = $('feedback');
  const fbHeader = $('feedback-header');
  fbHeader.className = `feedback-header ${isCorrect ? 'is-correct' : 'is-wrong'}`;
  fbHeader.textContent = isCorrect ? '✓ 正解！' : '✗ 不正解';
  $('feedback-explanation').textContent = q.explanation;
  fb.classList.remove('hidden');

  // Update progress bar
  const total = state.shuffled.length;
  $('progress-bar').style.width = `${((state.current + 1) / total) * 100}%`;
}

// ===== Next question =====
function nextQuestion() {
  state.current++;
  if (state.current >= state.shuffled.length) {
    showResult();
  } else {
    renderQuestion();
  }
}

// ===== Show result =====
function showResult() {
  const total = state.shuffled.length;
  const correct = state.correct;
  const rate = Math.round((correct / total) * 100);

  $('result-correct').textContent = correct;
  $('result-total').textContent = total;
  $('result-rate').textContent = rate;

  // Emoji & title
  const { emoji, title } = getRating(rate);
  $('result-emoji').textContent = emoji;
  $('result-title').textContent = title;

  // Ring animation
  const circumference = 326.7;
  const offset = circumference - (rate / 100) * circumference;
  const ring = $('ring-progress');
  ring.style.strokeDashoffset = circumference;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { ring.style.strokeDashoffset = offset; });
  });
  ring.style.stroke = rate >= 80 ? 'var(--clr-success)' : rate >= 60 ? 'var(--clr-warning)' : 'var(--clr-danger)';

  // Category breakdown
  const cats = {};
  state.shuffled.forEach(q => {
    if (!cats[q.category]) cats[q.category] = { total: 0, correct: 0 };
    cats[q.category].total++;
  });
  state.wrong.forEach(w => { cats[w.question.category].correct--; });
  state.shuffled.forEach(q => { cats[q.category].correct++; });
  // Recalculate properly
  Object.keys(cats).forEach(c => { cats[c].correct = 0; });
  state.shuffled.forEach(q => {
    const wrongIds = state.wrong.map(w => w.question.id);
    if (!wrongIds.includes(q.id)) cats[q.category].correct++;
  });

  const breakdown = $('result-breakdown');
  breakdown.innerHTML = Object.entries(cats).map(([cat, val]) => {
    const all = val.correct === val.total;
    return `<div class="breakdown-item">
      <span class="breakdown-cat">${cat}</span>
      <span class="breakdown-val ${all ? 'all-correct' : 'has-wrong'}">${val.correct}/${val.total}</span>
    </div>`;
  }).join('');

  // Review button visibility
  $('btn-review').style.display = state.wrong.length > 0 ? 'block' : 'none';

  showScreen('result');
}

function getRating(rate) {
  if (rate === 100) return { emoji: '🏆', title: '完璧！全問正解！' };
  if (rate >= 90)  return { emoji: '🎉', title: '優秀！もう少しで完璧！' };
  if (rate >= 80)  return { emoji: '😊', title: '合格ライン突破！' };
  if (rate >= 60)  return { emoji: '📚', title: 'もう少し頑張ろう！' };
  return { emoji: '💪', title: '復習して再挑戦！' };
}

// ===== Review screen =====
function showReview() {
  const list = $('review-list');
  if (state.wrong.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎉</div>間違えた問題はありません！</div>';
  } else {
    list.innerHTML = state.wrong.map((w, i) => {
      const q = w.question;
      return `
        <div class="review-item">
          <div class="review-q-no">問題 ${i + 1} ／ ${q.category}</div>
          <div class="review-question">${q.question}</div>
          <div class="review-answer-row">
            <span class="review-answer-label label-wrong">あなたの回答</span>
            <span>${q.choices[w.yourAnswer]}</span>
          </div>
          <div class="review-answer-row">
            <span class="review-answer-label label-correct">正解</span>
            <span>${q.choices[w.correctAnswer]}</span>
          </div>
          <div class="review-explanation">${q.explanation}</div>
        </div>`;
    }).join('');
  }
  showScreen('review');
}

// ===== Score display update during quiz =====
function updateScoreDisplay() {
  const idx = state.current;
  if (idx === 0) { $('score-rate').textContent = 0; return; }
  $('score-rate').textContent = Math.round((state.correct / idx) * 100);
}

// ===== Event listeners =====
$('btn-start').addEventListener('click', startQuiz);
$('btn-next').addEventListener('click', nextQuestion);
$('btn-retry').addEventListener('click', startQuiz);
$('btn-review').addEventListener('click', showReview);
$('btn-back').addEventListener('click', () => showScreen('result'));

// ===== Init =====
(async () => {
  try {
    state.questions = await loadQuestions();
    $('total-count').textContent = `${state.questions.length}問`;
    $('btn-start').disabled = false;
  } catch (e) {
    $('total-count').textContent = '読み込みエラー';
    console.error(e);
  }
})();
