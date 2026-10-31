/* ============================================================
   xdictionary — AI 故事生成（story.js，2026-10-08 新增）
   ------------------------------------------------------------
   职责：故事面板内容的唯一管理者（空态 / 加载中 / 出错 / 成品）。
   - 只读 localStorage 里的学习进度（english_app_v1）拿当前轮 20 个词，
     不写它、不碰 app.js 的 state；
   - 自己的存档在独立 key english_app_story_v1（与进度 / 皮肤 / 音效互不影响）：
       { config: { baseUrl, apiKey, model },
         story:  { roundKey, en, zh, createdAt } | null,   ← 面板展示的「当前轮」那篇
         history: [ 同结构 + round, words ] }              ← 故事集：历轮生成全保留
     roundKey = currentRound.createdAt → 换轮 / 重置后面板回到空态，
     但历史故事不丢（重置只清学习进度，与「标记保留」同一哲学）。
   - 请求直连 OpenAI 兼容接口（默认 DeepSeek），SSE 流式渲染；
     file:// 直连已用探针实测放行（2026-10-08，HEAD 拿到 HTTP 401 真 JSON）。
   - 2026-10-28 新增「墨水瓶」：没填自己 Key 的访客，可以用兑换码换来的墨滴
     生成（每篇 1 滴），请求经 Worker 转发，Key 只存在服务端。
     墨水瓶状态在独立 key english_app_ink_v1：{ drops, worker, clientId }。
     有 Key 时墨水瓶完全不出现 —— 两条通道互不干扰，老路径一行没动。
   - 操作栏「＋ 展开今日故事」按钮的展开 / 收起职责不变（仍归 app.js）；
     本模块只负责面板内部的「生成本轮故事 / 重新生成」按钮与设置弹窗。
   - 故事面板默认收着 → 生成时借 #btn-generate 的点击展开
     （纯 DOM 行为，不碰状态；顺带复用 app.js 的展开规则）。
   ============================================================ */
