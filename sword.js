/* ============================================================
   高频小灶 — 挥剑翻页动效（仅像素风生效）
   ------------------------------------------------------------
   设计要点：
     1) 不拦截点击 —— app.js 照常改状态并渲染；本文件只订阅
        「当前词变了」这个事实，然后演。动效是纯表现层，
        演砸了也不影响翻页本身。
     2) 触发条件用「状态推导」，不靠点击监听 ——
        观察进度数字（"3 / 20"）的增量：正好走一格 = 点了一次箭头。
        本 App 里只有两个箭头会单步移动（换轮 / 换批跳 20 格、
        切模式不动索引、首次进入不动索引，app.js 也没有 Enter 进词），
        所以这条判据既精确又不需要任何时序假设。
        这一版刻意删掉了早先的「点击监听 + armed 标记 + 定时器」链路：
        它要同时依赖监听注册、冒泡顺序和微任务时机，任一环节出问题
        都会让某一次点击静默失效。
     3) 时长以 CSS 为唯一真相 —— 数字只写在 style.css 的 --sword-* 里，
        这里借探针元素把 var()/calc() 求值成真实毫秒，不在 JS 重复一份。
     4) 字号不归这里管 —— 仍是 pixel.js 的 fitWords()；本文件只碰
        transform / opacity / 文本内容，绝不写 fontSize。
   ============================================================ */
