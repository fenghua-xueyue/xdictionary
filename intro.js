/* ============================================================
   xdictionary — 入场动效模块（intro.js）
   ------------------------------------------------------------
   两处入口，同一套视觉语汇：
     ① 页面入场：从首页点「开始背单词 / 继续学习」跳进学习页，
        一片叶子（薄荷=绿叶 / 暖阳=枫叶）被风推着从右上扫向左下，
        顶栏与学习界面各区块沿风的行进方向错峰浮现。
     ② 换肤入场：在学习页选皮肤后，新皮肤从按钮位置「铺开」——
        一团该皮肤的主色光晕扩散到整页 + 同一片叶子掠过 +
        界面各区块轻巧地重新落位。换肤是「换一个世界」，所以要有
        一段入场，而不是配色瞬间跳变。

   纪律（与 app.js 的动效守卫同款）：
     - 纯表现层：不读写学习进度，不碰 app.js 的任何状态；
     - 零依赖、无音频文件：风声 Web Audio 现场合成（仅页面入场）；
     - 颜色全走 CSS 变量（--intro-leaf / --intro-vein / --intro-wind /
       --intro-bloom，由 style.css 的 :root 与暖阳块提供），
       皮肤自己决定叶子长什么样；
     - prefers-reduced-motion: reduce → 不播任何动画，内容直接呈现；
     - 保险丝：页面入场靠 head 里的前置标记（data-intro-pending）先藏内容，
       本模块一旦出异常，CSS 熔断（约 2.4s）会把内容放回来；
       换肤入场只在已渲染的页面上叠一层浮层，异常时浮层移除即恢复。

   时长真相在 style.css「入场动效」区块：叶片 900ms，浮现最晚 1.12s 收尾；
   换肤入场总长约 1.2s（光晕 0.9s + 落位 0.38s 错峰）。
   ============================================================ */
