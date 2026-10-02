/* ============================================================
   高频词小灶 — 皮肤模块
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

  /* ---------- 皮肤登记表 ---------- */
  var SKINS = [
    {
      id: "mint",
      name: "薄荷",
      desc: "默认 · 清爽绿意",
      swatch: ["#F5F7F3", "#FFFFFF", "#2E9E78"]
    },
    {
      id: "warm",
      name: "暖阳米黄",
      desc: "护眼暖色 · 久看不累",
      swatch: ["#FAF3E7", "#FFFDF8", "#AE5526"]
    },
    {
      id: "pixel",
      name: "像素风",
      desc: "我的世界像素 · 方角积木",
      swatch: ["#8FBEF0", "#FFFFFF", "#7ADB2B"]
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
    try {
      return normalize(localStorage.getItem(LS_SKIN));
    } catch (e) {
      return DEFAULT_SKIN;   /* 无痕模式等：降级为默认皮肤 */
    }
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
      current = saveSkin(id);            // 立刻换色 + 存档
      renderList(pop.querySelector(".skin-list"), current);
      close();
      toast("已切换到「" + byId[current].name + "」皮肤");
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
