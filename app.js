/* ============================================================
   高频词小灶 — 第二界面（学习主页）交互逻辑
   纯前端，localStorage 持久化；不做 AI 故事生成
   ============================================================ */
(function () {
  "use strict";

  /* ---------- 静态示例故事（展示用，不接 API） ---------- */
  var SAMPLE_STORY = {
    en: "Last year, Tom decided to improve his English. At first, the task seemed impossible, and he almost wanted to abandon the plan. But his teacher told him that real ability grows from daily effort. So Tom made a simple schedule: twenty new words every day, and he would not neglect any of them. Slowly, he began to recognize patterns and understand the logic behind each word. When he met a difficult problem, he did not refuse to face it. Instead, he tried to find a better method. After six months, he could read short articles without fear. His steady progress proved that continued work can achieve great results.",
    zh: "去年，汤姆决定提升自己的英语。起初，这项任务看起来不可能完成，他一度想放弃这个计划。但老师告诉他，真正的能力来自日复一日的努力。于是汤姆制定了一个简单的日程：每天二十个新单词，并且不会忽视其中任何一个。慢慢地，他开始认出规律，理解每个单词背后的逻辑。遇到难题时，他不逃避面对，而是努力寻找更好的方法。六个月后，他已经能毫不费力地阅读短文。他稳步的进步证明，持续的付出能够取得巨大的成果。"
  };

  /* ---------- 状态 ---------- */
  var state = {
    view: "learn",          // learn(正常学习) | review(复习模式)
    mode: "learn",          // learn | en | zh
    currentIndex: 0,        // 学习视图内当前翻卡索引
    showAnswer: false,      // 英文/中文模式是否已揭示答案
    pool: [],               // 打乱后的词库索引
    cursor: 0,              // 已抽取的游标
    roundCounter: 0,        // 当前轮次号
    currentRound: null,     // { round, words, createdAt }
    reviewIndex: 0,         // 复习模式下跨所有学过的词的全局索引
    reviewSource: "all",    // 复习词源：all(全部已学词) | marked(标记模式：只看已标记的词)
    marks: { en: [], zh: [] } // 已标记的单词，按模式分开存：中文模式与英文模式互不影响
  };

  var LS_KEY = "english_app_v1";
  var ROUND_SIZE = 20;

  /* ---------- 词库按"单词"建索引（标记存的是单词字符串，取回词条时用） ---------- */
  var WORD_BY_TEXT = (function () {
    var map = {};
    for (var i = 0; i < WORDS.length; i++) map[WORDS[i].word] = WORDS[i];
    return map;
  })();

  /* ---------- 复习模式：所有学过的词，按 20 个一组分页 ---------- */
  /* ---------- 复习模式的词源：全部已学词 / 只看已标记的词 ---------- */
  function getLearnedWords() {
    if (!Array.isArray(state.pool) || state.pool.length !== WORDS.length) return [];
    return state.pool.slice(0, state.cursor).map(function (i) { return WORDS[i]; });
  }
  // 当前模式下被标记过的词（按标记先后顺序；只取词库里真实存在的）
  function getMarkedWords() {
    var arr = marksFor(state.mode);
    if (!arr || !arr.length) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var w = WORD_BY_TEXT[arr[i]];
      if (w) out.push(w);
    }
    return out;
  }
  function reviewWords() {
    return state.reviewSource === "marked" ? getMarkedWords() : getLearnedWords();
  }
  function getReviewChunks() {
    var learned = reviewWords();
    var chunks = [];
    for (var i = 0; i < learned.length; i += ROUND_SIZE) {
      chunks.push(learned.slice(i, i + ROUND_SIZE));
    }
    return chunks;
  }
  function reviewTotal() {
    var n = 0;
    getReviewChunks().forEach(function (c) { n += c.length; });
    return n;
  }

  /* ---------- 抽词：Fisher-Yates 打乱 ---------- */
  function freshPool() {
    var pool = [];
    for (var i = 0; i < WORDS.length; i++) pool.push(i);
    for (var k = pool.length - 1; k > 0; k--) {
      var j = Math.floor(Math.random() * (k + 1));
      var tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
    }
    return pool;
  }

  function drawRound() {
    if (!Array.isArray(state.pool) || state.pool.length !== WORDS.length) {
      state.pool = freshPool();
      state.cursor = 0;
    }
    // 跨轮不重复；抽完一轮（15 轮）后重新打乱循环
    if (state.cursor + ROUND_SIZE > WORDS.length) {
      state.pool = freshPool();
      state.cursor = 0;
    }
    var indices = state.pool.slice(state.cursor, state.cursor + ROUND_SIZE);
    state.cursor += ROUND_SIZE;

    var words = indices.map(function (i) { return WORDS[i]; });
    state.roundCounter += 1;

    state.currentRound = {
      round: state.roundCounter,
      words: words,
      createdAt: new Date().toISOString()
    };

    state.currentIndex = 0;
    state.showAnswer = false;
    state.view = "learn";

    saveState();
    renderAll();
  }

  /* ---------- 持久化 ---------- */
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        view: state.view,
        mode: state.mode,
        currentIndex: state.currentIndex,
        showAnswer: state.showAnswer,
        pool: state.pool,
        cursor: state.cursor,
        roundCounter: state.roundCounter,
        currentRound: state.currentRound,
        reviewIndex: state.reviewIndex,
        reviewSource: state.reviewSource,
        marks: state.marks
      }));
    } catch (e) { /* 无痕模式等：降级为内存态 */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      var d = JSON.parse(raw);
      if (d && typeof d === "object") Object.assign(state, d);
      state.marks = normalizeMarks(state.marks, d && d.mode);
      if (state.reviewSource !== "marked") state.reviewSource = "all";
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 视图对应的轮次 ---------- */
  function activeRoundFor(viewName) {
    if (viewName === "review") {
      var chunks = getReviewChunks();
      if (!chunks.length) return null;
      var rIdx = Math.floor(state.reviewIndex / ROUND_SIZE);
      if (rIdx >= chunks.length) rIdx = chunks.length - 1;
      if (rIdx < 0) rIdx = 0;
      return { words: chunks[rIdx], _round: rIdx, _total: chunks.length };
    }
    return state.currentRound;
  }

  /* ---------- 当前卡片的单词（学习 / 复习共用一套索引规则） ---------- */
  function cardIndex(viewName, round) {
    if (!round || !round.words.length) return 0;
    var idx = viewName === "review" ? (state.reviewIndex % ROUND_SIZE) : state.currentIndex;
    if (idx < 0) idx = 0;
    if (idx >= round.words.length) idx = viewName === "review" ? round.words.length - 1 : 0;
    return idx;
  }
  function currentWordFor(viewName) {
    var round = activeRoundFor(viewName);
    if (!round || !round.words.length) return null;
    return round.words[cardIndex(viewName, round)];
  }

  /* ---------- 标记（bookmark）：仅中文 / 英文模式可用，且两种模式各存一套 ---------- */
  function viewNameOf(el) {
    var sec = el && el.closest ? el.closest(".view") : null;
    return sec && sec.id === "view-review" ? "review" : "learn";
  }
  function modeLabel(mode) { return mode === "zh" ? "中文模式" : "英文模式"; }
  // 只有中文 / 英文模式有标记；背单词模式返回 null
  function marksFor(mode) {
    if (!state.marks || typeof state.marks !== "object") return null;
    return (mode === "en" || mode === "zh") ? state.marks[mode] : null;
  }
  function isMarked(word, mode) {
    var arr = marksFor(mode);
    return !!(arr && word && arr.indexOf(word) !== -1);
  }
  function toggleMark(word, mode) {
    var arr = marksFor(mode);
    if (!arr || !word) return false;
    var i = arr.indexOf(word);
    if (i === -1) { arr.push(word); return true; }  // 返回触发后是否处于已标记
    arr.splice(i, 1);
    return false;
  }
  // 把 localStorage 里读到的东西整理成 { en:[], zh:[] }
  // 兼容两种旧数据：没有 marks 字段、marks 是"不分模式的扁平数组"
  function normalizeMarks(raw, lastMode) {
    var out = { en: [], zh: [] };
    function clean(list) {
      return list.filter(function (w) { return typeof w === "string" && w; });
    }
    if (Array.isArray(raw)) {
      // 老版本：一个数组混着两种模式的标记。按"存档时所处的模式"归位；
      // 若当时是背单词模式（无从判断），就两种模式都记上，宁可多不可丢。
      var legacy = clean(raw);
      if (lastMode === "en" || lastMode === "zh") out[lastMode] = out[lastMode].concat(legacy);
      else { out.en = out.en.concat(legacy); out.zh = out.zh.concat(legacy); }
      return out;
    }
    if (raw && typeof raw === "object") {
      ["en", "zh"].forEach(function (m) {
        if (Array.isArray(raw[m])) out[m] = clean(raw[m]);
      });
    }
    return out;
  }

  /* ---------- 视图切换 ---------- */
  function switchView(name) {
    state.view = name;
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("view-active"); });
    document.getElementById(name === "review" ? "view-review" : "view-learn").classList.add("view-active");
    document.getElementById("app-header").style.display = "flex";
  }

  /* ---------- 渲染：卡片 ---------- */
  function renderCard(viewName) {
    var viewEl = document.getElementById(viewName === "review" ? "view-review" : "view-learn");
    var round = activeRoundFor(viewName);
    if (!round) return;

    var idx = cardIndex(viewName, round);

    var w = round.words[idx];
    var card = viewEl.querySelector(".flashcard");
    card.dataset.mode = state.mode;
    card.classList.toggle("show-answer", state.showAnswer);

    viewEl.querySelector(".card-word").textContent = w.word;
    viewEl.querySelector(".card-phonetic").textContent = w.phonetic;
    viewEl.querySelector(".card-meaning").textContent = w.meaning;

    var input = viewEl.querySelector(".write-input");
    input.value = "";
    input.classList.remove("correct", "wrong");

    var pct = (idx / Math.max(round.words.length - 1, 1)) * 100;
    viewEl.querySelector(".progress-fill").style.width = pct + "%";
    viewEl.querySelector(".progress-text").textContent =
      (idx + 1) + " / " + round.words.length;

    if (viewName === "review") {
      viewEl.querySelector(".nav-left").disabled = state.reviewIndex === 0;
      viewEl.querySelector(".nav-right").disabled = state.reviewIndex >= reviewTotal() - 1;
      var markedMode = state.reviewSource === "marked";
      var rt = document.getElementById("review-title");
      if (rt) rt.textContent = (markedMode ? "标记模式" : "复习模式") +
        " · 第 " + (round._round + 1) + " / " + round._total + " 轮";
      var hint = viewEl.querySelector(".progress-hint");
      if (hint) hint.textContent = markedMode
        ? "只看" + modeLabel(state.mode) + "标记过的单词 · 共 " + reviewTotal() + " 个"
        : "复习所有学过的单词 · 仅中 / 英文模式";
      // 复习模式“上一轮 / 下一轮”= 跳上/下一批；在首/尾批则禁用
      var nextBtn = document.getElementById("btn-new-round-review");
      if (nextBtn) nextBtn.disabled = (round._round + 1) >= round._total;
      var prevBtn = document.getElementById("btn-prev-batch");
      if (prevBtn) prevBtn.disabled = round._round <= 0;
    } else {
      viewEl.querySelector(".nav-left").disabled = idx === 0;
      viewEl.querySelector(".nav-right").disabled = idx === round.words.length - 1;
    }

    renderMark(viewName);
  }

  /* ---------- 渲染：卡片左上角标记按钮（状态跟随当前模式） ---------- */
  function renderMark(viewName) {
    var viewEl = document.getElementById(viewName === "review" ? "view-review" : "view-learn");
    if (!viewEl) return;
    var btn = viewEl.querySelector(".card-mark");
    if (!btn) return;
    var w = currentWordFor(viewName);
    var on = isMarked(w ? w.word : null, state.mode);
    btn.classList.toggle("marked", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    var label = modeLabel(state.mode) + (on ? "取消标记" : "标记这个单词");
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  /* ---------- 渲染：模式切换器高亮（两个视图同步） ---------- */
  function renderModeSwitchers() {
    document.querySelectorAll(".mode-switcher").forEach(function (sw) {
      sw.querySelectorAll(".mode-btn").forEach(function (b) {
        b.classList.toggle("active", b.dataset.mode === state.mode);
      });
    });
  }

  /* ---------- 渲染：轮次 badge ---------- */
  function renderRoundBadge() {
    var badge = document.getElementById("round-badge");
    var round = state.currentRound ? state.currentRound.round : 1;
    var learned = state.currentRound ? round * ROUND_SIZE : 0;
    badge.textContent = "第 " + round + " 轮 · 已学 " + learned + " 词";
  }

  /* ---------- 渲染：故事面板（静态示例） ---------- */
  function renderStory() {
    document.querySelector("#view-learn .story-en").textContent = SAMPLE_STORY.en;
    document.querySelector("#view-learn .story-zh").textContent = SAMPLE_STORY.zh;
    document.querySelector("#view-review .story-en").textContent = SAMPLE_STORY.en;
    document.querySelector("#view-review .story-zh").textContent = SAMPLE_STORY.zh;
  }

  /* ---------- 总渲染 ---------- */
  function renderAll() {
    switchView(state.view);
    renderModeSwitchers();
    renderRoundBadge();
    renderStory();
    renderCard("learn");
    if (state.view === "review") renderCard("review");

    // 复习 / 学习 切换按钮：现在分居两个视图的标题行，各按自身视图设标签
    // 学习页标题行的「复习」：没学过的词可复习才可用
    var toReviewBtn = document.getElementById("btn-review");
    if (toReviewBtn) {
      toReviewBtn.textContent = "复习";
      toReviewBtn.disabled = reviewTotal() === 0;
    }
    // 复习页标题行的「学习」：始终可点（回学习页）
    var toLearnBtn = document.getElementById("btn-review-back");
    if (toLearnBtn) {
      toLearnBtn.textContent = "学习";
      toLearnBtn.disabled = false;
    }
    renderReviewTools();
  }

  /* ---------- 渲染：复习页的「标记」按钮（进入 / 退出标记模式） ---------- */
  function renderReviewTools() {
    var btn = document.getElementById("btn-mark-only");
    if (!btn) return;
    var on = state.reviewSource === "marked";
    var count = getMarkedWords().length;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) {
      btn.disabled = false;
      btn.setAttribute("aria-label", "退出标记模式，回到全部复习");
      btn.title = "再点一次回到全部复习（当前只看 " + modeLabel(state.mode) + "标记过的 " + count + " 个词）";
    } else if (count === 0) {
      // 当前模式下还没标记过任何词 → 禁用，并说明原因
      btn.disabled = true;
      var why = modeLabel(state.mode) + "还没有标记过的单词，先用卡片左上角的书签标一下";
      btn.setAttribute("aria-label", why);
      btn.title = why;
    } else {
      btn.disabled = false;
      var tip = "只看" + modeLabel(state.mode) + "标记过的 " + count + " 个词";
      btn.setAttribute("aria-label", tip);
      btn.title = tip;
    }
  }

  /* ---------- 标记模式下若无词可看，自动退回"全部复习" ---------- */
  function syncReviewSource() {
    if (state.view !== "review") return false;
    if (state.reviewSource !== "marked") return false;
    if (getMarkedWords().length) return false;
    state.reviewSource = "all";
    state.reviewIndex = 0;
    return true;   // 发生过回退
  }

  /* ---------- 进入 / 退出「标记模式」 ---------- */
  function toggleMarkOnly() {
    if (state.view !== "review") return;
    if (state.reviewSource === "marked") {
      state.reviewSource = "all";
      state.reviewIndex = 0;
      state.showAnswer = false;
      saveState();
      renderAll();
      toast("已回到全部复习");
      return;
    }
    var marked = getMarkedWords();
    if (!marked.length) {
      toast(modeLabel(state.mode) + "还没有标记过单词，先用卡片左上角的书签标一下");
      return;
    }
    state.reviewSource = "marked";
    state.reviewIndex = 0;
    state.showAnswer = false;
    saveState();
    renderAll();
    toast("标记模式：只看" + modeLabel(state.mode) + "标记过的 " + marked.length + " 个词");
  }

  /* ---------- 交互动作 ---------- */
  function goTo(i) {
    var round = state.currentRound;
    if (!round) return;
    if (i < 0 || i >= round.words.length) return;
    state.currentIndex = i;
    state.showAnswer = false;
    saveState();
    renderCard("learn");
  }

  function setMode(mode) {
    state.mode = mode;
    state.showAnswer = false;
    var fellBack = syncReviewSource();   // 切模式后标记词可能为空 → 退回全部复习
    saveState();
    renderModeSwitchers();
    renderReviewTools();
    renderCard(state.view);
    if (fellBack) toast(modeLabel(mode) + "没有标记过的单词，已回到全部复习");
  }

  function revealAnswer() {
    state.showAnswer = true;
    saveState();
    renderCard(state.view);
  }

  // 复习模式：在“所有学过的词”里前后翻一张
  function reviewStep(delta) {
    var total = reviewTotal();
    if (!total) return;
    var gi = state.reviewIndex + delta;
    if (gi < 0) gi = 0;
    if (gi > total - 1) gi = total - 1;
    state.reviewIndex = gi;
    state.showAnswer = false;
    saveState();
    renderCard("review");
  }

  // 复习模式：跳到下一批 20 个词（不退出复习）
  function reviewNextBatch() {
    var total = reviewTotal();
    if (!total) return;
    var curChunk = Math.floor(state.reviewIndex / ROUND_SIZE);
    var nextStart = (curChunk + 1) * ROUND_SIZE;
    if (nextStart >= total) { toast("已经是最后一批啦"); return; }
    state.reviewIndex = nextStart;
    state.showAnswer = false;
    saveState();
    renderCard("review");
  }

  // 复习模式：回到上一批 20 个词（不退出复习）
  function reviewPrevBatch() {
    if (reviewTotal() === 0) return;
    var curChunk = Math.floor(state.reviewIndex / ROUND_SIZE);
    if (curChunk <= 0) { toast("已经是第一批啦"); return; }
    state.reviewIndex = (curChunk - 1) * ROUND_SIZE;
    state.showAnswer = false;
    saveState();
    renderCard("review");
  }

  // 复习 ↔ 正常学习 切换
  function toggleReview() {
    if (state.view === "review") {
      state.view = "learn";
      state.showAnswer = false;
      state.reviewSource = "all";   // 退出复习时复位，下次进来从「全部复习」开始
    } else {
      if (reviewTotal() === 0) { toast("还没有学过的单词可复习哦"); return; }
      state.view = "review";
      state.reviewIndex = 0;
      state.showAnswer = false;
      if (state.mode === "learn") state.mode = "en"; // 复习模式无“背单词”
      if (getMarkedWords().length === 0) state.reviewSource = "all";
    }
    saveState();
    renderAll();
  }

  // 重置：清空所有背过的单词，从头开始
  function openResetModal() {
    var m = document.getElementById("reset-modal");
    if (m) m.removeAttribute("hidden");
  }
  function closeResetModal() {
    var m = document.getElementById("reset-modal");
    if (m) m.setAttribute("hidden", "");
  }
  function resetAll() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    state.pool = [];
    state.cursor = 0;
    state.roundCounter = 0;
    state.currentRound = null;
    state.reviewIndex = 0;
    state.reviewSource = "all";
    state.view = "learn";
    state.mode = "learn";
    state.currentIndex = 0;
    state.showAnswer = false;
    // state.marks 刻意保留：标记是用户自己整理的「重点词」，不随学习进度重置而清空
    closeResetModal();
    if (!Array.isArray(state.pool) || state.pool.length !== WORDS.length) state.pool = freshPool();
    drawRound(); // 抽第 1 轮并渲染
  }

  var toastTimer;
  function toast(msg) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    // 复习 / 学习 切换（两个视图各自标题行里都有一个按钮，都走同一个动作）
    document.getElementById("btn-review").addEventListener("click", toggleReview);
    var backBtn = document.getElementById("btn-review-back");
    if (backBtn) backBtn.addEventListener("click", toggleReview);

    // 复习页标题行的「标记」：进入 / 退出标记模式（只看已标记的词）
    var markOnlyBtn = document.getElementById("btn-mark-only");
    if (markOnlyBtn) markOnlyBtn.addEventListener("click", toggleMarkOnly);

    // 学习页：重置（先弹确认框）
    document.getElementById("btn-reset").addEventListener("click", openResetModal);
    document.getElementById("btn-reset-cancel").addEventListener("click", closeResetModal);
    document.getElementById("btn-reset-confirm").addEventListener("click", resetAll);
    // 点遮罩空白处 / 按 Esc 取消
    var resetModal = document.getElementById("reset-modal");
    if (resetModal) {
      resetModal.addEventListener("click", function (e) { if (e.target === this) closeResetModal(); });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && resetModal && !resetModal.hasAttribute("hidden")) closeResetModal();
    });

    // 学习页：开始新一轮 / 生成故事（提示态）
    document.getElementById("btn-new-round-learn").addEventListener("click", function () { drawRound(); });
    document.getElementById("btn-generate").addEventListener("click", function () {
      toast("AI 生成开发中，敬请期待 🚀");
    });

    // 复习页：上一轮 / 下一轮 = 在复习批之间前后跳转（停留复习模式）
    document.getElementById("btn-prev-batch").addEventListener("click", reviewPrevBatch);
    document.getElementById("btn-new-round-review").addEventListener("click", reviewNextBatch);

    // 翻卡箭头
    document.getElementById("nav-prev-learn").addEventListener("click", function () { goTo(state.currentIndex - 1); });
    document.getElementById("nav-next-learn").addEventListener("click", function () { goTo(state.currentIndex + 1); });
    document.getElementById("nav-prev-review").addEventListener("click", function () { reviewStep(-1); });
    document.getElementById("nav-next-review").addEventListener("click", function () { reviewStep(1); });

    // 模式切换器（两个视图）
    document.querySelectorAll(".mode-switcher").forEach(function (sw) {
      sw.querySelectorAll(".mode-btn").forEach(function (b) {
        b.addEventListener("click", function () { setMode(b.dataset.mode); });
      });
    });

    // 卡片左上角「标记」按钮：点一下标记，再点取消（仅中文 / 英文模式可见，两种模式各存一套）
    document.querySelectorAll(".card-mark").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = state.mode;
        if (mode !== "en" && mode !== "zh") return;   // 背单词模式没有标记按钮
        var viewName = viewNameOf(btn);
        var w = currentWordFor(viewName);
        if (!w) return;
        var on = toggleMark(w.word, mode);
        saveState();
        if (syncReviewSource()) {
          // 把标记模式里最后一个标记取消了 → 整个列表空了，退回全部复习
          renderAll();
          toast("已取消标记「" + w.word + "」 · 没有标记词了，回到全部复习");
          return;
        }
        renderMark(viewName);
        renderReviewTools();
        toast((on ? "已标记「" + w.word + "」" : "已取消标记「" + w.word + "」") +
              " · " + modeLabel(mode));
      });
    });

    // 显示答案按钮（两个视图）
    document.querySelectorAll(".btn-show-answer").forEach(function (btn) {
      btn.addEventListener("click", revealAnswer);
    });

    // 中文模式默写输入框：实时视觉反馈（不阻断）
    document.querySelectorAll(".write-input").forEach(function (input) {
      input.addEventListener("input", function () {
        if (state.mode !== "zh") { input.classList.remove("correct", "wrong"); return; }
        var round = activeRoundFor(state.view);
        if (!round) return;
        var idx = state.view === "review" ? (state.reviewIndex % ROUND_SIZE) : state.currentIndex;
        if (idx >= round.words.length) idx = 0;
        var w = round.words[idx];
        var val = input.value.trim().toLowerCase();
        if (!val) { input.classList.remove("correct", "wrong"); return; }
        if (val === w.word.toLowerCase()) { input.classList.add("correct"); input.classList.remove("wrong"); }
        else { input.classList.add("wrong"); input.classList.remove("correct"); }
      });
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    loadState();
    if (!Array.isArray(state.pool) || state.pool.length !== WORDS.length) {
      state.pool = freshPool(); state.cursor = 0;
    }
    bindEvents();                                // 先绑定事件，保证任何分支按钮都可用
    if (!state.currentRound) { drawRound(); return; } // 直接打开学习页时自动抽第一轮
    // 复习模式下不允许停留在被隐藏的“背单词”模式
    if (state.view === "review" && state.mode === "learn") state.mode = "en";
    syncReviewSource();                          // 上次退出时若标记词已清空，回退到全部复习
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
