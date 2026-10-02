/* ============================================================
   高频词小灶 — 像素风主题脚本（仅 pixel 皮肤生效）
   ------------------------------------------------------------
   职责（全在 html[data-skin="pixel"] 下才执行，其它皮肤直接 return）：
     1) 计算舞台等比缩放系数 --px-scale = min(vw/1440, vh/1200)
     2) 长单词自动降字号（card-word 量宽缩到 60px 下限）
     3) 同步惰性钩子文本：.px-subtitle ← #round-badge；.px-index ← 各 view 的 .progress-text
     4) 监听卡片换词 / 视图切换，自动重新量宽（见 watchDom）
   与皮肤机制解耦：自身监听 <html> 的 data-skin 变化，运行中切到像素风也能即时生效。
   ============================================================ */
(function () {
  "use strict";

  var PIXEL = "pixel";

  function isPixel() {
    return document.documentElement.getAttribute("data-skin") === PIXEL;
  }

  /* ---------- 1) 舞台缩放 ---------- */
  function fitStage() {
    var stage = document.getElementById("stage");
    if (!stage) return;
    var k = Math.min(window.innerWidth / 1440, window.innerHeight / 1200);
    if (!(k > 0)) k = 1;
    stage.style.setProperty("--px-scale", k);
  }

  /* ---------- 2) 长词降字号 ---------- */
  var WORD_MAX = 840;                         // 可用词宽，与 CSS .card-word max-width 一致
  function fitWords() {
    // 含 ghost 层：挥剑翻页时新词先落在 ghost 上，也得先把字号量准
    var words = document.querySelectorAll(".card-word, .card-word-ghost");
    for (var i = 0; i < words.length; i++) {
      var el = words[i];
      if (!el.clientWidth) continue;          // 空词 / 隐藏视图：跳过，等可见后再量
      el.style.fontSize = "";                 // 复位到 --fs-word (160px)
      var fs = 160;
      // 量宽：超出则逐步缩到 60px 下限
      while (el.scrollWidth > WORD_MAX && fs > 60) {
        fs -= 4;
        el.style.fontSize = fs + "px";
      }
    }
  }

  /* ---------- 3) 同步惰性钩子 ---------- */
  /* 只在「值真的变了」时才写 DOM：
     本函数会被 watchDom 的 MutationObserver 调用，若无条件写 textContent，
     每次写又会触发一次 observer → 死循环。条件写让它一轮就收敛。 */
  function syncHooks() {
    var badge = document.getElementById("round-badge");
    var subs = document.querySelectorAll(".px-subtitle");
    for (var i = 0; i < subs.length; i++) {
      if (badge && subs[i].textContent !== badge.textContent) {
        subs[i].textContent = badge.textContent;
      }
    }
    var views = document.querySelectorAll(".view");
    for (var v = 0; v < views.length; v++) {
      var pt = views[v].querySelector(".progress-text");
      var idx = views[v].querySelector(".px-index");
      if (pt && idx && idx.textContent !== pt.textContent) {
        idx.textContent = pt.textContent;
      }
    }
  }

  /* ---------- 4) 换词 / 切视图后重新量宽 ----------
     app.js 直接改 .card-word 文本、切 .view-active 都不派发事件，
     卡片的词往往在 fitWords() 首跑之后才写进来（如切到复习视图），
     所以用 MutationObserver 兜住：文本变化 / class 变化都触发重量宽。
     顺带同步惰性钩子 —— .px-index 是卡片里的序号，翻页 / 换轮后原本不会更新。
     只监听 class + text（不监听 style），避免自己写 fontSize 造成死循环。 */
  function watchDom() {
    if (!document.body) return;
    new MutationObserver(function () {
      if (!isPixel()) return;
      fitWords();
      syncHooks();
    }).observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["class", "data-mode"]
    });
  }

  /* ---------- 总执行 ---------- */
  function apply() {
    if (!isPixel()) return;
    fitStage();
    fitWords();
    syncHooks();
  }

  /* ---------- 监听：运行中切换皮肤也要生效 ---------- */
  if (document.documentElement) {
    new MutationObserver(function () { apply(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  }
  window.addEventListener("resize", function () { if (isPixel()) { fitStage(); } });

  /* ---------- 初始执行 ---------- */
  function init() {
    apply();
    watchDom();
    // 二次校正：等 fonts / 布局稳定后再量一次（避免首帧字体未就绪导致测量偏小）
    setTimeout(apply, 60);
    setTimeout(apply, 300);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
