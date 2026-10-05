/* speak.js —— 单词发音（TTS 点读）
   技术：浏览器原生 speechSynthesis（零依赖、断网可用、file:// 可用）。
   解耦：不依赖 app.js 的任何内部状态 —— 当前词从激活视图的 .card-word 读取；
        不读写任何 localStorage key；不改动学习 / 复习逻辑。
   语音选择：只挑 lang 以 en 开头的语音，优先 en-US（本机为 Microsoft Zira）；
        无英文语音时降级提示（复用 #toast 节点，写法同 app.js）。
   播放态：.card-speaker.active（颜色走 CSS 变量，三款皮肤自动适配）。
*/
(function () {
  "use strict";

  var RATE = 0.9;   // 略慢，利于跟读
  var PITCH = 1;

  var enVoice = null;  // 选定的英文语音（找不到则为 null → 点击给降级提示）
  var btn = null;      // 当前正在播放的喇叭按钮

  /* ---------- 语音收集与选择 ---------- */
  function refreshVoices() {
    var list = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    var en = [];
    for (var i = 0; i < list.length; i++) {
      if (/^en/i.test(list[i].lang || "")) en.push(list[i]);
    }
    if (!en.length) { enVoice = null; return; }
    en.sort(function (a, b) { return voiceRank(a) - voiceRank(b); });
    enVoice = en[0];
  }

  // 优先级：en-US < en-GB < 其他 en（数字小者优先）
  function voiceRank(v) {
    var lang = (v.lang || "").toLowerCase();
    if (lang === "en-us") return 0;
    if (lang === "en-gb") return 10;
    return 20;
  }

  /* ---------- 当前词：从激活视图读 DOM（与 app.js 状态解耦） ---------- */
  function currentWord() {
    var view = document.querySelector(".view-active");
    if (!view) return "";
    var el = view.querySelector(".card-word");
    return el ? (el.textContent || "").trim() : "";
  }

  /* ---------- speak / cancel ---------- */
  function speak() {
    var word = currentWord();
    if (!word || !enVoice) return;
    cancel(); // 防连点叠音
    try {
      var u = new SpeechSynthesisUtterance(word);
      u.lang = enVoice.lang;
      u.rate = RATE;
      u.pitch = PITCH;
      u.onstart = function () { setPlaying(true); };
      u.onend = function () { setPlaying(false); };
      u.onerror = function () { setPlaying(false); };
      try { u.voice = enVoice; } catch (e) { /* 语音对象异常（极端/受限环境）时退回默认语音 */ }
      speechSynthesis.speak(u);
    } catch (e) {
      setPlaying(false); // 极端情况（语音对象异常等）不留播放态、不阻断翻页
    }
  }

  function cancel() {
    try { speechSynthesis.cancel(); } catch (e) {}
    setPlaying(false);
  }

  function setPlaying(on) {
    if (!btn) return;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /* ---------- 按钮绑定（学习页 + 复习页各一个，行为一致） ---------- */
  function bind() {
    var btns = document.querySelectorAll(".card-speaker");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute("data-speak-bound")) continue;
      b.setAttribute("data-speak-bound", "1");
      b.addEventListener("click", function () {
        if (!window.speechSynthesis) { toast("此浏览器不支持语音合成"); return; }
        if (!enVoice) { toast("未找到英文语音：请在系统设置里安装英文语音包"); return; }
        btn = this;
        speak();
      });
    }
  }

  /* ---------- 轻提示（复用 #toast 节点，写法同 app.js） ---------- */
  var toastTimer;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  /* ---------- 启动 ---------- */
  function init() {
    if (!window.speechSynthesis) return; // 浏览器不支持 → 喇叭保持原样（无提示可给）
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
    setTimeout(refreshVoices, 1500); // 兜底：个别情况下 voiceschanged 不触发
    bind();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
