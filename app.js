/* ============================================================
   xdictionary — 第二界面（学习主页）交互逻辑
   纯前端，localStorage 持久化；故事面板内容归 story.js（AI 生成）
   ============================================================ */
(function () {
  "use strict";
  /* 版本指纹：F12 控制台可确认浏览器实际加载的 app.js 是哪一版（排查缓存用） */
  console.log("[xdictionary] app.js v202610265 · 开书两拍 + 标记生词带手填释义");

  /* ---------- 状态 ---------- */
  var state = {
    view: "learn",          // learn(正常学习) | review(复习模式)
    mode: "learn",          // learn | en | zh
    currentIndex: 0,        // 学习视图内当前翻卡索引
    showAnswer: false,      // 英文/中文模式是否已揭示答案
    pool: [],               // 打乱后的词库索引（下标对应「当前来源」的词表）
    cursor: 0,              // 已抽取的游标
    roundCounter: 0,        // 当前轮次号
    currentRound: null,     // { round, words, createdAt }
    reviewIndex: 0,         // 复习模式下跨所有学过的词的全局索引
    reviewSource: "all",    // 复习词源：all(全部已学词) | marked(标记模式：只看已标记的词)
    marks: { en: [], zh: [] }, // 已标记的单词，按模式分开存：中文模式与英文模式互不影响
    source: "cet4",         // 抽词来源：cet4(四级词库) | 自定义词库 id（bank.js）
    ctx: null               // 每个来源各自的进度 { [sourceId]: {pool,cursor,roundCounter,currentRound} }；
                            // 平铺的 pool/cursor/roundCounter/currentRound 恒等于「当前来源」的进度
  };

  var LS_KEY = "english_app_v1";
  var ROUND_SIZE = 20;

  /* ---------- 词库按"单词"建索引（标记存的是单词字符串，取回词条时用） ---------- */
  var WORD_BY_TEXT = (function () {
    var map = {};
    for (var i = 0; i < WORDS.length; i++) map[WORDS[i].word] = WORDS[i];
    return map;
  })();

  /* ---------- 抽词来源：四级词库 / 自定义词库（bank.js，2026-10-26） ----------
     进度按来源隔离：切来源时把平铺字段存进 ctx[旧来源]，再取回 ctx[新来源]，
     四级词库的「已学 N 词」不因换了自定义词库而丢。 */
  function activeWords() {
    if (state.source && state.source !== "cet4") {
      var bank = window.BANKS && BANKS.byId(state.source);
      if (bank) return BANKS.entriesOf(bank);
      state.source = "cet4";   // 词库被删等异常 → 回四级词库
    }
    return WORDS;
  }
  function ctxFields() {
    return {
      pool: state.pool, cursor: state.cursor,
      roundCounter: state.roundCounter, currentRound: state.currentRound
    };
  }
  function applyCtx(c) {
    state.pool = c.pool || [];
    state.cursor = c.cursor || 0;
    state.roundCounter = c.roundCounter || 0;
    state.currentRound = c.currentRound || null;
  }
  function switchSource(id) {
    if (!id || id === state.source) return;
    if (id !== "cet4" && !(window.BANKS && BANKS.byId(id))) return;
    state.ctx[state.source] = ctxFields();       // 旧来源进度存档
    state.source = id;
    if (!state.ctx[id]) {
      state.ctx[id] = { pool: [], cursor: 0, roundCounter: 0, currentRound: null };
    }
    applyCtx(state.ctx[id]);
    state.view = "learn";
    state.showAnswer = false;
    state.reviewIndex = 0;
    if (!state.currentRound) {
      document.dispatchEvent(new CustomEvent("xd:source-changed", { detail: { id: state.source } }));
      drawRound(); return;   // 该来源第一次学：直接抽第一轮
    }
    saveState();
    renderAll();
    document.dispatchEvent(new CustomEvent("xd:source-changed", { detail: { id: state.source } }));
    var b = id === "cet4" ? null : BANKS.byId(id);
    toast(b ? "开始学「" + b.name + "」" : "已回到四级词库");
  }
  function lookupWord(text) {
    if (WORD_BY_TEXT[text]) return WORD_BY_TEXT[text];
    if (!window.BANKS) return null;
    var bank = BANKS.bankOfWord(text);
    if (!bank) return null;
    var w = String(text).toLowerCase();
    var list = BANKS.entriesOf(bank);
    for (var i = 0; i < list.length; i++) if (list[i].word === w) return list[i];
    return null;
  }

  /* ---------- 复习模式：所有学过的词，按 20 个一组分页 ---------- */
  /* ---------- 复习模式的词源：全部已学词 / 只看已标记的词 ---------- */
  function getLearnedWords() {
    var list = activeWords();
    if (!Array.isArray(state.pool) || state.pool.length !== list.length) return [];
    return state.pool.slice(0, Math.min(state.cursor, state.pool.length)).map(function (i) { return list[i]; });
  }
  // 当前模式下被标记过的词（按标记先后顺序；词库里有释义的用词条，
  // 没有的（故事里顺手标记的生词）给占位词条：优先带用户在故事角卡手填的
  // 释义（story.js 暴露的 UserDict），没有手填再给空释义，保证标记模式可见）
  function getMarkedWords() {
    var arr = marksFor(state.mode);
    if (!arr || !arr.length) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var w = lookupWord(arr[i]);
      if (!w) {
        var uMean = (window.UserDict && UserDict.meanOf) ? UserDict.meanOf(arr[i]) : "";
        w = { word: arr[i], meaning: uMean, phonetic: "" };
      }
      out.push(w);
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
    var list = activeWords();
    var pool = [];
    for (var i = 0; i < list.length; i++) pool.push(i);
    for (var k = pool.length - 1; k > 0; k--) {
      var j = Math.floor(Math.random() * (k + 1));
      var tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
    }
    return pool;
  }

  function drawRound() {
    var list = activeWords();
    if (!Array.isArray(state.pool) || state.pool.length !== list.length) {
      state.pool = freshPool();
      state.cursor = 0;
    }
    // 跨轮不重复；抽完一轮后重新打乱循环（词库比一轮还小时，每轮都重新洗牌）
    if (state.cursor + ROUND_SIZE > list.length) {
      state.pool = freshPool();
      state.cursor = 0;
    }
    var indices = state.pool.slice(state.cursor, state.cursor + ROUND_SIZE);
    state.cursor += ROUND_SIZE;

    var words = indices.map(function (i) { return list[i]; });
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
    // 当前来源的进度随时写回 ctx，切来源时才不会丢
    if (state.ctx && state.source) state.ctx[state.source] = ctxFields();
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
        marks: state.marks,
        source: state.source,
        ctx: state.ctx
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
      // 来源与按来源隔离的进度：老存档没有 → 平铺字段整体迁入 cet4 名下
      if (typeof state.source !== "string" || !state.source) state.source = "cet4";
      if (state.source !== "cet4" && !(window.BANKS && BANKS.byId(state.source))) state.source = "cet4";
      if (!state.ctx || typeof state.ctx !== "object") state.ctx = {};
      if (!state.ctx[state.source]) {
        state.ctx[state.source] = ctxFields();
      } else {
        applyCtx(state.ctx[state.source]);
      }
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

  /* ---------- 系统按钮簇（皮肤 / 音效 / 备份 / 重置）：托盘 ↔ 顶栏 搬运 ----------
     按钮常驻当前视图卡下的 .card-tray（HTML 里初始放在学习页的 .sys-slot）；
     切视图时搬进新视图的槽；开故事书时托盘整块隐藏，搬回顶栏，功能不断。 */
  var sysCluster = document.getElementById("sys-cluster");
  var headerRightEl = document.querySelector(".header-right");
  var roundBadgeEl = document.getElementById("round-badge");
  function mountSysCluster() {
    if (!sysCluster || !headerRightEl) return;
    if (document.getElementById("view-learn").classList.contains("story-open")) {
      // 徽标可能包在 .source-switch（词库切换器）里 → 锚点取包裹层，保证是直接子节点
      var anchor = (roundBadgeEl && roundBadgeEl.closest(".source-switch")) || roundBadgeEl;
      if (anchor && (sysCluster.parentElement !== headerRightEl || sysCluster.nextElementSibling !== anchor)) {
        headerRightEl.insertBefore(sysCluster, anchor);
      }
      return;
    }
    var slot = document.querySelector(".view-active .sys-slot");
    if (slot && sysCluster.parentElement !== slot) slot.appendChild(sysCluster);
  }

  /* ---------- 视图切换 ---------- */
  function switchView(name) {
    state.view = name;
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("view-active"); });
    document.getElementById(name === "review" ? "view-review" : "view-learn").classList.add("view-active");
    document.getElementById("app-header").style.display = "flex";
    mountSysCluster();
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

    /* 翻面状态（英文 / 中文模式）：换词 / 换模式由 renderCard 依据 showAnswer 复位；
       翻面本身（toggleFlip / revealAnswer）不走 renderCard，动画不会被打断。
       背单词模式：无翻面，壳层已由 CSS display:contents 拆掉。 */
    card.classList.remove("is-flipping");
    if (card._flipTimer) { clearTimeout(card._flipTimer); card._flipTimer = null; }
    if (state.mode === "en" || state.mode === "zh") {
      card.classList.toggle("is-flipped", !!state.showAnswer);
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-pressed", state.showAnswer ? "true" : "false");
      card.setAttribute("aria-label", state.mode === "en" ? "点击翻面查看中文释义" : "点击翻面查看英文单词");
    } else {
      card.classList.remove("is-flipped");
      card.removeAttribute("role");
      card.removeAttribute("tabindex");
      card.removeAttribute("aria-pressed");
      card.removeAttribute("aria-label");
    }

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
    var learned = state.currentRound ? Math.min(round * ROUND_SIZE, activeWords().length) : 0;
    var srcLabel = "";
    if (state.source !== "cet4" && window.BANKS) {
      var b = BANKS.byId(state.source);
      if (b) srcLabel = "「" + b.name + "」 · ";
    }
    badge.textContent = srcLabel + "第 " + round + " 轮 · 已学 " + learned + " 词";
  }

  /* ---------- 故事面板 ----------
     面板内容（空态 / 生成中 / 成品）由 story.js 负责（AI 生成），
     这里不再写入静态示例 —— renderAll 不碰面板内容。 */

  /* ---------- 总渲染 ---------- */
  function renderAll() {
    switchView(state.view);
    renderModeSwitchers();
    renderRoundBadge();
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
    var dir = i > state.currentIndex ? 1 : -1;
    playWordSwap(document.querySelector("#view-learn .flashcard"), dir, function () {
      state.currentIndex = i;
      state.showAnswer = false;
      saveState();
      renderCard("learn");
    });
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

  /* 英文 / 中文模式：揭示 = 翻面（英文见释义、中文见单词）。 */
  function revealAnswer() {
    state.showAnswer = true;
    saveState();
    var viewEl = document.getElementById(state.view === "review" ? "view-review" : "view-learn");
    var card = viewEl && viewEl.querySelector(".flashcard");
    if (card) setFlip(card, true);
  }

  /* ---------- 翻面（英文 / 中文模式） ----------
     真 3D：正面单词 + 音标，背面中文释义。只切类名，不走 renderCard。
     .is-flipping 只在动画期间挂着（下划线展开最晚 340+480=820ms 结束），
     挂着期间播「拿起-放下」抬升与高光扫过，动画完毕摘掉，等下次翻面重播。 */
  var FLIP_ANIM_MS = 900;
  function setFlip(card, flipped) {
    card.classList.toggle("is-flipped", flipped);
    card.setAttribute("aria-pressed", flipped ? "true" : "false");
    card.classList.remove("is-flipping");
    // 强制重启动画：先摘掉再在下一帧挂回，连续点击也能从头播
    void card.offsetWidth;
    card.classList.add("is-flipping");
    if (card._flipTimer) clearTimeout(card._flipTimer);
    card._flipTimer = setTimeout(function () {
      card.classList.remove("is-flipping");
      card._flipTimer = null;
    }, FLIP_ANIM_MS);
  }
  function toggleFlip(card) {
    if ((state.mode !== "en" && state.mode !== "zh") || !card) return;
    var flipped = !card.classList.contains("is-flipped");
    state.showAnswer = flipped;
    saveState();
    setFlip(card, flipped);
  }

  /* ---------- 切词：叠卡错位（三种模式通用） ----------
     顶层纸（背单词模式是 .card-flyer，中英文模式是整个翻转层）向右（下一个）/
     向左（上一个）抽走 200ms，中点换词，新词带着纸从下面那张卡的位置抬上来 260ms。
     与翻面刻意分成两类事件：翻 = 绕 Y 轴转「看另一面」，切 = 抽走 + 抬起「换一张卡」。
     减动效直接换词不播；动画期间忽略连点（_swapping 占位）。 */
  function playWordSwap(card, dir, apply) {
    if (!card) { apply(); return; }
    var reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* 保守当 false */ }
    if (reduce) { apply(); return; }
    if (card._swapping) return;
    card._swapping = true;
    var outCls = dir > 0 ? "swap-out-next" : "swap-out-prev";
    var inCls = dir > 0 ? "swap-in-next" : "swap-in-prev";
    card.classList.remove("swap-out-next", "swap-out-prev", "swap-in-next", "swap-in-prev");
    void card.offsetWidth;
    card.classList.add(outCls);
    setTimeout(function () {
      apply();                                  // 顶层纸抽到画外时换词，肉眼不可见
      card.classList.remove(outCls);
      void card.offsetWidth;
      card.classList.add(inCls);
      setTimeout(function () {
        card.classList.remove(inCls);
        card._swapping = false;
      }, 300);
    }, 205);
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
    // 抽词来源也回到四级词库，但只清当前来源的进度（其他词库的进度保留）
    state.source = "cet4";
    state.ctx = { cet4: { pool: [], cursor: 0, roundCounter: 0, currentRound: null } };
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

    // 学习页：开始新一轮 / 生成故事
    document.getElementById("btn-new-round-learn").addEventListener("click", function () { drawRound(); });

    /* 故事面板展开 / 收起开关：只切一个 .story-open 类到学习视图，
       具体怎么让位（卡片区隐藏、书桌居中）全交给 style.css 的「书桌」段。
       AI 生成本体在 story.js。 */
    var btnGen = document.getElementById("btn-generate");
    var learnView = document.getElementById("view-learn");
    function setSpanText(span, text) {
      // 图标是子元素，文字是它后面的文本节点（把最后一个非空文本节点换掉）
      for (var i = span.childNodes.length - 1; i >= 0; i--) {
        if (span.childNodes[i].nodeType === 3 && span.childNodes[i].nodeValue.trim()) {
          span.childNodes[i].nodeValue = " " + text;
        }
      }
    }
    /* 这个按钮只管展开 / 收起，生成走面板标题行的「✨ 生成本轮故事」（story.js）。 */
    function setGenLabel(open) {
      setSpanText(btnGen.querySelector(".std-label"), open ? "收起故事" : "看今日故事");
    }
    /* 故事书开合：合着时整本书藏在卡片下面，只露一条丝带（#btn-book-open）；
       翻开后书占中央，卡片区、进度、按钮条全部让位（让位规则写在 style.css 的「书桌」段）。 */
    function setStoryOpen(open) {
      learnView.classList.toggle("story-open", open);
      mountSysCluster();
      // 开书时把主容器底部那 80px 呼吸空收掉，书才能在一屏里放平
      var appMain = document.querySelector(".app-main");
      if (appMain) appMain.classList.toggle("is-reading", open);
      // body 级阅读态标记：CSS 据此收起顶栏系统按钮簇、把书桌竖向居中（书桌段）
      document.body.classList.toggle("story-reading", open);
      btnGen.setAttribute("aria-expanded", open ? "true" : "false");
      setGenLabel(open);
      // story.js 收到后会重新量一页装不装得下
      document.dispatchEvent(new CustomEvent("xd:book-open", { detail: { open: open } }));
      if (!open) return;
      // 窄屏单页时书会比视口高，带一下视野；宽屏书是等比缩放过的，不用滚
      if (window.innerWidth < 1024) {
        var panel = document.querySelector("#view-learn .story-panel");
        if (panel && panel.scrollIntoView) {
          var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          panel.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        }
      }
    }
    /* 书是 1080×720 的定尺纸，整本按视口等比缩，字号跟着一起缩 ——
       这样 1440 和 1024 下看到的是同一本书，只是大小不同。 */
    function fitBook() {
      var panel = document.querySelector("#view-learn .story-panel");
      if (!panel) return;
      var s = 1;
      var drop = 0;
      if (window.innerWidth >= 1024) {
        // 书是整屏几何居中：上下各分到 (视口高 - 书高) / 2 的空档，
        // 上面那份必须塞得下「顶栏 + 工具条」，所以书高上限是
        // 视口高 - 2 × (顶栏 + 工具条)。这样居中时工具条正好落在顶栏下沿，
        // 不会钻进去。
        var header = document.querySelector(".app-header");
        var headerH = header ? header.offsetHeight : 78;
        var tools = document.querySelector("#view-learn .book-tools");
        // 书没打开时工具条是 hidden，量不到 —— 退回标称值（34 + 10 间距）
        var toolsH = (tools && tools.offsetHeight > 20) ? tools.offsetHeight + 10 : 44;
        var byW = (window.innerWidth - 96) / 1080;
        var byH = (window.innerHeight - 2 * (headerH + toolsH)) / 720;
        s = Math.min(byW, byH, 1);
        // 低于 0.78 字就发糊（18px × 0.78 ≈ 14px）。矮屏宁可让书比
        // 完美居中低一点，也不能为了居中把字缩糊。
        if (s < 0.78) s = 0.78;
        // 上面的下限一旦生效，书就比「上限」高了，整屏居中会把工具条顶进顶栏；
        // 算出需要整体下推多少，由 CSS 的 --book-drop 兑现（最多 80px 兜住极端矮屏）
        var idealTop = (window.innerHeight - 720 * s) / 2;
        drop = Math.max(0, Math.min(80, Math.ceil(headerH + toolsH - idealTop)));
      }
      panel.style.setProperty("--book-scale", s.toFixed(4));
      panel.style.setProperty("--book-drop", drop + "px");
    }
    fitBook();
    window.addEventListener("resize", function () {
      fitBook();
      if (learnView.classList.contains("story-open")) {
        document.dispatchEvent(new CustomEvent("xd:book-open", { detail: { open: true } }));
      }
    });

    btnGen.addEventListener("click", function () {
      setStoryOpen(!learnView.classList.contains("story-open"));
      fitBook();
    });
    var btnBookOpen = document.getElementById("btn-book-open");
    if (btnBookOpen) btnBookOpen.addEventListener("click", openStoryFromRibbon);

    /* ---- 开书入场两拍动画（2026-10-26 深夜重构 · 薄荷/暖阳专属）----
       ① 卡片退场（~0.6s）：丝带抽出，卡片整体上移出屏，露出压在下面的合书
          —— 书在 JS 里临时搬出卡片、fixed 定位停在原位（见 style.css 两拍段）；
       ② 转向与翻书同时进行（~1.3s）：摊开的书以「立书位姿」（rotate -90°、
          对准合书中心）淡入接棒，一段动画里边转正、边飞向桌心、边放大，
          翻页叶全程同步掀开 —— 全程只有这一次旋转，不再有「立起→倒下」
          的两段旋转观感（用户反馈：转纵向与翻书同时进行，避免视觉差异）。
       中途任意点击跳过到末态；Esc 合书先跳完再合。
       窄屏（<1024，单页版式）/ 减动效 → 走原来的直接打开。 */
    var introAnims = [];
    var introRunning = false;
    var introSkipFn = null;
    var introBookEl = null, introBookHome = null, introBookNext = null, introBookStyle = "";
    function introTargetEnabled() {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      return window.innerWidth >= 1024;
    }
    function introFadeOut(el, dur) {
      if (!el || !el.animate) return;
      introAnims.push(el.animate([{ opacity: 1 }, { opacity: 0 }],
        { duration: dur, fill: "forwards" }));
    }
    function introFadeIn(el, dur, delay) {
      if (!el || !el.animate) return;
      // fill "both"：延迟期间就保持透明，落定后 hold 到 cleanup 再交还 CSS
      introAnims.push(el.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: dur, delay: delay || 0, fill: "both" }));
    }
    /* 把合书从卡片里搬到视图根、fixed 停在原位（卡片退场时它纹丝不动）；
       cleanupIntro / 第三幕切场时 restoreIntroBook 归还原位还原样式 */
    function detachBookUnder(bu) {
      introBookEl = bu;
      introBookHome = bu.parentNode;
      introBookNext = bu.nextSibling;
      introBookStyle = bu.style.cssText;
      var r = bu.getBoundingClientRect();
      bu.style.cssText = introBookStyle +
        ";position:fixed;margin:0;z-index:3;" +
        "left:" + r.left.toFixed(1) + "px;top:" + r.top.toFixed(1) + "px;" +
        "width:" + r.width.toFixed(1) + "px;height:" + r.height.toFixed(1) + "px;";
      learnView.appendChild(bu);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }
    function restoreIntroBook() {
      if (introBookEl && introBookHome) {
        introBookEl.style.cssText = introBookStyle;
        introBookHome.insertBefore(introBookEl, introBookNext);
      }
      introBookEl = introBookHome = introBookNext = null;
      introBookStyle = "";
    }
    function cleanupIntro() {
      introAnims.forEach(function (a) { try { a.cancel(); } catch (e) { /* 已结束 */ } });
      introAnims = [];
      restoreIntroBook();
      var wrap = document.querySelector("#view-learn .book-flip-wrap");
      if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
      var bookEl = document.querySelector("#view-learn .book");
      if (bookEl) {
        bookEl.style.removeProperty("transform-origin");
        bookEl.style.removeProperty("pointer-events");
        // 收书时把 opacity:0 写进了内联，这里要清掉，否则整本书一直藏着
        bookEl.style.removeProperty("opacity");
        // 翻页期间被藏起来的字（playFlipLeaves 写过 opacity:0 / 1）一并复位
        Array.prototype.forEach.call(bookEl.querySelectorAll(".book-page"), function (p) {
          p.style.removeProperty("opacity");
        });
      }
      learnView.classList.remove("story-intro");
      /* 抽书时给面板摘过入场扫场。页面入场（intro-run，1700ms 才摘）往往比
         抽书结束得晚 —— 这会儿就摘 shelf-cut 会把那条动画重建、从 0 再扫一遍，
         书当场消失一下。等入场收尾之后再摘。 */
      if (!document.documentElement.classList.contains("intro-run")) {
        learnView.classList.remove("shelf-cut");
      }
      var card = document.querySelector("#view-learn .flashcard");
      if (card) card.style.removeProperty("--card-exit-y");
      if (introSkipFn) { document.removeEventListener("click", introSkipFn, true); introSkipFn = null; }
      introRunning = false;
    }
    function finishIntroInstant() {
      introAnims.forEach(function (a) { try { a.finish(); } catch (e) { /* 已结束 */ } });
      cleanupIntro();
    }
    /* 翻页叶：两张纸（封面 + 一张空白扉页），各拆前后两半张（0→-90 / -90→-180
       接力，不依赖 backface —— 见 style.css「开书入场」段的说明）。
       DOM 顺序 = 绘制顺序：扉页在最下、封面在最上；掀开的顺序正好相反。
       （层序反了会被延迟期的整页白纸盖住，绿皮完全看不见，踩过）
       翻页期间书页上的字先藏起来、只留 .book 的纸白底，纸一张张翻完字再浮上来 ——
       否则书一摊开正文就已经在那儿，读作「几张薄纸片从现成的内容前面飞过」，
       不是翻书。从丝带开书、从书架抽书两条路径共用这一段。 */
    function playFlipLeaves(book, rect, delay, speed) {
      if (!book || !rect || rect.width <= 500) return;
      /* 减动效：整段不跑（CSS 里 .book-flip-wrap 是 display:none，只剩藏字那半截
         会留下永远不出现的白纸 —— 所以直接不进来） */
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      var d = delay || 0;
      var k = speed || 1;                       // 抽书那条路走慢一点，丝带开书保持原速
      var T = function (v) { return Math.round(v * k); };
      var wrap = document.createElement("div");
      wrap.className = "book-flip-wrap";
      /* DOM 顺序 = 绘制顺序：扉页在最下、封面在最上，掀开的顺序正好相反。
         每张纸里再挂一片 .bk-shade —— 纸翻起来时那一段由亮转暗、落下时又
         转亮，靠明暗扫过去才读得出「一张纸在过」。纯白纸翻在纯白书上，
         光有投影是不够的（投影会随着 rotateY 一起转窄，转侧时几乎消失）。 */
      var FWD = ["cover", "page"];                   // 掀开顺序（上 → 下）
      var DOM = FWD.slice().reverse();               // 绘制顺序（下 → 上）
      var leaves = "";
      DOM.forEach(function (n) {
        leaves += '<div class="bk-leaf bk-leaf-' + n + '-front"><i class="bk-shade"></i></div>' +
                  '<div class="bk-leaf bk-leaf-' + n + '-back"><i class="bk-shade"></i></div>';
      });
      wrap.innerHTML = '<div class="book-flip-persp">' + leaves + '</div>';
      book.appendChild(wrap);
      var leaf = function (cls) { return wrap.querySelector(".bk-leaf-" + cls); };
      var shade = function (cls) { return leaf(cls).querySelector(".bk-shade"); };
      var flipEase = "cubic-bezier(.45,.05,.55,.95)";
      var PAGE_MS = 200;     // 半张纸翻 90° 的用时
      var STEP_MS = 300;     // 相邻两张纸的起手间隔（比半张纸长，纸才一张张过）
      var DARK = 0.2;        // 侧对时的最暗值（正对时 0）

      /* 先藏字：纸白底在 .book 上，.book-page 只装字、页眉页脚，
         整页 opacity 0 露出来的就是一张干净白纸（中缝影在 .book::before，还在）。 */
      var pages = book.querySelectorAll(".book-page");
      Array.prototype.forEach.call(pages, function (p) { p.style.opacity = "0"; });

      FWD.forEach(function (name, i) {
        var t0 = d + i * T(STEP_MS);
        introAnims.push(leaf(name + "-front").animate(
          [{ transform: "rotateY(0deg)" }, { transform: "rotateY(-90deg)" }],
          { duration: T(PAGE_MS), delay: t0, easing: flipEase, fill: "forwards" }));
        introAnims.push(leaf(name + "-back").animate(
          [{ transform: "rotateY(-90deg)" }, { transform: "rotateY(-180deg)" }],
          { duration: T(PAGE_MS), delay: t0 + T(PAGE_MS), easing: flipEase, fill: "both" }));
        // 纸面由亮转暗（正对 → 侧对），背面再由暗转亮（侧对 → 摊平在左页上）
        introAnims.push(shade(name + "-front").animate(
          [{ opacity: 0 }, { opacity: DARK }],
          { duration: T(PAGE_MS), delay: t0, easing: "ease-in", fill: "forwards" }));
        introAnims.push(shade(name + "-back").animate(
          [{ opacity: DARK }, { opacity: 0.07 }],
          { duration: T(PAGE_MS), delay: t0 + T(PAGE_MS), easing: "linear", fill: "forwards" }));
        /* 淡出必须等「翻到底」之后：提前起淡的话叶子还差二十几度就透明，
           左页的字会从纸里透出来 —— 看着像穿模，也不像翻过去一张空白页。
           落定在 t0 + 2·PAGE_MS，停 60 再花 160 淡掉。 */
        introAnims.push(leaf(name + "-back").animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: T(160), delay: t0 + T(2 * PAGE_MS) + T(60), easing: "ease-out", fill: "forwards" }));
      });

      /* 字浮现：最后一张纸刚落到左页就起，和它的淡出交叉着来 ——
         读作「纸翻过去，印的字从纸上浮出来」，不是啪一下替换。 */
      var unveilAt = d + (FWD.length - 1) * T(STEP_MS) + T(2 * PAGE_MS) + T(80);
      Array.prototype.forEach.call(pages, function (p) {
        var a = p.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: T(280), delay: unveilAt, easing: "ease-out", fill: "forwards" });
        // fill:forwards 的已结束动画会被浏览器异步移除，末态要落到内联
        a.onfinish = function () { p.style.opacity = "1"; };
        introAnims.push(a);
      });
    }

    /* 跳过 = 动画全部落到末态，书直接摊开在故事桌（不等二三拍） */
    function skipIntroToEnd() {
      var wasRunning = introRunning;
      finishIntroInstant();
      if (wasRunning && !learnView.classList.contains("story-open")) {
        setStoryOpen(true); fitBook();
      }
    }
    function openStoryFromRibbon() {
      if (introRunning || !introTargetEnabled() || !learnView.animate) {
        setStoryOpen(true); fitBook(); return;
      }
      introRunning = true;
      var card = document.querySelector("#view-learn .flashcard");
      var ribbon = document.getElementById("btn-book-open");
      var bookUnder = document.querySelector("#view-learn .book-under");
      if (!card || !bookUnder) { setStoryOpen(true); fitBook(); introRunning = false; return; }
      // 先在未变换的静止态量下卡片与合书的屏幕位姿（后面全按这套坐标对齐）
      var cardRect = card.getBoundingClientRect();
      var buC = detachBookUnder(bookUnder);
      learnView.classList.add("story-intro");
      // ── ① 卡片退场：丝带抽出 + 整卡上移出屏（书留在原地，露出） ──
      // 多退 70px：卡片的投影会盖过底边 ~40px，只退 30px 会在顶缘露出阴影边
      var exitY = -(cardRect.bottom + 70);
      card.style.setProperty("--card-exit-y", exitY.toFixed(0) + "px");
      introAnims.push(card.animate(
        [{ transform: "translateY(0px)" }, { transform: "translateY(" + exitY.toFixed(0) + "px)" }],
        { duration: 560, delay: 60, easing: "cubic-bezier(.45,0,.6,1)", fill: "forwards" }));
      if (ribbon) introAnims.push(ribbon.animate(
        [{ transform: "translateY(3px)", opacity: 1 },
         { transform: "translateY(16px)", opacity: .85, offset: .6 },
         { transform: "translateY(22px)", opacity: 0 }],
        { duration: 280, easing: "ease-in", fill: "forwards" }));
      Array.prototype.forEach.call(
        document.querySelectorAll("#view-learn .progress-wrap, #view-learn .action-bar, #view-learn .view-title-row, #view-learn .mode-switcher, #view-learn .card-tray, #view-learn .flashcard-area .nav"),
        function (el) { introFadeOut(el, 170); });
      // 中途任意点击 = 跳过，直接落到末态（capture 阶段拦下，别让这一击再触发丝带）
      introSkipFn = function (e) {
        if (!introRunning) return;
        if (e && e.stopPropagation) e.stopPropagation();
        skipIntroToEnd();
      };
      document.addEventListener("click", introSkipFn, true);

      // ── ② 转向与翻书同时进行：摊开书以立书位姿（-90°）淡入接棒，合书交叉淡出；
      //    一段动画里转正、飞向桌心、放大同步完成，翻页叶全程掀开 ──
      //    只有这一次旋转：没有「先立起、再倒下」的第二个动作（用户反馈）。
      setTimeout(function () {
        // 前一拍里被跳过 / Esc 合书过 → introRunning 已被 cleanup 置 false，别再进第二拍
        if (!introRunning) return;
        setStoryOpen(true);
        fitBook();
        var book = document.querySelector("#view-learn .book");
        if (!book || !book.animate) { cleanupIntro(); return; }
        var toRect = book.getBoundingClientRect();
        var s1 = toRect.width / 1080;
        /* 关键：.book 的 CSS transform-origin 是 0 0（定尺纸排版锚点，见 style.css）。
           飞行动画期间临时改为中心原点 —— 起点对接与转正旋转都以书中心为基准，
           不会绕左上角甩出去；cleanup 时摘掉内联 origin，CSS 默认
           scale(--book-scale) · origin 0 0 的视觉与末帧完全一致，无跳变。 */
        book.style.transformOrigin = "50% 50%";
        var ecx = toRect.left + 540, ecy = toRect.top + 360;   /* 未缩放元素中心 */
        var dx = buC.x - ecx, dy = buC.y - ecy;
        var s0 = Math.max(buC.h / 720, buC.w / 1080) * 1.02;
        /* 中心原点下视觉框 = 中心 ± (540·s, 360·s)；后两帧的 translate 恰好补回
           缩放差，使 settle 与末帧的视觉左上角钉在 CSS 默认位 (toRect.left/top)。
           一段三帧：前 ~90% 从立书位姿（rotate -90°、opacity 0 淡入）飞到桌心
           （边转正边放大，翻页叶同步掀开），末段 settle 超冲 s1×1.012 后回落
           —— 末帧与 CSS 默认态一致，cancel 无跳变。 */
        var t0 = "translate(" + dx.toFixed(1) + "px," + dy.toFixed(1) + "px) rotate(-90deg) scale(" + s0.toFixed(4) + ")";
        introAnims.push(book.animate(
          [{ transform: t0, opacity: 0, easing: "ease-out" },
           { transform: t0, opacity: 1, offset: 0.05, easing: "cubic-bezier(.25,.6,.3,1)" },
           { transform: "translate(" + (540 * s1 * 1.012 - 540).toFixed(1) + "px," + (360 * s1 * 1.012 - 360).toFixed(1) + "px) rotate(0deg) scale(" + (s1 * 1.012).toFixed(4) + ")", opacity: 1, offset: 0.9, easing: "ease-out" },
           { transform: "translate(" + (540 * s1 - 540).toFixed(1) + "px," + (360 * s1 - 360).toFixed(1) + "px) rotate(0deg) scale(" + s1.toFixed(4) + ")", opacity: 1 }],
          { duration: 1300, fill: "forwards" }));
        // 合书交叉淡出：新书已在它的位姿出现，快速让位交棒。
        // onfinish 把终态写进内联样式兜底 —— fill:forwards 的已结束动画会被
        // 浏览器按「可替换动画」异步移除，移除后 opacity 会闪回 1、绿书盖在故事页上
        if (bookUnder.animate) {
          var buFade = bookUnder.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: 240, easing: "ease-out", fill: "forwards" });
          buFade.onfinish = function () { bookUnder.style.opacity = "0"; };
          introAnims.push(buFade);
        }
        // 翻页叶：时序与转体同步 —— 书在转正的途中封面就开始掀，转到位时纸也翻完
        playFlipLeaves(book, toRect, 120);
        // ── 收尾：工具条浮现（顶栏按钮簇阅读态由 CSS 整簇收起，不淡入） ──
        introFadeIn(document.querySelector("#view-learn .book-tools"), 300, 650);
        // 翻页到 1180ms（120 起手 + 两张纸，字浮完）才收尾，cleanup 必须排在它之后
        setTimeout(cleanupIntro, 1220);
      }, 620);
    }
    var btnBookClose = document.getElementById("btn-book-close");
    if (btnBookClose) btnBookClose.addEventListener("click", function () {
      setStoryOpen(false);
      var card = document.querySelector("#view-learn .flashcard");
      if (card && card.focus) card.focus({ preventScroll: true });
    });

    /* ---- 从书架抽书（story.js 派发的两次握手）----
       点书脊时，故事集弹窗还盖着整页：先把书桌在弹窗后面摆到阅读态、
       把真书藏成透明，并把书的最终矩形回传过去 —— 飞行体要照着它摊平。
       等飞行体摊成「书棱」落到桌心，再让真书从薄片展开 + 翻页叶掀开。
       两次都是 detail 对象直接读写（同步握手，省掉一轮异步等待）。 */
    /* 书已开着时点书脊（用户的真实路径：故事集按钮长在书工具条里，书必然先开着）：
       把桌上这本原地「抽走」—— 压成一条书棱并淡出，给飞行体腾出桌心，
       等飞行体摊平到位，新书再从同一条棱上长出来（同 reveal 那一拍）。
       不要加 story-intro：那套会把顶栏从 absolute 掰回 relative，书桌会跳一下。 */
    function collapseOpenBook() {
      var tools = document.querySelector("#view-learn .book-tools");
      if (tools) introFadeOut(tools, 240);
      var book = document.querySelector("#view-learn .book");
      if (!book || !book.animate) return;
      var r = book.getBoundingClientRect();
      var s = r.width / 1080;
      var dx = (540 * s - 540).toFixed(1);
      var dy = (360 * s - 360).toFixed(1);
      var full = "translate(" + dx + "px," + dy + "px) rotate(0deg) scale(" + s.toFixed(4) + ")";
      var thin = "translate(" + dx + "px," + dy + "px) rotate(0deg) scale(" +
        s.toFixed(4) + "," + (s * 0.05).toFixed(4) + ")";
      book.style.transformOrigin = "50% 50%";
      book.style.pointerEvents = "none";
      var a = book.animate([
        { transform: full, opacity: 1, easing: "ease-in" },
        { transform: thin, opacity: 0 }
      ], { duration: 240, fill: "forwards" });
      a.id = "shelf-collapse";   // 定帧截图时按 id 找它
      /* 末帧必须落到内联：fill:forwards 的已结束动画会被浏览器当「可替换动画」
         异步移除，移除后 opacity 回到 CSS 的 1 —— 这本书会在书脊转过来的那一拍
         以「压扁的书页」浮现，正好盖在飞行体的封面上（踩过两次了）。 */
      a.onfinish = function () { book.style.opacity = "0"; };
      introAnims.push(a);
    }
    function bookFromShelfPrepare(detail) {
      if (introRunning) finishIntroInstant();
      /* 页面入场扫场还在爬（面板 0.38~0.74s 才起步、0.38s 才淡完）：不摘掉的话
         书落定那一刻它正好爬到一半，整片书页发灰；面板上的 translateY(14px)
         也会让下面量到的书位姿偏高。必须在 fitBook / bookRect 之前摘。 */
      learnView.classList.add("shelf-cut");
      if (learnView.classList.contains("story-open")) {
        /* 书已经开着：先按当前布局量准矩形，再把书收成书棱。
           顺序不能反 —— 压扁之后 getBoundingClientRect 只剩几十像素高。 */
        fitBook();
        detail.rect = bookRect();
        collapseOpenBook();
        return;
      }
      learnView.classList.add("story-intro");   // 复用两拍那套：卡片让位、书不可点
      learnView.classList.add("story-fly");     // 书与工具条先透明
      setStoryOpen(true);
      fitBook();
      detail.rect = bookRect();
    }
    function bookRect() {
      var book = document.querySelector("#view-learn .book");
      if (!book) return null;
      var r = book.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    function bookFromShelfReveal(e) {
      var book = document.querySelector("#view-learn .book");
      var r = bookRect();
      if (!book || !book.animate || !r) { cleanupIntro(); return; }
      var s1 = r.width / 1080;
      var baseX = 540 * s1 - 540;
      var baseY = 360 * s1 - 360;
      var flat = "translate(" + baseX.toFixed(1) + "px," + baseY.toFixed(1) + "px) rotate(0deg) scale(" + s1.toFixed(4) + ")";
      /* 起始 = 飞行体转正的那枚「书的正面」（story.js 随事件带来尺寸）：
         宽只有一页、高已是全高，就在书桌正中。展开时宽度 1 页 → 2 页，
         中心不动、两边同时长 —— 读作「翻开」，不是「一块纸被拉大」。 */
      var d = (e && e.detail) || {};
      var sx0 = d.w ? (d.w / 1080).toFixed(4) : (s1 * 0.5).toFixed(4);
      var sy0 = d.h ? (d.h / 720).toFixed(4) : s1.toFixed(4);
      var closed = "translate(" + baseX.toFixed(1) + "px," + baseY.toFixed(1) +
        "px) rotate(0deg) scale(" + sx0 + "," + sy0 + ")";
      var over = "translate(" + (540 * s1 * 1.008 - 540).toFixed(1) + "px," +
        (360 * s1 * 1.008 - 360).toFixed(1) + "px) rotate(0deg) scale(" + (s1 * 1.008).toFixed(4) + ")";

      book.style.transformOrigin = "50% 50%";
      learnView.classList.remove("story-fly");   // 交棒：下面这帧动画从透明起步
      introRunning = true;
      /* 640ms 铺开（比最初那版慢一档）：起手只有一页宽，文字挤在一半宽里认不清，
         10% 就把透明度拉满 —— 让「书页铺开」这件事当主角，别让它半透明着变形。 */
      var revealAnim = book.animate([
        { transform: closed, opacity: 0, easing: "ease-out" },
        { transform: closed, opacity: 1, offset: 0.10, easing: "ease-out" },
        { transform: over, opacity: 1, offset: 0.86, easing: "cubic-bezier(.25,.7,.3,1)" },
        { transform: flat, opacity: 1 }
      ], { duration: 640, fill: "forwards" });
      revealAnim.id = "shelf-book";   // 定帧截图时按 id 找它
      introAnims.push(revealAnim);
      /* 翻页等书铺开一半再掀：speed 1.25 让叶子的转速跟上被放慢的整体节奏。
         时序（已含 1.25 倍）：第二张纸转到 -180° 在 1075ms，淡出到 1350ms，
         字浮完在 1525ms —— cleanup 必须排在字浮完**之后**再撤 wrap，撤早了
         白纸会啪一下变回文字，收得早了还会把字的淡入动画一起 cancel 掉。 */
      playFlipLeaves(book, r, 200, 1.25);
      introFadeIn(document.querySelector("#view-learn .book-tools"), 360, 700);
      setTimeout(cleanupIntro, 1560);
    }
    document.addEventListener("xd:book-prepare", function (e) {
      if (e.detail) bookFromShelfPrepare(e.detail);
    });
    document.addEventListener("xd:book-reveal", bookFromShelfReveal);

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      // 抽书飞行途中（书脊已飞出、书还没落定）：别让这一下把书合了
      if (document.body.classList.contains("shelf-flying")) return;
      if (!learnView.classList.contains("story-open")) return;
      // 入场动画没放完：先跳到末态再合书，别让两套状态打架
      if (introRunning) finishIntroInstant();
      // 弹窗自己会响应 Esc，别同一次按键既关弹窗又合书
      var m1 = document.getElementById("story-config-modal");
      var m2 = document.getElementById("story-history-modal");
      var bs = document.getElementById("backup-modal");
      var bk = document.getElementById("bank-modal");
      if ((m1 && !m1.hasAttribute("hidden")) || (m2 && !m2.hasAttribute("hidden")) ||
          (bs && !bs.hasAttribute("hidden")) || (bk && !bk.hasAttribute("hidden"))) return;
      setStoryOpen(false);
    });
    setGenLabel(false);
    btnGen.setAttribute("aria-expanded", "false");

    /* 故事 → 卡片：故事正文里的高亮词、覆盖条上的点被点中时（story.js 发自定义事件），
       跳到对应的那张词卡，并让卡片轻亮一下。 */
    document.addEventListener("xd:goto-word", function (e) {
      var w = e.detail && e.detail.word;
      if (!w) return;
      var round = state.currentRound;
      if (!round || !round.words || !round.words.length) return;
      var target = -1;
      for (var i = 0; i < round.words.length; i++) {
        if (String(round.words[i] && round.words[i].word).toLowerCase() === String(w).toLowerCase()) {
          target = i;
          break;
        }
      }
      if (target === -1) return;
      if (state.view !== "learn") switchView("learn");
      if (target !== state.currentIndex) goTo(target);
      var card = document.querySelector("#view-learn .flashcard");
      if (!card) return;
      card.classList.remove("card-pulse");
      void card.offsetWidth;
      card.classList.add("card-pulse");
      setTimeout(function () { card.classList.remove("card-pulse"); }, 950);
      if (card.scrollIntoView) {
        var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        card.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      }
      toast("已跳到「" + round.words[target].word + "」的卡片");
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

    // 翻面：点卡片 / Enter / Space（英文 / 中文模式；卡角按钮与输入控件不触发）
    document.querySelectorAll(".flashcard").forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (e.target.closest(".card-mark, .card-speaker, .answer-row, .write-row")) return;
        toggleFlip(card);
      });
      card.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target !== card) return;   // 卡内输入框等控件自己的键盘行为不抢
        e.preventDefault();
        toggleFlip(card);
      });
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

    // 抽词来源切换（bank.js 的「学习 / 停用」按钮发这个事件）
    document.addEventListener("xd:switch-source", function (e) {
      switchSource(e.detail && e.detail.id);
    });

    // 故事页双击标记（story.js 发）：落进当前模式的书签，与卡片书签同源。
    // 背单词模式没有自己的书签 → 落英文模式书签（复习进入时背单词模式
    // 本来就会被强制切成英文模式，标记在那边可见，行为一致）。
    document.addEventListener("xd:mark-toggle", function (e) {
      var d = e.detail || {};
      var word = String(d.word || "").toLowerCase().trim();
      var mode = (state.mode === "en" || state.mode === "zh") ? state.mode : "en";
      var arr = marksFor(mode);
      if (!word || !arr) { d.supported = false; d.marked = false; return; }
      d.supported = true;
      d.marked = toggleMark(word, mode);
      saveState();
      renderMark("learn");
      renderMark("review");
    });
    // 故事渲染 / 开书时问一遍当前模式的标记清单（同步应答）
    document.addEventListener("xd:marks-snapshot", function (e) {
      var mode = (state.mode === "en" || state.mode === "zh") ? state.mode : "en";
      var arr = marksFor(mode);
      e.detail.list = arr ? arr.slice() : [];
    });
  }

  /* ---------- 初始化 ---------- */
  function ensureCtx() {
    if (!state.ctx || typeof state.ctx !== "object") state.ctx = {};
    if (!state.ctx[state.source]) state.ctx[state.source] = ctxFields();
  }
  function init() {
    loadState();
    ensureCtx();   // 首次打开（无存档）也要有 ctx，切词库才不会踩空
    if (!Array.isArray(state.pool) || state.pool.length !== activeWords().length) {
      state.pool = freshPool(); state.cursor = 0;
    }
    bindEvents();                                // 先绑定事件，保证任何分支按钮都可用
    mountSysCluster();                           // 系统按钮簇就位（托盘 / 顶栏）
    document.dispatchEvent(new CustomEvent("xd:source-changed", { detail: { id: state.source } }));
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
