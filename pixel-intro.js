/* ============================================================
   xdictionary — 像素风入场动效 · 「凿穿双层」（pixel-intro.js）
   ------------------------------------------------------------
   核心概念：两层世界。像素世界（px-bg）是覆盖在上的**第一层
   表面**，学习界面藏在它底下是**第二层**。入场时：
     0.00–0.12s  舞台上只有第一层表面（六块 clip-path 碎片拼成
                 完整 px-bg，严丝合缝，看不出是拼的）；
     0.12–0.43s  巨型钻石镐立在屏幕左中，绕柄尾支点抡起过顶，
                 从上向下大弧劈至命中点；
     0.43s       命中！震屏 + 闪光 + 碎屑 +「开裂」闷响——表面
                 被凿穿一个洞（洞口塞子被凿飞），洞中露出底下
                 的第二层学习界面，洞缘一圈裂痕 + 八道锯齿缝
                 从洞口向外裂开；
     0.75s       全面碎裂：六块碎片沿裂缝各自向上升起、渐隐——
                 第二层界面逐区块弹到位；
     1.6s 左右   碎片走净，世界如常。
   声音：Web Audio 现场合成——挥镐轻叩 ×2 + 命中重裂 + 表面
   碎裂嗄啦声，读同一个 english_app_sound_v1 开关；起不来就
   静默（能响则响，绝不影响动画）。

   纪律（与 sword.js / intro.js 同款）：
     - 纯表现层：不读写学习进度，不碰 app.js；
     - 零依赖、无音频文件；镐形按用户提供的参考像素画逐格重刻为
       SVG 色块（仅本机使用），裂痕为本项目自绘；
     - 只在 pixel 皮肤被 intro.js 分派调用（window.__pixelIntro.run）；
     - pending 标记的摘除由本模块在动画轨道就位后调用 reveal 完成；
     - 震屏走独立 translate 属性，不碰 #stage 的 transform 缩放。
   ============================================================ */
