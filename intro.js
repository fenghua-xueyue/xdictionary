/* ============================================================
   xdictionary — 入场动效模块（intro.js）
   ------------------------------------------------------------
   从首页点「开始背单词 / 继续学习」跳进学习页时：
   一片叶子（薄荷=绿叶 / 暖阳=秋叶）被风推着从右上扫向左下，
   顶栏与学习界面的各区块沿风的行进方向错峰浮现。

   纪律（与 sword.js 同款）：
     - 纯表现层：不读写学习进度，不碰 app.js 的任何状态；
     - 零依赖、无音频文件：风声 Web Audio 现场合成；
     - 皮肤门控：只有 mint / warm 播放（叶片颜色走 CSS 变量
       --intro-leaf / --intro-vein / --intro-wind，由 style.css
       的 :root 与暖阳块提供）；像素皮肤完全不建 DOM；
     - prefers-reduced-motion: reduce → 不播任何动画，内容直接呈现；
     - 保险丝：head 里的前置标记（data-intro-pending）负责先藏内容，
       本模块一旦出异常，CSS 熔断（约 2.4s）也会把内容放回来，
       绝不出现「卡在空屏」。

   时长真相在 style.css「入场动效」区块：叶片 900ms，浮现最晚 1.12s 收尾。
   ============================================================ */
