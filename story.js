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
   - 操作栏「＋ 展开今日故事」按钮的展开 / 收起职责不变（仍归 app.js）；
     本模块只负责面板内部的「生成本轮故事 / 重新生成」按钮与设置弹窗。
   - 像素风下面板默认收着 → 生成时借 #btn-generate 的点击展开
     （纯 DOM 行为，不碰状态；顺带复用 app.js 的展开规则）。
   ============================================================ */
(function () {
  "use strict";

  var LS_STORY = "english_app_story_v1";
  var LS_PROGRESS = "english_app_v1";
  var DEFAULT_BASE = "https://api.deepseek.com";
  var DEFAULT_MODEL = "deepseek-chat";
  var HISTORY_MAX = 200;   // 故事集上限：每篇约 1~2KB，200 篇远在 localStorage 容量之内

  var els = {};
  var busy = false;
  var wordSentence = {};     // 小写单词 → 它在故事里第一次出现的句号（卡片锚点用）
  var WORD_INFO = null;      // 词库索引：单词 → { phonetic, meaning }

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
        typeof s.en === "string" && typeof s.zh === "string") return s;
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
  // 当前轮对应的已缓存故事（roundKey 不匹配 = 没有本轮故事）
  function currentStoryForRound() {
    var store = readStore();
    var rk = currentRoundKey();
    return (store.story && store.story.roundKey === rk) ? store.story : null;
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
  function splitBySeparator(full) {
    var m = full.match(/\n[ \t]*-{3,}[ \t]*\n/);
    if (m && typeof m.index === "number") {
      return { en: full.slice(0, m.index).trim(), zh: full.slice(m.index + m[0].length).trim() };
    }
    return null;
  }
  // 流式过程中的实时分段：只认 --- 分隔行（不启用兜底，避免把英文段落误切给中文）
  function splitLive(full) {
    var r = splitBySeparator(full);
    return r || { en: full, zh: "" };
  }
  // 落定时的分段：--- 没出现时按「空行 + 中文开头」兜底
  function splitStory(full) {
    var r = splitBySeparator(full);
    if (r) return r;
    var m = full.match(/\n\n(?=[\u4e00-\u9fff])/);
    if (m && typeof m.index === "number") {
      return { en: full.slice(0, m.index).trim(), zh: full.slice(m.index + m[0].length).trim() };
    }
    return { en: full.trim(), zh: "" };
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

    // 页眉的轮次 / 日期
    var rp = readProgress();
    if (els.kickerRound) {
      els.kickerRound.textContent = (rp && typeof rp.round === "number") ? "第 " + rp.round + " 轮" : "本轮";
    }
    if (els.kickerDate) {
      var d = story.createdAt ? new Date(story.createdAt) : null;
      els.kickerDate.textContent = (d && !isNaN(d.getTime()))
        ? (d.getMonth() + 1) + " 月 " + d.getDate() + " 日"
        : "—";
    }
    if (els.footRound) {
      els.footRound.textContent = "ROUND " + (rp && typeof rp.round === "number" ? (rp.round < 10 ? "0" : "") + rp.round : "—");
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
    els.coverage.textContent = "本篇用上 " + hitCount + " / " + list.length + " 词";
    els.meta.hidden = false;

    // 角卡先摆上当前这张卡片的词
    var cur = document.querySelector("#view-learn .card-word");
    if (cur && cur.textContent.trim()) showDock(cur.textContent.trim());

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
    if (busy) { setGenLabel(null, "生成中…"); return; }   // 生成中的面板状态由 generate() 管理
    var story = currentStoryForRound();
    var rp = readProgress();
    if (els.kickerRound) {
      els.kickerRound.textContent = (rp && typeof rp.round === "number") ? "第 " + rp.round + " 轮" : "本轮";
    }
    if (story) {
      buildStory(story, currentRoundWords());
      if (els.teaser) {
        var t = String(story.en || "").replace(/\s+/g, " ").trim();
        var m = t.match(/^[^.!?]+[.!?]/);
        els.teaser.textContent = (m ? m[0] : t).slice(0, 140);
        els.teaser.hidden = false;
      }
      els.empty.hidden = true;
      els.status.hidden = true;
      els.footer.hidden = false;
      setGenLabel("i-cyclic", "重新生成");
    } else {
      els.body.hidden = true;
      els.body.textContent = "";
      els.body.classList.remove("is-streaming");
      if (els.zhBody) { els.zhBody.hidden = true; els.zhBody.textContent = ""; }
      if (els.dock) els.dock.hidden = true;
      els.meta.hidden = true;
      els.empty.hidden = false;
      els.status.hidden = true;
      els.footer.hidden = true;
      // 空态也把页码的轮次印上，别留一个没渲染过的占位符
      if (els.footRound) {
        els.footRound.textContent = "ROUND " + (rp && typeof rp.round === "number" ? (rp.round < 10 ? "0" : "") + rp.round : "—");
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
    // 像素皮肤把书退化成单栏直读，没有定尺页，不参与排版
    if (document.documentElement.getAttribute("data-skin") === "pixel") return;
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
        "输出格式要求：先输出英文故事正文；然后单独一行输出 ---；最后另起一段输出中文对照。" +
        "除此之外不要输出任何别的文字或标题。" }
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

  async function generate() {
    if (busy) return;
    var cfg = readStore().config;
    if (!cfg.apiKey) {
      openConfig("还没有填 API Key，填好保存后就能生成了。");
      return;
    }
    var words = currentRoundWords();
    if (!words.length) { toast("还没有当前轮的单词，先抽一轮再说"); return; }

    var roundKey = currentRoundKey();
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
      var headers = { "Content-Type": "application/json" };
      if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;
      var res = await fetch(endpointOf(cfg.baseUrl), {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: buildMessages(words),
          temperature: 1.5,
          max_tokens: 600,
          stream: true
        })
      });
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

      // 生成期间换轮 / 重置了 → 内容对不上新一轮的词，不保存
      if (currentRoundKey() !== roundKey) {
        busy = false;
        render();
        toast("期间换了新的一轮，这篇故事没有保存");
        return;
      }

      var store = readStore();   // 期间设置可能被改过 → 读最新的再写回
      store.story = { roundKey: roundKey, en: story.en, zh: story.zh, createdAt: new Date().toISOString() };
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
    toast("故事生成设置已保存");
  }

  /* ---------- 故事集（历史故事） ---------- */
  function openHistory() {
    renderHistory();
    els.histModal.removeAttribute("hidden");
  }
  function closeHistory() { els.histModal.setAttribute("hidden", ""); }
  function historyItemEl(s) {
    var art = document.createElement("article");
    art.className = "history-item";
    // 标题：第 N 轮 · 日期时间（旧条目可能缺轮次号/时间，缺就略过）
    var label = [];
    if (typeof s.round === "number") label.push("第 " + s.round + " 轮");
    if (typeof s.createdAt === "string") {
      var d = new Date(s.createdAt);
      if (!isNaN(d.getTime())) {
        function p2(n) { return (n < 10 ? "0" : "") + n; }
        label.push(d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
          " " + p2(d.getHours()) + ":" + p2(d.getMinutes()));
      }
    }
    var h = document.createElement("h4");
    h.className = "history-item-title";
    h.textContent = label.length ? label.join(" · ") : "生成的故事";
    art.appendChild(h);
    // 正文：有条目自带的 words 就做高亮（老条目没有则纯文本）
    var words = Array.isArray(s.words) ? s.words : [];
    var en = document.createElement("p");
    en.className = "history-en";
    renderHighlighted(en, s.en, words);
    art.appendChild(en);
    var zh = document.createElement("p");
    zh.className = "history-zh";
    renderHighlighted(zh, s.zh, words);
    zh.hidden = !s.zh;
    art.appendChild(zh);
    return art;
  }
  function renderHistory() {
    var store = readStore();
    var items = store.history.slice();
    // 升级前只存过「当前轮那一篇」的旧存档：只要不在历史里，也并入展示（不丢）
    var cur = store.story;
    if (cur && !items.some(function (x) { return x.roundKey === cur.roundKey; })) items.unshift(cur);
    els.histList.textContent = "";
    if (!items.length) {
      var p = document.createElement("p");
      p.className = "history-empty";
      p.textContent = "还没有保存过故事。生成一篇后，它就会自动收进故事集，换轮、重置都不会丢。";
      els.histList.appendChild(p);
      return;
    }
    // 最新的排最上面
    items.reverse().forEach(function (s) { els.histList.appendChild(historyItemEl(s)); });
  }

  /* ---------- 事件 ---------- */
  function bind() {
    els.gen.addEventListener("click", generate);
    if (els.emptyCta) els.emptyCta.addEventListener("click", generate);
    els.cfgBtn.addEventListener("click", function () { openConfig(""); });
    els.histBtn.addEventListener("click", openHistory);
    els.cfgCancel.addEventListener("click", closeConfig);
    els.cfgSave.addEventListener("click", saveConfig);
    els.histClose.addEventListener("click", closeHistory);
    // 点遮罩空白处 / 按 Esc 关闭（app.js 对重置弹窗有同款监听，互不干扰）
    els.cfgModal.addEventListener("click", function (e) { if (e.target === this) closeConfig(); });
    els.histModal.addEventListener("click", function (e) { if (e.target === this) closeHistory(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!els.cfgModal.hasAttribute("hidden")) closeConfig();
        if (!els.histModal.hasAttribute("hidden")) closeHistory();
      }
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
    document.addEventListener("xd:book-open", function () {
      markSnapshot();        // 开书前可能又在卡片上标记过 → 重拉清单
      applyMarkedClasses();  // 并把正文里的标记态对齐
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

  // 换词后卡片顶部的「故事第 N 句」要跟着换 → 盯着单词节点（与 sword.js 同一手法）
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
    els.histModal = $("#story-history-modal");
    els.histList = $("#story-history-list");
    els.histClose = $("#btn-history-close");
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