(function () {
  "use strict";

  var PIXEL = "pixel";
  function isPixel() {
    return document.documentElement.getAttribute("data-skin") === PIXEL;
  }

  /* ---------- 时长：让浏览器把 CSS 里的 var()/calc() 求值成毫秒 ----------
     自定义属性的计算值是不求值的表达式（读出来会是 "calc(460ms * 1)"），
     所以借一个不可见探针元素，把它赋给真正的动画属性再读回来。
     探针在 init 时就建好 —— 不要在点剑那一刻才往 body 里插节点。 */
  var probe = null;
  function ensureProbe() {
    if (probe || !document.body) return;
    probe = document.createElement("div");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;";
    document.body.appendChild(probe);
  }
  function cssMs(expr) {
    ensureProbe();
    if (!probe) return 0;
    probe.style.animationDuration = expr;
    var s = getComputedStyle(probe).animationDuration;   // 计算值单位是秒
    return (parseFloat(s) || 0) * 1000;
  }

  /* ---------- 挥剑音效（Web Audio 现场合成：零依赖、无音频文件） ----------
     MC 的挥剑音是 Mojang 的版权素材，不能直接拿来用；项目又是「零依赖 +
     不引外部文件」，所以按「刀刃划开空气」的物理自己搭了一版同气质的挥砍声：
       噪声 → 带通(Q) 中心频率快速上扫 → 共振峰提亮 → 包络快起快落
       再叠一记 ~4ms 的高频瞬态，当「斩」的锋芒
     左右剑音色分开：黄金剑基频低、频带宽（闷厚）；钻石剑基频高、Q 大（脆亮）。
     声像跟着扫向走 —— 左剑自左扫向右，声音也从左滑到右。
     参数是在原型里调过的，**别再随手改**；改就用 OfflineAudioContext 量 RMS/谱心再调。
     慢放时整段一起拉长：k 直接读 CSS 的 --sword-k，和动画同源。 */
  var AC = null, soundOn = true;
  var LS_SOUND = "english_app_sound_v1";   // 独立 key，与进度/皮肤互不影响

  function readSound() {
    try { return localStorage.getItem(LS_SOUND) !== "off"; } catch (e) { return true; }
  }
  function saveSound(on) {
    soundOn = on;
    try { localStorage.setItem(LS_SOUND, on ? "on" : "off"); } catch (e) {}
  }

  /* 慢放系数：--sword-k 是纯数字，计算值可直接 parse（不像 --sword-swing 是 calc 表达式） */
  function swordK() {
    var n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sword-k"));
    return (n > 0) ? n : 1;
  }

  function ac() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!AC) { try { AC = new C(); } catch (e) { return null; } }
    if (AC.state === "suspended") AC.resume();
    return AC;
  }
  function noiseBuf(ctx, sec) {
    var n = Math.max(1, Math.floor(ctx.sampleRate * sec));
    var b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /* 把一记挥砍挂到任意 ctx / 目标节点上（离线渲染也走这条，便于量化验证） */
  function buildSwing(ctx, dest, t0, isL, k) {
    var dur = 0.34 * k;

    var src = ctx.createBufferSource();
    src.buffer = noiseBuf(ctx, dur + 0.05);

    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = isL ? 1.1 : 1.7;
    var f0 = isL ? 470 : 780;                       // 黄金 : 钻石 ≈ 1.66×
    bp.frequency.setValueAtTime(f0, t0);
    bp.frequency.exponentialRampToValueAtTime(f0 * 4.2, t0 + 0.20 * k);
    bp.frequency.exponentialRampToValueAtTime(f0 * 0.85, t0 + dur);

    var form = ctx.createBiquadFilter();            // 共振峰：给风声一个形体
    form.type = "peaking";
    form.frequency.value = isL ? 1200 : 2100;
    form.Q.value = 0.9;
    form.gain.value = 7;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.040 * k);   // 起手推力
    g.gain.exponentialRampToValueAtTime(0.32, t0 + 0.120 * k);   // 风声主体
    g.gain.exponentialRampToValueAtTime(0.13, t0 + 0.260 * k);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);       // 收干净

    var ts = ctx.createBufferSource();              // 瞬态：斩的锋芒（立刻到）
    ts.buffer = noiseBuf(ctx, 0.03);
    var hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 3000;
    var tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t0);
    tg.gain.exponentialRampToValueAtTime(0.12, t0 + 0.004 * k);
    tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.035 * k);

    var pan = null;
    if (ctx.createStereoPanner) {                   // 声像跟着扫向
      pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(isL ? -0.42 : 0.42, t0);
      pan.pan.linearRampToValueAtTime(isL ? 0.55 : -0.55, t0 + dur * 0.8);
    }

    src.connect(bp); bp.connect(form); form.connect(g);
    ts.connect(hp); hp.connect(tg);
    if (pan) { g.connect(pan); tg.connect(pan); pan.connect(dest); }
    else { g.connect(dest); tg.connect(dest); }

    src.start(t0); src.stop(t0 + dur + 0.02);
    ts.start(t0);  ts.stop(t0 + 0.05 * k + 0.02);
  }

  function playSwing(isL) {
    if (!soundOn) return;
    var ctx = ac();
    if (!ctx) return;
    try { buildSwing(ctx, ctx.destination, ctx.currentTime + 0.012, isL, swordK()); }
    catch (e) { /* 音频不可用就静默降级，绝不能影响翻页 */ }
  }

  /* 浏览器要求用户手势后才能出声：第一次交互时把 AudioContext 建好并 resume，
     免得第一次挥剑因为上下文还是 suspended 而没声音。 */
  function unlockAudio() {
    var ctx = ac();
    if (ctx && ctx.state === "running") {
      document.removeEventListener("pointerdown", unlockAudio, true);
      window.removeEventListener("keydown", unlockAudio, true);
    }
  }
  document.addEventListener("pointerdown", unlockAudio, true);
  window.addEventListener("keydown", unlockAudio, true);

  function initSoundButton() {
    soundOn = readSound();
    var btn = document.getElementById("btn-sound");
    if (!btn) return;
    function paint() {
      btn.textContent = soundOn ? "🔊" : "🔇";
      btn.setAttribute("aria-pressed", soundOn ? "true" : "false");
      btn.title = soundOn ? "挥剑音效：开（点击静音）" : "挥剑音效：关（点击开启）";
    }
    paint();
    btn.addEventListener("click", function () {
      saveSound(!soundOn);
      paint();
      if (soundOn) playSwing(false);        // 开启时给一记试听
    });
  }

  /* ---------- 状态 ---------- */
  var cards = [];       // 每张卡片的节点登记
  var shown = {};       // id -> 卡片当前「显示中」的内容（= 动画起点）
  var target = {};      // id -> app.js 最新要求的内容（连点打断时用它兜底）
  var lastIdx = {};     // id -> 上次看到的进度序号
  var animId = null;    // 正在播动画的卡片 id
  var busy = false;

  function snap(c) {
    return {
      word: c.word.textContent,
      phonetic: c.phon ? c.phon.textContent : "",
      meaning: c.mean ? c.mean.textContent : ""
    };
  }

  /* 进度数字 → 序号（"3 / 20" → 3）。这是判断「是不是点了一次箭头」的依据。 */
  function idxOf(c) {
    var pt = c.view ? c.view.querySelector(".progress-text") : null;
    if (!pt) return null;
    var m = /(\d+)\s*\/\s*(\d+)/.exec(pt.textContent);
    return m ? parseInt(m[1], 10) : null;
  }

  function resetClasses(c) {
    c.word.classList.remove("awayL", "awayR");
    c.ghost.classList.remove("flyL", "flyR");
    if (c.navL) c.navL.classList.remove("swL", "swR");
    if (c.navR) c.navR.classList.remove("swL", "swR");
    if (c.phon) c.phon.classList.remove("sw-infoout", "sw-infoin");
    if (c.mean) c.mean.classList.remove("sw-infoout", "sw-infoin");
  }

  /* ---------- 一次挥剑 ---------- */
  function startSwing(c, dir, from, to) {
    var isL = dir === "L";
    var nav = isL ? c.navL : c.navR;
    busy = true;
    animId = c.id;
    playSwing(isL);                        // 声音与动画同时起手（同一处触发，天然对齐）

    /* 1) 新词先落到 ghost 上。写完之后 pixel.js 的 observer 会跑 fitWords()，
          把两层的字号各自量准 —— 所以这里不需要自己算字号。 */
    c.ghost.textContent = to.word;

    /* 2) 当前层先还原成旧词；等剑挥过去之后再落定成新词 */
    c.word.textContent = from.word;
    if (c.phon) c.phon.textContent = from.phonetic;
    if (c.mean) c.mean.textContent = from.meaning;

    /* 3) 清掉上一轮的类 + 强制重排，否则同名动画不会重播。
          重排必须落在**真正承载动画的元素**上：早先只对 .card 取 offsetWidth，
          而剑（.nav）在 .card 之外，清类 + 加类可能被合并成「无变化」→ 重播失效。 */
    resetClasses(c);
    void c.word.offsetWidth;
    void c.ghost.offsetWidth;
    if (nav) void nav.offsetWidth;

    if (nav) nav.classList.add(isL ? "swL" : "swR");
    c.word.classList.add(isL ? "awayL" : "awayR");
    c.ghost.classList.add(isL ? "flyL" : "flyR");
    if (c.phon) c.phon.classList.add("sw-infoout");
    if (c.mean) c.mean.classList.add("sw-infoout");

    /* 4) 剑的动画一结束就摘掉类 —— 末帧是 opacity:0 + both 填充，
          不摘的话剑会一直隐身；摘掉后靠 .nav 的 opacity 过渡淡回原位。 */
    if (nav) {
      nav.addEventListener("animationend", function onSwordEnd(e) {
        if (e.target !== nav) return;
        nav.removeEventListener("animationend", onSwordEnd);
        nav.classList.remove("swL", "swR");
      });
    }

    /* 5) 落定。**主时钟是「按 CSS 时长算出来的定时器」**（wdelay + win，
          正好是新词飞入结束那一刻）—— 不把 animationend 当主时钟：
          动画没跑起来时（例如中文模式下 ghost 被 display:none）
          它永远不会触发，落定会被拖到兜底时间，音标释义白白多淡出一秒。
          animationend 只作为「提前完成」的加速信号；settle 幂等，两者都触发也无害。 */
    var settleMs = cssMs("var(--sword-wdelay)") + cssMs("var(--sword-win)");
    var infoMs = cssMs("var(--sword-infoin)");
    var done = false;

    function settle() {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);

      var fin = target[c.id] || to;          // 中途被连点过 → 以最新目标为准
      c.word.textContent = fin.word;
      if (c.phon) c.phon.textContent = fin.phonetic;
      if (c.mean) c.mean.textContent = fin.meaning;
      c.ghost.textContent = "";
      shown[c.id] = fin;
      target[c.id] = fin;
      resetClasses(c);

      /* 音标 / 释义在落定后淡入 */
      if (c.phon) c.phon.classList.add("sw-infoin");
      if (c.mean) c.mean.classList.add("sw-infoin");
      setTimeout(function () {
        if (c.phon) c.phon.classList.remove("sw-infoin");
        if (c.mean) c.mean.classList.remove("sw-infoin");
      }, infoMs + 80);

      busy = false;
      animId = null;
    }

    if (c.ghost) {
      c.ghost.addEventListener("animationend", function onFlyEnd(e) {
        if (e.target !== c.ghost) return;
        c.ghost.removeEventListener("animationend", onFlyEnd);
        settle();                                  // 动画真在跑 → 可以提前一点收
      });
    }
    var settleTimer = setTimeout(settle, settleMs + 30);
  }

  /* ---------- 订阅：当前词变了 ---------- */
  function onChange(c) {
    var id = c.id;
    var cur = snap(c);
    var sh = shown[id] || { word: "", phonetic: "", meaning: "" };
    var idx = idxOf(c);
    var d = (idx !== null && lastIdx[id] !== null && lastIdx[id] !== undefined)
      ? idx - lastIdx[id] : 0;

    if (!isPixel()) { shown[id] = cur; lastIdx[id] = idx; return; }

    if (cur.word === sh.word) {            // 同值 / 我们自己还原回去的 → 忽略
      lastIdx[id] = idx;
      return;
    }
    if (animId === id) { target[id] = cur; lastIdx[id] = idx; return; }  // 本卡正在演
    if (animId) { shown[id] = cur; lastIdx[id] = idx; return; }          // 别的卡在演

    lastIdx[id] = idx;

    /* 正好走一格 → 就是点了一次箭头 → 挥剑。
       其它情况（换轮 / 换批跳一批、切模式、首次进入）都直接切，不演。 */
    if (d === 1 || d === -1) {
      target[id] = cur;
      startSwing(c, d === 1 ? "R" : "L", sh, cur);
    } else {
      shown[id] = cur;
    }
  }

  /* ---------- 装配 ---------- */
  function buildCards() {
    cards = [];
    var list = document.querySelectorAll(".flashcard");
    for (var i = 0; i < list.length; i++) {
      var card = list[i];
      var view = card.closest ? card.closest(".view") : null;
      var word = card.querySelector(".card-word");
      var ghost = card.querySelector(".card-word-ghost");
      if (!view || !word || !ghost) continue;
      var rec = {
        id: view.id,
        view: view,
        card: card,
        word: word,
        ghost: ghost,
        phon: card.querySelector(".card-phonetic"),
        mean: card.querySelector(".card-meaning"),
        navL: view.querySelector(".nav-left"),
        navR: view.querySelector(".nav-right")
      };
      cards.push(rec);
      shown[rec.id] = snap(rec);
      lastIdx[rec.id] = idxOf(rec);
    }
  }

  function watchCards() {
    cards.forEach(function (c) {
      new MutationObserver(function () { onChange(c); }).observe(c.word, {
        childList: true, characterData: true, subtree: true
      });
    });
  }

  function init() {
    if (!document.body) return;
    ensureProbe();
    buildCards();
    watchCards();
    initSoundButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* 调试用慢放（界面不出现入口）：Alt + Shift + S 切换 ×2.4
     460ms 的动效肉眼很难看细节，调手感时全靠它。 */
  window.addEventListener("keydown", function (e) {
    if (!e.altKey || !e.shiftKey) return;
    if (e.key !== "S" && e.key !== "s") return;
    var on = !document.documentElement.classList.contains("sword-slow");
    document.documentElement.classList.toggle("sword-slow", on);
    var t = document.getElementById("toast");
    if (t) {
      t.textContent = on ? "慢放 ×2.4 已开（再按一次关闭）" : "慢放已关";
      t.classList.add("show");
      setTimeout(function () { t.classList.remove("show"); }, 2200);
    }
  });

  /* 调试钩子（无头验证用；正常页面不会调用） */
  window.__sword = {
    slow: function (on) { document.documentElement.classList.toggle("sword-slow", !!on); },
    isSlow: function () { return document.documentElement.classList.contains("sword-slow"); },
    busy: function () { return busy; },
    /* 音效：供无头验证用 OfflineAudioContext 量化（RMS / 谱心） */
    sfx: {
      build: buildSwing,
      play: playSwing,
      isOn: function () { return soundOn; },
      set: function (on) { saveSound(!!on); },
      k: swordK
    },
    cards: function () { return cards.map(function (c) { return c.id; }); },
    state: function () {
      return {
        animId: animId, busy: busy,
        shown: shown, target: target, lastIdx: lastIdx,
        head: (cards[0] && cards[0].word) ? cards[0].word.textContent : null,
        ghost: (cards[0] && cards[0].ghost) ? cards[0].ghost.textContent : null
      };
    },
    /* 直接在某张卡上播一次动画，供无头验证（不依赖 app.js 的进度状态） */
    demo: function (viewId, fromWord, toWord, dir) {
      var c = null;
      for (var i = 0; i < cards.length; i++) { if (cards[i].id === viewId) c = cards[i]; }
      if (!c || busy) return false;
      var from = { word: fromWord, phonetic: "", meaning: "" };
      var to = { word: toWord, phonetic: "", meaning: "" };
      target[c.id] = to;
      shown[c.id] = from;
      startSwing(c, dir || "R", from, to);
      return true;
    }
  };
})();