(function () {
  "use strict";

  var LS_STORY = "english_app_story_v1";
  var LS_PROGRESS = "english_app_v1";
  var LS_INK = "english_app_ink_v1";     // 墨水瓶：剩余墨滴 / Worker 地址 / 匿名 id
  var DEFAULT_BASE = "https://api.deepseek.com";
  var DEFAULT_MODEL = "deepseek-chat";
  var HISTORY_MAX = 200;   // 故事集上限：每篇约 1~2KB，200 篇远在 localStorage 容量之内

  var els = {};
  var busy = false;
  var wordSentence = {};     // 小写单词 → 它在故事里第一次出现的句号（卡片锚点用）
  var WORD_INFO = null;      // 词库索引：单词 → { phonetic, meaning }
  /* 从书架点开的那一篇。非空时书桌上摊开的是它（而不是当前轮）——
     合上书 / 生成本轮故事 / 点「回到本轮」都会清空，回到本轮视角。 */
  var viewStory = null;

  /* ---------- 小工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function infoOf(word) {
    var key = String(word).toLowerCase();
    if (!WORD_INFO) {
      WORD_INFO = {};
      var list = window.WORDS || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].word) WORD_INFO[list[i].word.toLowerCase()] = list[i];
      }
    }
    if (WORD_INFO[key]) return WORD_INFO[key];
    // 自定义词库兜底：四级词库里没有的词，去 BANKS 里找（找到就缓存）
    if (window.BANKS) {
      var bank = BANKS.bankOfWord(key);
      if (bank) {
        var entries = BANKS.entriesOf(bank);
        for (var j = 0; j < entries.length; j++) {
          if (entries[j] && entries[j].word === key) {
            WORD_INFO[key] = entries[j];
            return entries[j];
          }
        }
      }
    }
    return null;
  }

  /* ---------- 手填释义（词库外的词，2026-10-26）----------
     localStorage key：english_app_dict_v1 = { "小写单词": "释义" }。
     四级词库 + 自定义词库都查不到的词，角卡给输入行让用户自己补释义；
     保存后随点随显（loadUserDict 带缓存），备份整包带走（见 backup.js）。 */
  var LS_DICT = "english_app_dict_v1";
  var userDict = null;       // 懒加载缓存：小写单词 → 释义
  var dockWord = null;       // 角卡当前展示的词（原文大小写，保存 / 还原时用）
  function loadUserDict() {
    if (userDict) return userDict;
    try {
      var obj = JSON.parse(localStorage.getItem(LS_DICT) || "null");
      userDict = (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
    } catch (e) { userDict = {}; }
    for (var k in userDict) if (typeof userDict[k] !== "string") delete userDict[k];
    return userDict;
  }
  function saveUserDict() {
    try { localStorage.setItem(LS_DICT, JSON.stringify(userDict)); } catch (e) { /* 无痕模式 */ }
  }
  function userMeanOf(word) {
    return loadUserDict()[String(word).toLowerCase()] || "";
  }
  /* 暴露给 app.js：标记模式的生词卡自动带上手填释义。
     app.js 先于本模块加载，但只在渲染时取值 → 无时序问题；取值方需判空。 */
  window.UserDict = { meanOf: userMeanOf };

  /* ---------- 标记状态：从 app.js 拉当前模式的标记清单（同步应答） ---------- */
  var markedWords = {};
  function markSnapshot() {
    var snap = { list: null };
    document.dispatchEvent(new CustomEvent("xd:marks-snapshot", { detail: snap }));
    markedWords = {};
    (snap.list || []).forEach(function (w) { if (w) markedWords[String(w).toLowerCase()] = true; });
  }
  function applyMarkedClasses() {
    var nodes = els.panel.querySelectorAll(".st-word, .st-any");
    for (var i = 0; i < nodes.length; i++) {
      var dw = nodes[i].dataset.word;
      nodes[i].classList.toggle("is-marked", !!(dw && markedWords[dw.toLowerCase()]));
    }
  }
  function setMarkedState(word, marked) {
    var key = String(word).toLowerCase();
    if (marked) markedWords[key] = true; else delete markedWords[key];
    var nodes = els.panel.querySelectorAll(".st-word, .st-any");
    for (var i = 0; i < nodes.length; i++) {
      var dw = nodes[i].dataset.word;
      if (dw && dw.toLowerCase() === key) nodes[i].classList.toggle("is-marked", !!marked);
    }
  }

  /* ---------- 句子切分 / 中英配对 ----------
     模型只保证「英文正文 --- 中文对照」，不保证逐句对齐；
     这里按句数尝试对齐，对不上就退化为「英文逐句 + 中文整段」，不丢内容。 */
  function splitParagraphs(text) {
    var t = String(text || "").replace(/\r/g, "").trim();
    if (!t) return [];
    var parts = t.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length === 1) {
      var lines = t.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.length > 1) parts = lines;
    }
    return parts;
  }
  function splitSentences(text) {
    var t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return [];
    var m = t.match(/[^.!?]+[.!?]+["'”’)\]]?|[^.!?]+$/g) || [t];
    return m.map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function splitZhSentences(text) {
    var t = String(text || "").replace(/\s+/g, "").trim();
    if (!t) return [];
    var m = t.match(/[^。！？；]+[。！？；]+[”’」』]?|[^。！？；]+$/g) || [t];
    return m.map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function buildPairs(en, zh) {
    var enParas = splitParagraphs(en);
    var zhParas = zh ? splitParagraphs(zh) : [];
    var enSentList = enParas.map(splitSentences);
    var zhSentList = zhParas.map(splitZhSentences);
    var enTotal = enSentList.reduce(function (n, a) { return n + a.length; }, 0);
    var zhTotal = zhSentList.reduce(function (n, a) { return n + a.length; }, 0);
    var out = [];

    // ① 全文句数相等 → 逐句对齐，并保留段落归属（最理想的排版）
    if (zh && zhTotal > 0 && zhTotal === enTotal) {
      var flat = [];
      zhSentList.forEach(function (a) { flat = flat.concat(a); });
      var k = 0;
      enSentList.forEach(function (arr, pi) {
        arr.forEach(function (s) { out.push({ en: s, zh: flat[k++] || "", para: pi }); });
      });
      return out;
    }
    // ② 兜底：英文逐句，中文整段挂在每段首句（不硬拆，保证译文完整）
    enSentList.forEach(function (arr, pi) {
      arr.forEach(function (s, si) {
        out.push({ en: s, zh: si === 0 ? (zhParas[pi] || (pi === 0 ? zh : "")) : "", para: pi });
      });
    });
    return out;
  }

  /* ---------- 词形匹配 ----------
     故事里常常是 achieved / abilities 这种变形，按词干 + 常见后缀匹配，
     命中的整段文字（含后缀）包成可点的高亮词，点击仍回到原形卡片。 */
  function wordPattern(w) {
    var base = String(w).toLowerCase();
    if (base.length <= 3) return "\\b" + escapeRegExp(base) + "\\b";
    var stem = base, suffix = "s|es|ed|d|ing|ly";
    if (/y$/.test(base) && !/[aeiou]y$/.test(base)) {
      stem = base.slice(0, -1);
      suffix = "y|ies|ied|ying|ily";
    } else if (/e$/.test(base)) {
      stem = base.slice(0, -1);
      suffix = "e|es|ed|ing";
    }
    return "\\b" + escapeRegExp(stem) + "(?:" + suffix + ")?\\b";
  }
  function wordMatches(text, words) {
    var hits = [];
    words.forEach(function (w) {
      var re = new RegExp(wordPattern(w), "gi");
      var m;
      while ((m = re.exec(text)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, word: w, text: m[0] });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    });
    // 长匹配优先占位，避免短词吃掉长词的一部分；然后再按出现顺序排好
    hits.sort(function (a, b) {
      return (b.end - b.start) - (a.end - a.start) || a.start - b.start;
    });
    var taken = [], out = [];
    hits.forEach(function (h) {
      for (var i = 0; i < taken.length; i++) {
        if (h.start < taken[i].end && h.end > taken[i].start) return;
      }
      taken.push(h);
      out.push(h);
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* ---------- 渲染：一句英文（所有词都可点：本轮词=按钮高亮，其余=普通词） ---------- */
  function renderSentence(el, text, words, used) {
    var hits = wordMatches(text, words);
    var hitByStart = {};
    hits.forEach(function (h) { hitByStart[h.start] = h; });
    var re = /[A-Za-z][A-Za-z'’-]*/g;
    var m, cursor = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > cursor) el.appendChild(document.createTextNode(text.slice(cursor, m.index)));
      var h = hitByStart[m.index];
      if (h && h.text === m[0]) {
        // 本轮 20 词之一：保留原有的按钮 / 荧光带 / 角卡行为
        var info = infoOf(h.word);
        var b = document.createElement("button");
        b.type = "button";
        b.className = "st-word" + (markedWords[h.word.toLowerCase()] ? " is-marked" : "");
        b.dataset.word = h.word;
        b.setAttribute("aria-label", h.word + (info && info.meaning ? "，" + info.meaning : "") + "，单击看释义，双击标记");
        b.textContent = h.text;
        el.appendChild(b);
        used[h.word.toLowerCase()] = true;
      } else {
        // 普通词：同样可点出角卡；双击标记 / 取消标记
        var s = document.createElement("span");
        s.className = "st-any" + (markedWords[m[0].toLowerCase()] ? " is-marked" : "");
        s.dataset.word = m[0].toLowerCase();
        s.textContent = m[0];
        el.appendChild(s);
      }
      cursor = m.index + m[0].length;
    }
    if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
    return hits;
  }

  /* ---------- 存档（独立 key；损坏 / 非法一律按无存档处理） ---------- */
  function normalizeConfig(c) {
    c = (c && typeof c === "object") ? c : {};
    return {
      baseUrl: (typeof c.baseUrl === "string" && c.baseUrl.trim()) ? c.baseUrl.trim() : DEFAULT_BASE,
      apiKey: (typeof c.apiKey === "string") ? c.apiKey.trim() : "",
      model: (typeof c.model === "string" && c.model.trim()) ? c.model.trim() : DEFAULT_MODEL
    };
  }
  function normalizeStory(s) {
    if (s && typeof s === "object" &&
        typeof s.roundKey === "string" && s.roundKey &&
        typeof s.en === "string" && typeof s.zh === "string") {
      // 2026-10-27 之前的故事没有 title，补空串（书架会回退成英文首句）
      if (typeof s.title !== "string") s.title = "";
      return s;
    }
    return null;
  }
  // 历史故事：条目结构与 story 相同，另带 round（轮次号）与 words（用于高亮）
  function normalizeHistory(h) {
    if (!Array.isArray(h)) return [];
    var out = [];
    for (var i = 0; i < h.length; i++) {
      var s = normalizeStory(h[i]);
      if (!s) continue;
      if (typeof h[i].round === "number") s.round = h[i].round;
      if (Array.isArray(h[i].words)) {
        s.words = h[i].words.filter(function (w) { return typeof w === "string" && w; });
      }
      if (typeof h[i].createdAt === "string") s.createdAt = h[i].createdAt;
      out.push(s);
    }
    return out;
  }
  function readStore() {
    try {
      var raw = localStorage.getItem(LS_STORY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === "object") {
          return {
            config: normalizeConfig(d.config),
            story: normalizeStory(d.story),
            history: normalizeHistory(d.history)
          };
        }
      }
    } catch (e) { /* 损坏按无存档处理 */ }
    return { config: normalizeConfig(null), story: null, history: [] };
  }
  function saveStore(store) {
    try { localStorage.setItem(LS_STORY, JSON.stringify(store)); } catch (e) { /* 无痕模式降级为内存态 */ }
  }

  /* ---------- 墨水瓶（2026-10-28 新增） ----------
     两条生成通道，互不影响：
       ① 自带 API Key → 直连 DeepSeek，不计数（老路径，一行没动）
       ② 没有 Key    → 用兑换码换来的「墨滴」，经 Worker 代生成，每篇耗 1 滴
     墨量的权威在 Worker（KV），本地这份只是显示与离线兜底 ——
     本地改数字没用，Worker 那边过不去。 */
  function readInk() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(LS_INK) || "null"); } catch (e) { o = null; }
    o = (o && typeof o === "object") ? o : {};
    return {
      drops: (typeof o.drops === "number" && o.drops >= 0) ? Math.floor(o.drops) : 0,
      worker: (typeof o.worker === "string") ? o.worker.trim().replace(/\/+$/, "") : "",
      clientId: (typeof o.clientId === "string") ? o.clientId : ""
    };
  }
  function saveInk(o) {
    try { localStorage.setItem(LS_INK, JSON.stringify(o)); } catch (e) { /* 无痕模式忽略 */ }
  }
  function ensureClientId() {
    var ink = readInk();
    if (ink.clientId) return ink.clientId;
    var id = "";
    try {
      if (window.crypto && crypto.randomUUID) id = crypto.randomUUID().replace(/-/g, "");
    } catch (e) { /* ignore */ }
    if (!id) {
      for (var i = 0; i < 24; i++) id += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    }
    ink.clientId = id;
    saveInk(ink);
    return id;
  }
  function setInkDrops(n) {
    var ink = readInk();
    ink.drops = Math.max(0, Math.floor(n));
    saveInk(ink);
    renderInk();
  }
  // HTTP 头里的剩余墨量（Worker 回写）优先于本地估算
  function syncDropsFromHeader(res) {
    try {
      var raw = res.headers.get("x-ink-left");
      if (raw === null) return;
      var n = parseInt(raw, 10);
      if (!isNaN(n)) setInkDrops(n);
    } catch (e) { /* ignore */ }
  }
  // 主动向 Worker 对账（打开弹窗 / 生成失败时用）
  async function refreshInk() {
    var ink = readInk();
    if (!ink.worker) { renderInk(); return; }
    try {
      var res = await fetch(ink.worker + "/api/ink", {
        headers: { "x-client-id": ensureClientId() },
        cache: "no-store"
      });
      if (!res.ok) return;
      var j = await res.json();
      if (j && typeof j.drops === "number") setInkDrops(j.drops);
    } catch (e) { /* 离线 / 服务没开 → 用本地副本 */ }
  }

  /* ---------- 当前轮（只读进度 key） ---------- */
  function readProgress() {
    try {
      var raw = localStorage.getItem(LS_PROGRESS);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d && d.currentRound && Array.isArray(d.currentRound.words)) return d.currentRound;
    } catch (e) { /* ignore */ }
    return null;
  }
  function currentRoundKey() {
    var r = readProgress();
    return (r && typeof r.createdAt === "string") ? r.createdAt : null;
  }
  function currentRoundWords() {
    var r = readProgress();
    if (!r) return [];
    return r.words
      .map(function (w) { return (w && w.word) ? w.word : ""; })
      .filter(function (w) { return !!w; });
  }
  // 当前轮对应的故事：先认 store.story（最近写的那篇），再去故事集里找同一轮。
  // 回退到旧轮补写故事后，store.story 这个槽会被那一轮占住 —— 回到新轮时得从
  // 故事集里把它认回来，否则明明写过却显示空态。
  function currentStoryForRound() {
    var store = readStore();
    var rp = readProgress();
    var rk = (rp && typeof rp.createdAt === "string" && rp.createdAt) ? rp.createdAt : null;
    if (rk && store.story && store.story.roundKey === rk) return store.story;
    var list = Array.isArray(store.history) ? store.history : [];
    var i;
    if (rk) {
      for (i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].roundKey === rk) return list[i];
      }
    }
    /* 老存档：更早那几轮没有原始 createdAt（app.js 补的是 legacy-… 替代指纹），
       当年写的故事用的是另一个指纹 → 退一步按「同一轮 + 同一批词」认领。 */
    if (rp && typeof rp.round === "number" && Array.isArray(rp.words)) {
      var want = normWords(rp.words);
      for (i = list.length - 1; i >= 0; i--) {
        var h = list[i];
        if (!h || h.round !== rp.round) continue;
        if (sameWords(normWords(h.words || []), want)) return h;
      }
    }
    return null;
  }
  function normWords(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var w = arr[i];
      if (typeof w !== "string") w = (w && w.word) ? w.word : "";
      w = String(w || "").toLowerCase().trim();
      if (w) out.push(w);
    }
    return out;
  }
  function sameWords(a, b) {
    if (!a.length || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ---------- 轻提示（本地小份拷贝，避免依赖 app.js 内部） ---------- */
  var toastTimer;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  /* ---------- 渲染 ---------- */
  function setGenLabel(iconId, text) {
    if (!els.gen) return;
    /* iconId 为空时写纯文字（如「生成中…」），否则前置对应线描图标（与 HTML 初始结构一致） */
    els.gen.innerHTML = iconId
      ? '<svg class="svg-icon" aria-hidden="true" width="15" height="15"><use href="#' + iconId + '"></use></svg>' + text
      : text;
  }
  function setStatus(msg, isError) {
    els.status.hidden = false;
    els.status.textContent = msg;
    els.status.classList.toggle("is-error", !!isError);
  }

  // 把本轮 20 个词在故事文本里加粗高亮（安全拼 DOM，不用 innerHTML 塞原文）
  function renderHighlighted(el, text, words) {
    el.textContent = "";
    var seen = {}, list = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w && !seen[w.toLowerCase()]) { seen[w.toLowerCase()] = true; list.push(w); }
    }
    // 长词优先，避免短词先匹配吃掉长词的一部分
    list.sort(function (a, b) { return b.length - a.length; });
    if (!list.length) { el.textContent = text; return; }
    var re = new RegExp("\\b(" + list.map(escapeRegExp).join("|") + ")\\b", "gi");
    var parts = text.split(re);
    for (var k = 0; k < parts.length; k++) {
      if (k % 2 === 1) {
        var s = document.createElement("strong");
        s.className = "story-hl";
        s.textContent = parts[k];
        el.appendChild(s);
      } else if (parts[k]) {
        el.appendChild(document.createTextNode(parts[k]));
      }
    }
  }

  // 英文 / 中文分段：约定模型在两者之间单独输出一行 ---
  /* ---------- 标题行：AI 的第一行输出 TITLE: xxx（书脊上要竖排它） ---------- */
  var TITLE_HEAD = /^[ \t]*(?:TITLE|标题)[ \t]*[:：][ \t]*/i;
  function cleanTitle(t) {
    t = String(t || "").replace(/^["'“”‘’\s]+/, "").replace(/["'“”‘’\s]+$/, "");
    t = t.replace(/[。.!！?？]+$/, "").trim();
    if (t.length > 42) t = t.slice(0, 42).trim();
    return t;
  }
  // needNewline=true 给流式用：标题行还没收到换行就先不吐正文，
  // 否则半截标题会先闪进书里，换行后再跳走。
  function takeTitle(full, needNewline) {
    if (!TITLE_HEAD.test(full)) return { title: "", rest: full };
    var nl = full.search(/\r?\n/);
    if (nl < 0) {
      return needNewline
        ? { title: "", rest: "" }
        : { title: cleanTitle(full.replace(TITLE_HEAD, "")), rest: "" };
    }
    var line = full.slice(0, nl);
    var rest = full.slice(nl + 1).replace(/^[ \t]*\r?\n/, "");
    return { title: cleanTitle(line.replace(TITLE_HEAD, "")), rest: rest };
  }

  function splitBySeparator(full) {
    var m = full.match(/\n[ \t]*-{3,}[ \t]*\n/);
    if (m && typeof m.index === "number") {
      return { en: full.slice(0, m.index).trim(), zh: full.slice(m.index + m[0].length).trim() };
    }
    return null;
  }
  // 流式过程中的实时分段：只认 --- 分隔行（不启用兜底，避免把英文段落误切给中文）
  function splitLive(full) {
    var t = takeTitle(full, true);
    var r = splitBySeparator(t.rest);
    return r || { en: t.rest, zh: "" };
  }
  // 落定时的分段：--- 没出现时按「空行 + 中文开头」兜底
  function splitStory(full) {
    var t = takeTitle(full, false);
    var body = t.rest;
    var r = splitBySeparator(body);
    if (r) return { title: t.title, en: r.en, zh: r.zh };
    var m = body.match(/\n\n(?=[\u4e00-\u9fff])/);
    if (m && typeof m.index === "number") {
      return { title: t.title, en: body.slice(0, m.index).trim(), zh: body.slice(m.index + m[0].length).trim() };
    }
    return { title: t.title, en: body.trim(), zh: "" };
  }

  /* ---------- 渲染：故事正文（句对 + 覆盖条 + 卡片锚点） ---------- */
  /* ---------- 渲染：摊开的书（左页英文 / 右页译文，段号成对） ---------- */
  function buildStory(story, words) {
    markSnapshot();   // 先拿当前模式的标记清单，渲染时直接带上 is-marked
    var pairs = buildPairs(story.en || "", story.zh || "");
    var used = {};
    wordSentence = {};
    els.body.textContent = "";
    els.body.classList.remove("is-streaming");
    els.body.hidden = false;
    if (els.zhBody) {
      els.zhBody.textContent = "";
      els.zhBody.classList.remove("is-streaming");
      els.zhBody.hidden = false;
    }

    // 先按段归拢：同号的英文句 / 中文句落到同一段，左右页各渲染一次
    var groups = [], byPara = {};
    pairs.forEach(function (pair) {
      var g = byPara[pair.para];
      if (!g) { g = byPara[pair.para] = { en: [], zh: [] }; groups.push(g); }
      g.en.push(pair.en);
      if (pair.zh) g.zh.push(pair.zh);
    });

    var no = 0;
    groups.forEach(function (g) {
      no++;
      var num = (no < 10 ? "0" : "") + no;
      var hits = [];

      // 左页：英文段（整段一个 <p>，词仍是行内按钮）
      var left = document.createElement("div");
      left.className = "bk-para";
      left.dataset.para = no;
      var p = document.createElement("p");
      p.className = "bk-en";
      g.en.forEach(function (sent, i) {
        if (i) p.appendChild(document.createTextNode(" "));
        var span = document.createElement("span");
        span.className = "bk-sent";
        hits = hits.concat(renderSentence(span, sent, words, used));
        p.appendChild(span);
      });
      var noL = document.createElement("span");
      noL.className = "bk-no";
      noL.setAttribute("aria-hidden", "true");
      noL.textContent = num;
      left.appendChild(p);
      left.appendChild(noL);
      els.body.appendChild(left);

      // 右页：中文段
      if (els.zhBody) {
        var right = document.createElement("div");
        right.className = "bk-para";
        right.dataset.para = no;
        var z = document.createElement("p");
        z.className = "bk-zh";
        z.textContent = g.zh.join("");
        var noR = document.createElement("span");
        noR.className = "bk-no";
        noR.setAttribute("aria-hidden", "true");
        noR.textContent = num;
        right.appendChild(noR);
        right.appendChild(z);
        els.zhBody.appendChild(right);
      }

      hits.forEach(function (h) {
        var k = h.word.toLowerCase();
        if (!wordSentence[k]) wordSentence[k] = no;
      });
    });

    /* 页眉：书名 / 轮次 / 日期 —— 一律取这篇自己的 round，
       否则从书架翻旧篇时页眉会印上「第 9 轮」而内容是第 5 轮的。 */
    var rp = readProgress();
    var roundNo = (typeof story.round === "number")
      ? story.round
      : ((rp && typeof rp.round === "number") ? rp.round : null);
    if (els.title) els.title.textContent = storyTitle(story);
    if (els.kickerRound) {
      els.kickerRound.textContent = roundNo !== null ? "第 " + roundNo + " 轮" : "本轮";
    }
    if (els.kickerDate) {
      var d = story.createdAt ? new Date(story.createdAt) : null;
      els.kickerDate.textContent = (d && !isNaN(d.getTime()))
        ? (d.getMonth() + 1) + " 月 " + d.getDate() + " 日"
        : "—";
    }
    if (els.footRound) {
      els.footRound.textContent = "ROUND " + (roundNo !== null ? pad2(roundNo) : "—");
    }
    /* 「存档」小标：从书架点开的是旧篇才亮，点本轮那本不亮 */
    if (els.archiveTag) {
      var curKey = currentRoundKey();
      els.archiveTag.hidden = !(viewStory && curKey && story.roundKey !== curKey);
    }

    // 覆盖条：20 个点，实心 = 这篇用上了
    els.dots.textContent = "";
    var seen = {}, list = [];
    words.forEach(function (w) {
      var k = String(w).toLowerCase();
      if (w && !seen[k]) { seen[k] = true; list.push(w); }
    });
    var hitCount = 0;
    list.forEach(function (w) {
      var on = !!used[String(w).toLowerCase()];
      if (on) hitCount++;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "st-dot" + (on ? " on" : "");
      b.dataset.word = w;
      b.setAttribute("role", "listitem");
      b.title = on ? "「" + w + "」在故事里 · 点一下回到卡片" : "「" + w + "」这篇没用到";
      b.setAttribute("aria-label", b.title);
      els.dots.appendChild(b);
    });
    if (list.length) {
      els.coverage.textContent = "本篇用上 " + hitCount + " / " + list.length + " 词";
      els.meta.hidden = false;
    } else {
      /* 2026-10-27 之前的老存档没存词表 —— 别在页脚印「本篇用上 0 / 0 词」 */
      els.coverage.textContent = "";
      els.meta.hidden = true;
    }

    // 角卡先摆上当前这张卡片的词；看旧篇时先收起来（它跟这篇没关系，点词再出）
    if (viewStory) {
      if (els.dock) els.dock.hidden = true;
    } else {
      var cur = document.querySelector("#view-learn .card-word");
      if (cur && cur.textContent.trim()) showDock(cur.textContent.trim());
    }

    // 排完了再量：一页装不下就收字号
    fitPages();
  }

  /* ---------- 角卡：点正文里的词，卡上换内容，不跳转 ----------
     词库外的词（四级 + 自定义都查不到）→ 直接给输入行让用户补释义；
     已有手填释义 → 显示释义 + 编辑笔，点笔再改。 */
  function showDock(word) {
    if (!els.dock || !word) return;
    var key = String(word).toLowerCase();
    var info = infoOf(word);
    var isBank = !!(info && info.meaning);
    var uMean = isBank ? "" : userMeanOf(key);
    var editing = !isBank && !uMean;   // 词库外且还没有释义 → 进可填状态
    dockWord = word;
    els.dock.hidden = false;
    var w = els.dock.querySelector(".book-dock-word");
    var p = els.dock.querySelector(".book-dock-phon");
    var m = els.dock.querySelector(".book-dock-mean");
    if (w) w.textContent = word;
    if (p) p.textContent = (info && info.phonetic) ? info.phonetic : "";
    if (m) { m.textContent = isBank ? info.meaning : uMean; m.hidden = editing; }
    if (els.dockEdit) els.dockEdit.hidden = isBank || editing;
    if (els.dockEditRow) {
      els.dockEditRow.hidden = !editing;
      if (editing && els.dockInput) els.dockInput.value = "";
    }
    // 正文里同一个词可能出现在多段，全标一遍
    var old = els.panel.querySelectorAll(".st-word.is-active, .st-any.is-active");
    for (var i = 0; i < old.length; i++) old[i].classList.remove("is-active");
    var same = els.panel.querySelectorAll('.st-word[data-word="' + word + '"], .st-any[data-word="' + word + '"]');
    for (var j = 0; j < same.length; j++) same[j].classList.add("is-active");
  }

  /* 角卡编辑笔 / 输入行：打开输入行（预填现有释义并聚焦） */
  function openDockEditor() {
    if (!dockWord || !els.dockEditRow) return;
    var m = els.dock.querySelector(".book-dock-mean");
    els.dockEditRow.hidden = false;
    if (m) m.hidden = true;
    if (els.dockEdit) els.dockEdit.hidden = true;
    if (els.dockInput) {
      els.dockInput.value = userMeanOf(dockWord);
      setTimeout(function () { els.dockInput.focus(); }, 0);
    }
  }
  /* 保存：非空存入（截 120 字），空 = 清除该词释义；完成后回展示态 */
  function saveDockEditor() {
    if (!dockWord || !els.dockInput) return;
    var key = String(dockWord).toLowerCase();
    var val = els.dockInput.value.replace(/\s+/g, " ").trim().slice(0, 120);
    loadUserDict();
    if (val) userDict[key] = val; else delete userDict[key];
    saveUserDict();
    showDock(dockWord);
    if (val) toast("已记下「" + dockWord + "」的释义");
  }

  /* ---------- 段号联动：两侧同号段一起浮底，点一下可以钉住 ---------- */
  function setHot(no, on) {
    var nodes = els.panel.querySelectorAll('.bk-para[data-para="' + no + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("is-hot", !!on);
  }
  function toggleLock(node) {
    var no = node.dataset.para;
    var had = node.classList.contains("is-lock");
    var locked = els.panel.querySelectorAll(".bk-para.is-lock");
    for (var i = 0; i < locked.length; i++) locked[i].classList.remove("is-lock");
    if (had) return;
    var nodes = els.panel.querySelectorAll('.bk-para[data-para="' + no + '"]');
    for (var j = 0; j < nodes.length; j++) nodes[j].classList.add("is-lock");
  }

  /* ---------- 空态：把这一轮的词先摊在桌上（前 5 个 + 余数） ---------- */
  function fillEmptyWords() {
    if (!els.emptyWords) return;
    els.emptyWords.textContent = "";
    var words = currentRoundWords();
    var head = words.slice(0, 5);
    head.forEach(function (w) {
      var s = document.createElement("span");
      s.textContent = w;
      els.emptyWords.appendChild(s);
    });
    if (words.length > head.length) {
      var more = document.createElement("span");
      more.className = "is-more";
      more.textContent = "+" + (words.length - head.length) + " 词";
      els.emptyWords.appendChild(more);
    }
    els.emptyWords.hidden = !head.length;
  }

  function render() {
    if (!els.panel) return;
    els.gen.disabled = busy;
    renderInk();
    if (busy) { setGenLabel(null, "生成中…"); return; }   // 生成中的面板状态由 generate() 管理
    // 书架点开的旧篇优先；没点过就是本轮那篇
    var story = viewStory || currentStoryForRound();
    var words = viewStory ? (viewStory.words || []) : currentRoundWords();
    var rp = readProgress();
    if (els.kickerRound) {
      els.kickerRound.textContent = (rp && typeof rp.round === "number") ? "第 " + rp.round + " 轮" : "本轮";
    }
    if (story) {
      buildStory(story, words);
      if (els.teaser) {
        var t = String(story.en || "").replace(/\s+/g, " ").trim();
        var m = t.match(/^[^.!?]+[.!?]/);
        els.teaser.textContent = (m ? m[0] : t).slice(0, 140);
        els.teaser.hidden = false;
      }
      els.empty.hidden = true;
      els.status.hidden = true;
      els.footer.hidden = false;
      /* 看旧篇时主按钮改成「回到本轮」：一键切回，不会误触重新生成把本轮覆盖掉 */
      if (viewStory) setGenLabel("i-back", "回到本轮");
      else setGenLabel("i-cyclic", "重新生成");
    } else {
      if (els.title) els.title.textContent = "今日小故事";
      els.body.hidden = true;
      els.body.textContent = "";
      els.body.classList.remove("is-streaming");
      if (els.zhBody) { els.zhBody.hidden = true; els.zhBody.textContent = ""; }
      if (els.dock) els.dock.hidden = true;
      els.meta.hidden = true;
      els.empty.hidden = false;
      els.status.hidden = true;
      els.footer.hidden = true;
      if (els.archiveTag) els.archiveTag.hidden = true;
      // 空态也把页码的轮次印上，别留一个没渲染过的占位符
      if (els.footRound) {
        els.footRound.textContent = "ROUND " + (rp && typeof rp.round === "number" ? pad2(rp.round) : "—");
      }
      if (els.coverage) els.coverage.textContent = "";
      if (els.kickerDate) {
        var today = new Date();
        els.kickerDate.textContent = (today.getMonth() + 1) + " 月 " + today.getDate() + " 日";
      }
      if (els.teaser) { els.teaser.hidden = true; els.teaser.textContent = ""; }
      fillEmptyWords();
      wordSentence = {};
      setGenLabel("i-spark", "生成本轮故事");
    }
    syncCardChip();
  }

  /* ---------- 卡片上的故事锚点 ---------- */
  function syncCardChip() {
    var chip = document.querySelector("#view-learn .card-story");
    if (!chip) return;
    /* 书桌上摊的是从书架翻的旧篇 → 卡片对不上它，别报段号 */
    if (viewStory) { chip.hidden = true; return; }
    var wordEl = document.querySelector("#view-learn .card-word");
    var word = wordEl ? wordEl.textContent.trim().toLowerCase() : "";
    var sent = word ? wordSentence[word] : 0;
    var show = !!currentStoryForRound() && !!sent;
    chip.hidden = !show;
    if (!show) return;
    chip.dataset.word = word;
    chip.dataset.sent = sent;
    chip.querySelector(".card-story-label").textContent = "故事第 " + sent + " 段";
    chip.title = "翻开故事，跳到「" + word + "」出现的那一段";
    chip.setAttribute("aria-label", chip.title);
  }

  // 卡片 → 故事：翻开书，把那一页的那一段带到眼前并闪一下
  function focusPara(no) {
    var nodes = els.panel.querySelectorAll('.bk-para[data-para="' + no + '"]');
    if (!nodes.length) return;
    var learnView = document.getElementById("view-learn");
    if (learnView && !learnView.classList.contains("story-open")) {
      var expand = document.getElementById("btn-generate");
      if (expand) expand.click();
    }
    setTimeout(function () {
      if (nodes[0].scrollIntoView) {
        nodes[0].scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
      }
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.classList.remove("is-pin");
        void n.offsetWidth;
        n.classList.add("is-pin");
        clearTimeout(n._pinTimer);
        n._pinTimer = setTimeout(function (el) {
          return function () { el.classList.remove("is-pin"); };
        }(n), 1900);
      }
    }, 80);
  }

  /* ---------- 把一页排满 ----------
     书是定尺纸，正文既不能溢出去，也别只写半页。
     两个连续旋钮：字号倍率 --bk-scale 与行距 --lh，先定字号、再定行距：
       1. 基础字号下最小行距都装不下 → 收字号，但先保住舒适行距（1.66）；
       2. 基础字号下最大行距还填不满 → 行距先放到很开（诗歌体），还不够才放字号；
       3. 定完字号，行距在上下限之间插值，把内容精确顶到 target
          （页高的 94.5% —— 上下各留一两行空白，正是要的效果）；
       4. 字号收到底仍溢出 → 才允许页内滚动（两侧同步，见 syncScroll）；
          两个旋钮都到上限仍填不满（两三行的短文）→ 版心内垂直居中。 */
  var LH_MIN = 1.44;        // 长文允许压到这里（正常书籍行距），再紧就不像书了
  var LH_PREF = 1.66;       // 长文也尽量守住的舒适行距：先缩字、后压行距
  var LH_MAX_EN = 2.42, LH_HI_EN = 3.0;   // 上限 / 短文可放到「诗歌体」
  var LH_MAX_ZH = 2.7, LH_HI_ZH = 3.2;    // 中文行短，本来就可以更开
  var LH_TARGET = 0.945;    // 正文占页高的比例：上方留一点、下方留一点
  var S_MIN_EN = 0.66, S_MAX_EN = 1.20;   // 18px → 11.9px ~ 21.6px（正文不超过标题 22px）
  var S_MIN_ZH = 0.72, S_MAX_ZH = 1.44;   // 15px → 10.8px ~ 21.6px
  var CENTER_BELOW = 0.78;  // 撑到上限还不到这个填充率 → 居中，别贴着页顶
  var MIN_FILL = 0.80;      // 最大行距下已经填到这么多，就算「留够一两行」了，不再放大

  function pageOf(el) {
    return el && el.closest ? el.closest(".book-page") : null;
  }
  function setLh(page, v) {
    if (page) page.style.setProperty("--lh", Number(v).toFixed(3));
  }
  function setScale(page, v) {
    if (page) page.style.setProperty("--bk-scale", Number(v).toFixed(3));
  }
  /* 正文的真实高度。不能用 scrollHeight —— 内容比容器短时它是「容器高度」，
     永远测不到短内容到底占了多高（这坑踩过）。改成量最后一段的底边：
     offsetTop / offsetHeight 都是布局像素，和 clientHeight 同量纲，
     也不会被书的 scale 影响。 */
  function contentHeight(el) {
    var pars = el.querySelectorAll(".bk-para");
    if (!pars.length) return 0;
    var last = pars[pars.length - 1];
    var padBottom = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    return (last.offsetTop + last.offsetHeight) - el.offsetTop + padBottom;
  }
  function measureAt(el, page, lh) {
    setLh(page, lh);
    return contentHeight(el);
  }
  /* 在 [lo, hi] 上二分找「f(s) ≤ goal」的最大 s（f 单调递增）。
     高度对字号的响应大致是平方关系，直接解方程也行，但字宽/换行位置不是
     连续的，二分比公式稳 —— 7 次就精确到 1% 以内。 */
  function bisect(f, lo, hi, goal) {
    if (f(lo) > goal) return lo;
    if (f(hi) <= goal) return hi;
    for (var i = 0; i < 7; i++) {
      var mid = (lo + hi) / 2;
      if (f(mid) <= goal) lo = mid; else hi = mid;
    }
    return lo;
  }

  // 返回 { fill: 实际填充率, over: 收到最小字号仍溢出（要滚动） }
  function fitPage(el, page, o) {
    if (!el || el.hidden || !el.clientHeight) return { fill: 1, over: false };
    if (!el.querySelector(".bk-para")) return { fill: 1, over: false };   // 空态不参与排版
    var avail = el.clientHeight;
    var target = avail * LH_TARGET;
    var lhTop = o.lhMax;
    var at = function (lh) {
      return function (v) { setScale(page, v); return measureAt(el, page, lh); };
    };

    setScale(page, 1);
    var hMin = measureAt(el, page, LH_MIN);
    var hMax = measureAt(el, page, o.lhMax);
    var s = 1;
    if (hMin > target) {
      /* 太长：先保住舒适行距（LH_PREF），从字号里找空间 —— 字小一点但行间透气，
         比字大一点却挤成一坨好读。字号收到下限还不够，才回头压行距。 */
      s = bisect(at(LH_PREF), o.sMin, 1, target);
    } else if (hMax < target * MIN_FILL) {
      /* 太短：先把行距放到「很开」（诗歌体那种疏排），还不够才放大字号。
         字号封在标题以下 —— 正文比标题大，版面就散了。 */
      lhTop = o.lhHi;
      if (measureAt(el, page, lhTop) < target) s = bisect(at(lhTop), 1, o.sMax, target);
    }

    setScale(page, s);
    var hm = measureAt(el, page, LH_MIN);
    if (hm > target) {                 // 收到下限还装不下：行距压到最小，交给滚动
      setLh(page, LH_MIN);
      var hh = contentHeight(el);
      return { fill: hh / avail, over: hh > avail + 1 };
    }
    var hM = measureAt(el, page, lhTop);
    var lh = hM <= target
      ? lhTop
      : LH_MIN + (target - hm) * (lhTop - LH_MIN) / Math.max(1, hM - hm);
    setLh(page, Math.max(LH_MIN, Math.min(lhTop, lh)));
    return { fill: contentHeight(el) / avail, over: false };
  }

  function fitPages() {
    if (!els.book) return;
    var book = els.book;
    // 窄屏是单页自然长高（英文在上、译文在下），没有「一页多高」这回事
    if (window.innerWidth < 1024) {
      [els.body, els.zhBody].forEach(function (el) {
        if (!el) return;
        el.classList.remove("is-scroll");
        var p = pageOf(el);
        if (!p) return;
        p.style.removeProperty("--lh");
        p.style.removeProperty("--bk-scale");
      });
      els.book.classList.remove("is-center");
      return;
    }
    if (book.clientHeight < 100) return;   // 合着的时候不量
    var en = els.body, zh = els.zhBody;
    var enPage = pageOf(en), zhPage = pageOf(zh);
    // 上一轮的渐隐内边距 / 居中都改变布局，先摘掉再量
    if (en) en.classList.remove("is-scroll");
    if (zh) zh.classList.remove("is-scroll");
    book.classList.remove("is-center");

    var rEn = fitPage(en, enPage, { lhMax: LH_MAX_EN, lhHi: LH_HI_EN, sMin: S_MIN_EN, sMax: S_MAX_EN });
    var rZh = zh
      ? fitPage(zh, zhPage, { lhMax: LH_MAX_ZH, lhHi: LH_HI_ZH, sMin: S_MIN_ZH, sMax: S_MAX_ZH })
      : { fill: 1, over: false };

    // 两侧有一侧怎么撑都填不满（多半是短译文），两页一起居中，跨页才对称
    if (!rEn.over && !rZh.over && Math.min(rEn.fill, rZh.fill) < CENTER_BELOW) {
      book.classList.add("is-center");
    }
    /* 滚动标记只认 fit 的结论：居中会把整块文字下推，此时再量 scrollHeight
       会被这段位移误判成「装不下」（踩过）。 */
    if (en) en.classList.toggle("is-scroll", !!rEn.over);
    if (zh) zh.classList.toggle("is-scroll", !!rZh.over);
  }

  var syncingScroll = false;
  function syncScroll(from, to) {
    if (syncingScroll || !from || !to) return;
    if (from.scrollHeight <= from.clientHeight + 1) return;
    if (to.scrollHeight <= to.clientHeight + 1) return;
    syncingScroll = true;
    // 全程用 offsetTop / offsetHeight（布局像素），不能用 getBoundingClientRect：
    // 书是 scale 过的，rect 是缩放后的视觉像素，跟 scrollTop 不是一个量纲（踩过）。
    var fromTop = from.offsetTop;
    var scroll = from.scrollTop;
    var pars = from.querySelectorAll(".bk-para");
    // 找「卡在页顶」的那一段，算出滚过这一段的多大比例；
    // 对页同号段按同样比例落位 —— 两页段落高度不同，纯像素对齐会越滚越偏。
    for (var i = 0; i < pars.length; i++) {
      var top = pars[i].offsetTop - fromTop;
      var h = pars[i].offsetHeight;
      if (top + h <= scroll + 1) continue;
      var local = (scroll - top) / Math.max(1, h);
      if (local < 0) local = 0;
      if (local > 1) local = 1;
      var mate = to.querySelector('.bk-para[data-para="' + pars[i].dataset.para + '"]');
      if (mate) {
        to.scrollTop = (mate.offsetTop - to.offsetTop) + local * mate.offsetHeight;
      }
      break;
    }
    syncingScroll = false;
  }

  function fail(msg) {
    els.body.hidden = true;
    els.body.textContent = "";
    els.body.classList.remove("is-streaming");
    if (els.zhBody) { els.zhBody.hidden = true; els.zhBody.textContent = ""; }
    els.meta.hidden = true;
    els.footer.hidden = true;
    els.empty.hidden = true;
    setStatus(msg, true);
    els.gen.disabled = false;
    setGenLabel(currentStoryForRound() ? "i-cyclic" : "i-spark", currentStoryForRound() ? "重新生成" : "生成本轮故事");
  }

  /* ---------- 请求 ---------- */
  function endpointOf(baseUrl) {
    var b = baseUrl.replace(/\/+$/, "");
    if (/\/chat\/completions$/.test(b)) return b;   // 已是完整端点
    return b + "/chat/completions";
  }
  function buildMessages(words) {
    return [
      { role: "system", content: "你是英语老师，用学生当天背的单词写一篇短文，英文约120词，再给中文对照。" },
      { role: "user", content:
        "今天的单词：" + words.join(", ") + "。请写一篇连贯小故事，尽量包含所有这些词（可以用它们的变形）；" +
        "个别难组合的词可省略并在文末说明。\n" +
        "排版要求：英文写成 2~3 段，段与段之间空一行；中文对照用同样的分段，并且逐句对应，" +
        "中文的句子数量尽量与英文一致（方便逐句对照阅读）。\n" +
        "输出格式要求：\n" +
        "第 1 行：TITLE: 英文短标题（3~5 个词，首字母大写，不要引号、不要句号）；\n" +
        "空一行后输出英文故事正文；\n" +
        "然后单独一行输出 ---；\n" +
        "最后另起一段输出中文对照。\n" +
        "除以上内容外不要输出任何别的东西。" }
    ];
  }
  function friendlyHttpError(status, bodyText) {
    if (status === 401) return "API Key 无效或没填对，点右上角的设置按钮检查一下。";
    if (status === 402) return "账户余额不足，请到 DeepSeek 开放平台充值后再试。";
    if (status === 429) return "请求太频繁了，稍等一会儿再试。";
    var detail = "";
    try {
      var j = JSON.parse(bodyText);
      if (j && j.error && j.error.message) detail = j.error.message;
    } catch (e) { /* ignore */ }
    return "请求失败（HTTP " + status + "）" + (detail ? "：" + detail : "");
  }

  /* 统一请求入口：有 Key 直连，没 Key 走 Worker。返回 Response（body 是 SSE 流）。
     两条通道的下游解析完全一致，所以后面那段 while(reader.read()) 一行都不用改。 */
  async function requestStream(cfg, words) {
    var messages = buildMessages(words);
    if (cfg.apiKey) {
      return fetch(endpointOf(cfg.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + cfg.apiKey
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages,
          temperature: 1.5,
          max_tokens: 600,
          stream: true
        })
      });
    }
    var ink = readInk();
    if (!ink.worker) {
      var e1 = new Error("还没有配置墨水服务");
      e1.inkCode = "no_worker";
      throw e1;
    }
    var res = await fetch(ink.worker + "/api/story", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": ensureClientId()
      },
      body: JSON.stringify({ messages: messages })
    });
    if (res.status === 402) {
      var e2 = new Error("墨水用完了");
      e2.inkCode = "no_ink";
      throw e2;
    }
    return res;
  }

  async function generate() {
    if (busy) return;
    viewStory = null;          // 生成的是本轮 → 视角先切回本轮，别让旧篇盖住流式内容
    var cfg = readStore().config;
    if (!cfg.apiKey) {
      var hold = readInk();
      if (!hold.worker) { openInk("还没有填 API Key。带一瓶自己的墨，或者用兑换码换几滴。"); return; }
      if (hold.drops <= 0) { openInk("墨水瓶空了，添一点墨就能继续写。"); return; }
    }
    var words = currentRoundWords();
    if (!words.length) { toast("还没有当前轮的单词，先抽一轮再说"); return; }

    var roundKey = currentRoundKey();
    if (!roundKey) { toast("这一轮的记录有点乱，点「下一轮」重新抽一轮再写"); return; }
    var rp = readProgress();
    var roundNo = (rp && typeof rp.round === "number") ? rp.round : null;
    busy = true;
    els.gen.disabled = true;
    setGenLabel(null, "生成中…");
    els.empty.hidden = true;
    els.footer.hidden = true;
    els.meta.hidden = true;
    els.body.hidden = false;
    els.body.textContent = "";
    els.body.classList.add("is-streaming");
    if (els.zhBody) { els.zhBody.hidden = true; els.zhBody.textContent = ""; }
    setStatus("正在生成，请稍候…", false);

    // 面板默认收着（三款皮肤都收）→ 借 app.js 的展开按钮打开（纯 DOM 行为，不碰状态）
    var learnView = document.getElementById("view-learn");
    var btnExpand = document.getElementById("btn-generate");
    if (learnView && btnExpand && !learnView.classList.contains("story-open")) btnExpand.click();

    var full = "";
    try {
      var res = await requestStream(cfg, words);
      if (!res.ok) {
        var bodyText = "";
        try { bodyText = await res.text(); } catch (e) { /* ignore */ }
        throw new Error(friendlyHttpError(res.status, bodyText));
      }
      if (!res.body || !res.body.getReader) {
        throw new Error("当前浏览器不支持流式读取，请换新版 Chrome / Edge。");
      }

      // —— SSE 流式读取：data: {...} 逐行解析，[DONE] 结束 ——
      var reader = res.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buf = "";
      var got = 0;
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        var lines = buf.split("\n");
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.indexOf("data:") !== 0) continue;
          var payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            var j = JSON.parse(payload);
            var delta = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (delta) { full += delta; got += delta.length; }
          } catch (e) { /* 忽略无法解析的行 */ }
        }
        var live = splitLive(full);
        els.body.textContent = live.en + (live.zh ? "\n\n" + live.zh : "");
        setStatus("正在生成…（已收到 " + got + " 字）", false);
      }

      var story = splitStory(full);
      if (!story.en) throw new Error("模型没有返回有效内容，请重新生成试试。");
      syncDropsFromHeader(res);   // 走 Worker 时把服务端回写的余量落到本地显示

      // 生成期间换轮 / 重置了 → 内容对不上新一轮的词，不保存
      if (currentRoundKey() !== roundKey) {
        busy = false;
        render();
        toast("期间换了新的一轮，这篇故事没有保存");
        return;
      }

      var store = readStore();   // 期间设置可能被改过 → 读最新的再写回
      store.story = {
        roundKey: roundKey,
        title: story.title || "",
        en: story.en,
        zh: story.zh,
        createdAt: new Date().toISOString()
      };
      if (roundNo !== null) store.story.round = roundNo;
      if (words.length) store.story.words = words.slice();
      // 同步收进故事集：同一轮重新生成则替换旧条目；超过上限丢最老的
      store.history = store.history.filter(function (h) { return h.roundKey !== roundKey; });
      store.history.push(store.story);
      if (store.history.length > HISTORY_MAX) store.history = store.history.slice(-HISTORY_MAX);
      saveStore(store);
      busy = false;
      render();
      toast("本轮故事已生成");
    } catch (err) {
      busy = false;
      // 墨水相关的失败不按「网络错误」报，直接把添墨面板摆到面前
      if (err && err.inkCode) {
        fail(err.message);
        openInk(err.inkCode === "no_ink"
          ? "墨水瓶空了，添一点墨就能继续写。"
          : "还没有配置墨水服务，看看下面这两条路。");
        return;
      }
      var msg = (err && err.message) ? err.message : "生成失败，请重试。";
      if (err instanceof TypeError) msg = "网络请求失败，请检查网络连接后再试。";   // fetch 被断网 / 拦截时抛 TypeError
      fail(msg);
    }
  }

  /* ---------- 设置弹窗 ---------- */
  function openConfig(hint) {
    var cfg = readStore().config;
    els.cfgBase.value = cfg.baseUrl;
    els.cfgKey.value = cfg.apiKey;
    els.cfgModel.value = cfg.model;
    els.cfgHint.hidden = !hint;
    els.cfgHint.textContent = hint || "";
    els.cfgModal.removeAttribute("hidden");
    try { els.cfgKey.focus(); } catch (e) { /* ignore */ }
  }
  function closeConfig() { els.cfgModal.setAttribute("hidden", ""); }
  function saveConfig() {
    var store = readStore();
    store.config = {
      baseUrl: els.cfgBase.value.trim() || DEFAULT_BASE,
      apiKey: els.cfgKey.value.trim(),
      model: els.cfgModel.value.trim() || DEFAULT_MODEL
    };
    saveStore(store);
    closeConfig();
    renderInk();
    toast("故事生成设置已保存");
  }

  /* ---------- 墨水瓶 UI（2026-10-28） ----------
     规则：有自己的 Key 就完全不显示墨水瓶（他不受计数约束）；
     没有 Key 才出现，空了会变成空心瓶。 */
  var inkBusy = false;

  function renderInk() {
    var bottle = els.ink;
    if (!bottle) return;
    var cfg = readStore().config;
    var ink = readInk();
    bottle.hidden = !!cfg.apiKey;
    if (els.inkNum) els.inkNum.textContent = String(ink.drops);
    bottle.classList.toggle("is-empty", ink.drops <= 0);
    bottle.title = ink.drops > 0
      ? "还剩 " + ink.drops + " 滴墨，点一下可以添墨"
      : "墨水瓶空了，点一下添墨";
  }
  function inkMsg(text, isError) {
    if (!els.inkMsg) return;
    els.inkMsg.hidden = !text;
    els.inkMsg.textContent = text || "";
    els.inkMsg.classList.toggle("is-error", !!isError);
  }
  function openInk(hint) {
    if (!els.inkModal) return;
    var ink = readInk();
    if (els.inkHint) {
      els.inkHint.hidden = !hint;
      els.inkHint.textContent = hint || "";
    }
    if (els.inkCount) els.inkCount.textContent = String(ink.drops);
    if (els.inkWorker) els.inkWorker.value = ink.worker;
    if (els.inkCodeInput) els.inkCodeInput.value = "";
    inkMsg("", false);
    els.inkModal.removeAttribute("hidden");
    refreshInk();
    try { els.inkCodeInput.focus(); } catch (e) { /* ignore */ }
  }
  function closeInk() { if (els.inkModal) els.inkModal.setAttribute("hidden", ""); }

  async function redeemInk() {
    if (inkBusy || !els.inkCodeInput) return;
    var code = (els.inkCodeInput.value || "").trim();
    if (!code) { inkMsg("先填兑换码。", true); return; }
    var ink = readInk();
    if (!ink.worker) { inkMsg("墨水服务还没接通，先在下面填服务地址（部署说明见 server/）。", true); return; }
    inkBusy = true;
    if (els.inkRedeem) els.inkRedeem.disabled = true;
    inkMsg("正在兑换…", false);
    try {
      var res = await fetch(ink.worker + "/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-id": ensureClientId() },
        body: JSON.stringify({ code: code })
      });
      var j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok || !j || !j.ok) {
        inkMsg((j && j.error) || "兑换失败，检查一下码有没有输错。", true);
        return;
      }
      setInkDrops(j.drops);
      if (els.inkCount) els.inkCount.textContent = String(j.drops);
      if (els.inkCodeInput) els.inkCodeInput.value = "";
      inkMsg("添了 " + j.added + " 滴墨，现在共有 " + j.drops + " 滴。", false);
      toast("添墨成功");
    } catch (e) {
      inkMsg("连不上墨水服务，检查服务地址或稍后再试。", true);
    } finally {
      inkBusy = false;
      if (els.inkRedeem) els.inkRedeem.disabled = false;
    }
  }

  function saveWorker() {
    if (!els.inkWorker) return;
    var ink = readInk();
    ink.worker = (els.inkWorker.value || "").trim().replace(/\/+$/, "");
    saveInk(ink);
    inkMsg(ink.worker ? "服务地址已保存。" : "已清空服务地址。", false);
    refreshInk();
  }

  /* ---------- 故事集 = 书架（2026-10-27 改版） ---------- */
  /* 每根书脊 = 一轮故事。只陈列最近几轮（一排 6 本、按页翻）：
     200 篇铺成一屏不是书架，是长廊。更早的靠翻页，一篇都不丢。 */
  var SHELF_PER_PAGE = 6;
  var shelfPageNo = 0;          // 0 = 最新一页

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // 书名：新故事用 AI 给的 title；老存档没有就取英文首句前 3 个词
  function storyTitle(s) {
    var t = (s && typeof s.title === "string") ? s.title.trim() : "";
    if (t) return t;
    var en = (s && typeof s.en === "string") ? s.en : "";
    var first = en.split(/[.!?\n]/)[0] || "";
    var ws = first.trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (ws.length) {
      return ws.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
    }
    return "Untitled";
  }
  // 竖排标题区只有 148px 高：单词太多就截断，宁短勿溢
  function spineTitle(s) {
    var t = storyTitle(s);
    var ws = t.split(/\s+/).filter(Boolean);
    if (ws.length > 5) return ws.slice(0, 5).join(" ") + "…";
    if (t.length > 30) return t.slice(0, 30) + "…";
    return t;
  }
  function storyDate(s) {
    if (typeof s.createdAt !== "string") return "";
    var d = new Date(s.createdAt);
    if (isNaN(d.getTime())) return "";
    return pad2(d.getMonth() + 1) + "." + pad2(d.getDate());
  }
  function storyMeta(s) {
    var bits = [];
    if (typeof s.round === "number") bits.push("第 " + s.round + " 轮");
    if (typeof s.createdAt === "string") {
      var d = new Date(s.createdAt);
      if (!isNaN(d.getTime())) {
        bits.push(d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
          " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()));
      }
    }
    return bits.join(" · ");
  }

  function spineEl(s, curKey, colorIdx) {
    var name = spineTitle(s);
    var date = storyDate(s);
    var round = (typeof s.round === "number") ? pad2(s.round) : "--";

    var b = document.createElement("button");
    b.type = "button";
    b.className = "spine";
    // 颜色跟着故事在全局的位置走（不是页内位置），翻页时同一本书不会变色
    b.setAttribute("data-c", String(colorIdx || 1));
    if (curKey && s.roundKey === curKey) b.classList.add("is-now");
    b.title = name + (s.round ? " · 第 " + s.round + " 轮" : "") + (date ? " · " + date : "");
    b.setAttribute("aria-label", "翻开《" + name + "》" + (date ? "，生成于 " + date : ""));

    var face = document.createElement("span");
    face.className = "face";
    function put(cls, text) {
      var n = document.createElement("span");
      n.className = cls;
      if (text != null) n.textContent = text;
      face.appendChild(n);
      return n;
    }
    put("headband");
    put("rule t");
    put("no", round);
    put("title", name);
    put("rule b");
    put("date", date);
    put("mark");
    put("tailyarn");
    b.appendChild(face);

    b.addEventListener("click", function () { openInBook(s, b); });
    return b;
  }

  function shelfAll() {
    var store = readStore();
    var items = store.history.slice();
    // 升级前只存过「当前轮那一篇」的旧存档：只要不在历史里，也并入展示（不丢）
    var cur = store.story;
    if (cur && !items.some(function (x) { return x.roundKey === cur.roundKey; })) items.unshift(cur);
    return items;   // 正序：旧 → 新
  }

  function renderShelf() {
    if (!els.shelfRow) return;
    var all = shelfAll();
    var pages = Math.max(1, Math.ceil(all.length / SHELF_PER_PAGE));
    if (shelfPageNo > pages - 1) shelfPageNo = pages - 1;
    if (shelfPageNo < 0) shelfPageNo = 0;

    // 第 0 页是最新的 6 本，第 1 页再往前 6 本；页内仍按时间正序（左旧右新）
    var end = all.length - shelfPageNo * SHELF_PER_PAGE;
    var start = Math.max(0, end - SHELF_PER_PAGE);
    var page = all.slice(start, end);

    /* 「当前在读」跟着书桌上真正摊开的那篇走：从书架翻旧篇后回来看，
       绿点应该在第 5 轮那本上，而不是还钉在本轮 */
    var cur = viewStory || readStore().story;
    var curKey = cur ? cur.roundKey : "";
    els.shelfRow.textContent = "";
    page.forEach(function (s, k) {
      els.shelfRow.appendChild(spineEl(s, curKey, (start + k) % 6 + 1));
    });

    var hasAny = all.length > 0;
    els.shelfEmpty.hidden = hasAny;
    els.shelfStage.hidden = !hasAny;
    var modalBox = els.histModal ? els.histModal.querySelector(".modal-shelf") : null;
    if (modalBox) modalBox.classList.toggle("is-empty", !hasAny);

    if (!hasAny) {
      els.shelfEmpty.textContent = "还没有保存过故事。生成一篇后它就会自动收进这里，换轮、重置都不会丢。";
      els.shelfMeta.textContent = "";
      els.shelfNav.hidden = true;
      return;
    }

    var reading = cur && all.some(function (x) { return x.roundKey === cur.roundKey; });
    els.shelfMeta.textContent = all.length + " 篇" +
      (reading ? " · 当前读第 " + (cur.round || "?") + " 轮" : "");

    // 只有一页时不摆翻页器，省得白占一行
    els.shelfNav.hidden = pages <= 1;
    if (pages > 1) {
      els.shelfPage.textContent = (shelfPageNo + 1) + " / " + pages;
      els.shelfPrev.disabled = shelfPageNo >= pages - 1;   // 「更早」= 页码变大
      els.shelfNext.disabled = shelfPageNo <= 0;
    }
  }

  /* 点开一本：合上故事集，直接在书桌上摊开那一篇 ——
     不再另开小窗阅读视图。
     · 宽屏 + 非减动效 → 走「抽书」动画（书脊飞出来、摊平、翻开）。
       书开着 / 没开着都走这一条：故事集按钮长在书的工具条里，用户点书脊时
       书其实永远开着，所以「书已打开」才是它的主路径（书由 app.js 先收走）。
     · 窄屏 / 减动效 → 书开着就原地换页，没开就借丝带直接打开。 */
  var swapTimer;

  /* 抽书动画只在宽屏 + 非减动效下走：窄屏是单页版式、书比视口高，
     飞过来接不上（与 app.js 的 introTargetEnabled 同一套判据） */
  function flyEnabled() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    return window.innerWidth >= 1024;
  }

  function openInBook(s, btn) {
    if (!s) return;
    var learnView = document.getElementById("view-learn");
    if (!learnView) return;

    // 抽书优先：书开没开都交给它（开着的那本由 app.js 在 prepare 里收成书棱）
    if (flyEnabled() && btn) { flyFromShelf(s, btn); return; }

    if (learnView.classList.contains("story-open")) {
      viewStory = s;
      closeHistory();
      render();                     // 先把内容摆好，翻开看到的就是这一篇
      if (els.book) {
        els.book.classList.remove("is-swap");
        void els.book.offsetWidth;  // 强制重排，同一本书连点两本也能重放动画
        els.book.classList.add("is-swap");
        clearTimeout(swapTimer);
        swapTimer = setTimeout(function () {
          if (els.book) els.book.classList.remove("is-swap");
        }, 460);
      }
      setTimeout(fitPages, 0);      // 书开着时不会派发 xd:book-open，自己重量一次
      return;
    }

    viewStory = s;
    closeHistory();
    render();
    var ribbon = document.getElementById("btn-book-open");
    var expand = document.getElementById("btn-generate");
    if (ribbon) ribbon.click();
    else if (expand) expand.click();
    /* 故事集关掉后焦点别丢在 body 上：落到「返回单词」，键盘能接着用。
       720ms 让开书两拍先跑起来（中途不会触发跳过逻辑，这里只是 focus） */
    setTimeout(function () {
      var c = document.getElementById("btn-book-close");
      if (c && c.focus) c.focus({ preventScroll: true });
    }, 720);
  }

  /* ---------- 抽书：书脊弹起 → 向左倒下 → 摊开翻页 ----------
     ① 书脊弹起：把那根书脊复刻成一个 fixed 飞行体（同色、同字、同尺寸），
        它从架上升起、飞出弹窗的边界；
     ② 向左倒下：绕中心转 90°，长边横过来，落到书桌中心 —— 一本抽出来的书
        倒向桌面。全程保持原比例，它就是一本 280×84 的小书，不拉伸；
     ③ 翻开：派发 xd:book-reveal（带上这块面积），让真书从同一块面积上摊开，
        翻页叶跟着掀。
     书桌在弹窗后面（story-fly 让真书透明）先摆好，所以终点是量出来的真书
     中心，不是估的 —— 交接处严丝合缝。
     弹窗在飞行体离开书架的瞬间关闭，视线全在中间，看不到背后的排版切换。 */
  /* 整段抽书的主时长。关键帧的 offset 都是比例，改这一个数就能整体放慢；
     但下面两处 setTimeout（关弹窗 / 交棒给真书）是绝对毫秒，必须跟着换算。 */
  var FLY_MS = 1200;
  function flyFromShelf(s, btn) {
    var rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) { openInBook(s, null); return; }

    // ① 内容先摆好，再让书桌在弹窗后面切到阅读态，拿真书的最终矩形
    //    书本来就开着时先别换：让桌上那本按原样被「抽走」，等它化成书棱、
    //    看不见了再换内容（几毫秒后由 reveal 那一拍接手），中途不会露出新字。
    var lv = document.getElementById("view-learn");
    var wasOpen = !!lv && lv.classList.contains("story-open");
    if (!wasOpen) {
      viewStory = s;
      render();
    }
    var probe = { rect: null };
    document.dispatchEvent(new CustomEvent("xd:book-prepare", { detail: probe }));
    var to = probe.rect;
    document.body.classList.add("shelf-flying");   // 飞行途中按 Esc 不合书

    /* ② 轴与终点：飞行体绕「书脊右边缘那条竖边」转 ——
       书脊贴在轴的左边、封面折在轴的右边、朝观者这一侧伸出；绕 y 轴向右
       （正角）转 90° 后，书脊向右转开、封面从前面转正，向右铺成书的正面。
       方向是用户定的：书向右翻开，封面就该从右边出来、往右摊开。
       翻页叶（app.js 的 .bk-leaf 0 → -180）不动。 */
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = to ? (to.left + to.width / 2) : vw / 2;
    var cy = to ? (to.top + to.height / 2) : vh / 2;
    /* 书的正面 = 真书的一页：宽取真书一半、高取真书高。
       封面从轴向右铺开，所以轴落在「书桌中心 − 半页」处 —— 转正之后，
       这枚封面正好居中在书桌中心，真书接着对称铺成两页。 */
    var cw = to ? to.width / 2 : 420;
    var ch = to ? to.height : 600;
    var axisX = rect.right;   /* 书脊贴在轴的左边，所以轴取书脊的**右**边缘 ——
                                 起飞第一帧才和架上那根严丝合缝，不然整根会左跳 84px */
    var axisY = rect.top + rect.height / 2;
    var endX = cx - cw / 2;
    var liftY = Math.max(90, axisY - 185);   // 弹出弹窗上沿，但不顶出视口
    /* 旋转发生在「桌心上方 44px」这一层：先飞到位、停一拍、再原地转身，
       转完才落到桌面。旋转和位移分开，观者才看得见那个 90°。 */
    var turnY = cy - 44;

    var fly = document.createElement("div");
    fly.className = "spine spine-fly";
    fly.setAttribute("data-c", btn.getAttribute("data-c") || "1");
    fly.setAttribute("aria-hidden", "true");
    fly.style.left = axisX + "px";
    fly.style.top = axisY + "px";

    var flip = document.createElement("div");
    flip.className = "fly-flip";

    // 书脊面：连竖排字一起复刻，起飞那一瞬还认得出是架上这本
    var spineSide = document.createElement("div");
    spineSide.className = "fly-side fly-spine-side";
    spineSide.style.setProperty("--fw", rect.width + "px");
    spineSide.style.setProperty("--fh", rect.height + "px");
    var face = btn.querySelector(".face");
    if (face) spineSide.appendChild(face.cloneNode(true));
    var spineShade = document.createElement("span");
    spineShade.className = "fly-shade";
    spineSide.appendChild(spineShade);

    // 书的正面：同色系的书封 + 书名（书脊上用的就是这个名字）
    var cover = document.createElement("div");
    cover.className = "fly-side fly-cover-side";
    cover.style.setProperty("--cw", cw + "px");
    cover.style.setProperty("--ch", ch + "px");
    var plate = document.createElement("span");
    plate.className = "fly-cover-plate";
    cover.appendChild(plate);
    var coverTitle = document.createElement("span");
    coverTitle.className = "fly-cover-title";
    coverTitle.textContent = spineTitle(s) || "";
    cover.appendChild(coverTitle);
    var coverShade = document.createElement("span");
    coverShade.className = "fly-shade";
    cover.appendChild(coverShade);

    flip.appendChild(spineSide);
    flip.appendChild(cover);
    fly.appendChild(flip);
    document.body.appendChild(fly);

    // ③ 书架退场：整片遮罩淡掉；被点的这本立刻隐形（飞行体已在原位接住，留着会双影）
    btn.classList.add("is-flying");
    els.histModal.classList.add("is-fly-away");

    /* ④ 四拍：弹出 → 停一拍 → 原地转身 90° → 落到桌面。
       **位移和旋转必须分开**：原来边飞边转，一个大平移把旋转整个吃掉了，
       看着就是「书脊缩窄、封面出现」，像换图不像转身。
       现在先飞到桌心上方 44px 定住，停 90ms 让眼睛认出「这是一根竖着的书脊」，
       再在原地慢慢转 448ms，转完才落下 —— 那 90° 才有地方被看见。 */
    var spin = flip.animate([
      // 起飞段顺手把书架上那点 -12° 掰正，后面转的才是完整的 90°
      { transform: "rotateY(-12deg)", offset: 0, easing: "cubic-bezier(.3,.7,.4,1)" },
      { transform: "rotateY(0deg)", offset: 0.22, easing: "linear" },
      { transform: "rotateY(0deg)", offset: 0.30, easing: "cubic-bezier(.35,.08,.36,.96)" },
      { transform: "rotateY(90deg)", offset: 0.74, easing: "linear" },
      { transform: "rotateY(90deg)", offset: 1 }
    ], { duration: FLY_MS, fill: "forwards" });
    /* 书脊跟着长到书的真实高度：封面 655 高、书脊才 280，转到一半会对不上，
       书脊会像贴在封面右边中间的一小块。长在起飞段做完，别和旋转叠在一起。 */
    var grow = spineSide.animate([
      { height: rect.height + "px", offset: 0, easing: "linear" },
      { height: rect.height + "px", offset: 0.04, easing: "cubic-bezier(.4,.1,.35,1)" },
      { height: ch + "px", offset: 0.22 }
    ], { duration: FLY_MS, fill: "forwards" });

    spin.id = "shelf-spin";

    /* 受光：书脊转开越来越暗、封面从里侧转出来由暗转亮。
       ——封面不再「延迟淡入」了。以前封面到 0.46 才显形，转出的那 50° 被
       整段藏起来，观者只看到书脊变窄、然后一大片封面凭空出现，所以像切换。
       现在它从 0° 起就在（宽度为 0），随角度一点点变宽、同时变亮，
       中间那条窄暗面带就是「书的侧影」，旋转才被真正看见。 */
    var spineDim = spineShade.animate([
      { opacity: 0, offset: 0, easing: "linear" },
      { opacity: 0, offset: 0.30, easing: "linear" },
      { opacity: 0.55, offset: 0.74 },
      { opacity: 0.55, offset: 1 }
    ], { duration: FLY_MS, fill: "forwards" });
    var coverDim = coverShade.animate([
      { opacity: 0.30, offset: 0, easing: "linear" },
      { opacity: 0.30, offset: 0.30, easing: "linear" },
      { opacity: 0, offset: 0.74 },
      { opacity: 0, offset: 1 }
    ], { duration: FLY_MS, fill: "forwards" });
    /* 书脊转到接近侧面（θ ≈ 79°）就淡掉：再往后只剩一条线，还容易把背面透出来 */
    var spineOut = spineSide.animate([
      { opacity: 1, offset: 0, easing: "linear" },
      { opacity: 1, offset: 0.66 },
      { opacity: 0, offset: 0.74 }
    ], { duration: FLY_MS, fill: "forwards" });
    spineOut.onfinish = function () { spineSide.style.opacity = "0"; };

    /* 位移：竖直弹出弹窗上沿 → 横移到**视口中心**上方 → 转身时轴同步归位 → 落下。
       轴一开始放在 cx（而不是最终的 cx − 半页）：否则转身前半程整本书都在
       屏幕左半边，右边一大片空白，看着像「书贴在左边」，更谈不上转身。
       让轴在旋转的 528ms 里从 cx 滑到 cx − 半页：书脊往左退半步，封面在它
       右侧转正、铺满半页宽 —— 读作「书在屏幕正中向右翻开」。 */
    var anim = fly.animate([
      { left: axisX + "px", top: axisY + "px", opacity: 1, offset: 0, easing: "cubic-bezier(.25,.7,.35,1)" },
      { left: axisX + "px", top: liftY + "px", opacity: 1, offset: 0.14, easing: "cubic-bezier(.35,.2,.35,1)" },
      { left: cx + "px", top: turnY + "px", opacity: 1, offset: 0.22, easing: "linear" },
      { left: endX + "px", top: turnY + "px", opacity: 1, offset: 0.74, easing: "cubic-bezier(.4,.1,.4,1)" },
      { left: endX + "px", top: cy + "px", opacity: 1, offset: 0.82, easing: "linear" },
      { left: endX + "px", top: cy + "px", opacity: 0, offset: 0.90 },
      { left: endX + "px", top: cy + "px", opacity: 0, offset: 1 }
    ], { duration: FLY_MS, fill: "forwards" });
    anim.id = "shelf-fly";   // 定帧截图时按 id 找它（见 .verify/make-book-test.js）
    /* 末帧 opacity 0 必须写进内联：fill:forwards 的已结束动画会被浏览器当作
       「可替换动画」异步移除，移除后 opacity 回到 CSS 的 1 —— 飞行体会以一条
       实心绿横线返场、压在刚展开的书上（开书两拍踩过同一个坑）。 */
    anim.onfinish = function () { fly.style.opacity = "0"; };

    /* ⑤ 收尾三拍：关弹窗（飞行体已离开书架）→ 交棒给真书 → 清飞行体 */
    setTimeout(function () {
      // 清掉退场类再藏：不然下次打开故事集会是一张透明的空架子
      els.histModal.classList.remove("is-fly-away");
      closeHistory();
      renderShelf();                     // 重建书脊，架子回到干净状态
    }, 700);   // 略晚于弹窗自己的退场（overlay-out .5s / shelf-sink .66s）
    setTimeout(function () {
      /* 书本来就开着：此刻它已经被收成一条看不见的书棱，才把内容换成新的一篇
         —— 抽走的是原来那本，长出来的是新书，中途不会露出换字的破绽。 */
      if (wasOpen) {
        viewStory = s;
        render();
        setTimeout(fitPages, 0);
      }
      document.dispatchEvent(new CustomEvent("xd:book-reveal", {
        // 真书就从这枚「书的正面」上铺开：右页宽 × 开本高
        detail: { w: cw, h: ch }
      }));
      document.body.classList.remove("shelf-flying");
    }, 984);   // = 0.82 × FLY_MS，正好是飞行体落定的那一拍（再早会差 44px 高度）
    setTimeout(function () {
      try { anim.cancel(); } catch (e) { /* 已结束 */ }
      try { spin.cancel(); } catch (e) { /* 已结束 */ }
      try { grow.cancel(); } catch (e) { /* 已结束 */ }
      try { coverDim.cancel(); } catch (e) { /* 已结束 */ }
      try { spineDim.cancel(); } catch (e) { /* 已结束 */ }
      try { spineOut.cancel(); } catch (e) { /* 已结束 */ }
      if (fly.parentNode) fly.parentNode.removeChild(fly);
      var c = document.getElementById("btn-book-close");
      if (c && c.focus) c.focus({ preventScroll: true });
    }, FLY_MS + 40);
  }

  /* 旧篇 → 本轮（书桌主按钮在看旧篇时变成「回到本轮」） */
  function backToCurrent() {
    if (!viewStory) return;
    viewStory = null;
    render();
    setTimeout(fitPages, 0);
  }

  function openHistory() {
    /* 打开时定位到「正在读」那本所在的页：从书桌点故事集，不该每次都从最新一页重翻 */
    var all = shelfAll();
    var cur = viewStory || readStore().story;
    var pages = Math.max(1, Math.ceil(all.length / SHELF_PER_PAGE));
    shelfPageNo = 0;
    if (cur && all.length) {
      var idx = -1;
      for (var i = 0; i < all.length; i++) {
        if (all[i].roundKey === cur.roundKey) { idx = i; break; }
      }
      if (idx >= 0) {
        // 第 0 页 = 最新 6 本，越老的页码越大
        shelfPageNo = Math.min(pages - 1, Math.floor((all.length - 1 - idx) / SHELF_PER_PAGE));
      }
    }
    renderShelf();
    els.histModal.removeAttribute("hidden");
  }
  function closeHistory() {
    els.histModal.setAttribute("hidden", "");
  }

  /* ---------- 事件 ---------- */
  function bind() {
    els.gen.addEventListener("click", function () {
      if (viewStory) { backToCurrent(); return; }
      generate();
    });
    if (els.emptyCta) els.emptyCta.addEventListener("click", generate);
    els.cfgBtn.addEventListener("click", function () { openConfig(""); });
    els.histBtn.addEventListener("click", openHistory);
    els.cfgCancel.addEventListener("click", closeConfig);
    els.cfgSave.addEventListener("click", saveConfig);
    // 墨水瓶
    if (els.ink) els.ink.addEventListener("click", function () { openInk(""); });
    if (els.inkClose) els.inkClose.addEventListener("click", closeInk);
    if (els.inkRedeem) els.inkRedeem.addEventListener("click", redeemInk);
    if (els.inkSaveWorker) els.inkSaveWorker.addEventListener("click", saveWorker);
    if (els.inkCodeInput) els.inkCodeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); redeemInk(); }
    });
    if (els.inkOwnKey) els.inkOwnKey.addEventListener("click", function () {
      closeInk();
      openConfig("填好你自己的 Key 保存后，这条通道就不再计数了。");
    });
    if (els.inkModal) els.inkModal.addEventListener("click", function (e) { if (e.target === this) closeInk(); });
    els.histClose.addEventListener("click", closeHistory);
    // 书架翻页：「‹」看更早（页码变大），「›」看更新
    if (els.shelfPrev) els.shelfPrev.addEventListener("click", function () {
      shelfPageNo += 1;
      renderShelf();
    });
    if (els.shelfNext) els.shelfNext.addEventListener("click", function () {
      shelfPageNo -= 1;
      renderShelf();
    });
    // 点遮罩空白处 / 按 Esc 关闭（app.js 对重置弹窗有同款监听，互不干扰）
    els.cfgModal.addEventListener("click", function (e) { if (e.target === this) closeConfig(); });
    els.histModal.addEventListener("click", function (e) { if (e.target === this) closeHistory(); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!els.cfgModal.hasAttribute("hidden")) { closeConfig(); return; }
      if (els.inkModal && !els.inkModal.hasAttribute("hidden")) { closeInk(); return; }
      if (!els.histModal.hasAttribute("hidden")) closeHistory();
    });

    // 故事 → 角卡：点正文里的词（本轮高亮词或普通词），右上角的卡换内容
    var onWord = function (e) {
      var w = e.target.closest ? e.target.closest(".st-word, .st-any") : null;
      if (!w) return;
      e.stopPropagation();
      showDock(w.dataset.word);
    };
    els.body.addEventListener("click", onWord);
    if (els.zhBody) els.zhBody.addEventListener("click", onWord);

    // 角卡 · 手填释义：编辑笔 / 存按钮（点击不冒泡进段落钉选逻辑）
    if (els.dock) {
      els.dock.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest(".book-dock-edit")) { openDockEditor(); return; }
        if (e.target.closest && e.target.closest(".book-dock-save")) { saveDockEditor(); }
      });
    }
    if (els.dockInput) {
      // 输入行里的 Enter / Esc 不冒泡：Esc 全局会合书、Enter 可能触发别的快捷键
      els.dockInput.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); saveDockEditor(); }
        else if (e.key === "Escape") {
          els.dockInput.value = userMeanOf(dockWord);
          showDock(dockWord);   // 还原到展示态（有释义显释义，没有回到空输入行）
        }
      });
    }

    // 双击标记：双击任意英文词 → 落进当前模式的书签（再双击一次取消）
    var onWordDbl = function (e) {
      var w = e.target.closest ? e.target.closest(".st-word, .st-any") : null;
      if (!w) return;
      e.stopPropagation();
      e.preventDefault();
      if (window.getSelection) window.getSelection().removeAllRanges();   // 双击会顺带选中单词，清掉
      var d = { word: w.dataset.word, marked: false, supported: true };
      document.dispatchEvent(new CustomEvent("xd:mark-toggle", { detail: d }));
      if (!d.supported) {
        toast("暂时无法标记，请重试");
        return;
      }
      setMarkedState(w.dataset.word, d.marked);
      showDock(w.dataset.word);
      toast(d.marked ? "已标记「" + w.dataset.word + "」· 标记模式可见" : "已取消标记「" + w.dataset.word + "」");
    };
    els.body.addEventListener("dblclick", onWordDbl);
    if (els.zhBody) els.zhBody.addEventListener("dblclick", onWordDbl);

    // 覆盖点 → 卡片（这里仍然跳卡片：它本来就是「回到那张卡」的入口）
    els.dots.addEventListener("click", function (e) {
      var d = e.target.closest ? e.target.closest(".st-dot") : null;
      if (!d) return;
      document.dispatchEvent(new CustomEvent("xd:goto-word", { detail: { word: d.dataset.word } }));
    });

    // 段号 / 段落联动：悬停两侧同号段一起浮底；点一下钉住，再点取消
    els.panel.addEventListener("mouseover", function (e) {
      var p = e.target.closest ? e.target.closest(".bk-para") : null;
      if (!p || p.contains(e.relatedTarget)) return;
      setHot(p.dataset.para, true);
    });
    els.panel.addEventListener("mouseout", function (e) {
      var p = e.target.closest ? e.target.closest(".bk-para") : null;
      if (!p || p.contains(e.relatedTarget)) return;
      setHot(p.dataset.para, false);
    });
    els.panel.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".st-word, .st-any")) return;
      var p = e.target.closest ? e.target.closest(".bk-para") : null;
      if (p) toggleLock(p);
    });

    // 卡片 → 故事
    var chip = document.querySelector("#view-learn .card-story");
    if (chip) chip.addEventListener("click", function () {
      if (chip.dataset.sent) focusPara(Number(chip.dataset.sent));
    });

    // 长故事：两页滚动保持一致（比例对不齐，按段号对齐）
    if (els.zhBody) {
      els.body.addEventListener("scroll", function () { syncScroll(els.body, els.zhBody); });
      els.zhBody.addEventListener("scroll", function () { syncScroll(els.zhBody, els.body); });
    }

    // 书翻开 / 视口变了 → 重新量一次要不要收字号（app.js 发的事件）
    // 用 setTimeout 而不是 rAF：rAF 要等一帧，标签页在后台 / 无头截图时可能被饿死
    document.addEventListener("xd:book-open", function (e) {
      /* 合书 = 收摊：书桌上默认永远是本轮那篇，下次开书别还摊着三天前那篇 */
      if (e && e.detail && e.detail.open === false) {
        if (viewStory) {
          viewStory = null;
          render();       // 合着时 fitPages 自己会跳过（.book clientHeight < 100）
        }
        return;
      }
      markSnapshot();        // 开书前可能又在卡片上标记过 → 重拉清单
      applyMarkedClasses();  // 并把正文里的标记态对齐
      setTimeout(fitPages, 0);
    });

    /* 换轮 / 回退到旧轮（app.js 发）：书桌上摊的必须是「这一轮」那篇。
       从书架点开的旧篇先收掉，否则回退后还摊着别的轮次。 */
    document.addEventListener("xd:round-changed", function () {
      if (viewStory) viewStory = null;
      render();
      setTimeout(fitPages, 0);
    });
  }

  /* ---------- 换轮感知 ---------- */
  // app.js 换轮 / 重置后会重写轮次徽标 → 盯着它，一旦变化就重新核对本轮故事
  function watchRound() {
    var badge = document.getElementById("round-badge");
    if (!badge || typeof MutationObserver === "undefined") return;
    new MutationObserver(function () { render(); })
      .observe(badge, { childList: true, characterData: true, subtree: true });
  }

  // 换词后卡片顶部的「故事第 N 句」要跟着换 → 盯着单词节点（MutationObserver，与 intro.js 无关）
  function watchCard() {
    var wordEl = document.querySelector("#view-learn .card-word");
    if (!wordEl || typeof MutationObserver === "undefined") return;
    new MutationObserver(function () { syncCardChip(); })
      .observe(wordEl, { childList: true, characterData: true, subtree: true });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    els.panel = $("#view-learn .story-panel");
    if (!els.panel) return;   // 非 study 页面（如首页）不干活
    els.empty = $(".story-empty", els.panel);
    els.emptyCta = $("#btn-story-empty");
    els.emptyWords = $(".story-empty-words", els.panel);
    els.status = $(".story-status", els.panel);
    els.body = $(".story-body-en", els.panel) || $(".story-body", els.panel);
    els.zhBody = $(".story-body-zh", els.panel);
    els.dock = $(".book-dock", els.panel);
    els.dockEdit = $(".book-dock-edit", els.panel);
    els.dockEditRow = $(".book-dock-editrow", els.panel);
    els.dockInput = $("#book-dock-input");
    els.book = $(".book", els.panel);
    els.footRound = $(".book-foot-round", els.panel);
    els.bookRibbon = document.getElementById("btn-book-open");
    els.bookClose = document.getElementById("btn-book-close");
    els.meta = $(".story-meta", els.panel);
    els.dots = $(".story-dots", els.panel);
    els.coverage = $(".story-meta-count", els.panel);
    els.kickerRound = $(".story-round-label", els.panel);
    els.kickerDate = $(".story-date", els.panel);
    els.archiveTag = $(".story-archive-tag", els.panel);
    els.title = $(".story-title", els.panel);
    els.teaser = $(".story-teaser", els.panel);
    els.footer = $(".story-footer", els.panel);
    els.gen = $("#btn-story-gen");
    els.cfgBtn = $("#btn-story-config");
    els.histBtn = $("#btn-story-history");
    els.cfgModal = $("#story-config-modal");
    els.cfgBase = $("#cfg-baseurl");
    els.cfgKey = $("#cfg-apikey");
    els.cfgModel = $("#cfg-model");
    els.cfgHint = $("#cfg-hint");
    els.cfgCancel = $("#btn-cfg-cancel");
    els.cfgSave = $("#btn-cfg-save");
    // 墨水瓶
    els.ink = $("#btn-ink");
    els.inkNum = $("#ink-num");
    els.inkModal = $("#ink-modal");
    els.inkCount = $("#ink-count");
    els.inkHint = $("#ink-hint");
    els.inkMsg = $("#ink-msg");
    els.inkCodeInput = $("#ink-code");
    els.inkRedeem = $("#btn-ink-redeem");
    els.inkWorker = $("#ink-worker");
    els.inkSaveWorker = $("#btn-ink-save-worker");
    els.inkOwnKey = $("#btn-ink-own-key");
    els.inkClose = $("#btn-ink-close");
    els.histModal = $("#story-history-modal");
    els.histClose = $("#btn-history-close");
    els.shelfMeta = $("#shelf-meta");
    els.shelfEmpty = $("#shelf-empty");
    els.shelfStage = $("#shelf-stage");
    els.shelfRow = $("#shelf-row");
    els.shelfNav = $("#shelf-nav");
    els.shelfPage = $("#shelf-page");
    els.shelfPrev = $("#btn-shelf-prev");
    els.shelfNext = $("#btn-shelf-next");
    if (!els.gen || !els.cfgModal || !els.histModal || !els.body || !els.dots) return;
    bind();
    watchRound();
    watchCard();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