(function () {
  "use strict";

  var CLEANUP_MS = 1700;      // 页面入场：播完清理
  var SWITCH_MS = 2050;       // 换肤入场：叶子 1.65s + 起步 .22s，余量收尾

  var root = document.documentElement;
  var skinAtLoad = root.getAttribute("data-skin") || "mint";

  function reveal() { root.removeAttribute("data-intro-pending"); }
  function isReduce() {
    return !!(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* ---------- 风声（能响则响） ----------
     跳转后是全新页面，浏览器可能仍要求手势才放行声音；
     AudioContext 起不来就静默放弃，绝不影响入场动画。
     合成思路：噪声 → 低通自上而下扫频（风从紧到松）→ 包络慢起慢落，
     声像跟着叶子一起从右滑向左。参数自成一版。 */
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

  /* ---------- 叶片 / 风线的图形 ----------
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
  var WIND_SVG =
    '<svg viewBox="0 0 120 44" width="100%" aria-hidden="true" focusable="false">' +
      '<path fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" d="M4 32 Q 58 4 116 24"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".7" d="M30 40 Q 74 22 112 36"/>' +
    '</svg>';

  function leafSvg(skinId) { return skinId === "warm" ? MAPLE_SVG : LEAF_SVG; }

  /* 飞行轨迹按当前视口现算：右上出屏 → 弧线掠过面板区 → 左下入屏 */
  function leafPathD() {
    var w = window.innerWidth || 1280;
    var h = window.innerHeight || 800;
    return "M " + (w * 1.08).toFixed(0) + " " + (-h * 0.08).toFixed(0) +
           " Q " + (w * 0.52).toFixed(0) + " " + (h * 0.40).toFixed(0) +
           ", " + (-w * 0.12).toFixed(0) + " " + (h * 1.08).toFixed(0);
  }

  /* 换肤用的轨迹：沿右侧留白自上而下掠过，不经过卡片区。
     页面入场时内容是藏着的，叶子可以从中间横穿；换肤时内容一直在，
     从正中扫过去会把单词挡住 —— 所以贴着右边缘走，只当侧景。 */
  function switchPathD() {
    var w = window.innerWidth || 1280;
    var h = window.innerHeight || 800;
    return "M " + (w * 1.06).toFixed(0) + " " + (-h * 0.06).toFixed(0) +
           " Q " + (w * 0.93).toFixed(0) + " " + (h * 0.42).toFixed(0) +
           ", " + (w * 0.76).toFixed(0) + " " + (h * 1.06).toFixed(0);
  }

  function makeLeaf(skinId, size, pathD) {
    var leaf = document.createElement("div");
    leaf.className = "intro-leaf";
    /* 三层嵌套：外层沿轨迹飞（offset-path）→ 中层翻转（rotateY）+
       由小到大再变小（九宫格中格 ≈ 视口短边的 1/3 为满格）→
       内层全程自转翻滚 */
    leaf.innerHTML = '<div class="intro-leaf-flip"><div class="intro-leaf-spin">' + leafSvg(skinId) + '</div></div>';
    leaf.style.offsetPath = 'path("' + (pathD || leafPathD()) + '")';
    leaf.style.width = size + "px";
    leaf.style.height = size + "px";
    return leaf;
  }

  /* ---------- ① 页面入场 ---------- */
  function buildFx(skinId) {
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
    debris1.innerHTML = leafSvg(skinId);
    var debris2 = document.createElement("div");
    debris2.className = "intro-debris d2";
    debris2.innerHTML = leafSvg(skinId);

    fx.appendChild(wind1); fx.appendChild(wind2);
    fx.appendChild(debris1); fx.appendChild(debris2);
    fx.appendChild(makeLeaf(skinId, Math.max(120, Math.round(Math.min(w, h) / 3))));
    document.body.appendChild(fx);
    return fx;
  }

  /* ---------- ② 换肤入场 ----------
     光晕从按钮中心扩散（新皮肤的主色），叶子同一时刻掠过，
     界面各区块随后错峰落位（.skin-run）。
     返工也安全：上一次没播完就再切一次，先清干净再重来。 */
  var switchTimer = null;

  function playSwitch(skinId, originEl) {
    if (isReduce()) return;
    if (switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
    var stale = document.querySelectorAll(".skin-fx");
    Array.prototype.forEach.call(stale, function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    root.classList.remove("skin-run");

    var w = window.innerWidth || 1280;
    var h = window.innerHeight || 800;

    var fx = document.createElement("div");
    fx.className = "skin-fx";
    fx.setAttribute("aria-hidden", "true");

    // 光晕：以按钮中心为圆心铺开（skin.js 传的是量好的矩形快照，
    // 因为浮层列表重绘后那颗按钮已经不在文档里了）
    var bx = 50, by = 50;
    var r = originEl;
    if (r && typeof r.getBoundingClientRect === "function") r = r.getBoundingClientRect();
    if (r && typeof r.left === "number" && (r.width || r.height)) {
      bx = ((r.left + r.width / 2) / w * 100).toFixed(2);
      by = ((r.top + r.height / 2) / h * 100).toFixed(2);
    }
    var bloom = document.createElement("span");
    bloom.className = "skin-bloom";
    bloom.style.setProperty("--bx", bx + "%");
    bloom.style.setProperty("--by", by + "%");
    fx.appendChild(bloom);

    // 风线 ×2：比页面入场更轻，只作陪衬
    var wind1 = document.createElement("div");
    wind1.className = "intro-wind w1";
    wind1.innerHTML = WIND_SVG;
    var wind2 = document.createElement("div");
    wind2.className = "intro-wind w2";
    wind2.innerHTML = WIND_SVG;
    fx.appendChild(wind1); fx.appendChild(wind2);

    fx.appendChild(makeLeaf(skinId, Math.max(96, Math.round(Math.min(w, h) / 4.4)), switchPathD()));
    document.body.appendChild(fx);

    // 同一同步块里挂类：落位动画的 from 态立即接住，不闪帧
    root.classList.add("skin-run");

    switchTimer = setTimeout(function () {
      switchTimer = null;
      if (fx.parentNode) fx.parentNode.removeChild(fx);
      root.classList.remove("skin-run");
    }, SWITCH_MS);
  }

  /* ---------- 页面入场启动 ----------
     先摘 pending 标记、再挂 intro-run 类：同一同步块内完成，
     动画的 from 态（opacity 0）无缝接住隐藏态，不会闪帧。 */
  function start() {
    if (isReduce()) { reveal(); return; }         // 减动效：内容直接呈现
    if (skinAtLoad !== "mint" && skinAtLoad !== "warm") { reveal(); return; }
    reveal();
    var fx;
    try { fx = buildFx(skinAtLoad); } catch (e) { return; }
    playGust();
    root.classList.add("intro-run");
    setTimeout(function () {
      if (fx && fx.parentNode) fx.parentNode.removeChild(fx);
      root.classList.remove("intro-run");
    }, CLEANUP_MS);
  }

  /* 换肤：skin.js 发事件，这里接手。事件里带新皮肤 id 与被点的按钮。 */
  document.addEventListener("xd:skin-change", function (e) {
    var d = (e && e.detail) || {};
    if (!d.to) return;
    playSwitch(d.to, d.origin || null);
  });

  window.__intro = { playSwitch: playSwitch, start: start };

  start();
})();