(function () {
  "use strict";

  var CLEANUP_MS = 2000;   // 播完摘除浮层与 run 标记，之后一切如常

  var LS_SOUND = "english_app_sound_v1";

  function readSound() {
    try { return localStorage.getItem(LS_SOUND) !== "off"; }
    catch (e) { return true; }
  }

  /* ---------- 音效合成 ---------- */
  function makeCtx() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    var ctx;
    try { ctx = new C(); } catch (e) { return null; }
    try { if (ctx.state === "suspended") ctx.resume(); } catch (e) { /* 放弃出声 */ }
    return ctx;
  }
  function noiseBuf(ctx, sec) {
    var n = Math.max(1, Math.floor(ctx.sampleRate * sec));
    var b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  /* 通用「叩/裂」：低通噪声脉冲 + 方波 blip，gain/freq 可调 */
  function buildThock(ctx, dest, t, opts) {
    var o = opts || {};
    var dur = o.dur || 0.08;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf(ctx, dur + 0.04);
    var lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = o.lp || 520;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.10, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp); lp.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.02);

    if (o.sq) {
      var osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = o.sq;
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime((o.gain || 0.10) * 0.5, t + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.7);
      osc.connect(og); og.connect(dest);
      osc.start(t); osc.stop(t + dur);
    }
  }
  function playSounds() {
    if (!readSound()) return;
    var ctx = makeCtx();
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime + 0.06;
      buildThock(ctx, ctx.destination, t0 + 0.14, { gain: 0.05, lp: 900, sq: 220, dur: 0.05 });  // 挥镐轻叩 1
      buildThock(ctx, ctx.destination, t0 + 0.28, { gain: 0.06, lp: 800, sq: 190, dur: 0.05 });  // 挥镐轻叩 2
      buildThock(ctx, ctx.destination, t0 + 0.44, { gain: 0.16, lp: 420, sq: 88,  dur: 0.16 });  // 命中重裂
      buildThock(ctx, ctx.destination, t0 + 0.76, { gain: 0.07, lp: 2600, sq: 0,   dur: 0.14 }); // 表面碎裂嗄啦
      setTimeout(function () { try { ctx.close(); } catch (e) {} }, 2400);
    } catch (e) {
      try { ctx.close(); } catch (e2) { /* 静默 */ }
    }
  }

  /* ---------- 巨型钻石镐 v4（按用户提供的参考像素画逐格重刻） ----------
     16×16 网格逐格转写为 SVG 色块：弯月镐头（深青描边 + 亮青高光 +
     三档青色过渡）+ 斜落木柄（四档棕色）。斜持姿态：镐头在右上、
     柄尾落向左下，凹弧正对命中点，凿下去正合适。 */
  var PICK_SVG =
    '<svg viewBox="0 0 16 16" width="480" height="480" aria-hidden="true" focusable="false" ' +
    'xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">' +
      /* 镐头：拱顶描边 → 亮青高光 → 三档青色 → 右尖下探 */
      '<rect x="6"   y="2"  width="5" height="1" fill="#0E3F36"/>' +
      '<rect x="5"   y="3"  width="1" height="1" fill="#0E3F36"/>' +
      '<rect x="6"   y="3"  width="1" height="1" fill="#33EBCB"/>' +
      '<rect x="7"   y="3"  width="1" height="1" fill="#2BC7AC"/>' +
      '<rect x="8"   y="3"  width="2" height="1" fill="#27B29A"/>' +
      '<rect x="10"  y="3"  width="1" height="1" fill="#2BC7AC"/>' +
      '<rect x="11"  y="3"  width="1" height="1" fill="#0E3F36"/>' +
      '<rect x="6"   y="4"  width="1" height="1" fill="#0E3F36"/>' +
      '<rect x="7"   y="4"  width="3" height="1" fill="#082520"/>' +
      '<rect x="10"  y="4"  width="2" height="1" fill="#27B29A"/>' +
      '<rect x="11"  y="5"  width="1" height="1" fill="#2BC7AC"/>' +
      '<rect x="12"  y="5"  width="1" height="1" fill="#27B29A"/>' +
      '<rect x="13"  y="5"  width="1" height="1" fill="#082520"/>' +
      '<rect x="12"  y="6"  width="1" height="1" fill="#27B29A"/>' +
      '<rect x="13"  y="6"  width="1" height="1" fill="#2BC7AC"/>' +
      '<rect x="14"  y="6"  width="1" height="1" fill="#082520"/>' +
      '<rect x="12"  y="7"  width="1" height="1" fill="#082520"/>' +
      '<rect x="13"  y="7"  width="1" height="1" fill="#27B29A"/>' +
      '<rect x="14"  y="7"  width="1" height="1" fill="#082520"/>' +
      '<rect x="12"  y="8"  width="1" height="1" fill="#082520"/>' +
      '<rect x="13"  y="8"  width="1" height="1" fill="#27B29A"/>' +
      '<rect x="14"  y="8"  width="1" height="1" fill="#082520"/>' +
      '<rect x="12"  y="9"  width="1" height="1" fill="#082520"/>' +
      '<rect x="13"  y="9"  width="1" height="1" fill="#2BC7AC"/>' +
      '<rect x="14"  y="9"  width="1" height="1" fill="#082520"/>' +
      '<rect x="12"  y="10" width="1" height="1" fill="#082520"/>' +
      '<rect x="13"  y="10" width="1" height="1" fill="#33EBCB"/>' +
      '<rect x="14"  y="10" width="1" height="1" fill="#082520"/>' +
      '<rect x="13"  y="11" width="1" height="1" fill="#082520"/>' +
      /* 木柄：自镐头（右上）斜落至柄尾（左下），亮/中/暗三档相间 */
      '<rect x="12"  y="3"  width="1" height="1" fill="#493615"/>' +
      '<rect x="13"  y="3"  width="1" height="1" fill="#684E1E"/>' +
      '<rect x="12"  y="4"  width="1" height="1" fill="#896727"/>' +
      '<rect x="13"  y="4"  width="1" height="1" fill="#281E0B"/>' +
      '<rect x="10"  y="5"  width="1" height="1" fill="#493615"/>' +
      '<rect x="9"   y="6"  width="1" height="1" fill="#493615"/>' +
      '<rect x="10"  y="6"  width="1" height="1" fill="#684E1E"/>' +
      '<rect x="11"  y="6"  width="1" height="1" fill="#281E0B"/>' +
      '<rect x="8"   y="7"  width="1" height="1" fill="#493615"/>' +
      '<rect x="9"   y="7"  width="1" height="1" fill="#896727"/>' +
      '<rect x="10"  y="7"  width="1" height="1" fill="#281E0B"/>' +
      '<rect x="7"   y="8"  width="1" height="1" fill="#493615"/>' +
      '<rect x="8"   y="8"  width="1" height="1" fill="#684E1E"/>' +
      '<rect x="9"   y="8"  width="1" height="1" fill="#281E0B"/>' +
      '<rect x="6"   y="9"  width="1" height="1" fill="#493615"/>' +
      '<rect x="7"   y="9"  width="1" height="1" fill="#896727"/>' +
      '<rect x="8"   y="9"  width="1" height="1" fill="#281E0B"/>' +
      '<rect x="5"   y="10" width="1" height="1" fill="#493615"/>' +
      '<rect x="6"   y="10" width="1" height="1" fill="#684E1E"/>' +
      '<rect x="7"   y="10" width="1" height="1" fill="#281E0B"/>' +
      '<rect x="4"   y="11" width="1" height="1" fill="#493615"/>' +
      '<rect x="5"   y="11" width="1" height="1" fill="#896727"/>' +
      '<rect x="6"   y="11" width="1" height="1" fill="#281E0B"/>' +
      '<rect x="3"   y="12" width="1" height="1" fill="#493615"/>' +
      '<rect x="4"   y="12" width="1" height="1" fill="#684E1E"/>' +
      '<rect x="5"   y="12" width="1" height="1" fill="#281E0B"/>' +
      '<rect x="2"   y="13" width="1" height="1" fill="#493615"/>' +
      '<rect x="3"   y="13" width="1" height="1" fill="#896727"/>' +
      '<rect x="4"   y="13" width="1" height="1" fill="#281E0B"/>' +
      '<rect x="2"   y="14" width="2" height="1" fill="#281E0B"/>' +
    '</svg>';

  /* ---------- 第一层表面：六块碎片拼出完整 px-bg（裂好后各自飞走） ----------
     多边形以命中点 (470,600) 为中心放射切分，静止时严丝合缝；
     洞口由 CSS mask 在每块碎片上统一凿出（见 style.css）。 */
  var L1_SHARDS = [
    { clip: "polygon(0px 0px, 1440px 0px, 470px 600px)",                              dx: -40,  dy: -260, d: 0.75 },
    { clip: "polygon(1440px 0px, 1440px 760px, 470px 600px)",                         dx: 90,   dy: -200, d: 0.81 },
    { clip: "polygon(1440px 760px, 1440px 1200px, 980px 1200px, 470px 600px)",        dx: 110,  dy: -160, d: 0.87 },
    { clip: "polygon(980px 1200px, 420px 1200px, 470px 600px)",                       dx: -10,  dy: -240, d: 0.93 },
    { clip: "polygon(420px 1200px, 0px 1200px, 0px 820px, 470px 600px)",              dx: -90,  dy: -180, d: 0.99 },
    { clip: "polygon(0px 820px, 0px 0px, 470px 600px)",                               dx: -110, dy: -220, d: 1.05 }
  ];

  /* ---------- 凿穿的洞：命中点击穿表面，洞中露出第二层 ----------
     洞缘 = 锯齿八边形（圆心即命中点）。三块「塞子」补片在命中前
     无缝补住洞口（与表面同一张 px-bg，外缘外推 6px 压住接缝），
     命中时被凿飞，洞口就此敞开。顶点同时供裂痕描线使用。 */
  var HOLE_PTS = [
    [620, 610], [576, 716], [464, 756], [352, 712],
    [312, 592], [362, 490], [478, 442], [586, 496]
  ];
  function ringD(pts) {
    return pts.map(function (p, i) {
      return (i ? "L" : "M") + p[0] + " " + p[1];
    }).join("") + "Z";
  }
  function plugOut(p, px) {
    var dx = p[0] - 470, dy = p[1] - 600, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var k = (len + px) / len;
    return [Math.round(470 + dx * k), Math.round(600 + dy * k)];
  }
  var PLUG_FRAGS = [
    { idx: [6, 7, 0, 1], dx: 64,  dy: -52, d: 0.43 },   /* 右上扇块：向上凿飞 */
    { idx: [1, 2, 3, 4], dx: 10,  dy: 64,  d: 0.45 },   /* 下扇块：被凿落坠走 */
    { idx: [4, 5, 6],    dx: -60, dy: -48, d: 0.47 }    /* 左上扇块：向上掀飞 */
  ];
  function plugHtml() {
    return PLUG_FRAGS.map(function (f) {
      var pts = f.idx.map(function (i) { return plugOut(HOLE_PTS[i], 6); });
      var clip = "polygon(470px 600px," + pts.map(function (p) {
        return p[0] + "px " + p[1] + "px";
      }).join(",") + ")";
      return '<div class="px-intro-plug" style="clip-path:' + clip +
        ';-webkit-clip-path:' + clip + ';--dx:' + f.dx + 'px;--dy:' + f.dy + 'px;--d:' + f.d + 's"></div>';
    }).join("");
  }

  function l1Html() {
    return L1_SHARDS.map(function (s, i) {
      return '<div class="px-intro-l1" style="clip-path:' + s.clip + ';' +
        '-webkit-clip-path:' + s.clip + ';--sx:' + s.dx + 'px;--sy:' + s.dy + 'px;--d:' + s.d + 's"></div>';
    }).join("");
  }

  /* ---------- 裂痕：洞缘一圈 + 八道锯齿缝从洞口向外裂开 ---------- */
  var CRACK_SVG =
    '<svg class="px-intro-crack" viewBox="0 0 1440 1200" aria-hidden="true" focusable="false" ' +
    'xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">' +
      '<path class="c-main" d="M620 610 L714 640 L706 706 L806 756" pathLength="1"/>' +
      '<path class="c-lite" d="M620 610 L714 640 L706 706 L806 756" pathLength="1"/>' +
      '<path class="c-main" d="M586 496 L642 434 L632 366 L692 316" pathLength="1"/>' +
      '<path class="c-lite" d="M586 496 L642 434 L632 366 L692 316" pathLength="1"/>' +
      '<path class="c-main" d="M478 442 L482 358 L458 292 L486 224" pathLength="1"/>' +
      '<path class="c-main" d="M362 490 L306 428 L318 360 L262 306" pathLength="1"/>' +
      '<path class="c-main" d="M312 592 L216 570 L150 596 L90 570"  pathLength="1"/>' +
      '<path class="c-main" d="M352 712 L300 782 L308 856 L250 908" pathLength="1"/>' +
      '<path class="c-main" d="M464 756 L448 846 L470 920 L444 990" pathLength="1"/>' +
      '<path class="c-main" d="M576 716 L612 800 L596 872 L640 940" pathLength="1"/>' +
      '<path class="c-ring" d="' + ringD(HOLE_PTS) + '" pathLength="1"/>' +
    '</svg>';

  function buildFx() {
    var fx = document.createElement("div");
    fx.className = "px-intro-fx";
    fx.setAttribute("aria-hidden", "true");
    fx.innerHTML =
      l1Html() +          /* 第一层表面（最底，盖住第二层界面） */
      plugHtml() +        /* 洞口塞子（命中前补住洞口，命中时凿飞） */
      CRACK_SVG +         /* 裂痕画在表面上 */
      '<div class="px-intro-pick">' + PICK_SVG + '</div>' +
      '<div class="px-intro-flash"></div>' +
      '<div class="px-intro-debris" style="--dx:-70px;  --dy:-46px"></div>' +
      '<div class="px-intro-debris" style="--dx:64px;   --dy:-58px"></div>' +
      '<div class="px-intro-debris" style="--dx:-110px; --dy:-12px"></div>' +
      '<div class="px-intro-debris" style="--dx:108px;  --dy:-20px"></div>' +
      '<div class="px-intro-debris" style="--dx:-46px;  --dy:34px"></div>' +
      '<div class="px-intro-debris" style="--dx:52px;   --dy:30px"></div>';
    var stage = document.getElementById("stage") || document.body;
    stage.appendChild(fx);          /* 挂进舞台：坐标走 1440×1200 缩放坐标系 */
    return fx;
  }

  /* ---------- 入口：intro.js 在 pixel 皮肤下调用 ----------
     reveal：摘除 head 打的 data-intro-pending（第二层界面此时还
     藏着，本模块先把第一层表面与动画轨道搭好，再无缝交接）。 */
  function run(reveal) {
    var root = document.documentElement;
    var fx;
    try { fx = buildFx(); } catch (e) { reveal(); return; }
    playSounds();
    root.setAttribute("data-px-intro-run", "");
    reveal();
    setTimeout(function () {
      if (fx && fx.parentNode) fx.parentNode.removeChild(fx);
      root.removeAttribute("data-px-intro-run");
    }, CLEANUP_MS);
  }

  window.__pixelIntro = { run: run };
})();
