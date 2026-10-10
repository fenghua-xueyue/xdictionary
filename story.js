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
   - 顶栏「＋ 生成今日故事」按钮的展开 / 收起职责不变（仍归 app.js）；
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

  /* ---------- 小工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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
  function setGenLabel(text) { if (els.gen) els.gen.textContent = text; }
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

  function render() {
    if (!els.panel) return;
    els.gen.disabled = busy;
    if (busy) { setGenLabel("生成中…"); return; }   // 生成中的面板状态由 generate() 管理
    var story = currentStoryForRound();
    if (story) {
      var words = currentRoundWords();
      renderHighlighted(els.en, story.en, words);
      renderHighlighted(els.zh, story.zh, words);
      els.en.hidden = false;
      els.zh.hidden = !story.zh;
      els.footer.hidden = false;
      els.empty.hidden = true;
      els.status.hidden = true;
      setGenLabel("↻ 重新生成");
    } else {
      els.en.hidden = true;
      els.zh.hidden = true;
      els.footer.hidden = true;
      els.empty.hidden = false;
      els.status.hidden = true;
      setGenLabel("✨ 生成本轮故事");
    }
  }

  function fail(msg) {
    els.en.hidden = true;
    els.zh.hidden = true;
    els.footer.hidden = true;
    els.empty.hidden = true;
    setStatus(msg, true);
    els.gen.disabled = false;
    setGenLabel(currentStoryForRound() ? "↻ 重新生成" : "✨ 生成本轮故事");
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
        "今天的单词：" + words.join(", ") + "。请写一篇连贯小故事，尽量包含所有这些词；" +
        "个别难组合的词可省略并在文末说明。附中文对照。\n" +
        "输出格式要求：先输出英文故事正文；然后单独一行输出 ---；最后另起一段输出中文对照。" +
        "除此之外不要输出任何别的文字或标题。" }
    ];
  }
  function friendlyHttpError(status, bodyText) {
    if (status === 401) return "API Key 无效或没填对，点右上角 ⚙ 检查一下设置。";
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
    setGenLabel("生成中…");
    els.empty.hidden = true;
    els.footer.hidden = true;
    els.zh.hidden = true;
    els.zh.textContent = "";
    els.en.hidden = false;
    els.en.textContent = "";
    setStatus("正在生成，请稍候…", false);

    // 像素风下面板默认收着 → 借 app.js 的展开按钮打开（纯 DOM 行为，不碰状态）
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
        els.en.textContent = live.en;
        if (live.zh) { els.zh.hidden = false; els.zh.textContent = live.zh; }
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
  }

  /* ---------- 换轮感知 ---------- */
  // app.js 换轮 / 重置后会重写轮次徽标 → 盯着它，一旦变化就重新核对本轮故事
  function watchRound() {
    var badge = document.getElementById("round-badge");
    if (!badge || typeof MutationObserver === "undefined") return;
    new MutationObserver(function () { render(); })
      .observe(badge, { childList: true, characterData: true, subtree: true });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    els.panel = $("#view-learn .story-panel");
    if (!els.panel) return;   // 非 study 页面（如首页）不干活
    els.empty = $(".story-empty", els.panel);
    els.status = $(".story-status", els.panel);
    els.en = $(".story-en", els.panel);
    els.zh = $(".story-zh", els.panel);
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
    if (!els.gen || !els.cfgModal || !els.histModal) return;
    bind();
    watchRound();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
