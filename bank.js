/* ============================================================
   bank.js — 自定义词库「加词」（IIFE，2026-10-26 新增）
   ============================================================
   用户把自己的词（txt / csv / md 文档或直接粘贴）导入成自定义
   词库，学习模式的抽词来源可以切到它。纯本地：
   - localStorage key: english_app_custom_v1
     格式 { banks:[{ id, name, createdAt, words:[{word,meaning,phonetic}] }] }
   - 解析规则（v1，无图片识别）：
     ① 行式配对：行首是英文单词、后面带中文释义（或 Tab / 两格以上
        空格分隔），读作「单词 + 释义」；/…/ 里的内容当音标收下。
     ② 其余行当文章：正则抽英文单词（滤掉常用虚词），无释义。
   - 与四级词库 + 已有自定义词库比对去重，识别列表里标「已有」。
   - 与 app.js 的协作：app.js 读 window.BANKS；切换抽词来源走
     自定义事件 xd:switch-source / xd:source-changed / xd:banks-changed，
     两个文件互不直接调用对方内部函数。
   ============================================================ */
(function () {
  "use strict";

  var LS_KEY = "english_app_custom_v1";

  /* ---------- 存取 ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return { banks: [] };
      var d = JSON.parse(raw);
      if (!d || typeof d !== "object" || !Array.isArray(d.banks)) return { banks: [] };
      return d;
    } catch (e) { return { banks: [] }; }
  }
  function save(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }
  function all() { return load().banks; }
  function persist(banks) { return save({ banks: banks }); }
  function byId(id) {
    var banks = all();
    for (var i = 0; i < banks.length; i++) if (banks[i].id === id) return banks[i];
    return null;
  }
  /* 某个单词字符串落在哪个自定义库里（含四级词库判断在 app.js） */
  function bankOfWord(word) {
    var w = String(word || "").toLowerCase();
    var banks = all();
    for (var i = 0; i < banks.length; i++) {
      var list = banks[i].words || [];
      for (var k = 0; k < list.length; k++) {
        if (String(list[k].word).toLowerCase() === w) return banks[i];
      }
    }
    return null;
  }
  /* 词库词条 → 学习用词条（phonetic 缺省给空串，card 直接用） */
  function entriesOf(bank) {
    return (bank.words || []).map(function (w) {
      return { word: w.word, meaning: w.meaning || "", phonetic: w.phonetic || "", example: "" };
    });
  }
  function newId() { return "bk_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36); }
  function addBank(name, words) {
    var banks = all();
    var bank = { id: newId(), name: name, createdAt: new Date().toISOString(), words: words };
    banks.push(bank);
    persist(banks);
    notifyBanksChanged();
    return bank;
  }
  function appendWords(id, words) {
    var banks = all();
    var bank = null;
    banks.forEach(function (b) { if (b.id === id) bank = b; });
    if (!bank) return null;
    var have = {};
    (bank.words || []).forEach(function (w) { have[String(w.word).toLowerCase()] = 1; });
    (words || []).forEach(function (w) {
      var k = String(w.word).toLowerCase();
      if (!have[k]) { bank.words.push(w); have[k] = 1; }
    });
    persist(banks);
    notifyBanksChanged();
    return bank;
  }
  function removeBank(id) {
    var banks = all().filter(function (b) { return b.id !== id; });
    persist(banks);
    notifyBanksChanged();
  }
  function renameBank(id, name) {
    var banks = all();
    banks.forEach(function (b) { if (b.id === id) b.name = name; });
    persist(banks);
    notifyBanksChanged();
  }

  /* ---------- 常用虚词表：从文章里抽词时滤掉 ---------- */
  var STOP = {};
  ("the a an and or but if of to in on at by for with as is are was were be been being am do does did " +
   "have has had will would shall should can could may might must not no nor so too very s t d ll m re ve y " +
   "i me my myself we our ours ourselves you your yours he him his she her hers it its they them their theirs " +
   "this that these those there here when where why how what which who whom then than also just about into " +
   "over under again from up down out off only own same some such all any both each few more most other " +
   "because while during before after above below between through one two three get got make made " +
   "old new day way time thing").split(" ")
   .forEach(function (w) { STOP[w] = 1; });

  var CJK = /[\u4e00-\u9fa5\u3400-\u4dbf]/;
  var WORD_TOKEN = /[A-Za-z][A-Za-z'\-]*/g;

  /* 把一行整理成待解析文本：去掉 markdown 列表符 / 加粗符号 / 行号 */
  function cleanLine(line) {
    var s = line.replace(/\*\*|__|`/g, "");
    s = s.replace(/^[ \t]*(?:[-*•·]|\d+[.、)])\s+/, "");
    return s.trim();
  }

  /* 单行配对解析：行首英文词 + 中文释义（或 Tab / 两格以上空格分隔）。
     返回 {word, meaning, phonetic} 或 null（当文章行处理）。 */
  function parsePairLine(s) {
    var m = s.match(/^([A-Za-z][A-Za-z'\.\-]{0,30})([\s\S]*)$/);
    if (!m) return null;
    var word = m[1];
    var rest = m[2];
    if (!rest || !rest.trim()) return null;

    // 分隔判定：显式分隔符（Tab / 两格以上空格 / ,，;；:：=→）或释义以中文开头
    var sep = rest.match(/^(\s{2,}|\t|\s*[,，;；:：=→]\s*|\s+)/);
    if (!sep) return null;
    var remainder = rest.slice(sep[0].length);

    // 音标 /…/ 收下
    var phonetic = "";
    var ph = remainder.match(/^(\/[^\/]+\/)\s*/);
    if (ph) { phonetic = ph[1]; remainder = remainder.slice(ph[0].length); }

    remainder = remainder.trim();
    // 认定为「配对」的条件：释义含中文；或分隔是 Tab / 两格以上空格（明确的表格感）
    var strongSep = /^(\t|\s{2,})/.test(rest) || /^(\s*[,，;；:：=→]\s*)/.test(rest);
    if (!CJK.test(remainder) && !strongSep) return null;
    if (!remainder) return null;

    // 释义里的括号注音保留原样；去掉释义前残留的分隔符
    remainder = remainder.replace(/^[,，;；:：=→\s]+/, "");
    if (!remainder) return null;
    return { word: word.toLowerCase(), meaning: remainder, phonetic: phonetic };
  }

  /* 整段文本 → 词条数组（输入内部去重，先出现的释义优先） */
  function parseInput(text) {
    var out = [];
    var seen = {};
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = cleanLine(lines[i]);
      if (!s) continue;
      if (/^(#|\/\/)/.test(s)) continue;   // 注释行
      var pair = parsePairLine(s);
      if (pair) {
        pushWord(pair.word, pair.meaning, pair.phonetic);
        continue;
      }
      // 文章行：抽英文单词
      var tokens = s.match(WORD_TOKEN) || [];
      for (var k = 0; k < tokens.length; k++) {
        var w = tokens[k].toLowerCase().replace(/^[-']+|[-']+$/g, "");
        if (!w || w.length < 2 || STOP[w]) continue;
        if (!/^[a-z][a-z'\-]*$/.test(w)) continue;
        pushWord(w, "", "");
      }
    }
    function pushWord(word, meaning, phonetic) {
      if (seen[word]) {
        // 重复词：已有释义就不动；没释义就用后到的补上
        if (meaning && !seen[word].meaning) { seen[word].meaning = meaning; }
        if (phonetic && !seen[word].phonetic) { seen[word].phonetic = phonetic; }
        return;
      }
      var item = { word: word, meaning: meaning || "", phonetic: phonetic || "" };
      seen[word] = item;
      out.push(item);
    }
    return out;
  }

  /* ---------- 状态比对：新词 / 已有（四级词库或任一自定义库） ---------- */
  function knownWordSet() {
    var set = {};
    if (window.WORDS) for (var i = 0; i < window.WORDS.length; i++) set[String(window.WORDS[i].word).toLowerCase()] = 1;
    all().forEach(function (b) { (b.words || []).forEach(function (w) { set[String(w.word).toLowerCase()] = 1; }); });
    return set;
  }

  /* ---------- 对外 API（app.js / 其他模块使用） ---------- */
  window.BANKS = {
    all: all,
    byId: byId,
    bankOfWord: bankOfWord,
    entriesOf: entriesOf,
    add: addBank,
    append: appendWords,
    remove: removeBank,
    rename: renameBank,
    parseInput: parseInput,
    knownWordSet: knownWordSet,
    LS_KEY: LS_KEY
  };

  function notifyBanksChanged() {
    document.dispatchEvent(new CustomEvent("xd:banks-changed"));
    // 弹窗开着的话刷新词库列表
    if (modal && !modal.hidden) renderBankList();
  }

  /* ---------- 轻提示（复用 #toast，写法同 app.js / backup.js） ---------- */
  var toastTimer;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }

  /* ---------- 弹窗 UI ---------- */
  var modal, btnOpen, btnClose, dropZone, fileInput, pasteBox;
  var previewWrap, previewGrid, previewSummary, btnSave, nameInput, targetSelect, targetRow;
  var bankList, banksEmpty;
  var sourceBadge, sourceMenu;   // 顶栏快速切换：点轮次徽标弹出的词源菜单
  var parsed = [];        // 当前识别结果 [{word, meaning, phonetic, known}]
  var sourceId = "cet4";  // 当前抽词来源（app.js 通过事件同步过来）

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function openModal() {
    renderBankList();
    modal.hidden = false;
  }
  function closeModal() { modal.hidden = true; }

  /* ---- 识别结果渲染 ---- */
  function renderPreview() {
    var fresh = parsed.filter(function (p) { return !p.known; }).length;
    previewSummary.textContent = parsed.length
      ? "识别出 " + parsed.length + " 个词：新词 " + fresh + " 个 · 词库里已有 " + (parsed.length - fresh) + " 个（已自动取消勾选）"
      : "还没有识别到单词 —— 拖入文件、粘贴文本，或两者混着用";
    if (!parsed.length) {
      previewGrid.innerHTML = "";
      previewWrap.hidden = true;
      updateSaveBtn();   // 修复：列表清空（保存成功后）按钮文字/禁用态要跟着复位
      return;
    }
    previewWrap.hidden = false;
    var html = "";
    for (var i = 0; i < parsed.length; i++) {
      var p = parsed[i];
      html += '<label class="bank-item' + (p.known ? " is-known" : "") + '">' +
        '<input type="checkbox" data-idx="' + i + '"' + (p.known ? "" : " checked") + '>' +
        '<span class="bank-item-word">' + esc(p.word) + '</span>' +
        '<input type="text" class="bank-item-meaning" data-idx="' + i + '" value="' + esc(p.meaning) + '" placeholder="释义（可补）">';
      html += p.known ? '<span class="bank-item-tag">已有</span>' : '<span class="bank-item-tag is-new">新词</span>';
      html += "</label>";
    }
    previewGrid.innerHTML = html;
    updateSaveBtn();
  }

  function updateSaveBtn() {
    var n = checkedCount();
    btnSave.disabled = n === 0;
    btnSave.textContent = n ? "保存 " + n + " 个新词" : "先勾选要保存的词";
  }
  function checkedCount() {
    var boxes = previewGrid.querySelectorAll('input[type="checkbox"]');
    var n = 0;
    boxes.forEach(function (b) { if (b.checked) n++; });
    return n;
  }

  function collectInput() {
    // 文本框内容 + 已拖入文件内容合并解析
    var text = pasteBox.value || "";
    if (fileText) text += (text ? "\n" : "") + fileText;
    return text;
  }
  function reparse() {
    var known = knownWordSet();
    parsed = parseInput(collectInput()).map(function (p) {
      p.known = !!known[p.word];
      return p;
    });
    renderPreview();
  }

  var fileText = "";
  function setFileText(text, fileName) {
    fileText = text || "";
    if (!nameInput.value && fileName) {
      nameInput.value = fileName.replace(/\.[^.]+$/, "").slice(0, 30);
    }
    reparse();
  }
  function clearAll() {
    pasteBox.value = "";
    fileText = "";
    parsed = [];
    renderPreview();
  }

  function readFile(f) {
    if (!f) return;
    var okType = /\.(txt|csv|md|markdown|tsv|text)$/i.test(f.name) || /^text\//.test(f.type) || f.type === "";
    if (!okType) {
      toast("暂支持 txt / csv / md 文本文件，图片识别将在后续版本加入");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      setFileText(String(reader.result), f.name);
      toast("已读取「" + f.name + "」，识别出单词见下方列表");
    };
    reader.onerror = function () { toast("文件读取失败，请重试"); };
    reader.readAsText(f, "utf-8");
  }

  /* ---- 保存 ---- */
  function doSave() {
    var boxes = previewGrid.querySelectorAll('input[type="checkbox"]');
    var words = [];
    boxes.forEach(function (b) {
      if (!b.checked) return;
      var i = Number(b.getAttribute("data-idx"));
      var p = parsed[i];
      if (!p) return;
      var meaningInput = previewGrid.querySelector('.bank-item-meaning[data-idx="' + i + '"]');
      words.push({
        word: p.word,
        meaning: (meaningInput && meaningInput.value.trim()) || p.meaning || "",
        phonetic: p.phonetic || ""
      });
    });
    if (!words.length) return;

    var mode = targetSelect.value;
    if (mode === "new") {
      var name = nameInput.value.trim();
      if (!name) { name = "我的词库 " + (all().length + 1); }
      addBank(name, words);
      toast("词库「" + name + "」已保存，共 " + words.length + " 个词");
    } else {
      var bank = byId(mode);
      if (!bank) { toast("目标词库不存在，请重新选择"); return; }
      appendWords(mode, words);
      toast("已把 " + words.length + " 个词追加进「" + bank.name + "」");
    }
    clearAll();
    nameInput.value = "";
    renderBankList();
  }

  /* ---- 我的词库列表 ---- */
  function renderBankList() {
    var banks = all();
    if (!banks.length) {
      bankList.innerHTML = "";
      banksEmpty.hidden = false;
      return;
    }
    banksEmpty.hidden = true;
    var html = "";
    for (var i = 0; i < banks.length; i++) {
      var b = banks[i];
      var active = b.id === sourceId;
      html += '<div class="bank-row' + (active ? " is-active" : "") + '">' +
        '<div class="bank-row-main">' +
          '<span class="bank-row-name">' + esc(b.name) + "</span>" +
          '<span class="bank-row-meta">' + (b.words || []).length + " 词" + (active ? " · 学习中" : "") + "</span>" +
        "</div>" +
        '<div class="bank-row-actions">' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="switch" data-id="' + b.id + '">' + (active ? "停用" : "学习") + "</button>" +
          '<button type="button" class="btn btn-reset btn-sm" data-act="del" data-id="' + b.id + '">删除</button>' +
        "</div>" +
      "</div>";
    }
    bankList.innerHTML = html;
  }

  function onBankListClick(e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    var act = btn.getAttribute("data-act");
    if (act === "switch") {
      if (id === sourceId) {
        document.dispatchEvent(new CustomEvent("xd:switch-source", { detail: { id: "cet4" } }));
      } else {
        document.dispatchEvent(new CustomEvent("xd:switch-source", { detail: { id: id } }));
      }
      return;
    }
    if (act === "del") {
      // 两段确认：点一次按钮文字变「确认删除」，再点才真删，3 秒不点自动还原
      if (btn.dataset.armed) {
        var wasActive = id === sourceId;
        removeBank(id);
        if (wasActive) document.dispatchEvent(new CustomEvent("xd:switch-source", { detail: { id: "cet4" } }));
        toast("词库已删除");
      } else {
        btn.dataset.armed = "1";
        btn.textContent = "确认删除";
        setTimeout(function () {
          if (!btn.isConnected) return;
          delete btn.dataset.armed;
          btn.textContent = "删除";
        }, 3000);
      }
    }
  }

  /* ---- 顶栏词库快速切换（点轮次徽标弹出，2026-10-26） ---- */
  function srcItemHtml(id, name, meta, active) {
    return '<button type="button" class="src-item' + (active ? " is-active" : "") + '" data-id="' + id + '" role="menuitem">' +
      '<span class="src-name">' + esc(name) + '</span>' +
      '<span class="src-meta">' + esc(meta) + (active ? " · 学习中" : "") + '</span>' +
      "</button>";
  }
  function renderSourceMenu() {
    var cur = sourceId;
    var html = srcItemHtml("cet4", "四级高频词库", window.WORDS ? window.WORDS.length + " 词" : "", cur === "cet4");
    var banks = all();
    for (var i = 0; i < banks.length; i++) {
      var b = banks[i];
      html += srcItemHtml(b.id, b.name, (b.words || []).length + " 词", b.id === cur);
    }
    html += '<div class="src-sep"></div>';
    html += '<button type="button" class="src-item src-manage" data-act="manage" role="menuitem"><span class="src-name">加词 / 管理词库…</span></button>';
    sourceMenu.innerHTML = html;
  }
  function toggleSourceMenu(open) {
    if (open) renderSourceMenu();
    sourceMenu.hidden = !open;
    sourceBadge.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    modal = $("#bank-modal");
    btnOpen = $("#btn-bank");
    if (!modal || !btnOpen) return;   // index.html 无入口，早退

    btnClose = $("#btn-bank-close");
    dropZone = $("#bank-drop");
    fileInput = $("#bank-file");
    pasteBox = $("#bank-paste");
    previewWrap = $("#bank-preview");
    previewGrid = $("#bank-grid");
    previewSummary = $("#bank-summary");
    btnSave = $("#btn-bank-save");
    nameInput = $("#bank-name");
    targetSelect = $("#bank-target");
    targetRow = $("#bank-target-row");
    bankList = $("#bank-list");
    banksEmpty = $("#bank-list-empty");

    btnOpen.addEventListener("click", openModal);
    btnClose.addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!modal.hidden) closeModal();
        else if (!sourceMenu.hidden) toggleSourceMenu(false);
      }
    });

    // 文件：点击选择 + 拖拽
    dropZone.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
      fileInput.value = "";
    });
    ["dragover", "dragenter"].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropZone.classList.add("is-drag");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropZone.classList.remove("is-drag");
      });
    });
    dropZone.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      readFile(f);
    });

    // 粘贴文本：停止输入 350ms 后自动解析
    var pasteTimer;
    pasteBox.addEventListener("input", function () {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(reparse, 350);
    });

    // 勾选 / 改释义
    previewGrid.addEventListener("change", function (e) {
      if (e.target.type === "checkbox") updateSaveBtn();
    });
    previewGrid.addEventListener("input", function () { updateSaveBtn(); });

    // 保存目标切换：追加到已有库时不需要新名字
    targetSelect.addEventListener("change", function () {
      var isNew = targetSelect.value === "new";
      targetRow.hidden = !isNew;
      nameInput.parentElement.hidden = !isNew;
    });

    btnSave.addEventListener("click", doSave);
    bankList.addEventListener("click", onBankListClick);

    // 与 app.js 的来源同步
    document.addEventListener("xd:source-changed", function (e) {
      sourceId = (e.detail && e.detail.id) || "cet4";
      if (!modal.hidden) renderBankList();
      if (!sourceMenu.hidden) renderSourceMenu();   // 菜单开着时同步高亮
    });

    /* 顶栏快速切换：点徽标弹出词源菜单，点外部 / Esc 收起 */
    sourceBadge = $("#round-badge");
    sourceMenu = $("#source-menu");
    if (sourceBadge && sourceMenu) {
      sourceBadge.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleSourceMenu(sourceMenu.hidden);
      });
      document.addEventListener("click", function (e) {
        if (sourceMenu.hidden) return;
        if (sourceMenu.contains(e.target) || e.target === sourceBadge) return;
        toggleSourceMenu(false);
      });
      sourceMenu.addEventListener("click", function (e) {
        var item = e.target.closest("button[data-id], button[data-act]");
        if (!item) return;
        if (item.dataset.act === "manage") {
          toggleSourceMenu(false);
          openModal();
          return;
        }
        toggleSourceMenu(false);
        document.dispatchEvent(new CustomEvent("xd:switch-source", { detail: { id: item.dataset.id } }));
      });
      document.addEventListener("xd:banks-changed", function () {
        if (!sourceMenu.hidden) renderSourceMenu();
      });
    }

    // 保存目标下拉：每次打开弹窗 / 词库变化时重建选项
    function refreshTargets() {
      var banks = all();
      var cur = targetSelect.value;
      var html = '<option value="new">新建词库</option>';
      banks.forEach(function (b) {
        html += '<option value="' + b.id + '">追加到「' + esc(b.name) + "」</option>";
      });
      targetSelect.innerHTML = html;
      var still = targetSelect.querySelector('option[value="' + cur + '"]');
      if (still) { targetSelect.value = cur; } else { targetSelect.value = "new"; }
      var isNew = targetSelect.value === "new";
      targetRow.hidden = !isNew;
      nameInput.parentElement.hidden = !isNew;
    }
    refreshTargets();
    document.addEventListener("xd:banks-changed", refreshTargets);
    btnOpen.addEventListener("click", refreshTargets);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEvents);
  } else {
    bindEvents();
  }
})();
