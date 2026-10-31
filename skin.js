/* ============================================================
   xdictionary — 皮肤模块
   ------------------------------------------------------------
   换皮肤的原理：皮肤 = 一组 CSS 变量覆盖（见 style.css 末尾
   「皮肤定义」区块）。本模块只做三件事：
     1) 把 <html data-skin="id"> 设对 → CSS 自动换色
     2) 把选择记在 localStorage（独立 key，不影响学习进度）
     3) 渲染顶栏的皮肤按钮 + 选择浮层
   皮肤本身长什么样**不在本文件**，在 style.css。

   新增一款皮肤：
     ① style.css 末尾加一段  html[data-skin="<id>"] { --xxx: ...; }
     ② 下面 SKINS 数组里加一行 { id, name, desc, swatch }
   其它代码一行都不用改。
   ============================================================ */
(function () {
  "use strict";

  /* ---------- 皮肤登记表 ----------
     命名按「四季」排：春 / 秋（未做的 夏 / 冬 以后在这里加一行即可）。
     id 仍保留 mint / warm —— 它是存档里的值和 CSS 选择器，改名会让老用户的
     选择丢失，也让 style.css 几十处 data-skin 覆写全部失配；名字只影响展示。 */
  var SKINS = [
    {
      id: "mint",
      name: "春",
      desc: "默认 · 初春新绿",
      swatch: ["#F5F7F3", "#FFFFFF", "#2E9E78"]
    },
    {
      id: "warm",
      name: "秋",
      desc: "暖色 · 秋叶护眼",
      swatch: ["#FAF3E7", "#FFFDF8", "#AE5526"]
    }
  ];

  var DEFAULT_SKIN = "mint";

  /* 皮肤选择的存档 key：与学习进度 english_app_v1 分开，
     这样「↺ 重置」只清进度，不会把皮肤选择一起清掉。 */
  var LS_SKIN = "english_app_skin_v1";

  var byId = {};
  SKINS.forEach(function (s) { byId[s.id] = s; });

  function normalize(id) {
    return (id && byId[id]) ? id : DEFAULT_SKIN;
  }

  /* ---------- 读取 / 应用 / 保存 ---------- */
  function readSkin() {
    var raw = "";
    try { raw = localStorage.getItem(LS_SKIN) || ""; } catch (e) { return DEFAULT_SKIN; }
    var id2 = normalize(raw);
    /* 存档里可能是已经下线的皮肤 id（或手工写坏的值）：
       静默改写回默认，免得每次读都要兜一次底。 */
    if (raw && raw !== id2) {
      try { localStorage.setItem(LS_SKIN, id2); } catch (e) { /* 忽略 */ }
    }
    return id2;
  }

  function applySkin(id) {
    var id2 = normalize(id);
    document.documentElement.setAttribute("data-skin", id2);
    return id2;
  }

  function saveSkin(id) {
    var id2 = normalize(id);
    applySkin(id2);
    try { localStorage.setItem(LS_SKIN, id2); } catch (e) { /* 忽略 */ }
    return id2;
  }

  /* ---------- 轻提示（与 app.js 的 toast 同一套 DOM，互相不冲突） ---------- */
  var toastTimer;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  /* ---------- 渲染皮肤列表 ---------- */
  function renderList(box, currentId) {
    box.innerHTML = "";
    SKINS.forEach(function (s) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "skin-item" + (s.id === currentId ? " active" : "");
      item.setAttribute("data-skin-id", s.id);
      item.setAttribute("aria-pressed", s.id === currentId ? "true" : "false");

      var sw = document.createElement("span");
      sw.className = "skin-swatch";
      sw.setAttribute("aria-hidden", "true");
      // 三段竖条：页面底 / 卡面 / 主色
      s.swatch.forEach(function (c) {
        var i = document.createElement("i");
        i.style.background = c;
        sw.appendChild(i);
      });

      var txt = document.createElement("span");
      txt.className = "skin-item-text";
      var nm = document.createElement("span");
      nm.className = "skin-item-name";
      nm.textContent = s.name;
      var ds = document.createElement("span");
      ds.className = "skin-item-desc";
      ds.textContent = s.desc;
      txt.appendChild(nm);
      txt.appendChild(ds);

      var ck = document.createElement("span");
      ck.className = "skin-item-check";
      ck.setAttribute("aria-hidden", "true");
      ck.textContent = "✓";

      item.appendChild(sw);
      item.appendChild(txt);
      item.appendChild(ck);
      box.appendChild(item);
    });
  }

  /* ---------- 绑定顶栏按钮 + 浮层 ---------- */
  function bindSwitcher(btn, pop) {
    var current = readSkin();

    function open() {
      renderList(pop.querySelector(".skin-list"), current);
      pop.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
    function close() {
      pop.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
    }
    function isOpen() { return !pop.hasAttribute("hidden"); }

    btn.addEventListener("click", function () { isOpen() ? close() : open(); });

    // 选皮肤
    pop.addEventListener("click", function (e) {
      var item = e.target.closest ? e.target.closest(".skin-item") : null;
      if (!item) return;
      var id = item.getAttribute("data-skin-id");
      if (!id) return;
      var prev = current;
      // 浮层列表马上会被重绘，按钮会从文档里摘掉 —— 先把位置量下来，
      // 换肤入场的光晕要从这颗按钮的位置铺开。
      var r = item.getBoundingClientRect();
      var origin = { left: r.left, top: r.top, width: r.width, height: r.height };
      current = saveSkin(id);            // 立刻换色 + 存档
      renderList(pop.querySelector(".skin-list"), current);
      close();
      toast("已切换到「" + byId[current].name + "」皮肤");
      // 换肤入场（intro.js 接手）：只有真的换了才播，点当前皮肤不播
      if (prev !== current) {
        document.dispatchEvent(new CustomEvent("xd:skin-change", {
          detail: { from: prev, to: current, origin: origin }
        }));
      }
    });

    // 点浮层外面 / 按 Esc 收起
    document.addEventListener("click", function (e) {
      if (!isOpen()) return;
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) { close(); btn.focus(); }
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    applySkin(readSkin());
    var btn = document.getElementById("btn-skin");
    var pop = document.getElementById("skin-pop");
    if (btn && pop) bindSwitcher(btn, pop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* 暴露给无头验证脚本用（正常页面不会用到） */
  window.__skin = { SKINS: SKINS, read: readSkin, apply: applySkin, save: saveSkin, normalize: normalize };
})();