(function () {
  "use strict";

  var INTRO_SKINS = { mint: true, warm: true };
  var CLEANUP_MS = 1700;   // 播完清理：摘掉浮层与 intro-run 类，之后视图切换不再受影响

  var root = document.documentElement;
  var skin = root.getAttribute("data-skin") || "mint";

  function reveal() { root.removeAttribute("data-intro-pending"); }
  function isReduce() {
    return !!(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* ---------- 风声（能响则响） ----------
     跳转后是全新页面，浏览器可能仍要求手势才放行声音；
     AudioContext 起不来就静默放弃，绝不影响入场动画。
     合成思路：噪声 → 低通自上而下扫频（风从紧到松）→ 包络慢起慢落，
     声像跟着叶子一起从右滑向左。参数自成一版，与挥剑音互不相干。 */
  function readSound() {
    try { return localStorage.getItem("english_app_sound_v1") !== "off"; }
    catch (e) { return true; }
  }
  function playGust() {
    if (!readSound()) return;
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    var ctx;
    try { ctx = new C(); } catch (e) { return; }
    try { if (ctx.state === "suspended") ctx.resume(); } catch (e) { /* 放弃出声 */ }
    try {
      var t0 = ctx.currentTime + 0.03;
      var dur = 0.8;

      var n = Math.max(1, Math.floor(ctx.sampleRate * (dur + 0.05)));
      var buf = ctx.createBuffer(1, n, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

      var src = ctx.createBufferSource();
      src.buffer = buf;

      var lp = ctx.createBiquadFilter();          // 风箱：低通往下扫
      lp.type = "lowpass";
      lp.Q.value = 0.7;
      lp.frequency.setValueAtTime(1100, t0);
      lp.frequency.exponentialRampToValueAtTime(320, t0 + dur);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.10);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      var pan = null;
      if (ctx.createStereoPanner) {               // 声像：右 → 左
        pan = ctx.createStereoPanner();
        pan.pan.setValueAtTime(0.45, t0);
        pan.pan.linearRampToValueAtTime(-0.45, t0 + dur);
      }

      src.connect(lp); lp.connect(g);
      if (pan) { g.connect(pan); pan.connect(ctx.destination); }
      else { g.connect(ctx.destination); }
      src.start(t0); src.stop(t0 + dur + 0.02);

      setTimeout(function () { try { ctx.close(); } catch (e) {} }, 1400);
    } catch (e) {
      try { ctx.close(); } catch (e2) { /* 静默 */ }
    }
  }

  /* ---------- 叶片 / 风线的 DOM ----------
     颜色全部走 CSS 变量（fill/stroke 直接引用），皮肤换色自动生效。
     薄荷 = 简约圆叶；暖阳 = 枫叶（🍁 同款剪影）。 */
  var LEAF_SVG =
    '<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">' +
      '<path fill="var(--intro-leaf)" d="M52 10 C30 10 12 28 11 55 C36 53 54 36 54 12 Z"/>' +
      '<path fill="none" stroke="var(--intro-vein)" stroke-width="2.4" stroke-linecap="round" d="M16 50 C24 38 36 24 48 16"/>' +
      '<path fill="none" stroke="var(--intro-vein)" stroke-width="2" stroke-linecap="round" d="M12 54 C10 58 7 60 4 61"/>' +
    '</svg>';
  /* 枫叶路径取自 Material Design Icons 的 leaf-maple
     （Pictogrammers Free License，可自由使用），24×24，自带叶柄。 */
  var MAPLE_SVG =
    '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">' +
      '<path fill="var(--intro-leaf)" d="M21.79 13L16 16l1 2l-4-.75V21h-2v-3.75L7 18l1-2l-5.79-3l1-1.73L1.61 8l3.6-.23l1-1.77l3.42 3.9L8 5h2l2-3l2 3h2l-1.63 4.9L17.79 6l1 1.73l3.6.23l-1.6 3.23z"/>' +
    '</svg>';

  function leafSvg() { return skin === "warm" ? MAPLE_SVG : LEAF_SVG; }
  var WIND_SVG =
    '<svg viewBox="0 0 120 44" width="100%" aria-hidden="true" focusable="false">' +
      '<path fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" d="M4 32 Q 58 4 116 24"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".7" d="M30 40 Q 74 22 112 36"/>' +
    '</svg>';

  /* 飞行轨迹按当前视口现算：右上出屏 → 弧线掠过面板区 → 左下入屏 */
  function leafPathD() {
    var w = window.innerWidth || 1280;
    var h = window.innerHeight || 800;
    return "M " + (w * 1.08).toFixed(0) + " " + (-h * 0.08).toFixed(0) +
           " Q " + (w * 0.52).toFixed(0) + " " + (h * 0.40).toFixed(0) +
           ", " + (-w * 0.12).toFixed(0) + " " + (h * 1.08).toFixed(0);
  }

  function buildFx() {
    var w = window.innerWidth || 1280;
    var h = window.innerHeight || 800;
    var fx = document.createElement("div");
    fx.className = "intro-fx";
    fx.setAttribute("aria-hidden", "true");

    var wind1 = document.createElement("div");
    wind1.className = "intro-wind w1";
    wind1.innerHTML = WIND_SVG;
    var wind2 = document.createElement("div");
    wind2.className = "intro-wind w2";
    wind2.innerHTML = WIND_SVG;

    var debris1 = document.createElement("div");
    debris1.className = "intro-debris d1";
    debris1.innerHTML = leafSvg();
    var debris2 = document.createElement("div");
    debris2.className = "intro-debris d2";
    debris2.innerHTML = leafSvg();

    var leaf = document.createElement("div");
    leaf.className = "intro-leaf";
    /* 三层嵌套：外层沿轨迹飞（offset-path）→ 中层翻转（rotateY）+
       由小到大再变小（九宫格中格 ≈ 视口短边的 1/3 为满格）→
       内层全程自转翻滚 */
    leaf.innerHTML = '<div class="intro-leaf-flip"><div class="intro-leaf-spin">' + leafSvg() + '</div></div>';
    leaf.style.offsetPath = 'path("' + leafPathD() + '")';
    var s = Math.max(120, Math.round(Math.min(w, h) / 3));   // 中央满格尺寸
    leaf.style.width = s + "px";
    leaf.style.height = s + "px";

    fx.appendChild(wind1); fx.appendChild(wind2);
    fx.appendChild(debris1); fx.appendChild(debris2);
    fx.appendChild(leaf);
    document.body.appendChild(fx);
    return fx;
  }

  /* ---------- 启动 ----------
     按皮肤分派：pixel → pixel-intro.js 的方块入场；
     mint / warm → 叶片入场（先摘 pending 标记、再挂 intro-run 类：
     同一同步块内完成，动画的 from 态（opacity 0）无缝接住隐藏态，
     不会闪帧）。 */
  function start() {
    if (isReduce()) { reveal(); return; }   // 减动效：内容直接呈现，什么都不播
    if (skin === "pixel") {
      if (window.__pixelIntro) {
        try { window.__pixelIntro.run(reveal); return; }
        catch (e) { reveal(); }             // 像素入场出问题 → 立即放行内容
      }
      reveal();
      return;
    }
    if (!INTRO_SKINS[skin]) { reveal(); return; }   // 双保险（head 里已 gate 一次）
    reveal();
    var fx;
    try { fx = buildFx(); } catch (e) { return; }
    playGust();
    root.classList.add("intro-run");
    setTimeout(function () {
      if (fx && fx.parentNode) fx.parentNode.removeChild(fx);
      root.classList.remove("intro-run");
    }, CLEANUP_MS);
  }

  start();
})();
