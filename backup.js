/* ============================================================
   backup.js — 备份进度：导出 / 导入（IIFE，2026-10-13 新增）
   ============================================================
   背景：五个 localStorage key（进度 / 皮肤 / 音效 / 故事 / 自定义词库）都
   只存在本机浏览器里，清缓存、换浏览器、换设备、iOS Safari 7 天
   不访问都会丢。本模块把它们打包成一个 JSON 文件下载（导出），
   或从备份文件恢复（导入）。

   约定（与总纲 §4 / §5.4 一致）：
   - 不碰 app.js / bank.js 的状态；
   - 文件格式 { app:"xdictionary-backup", v:1, exportedAt, data }，
     data 里是四个 key 的原始字符串；缺失的 key 记 null，
     导入时 null = 删掉该 key（回到默认）。
   - 导入是「整包替换」：pool 是洗牌后的索引数组，两台设备的
     洗牌结果不同，游标/轮次语义没法合并 —— 所以导入前弹确认，
     且确认后先把当前进度自动另存一份再覆盖。
   - API Key 不进备份文件：导出时从 story.config.apiKey 剔除
     （换设备后到故事设置的 ⚙ 里重填一次即可）。
   - 弹窗 DOM #backup-modal，顶栏入口 #btn-backup（study.html）。
   ============================================================ */
(function () {
  "use strict";

  var APP_TAG = "xdictionary-backup";
  var BACKUP_V = 1;
  var KEYS = [
    "english_app_v1",
    "english_app_skin_v1",
    "english_app_sound_v1",
    "english_app_story_v1",
    "english_app_custom_v1"
  ];

  /* ---------- 轻提示（复用 #toast 节点，写法同 app.js / speak.js） ---------- */
  var toastTimer;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  function $(sel) { return document.querySelector(sel); }
  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* 无痕模式 */ } }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* 无痕模式 */ } }
  function datePart() { return new Date().toISOString().slice(0, 10); }

  /* ---------- 打包备份对象（导出与"导入前自动另存"共用） ---------- */
  function buildBackupObject() {
    var data = {};
    KEYS.forEach(function (k) {
      var raw = lsGet(k);
      if (raw === null) { data[k] = null; return; }
      if (k === "english_app_story_v1") {
        // 剔除 API Key，其余原样保留；解析失败就原样带上（不丢数据）
        try {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && parsed.config && typeof parsed.config === "object") {
            parsed.config.apiKey = "";
          }
          data[k] = JSON.stringify(parsed);
        } catch (e) { data[k] = raw; }
      } else {
        data[k] = raw;
      }
    });
    return { app: APP_TAG, v: BACKUP_V, exportedAt: new Date().toISOString(), data: data };
  }

  function download(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- 导入校验 ---------- */
  function validateBackup(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (obj.app !== APP_TAG) return null;
    if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) return null;
    var hasAny = KEYS.some(function (k) { return typeof obj.data[k] === "string"; });
    return hasAny ? obj : null;
  }

  function summarize(obj) {
    var parts = [];
    try {
      var p = JSON.parse(obj.data["english_app_v1"]);
      if (p && p.currentRound && typeof p.currentRound.round === "number") parts.push("第 " + p.currentRound.round + " 轮");
      if (p && p.marks) {
        var n = (Array.isArray(p.marks.en) ? p.marks.en.length : 0) + (Array.isArray(p.marks.zh) ? p.marks.zh.length : 0);
        if (n) parts.push("标记 " + n + " 个词");
      }
    } catch (e) { /* 该 key 缺失或为空 */ }
    try {
      var s = JSON.parse(obj.data["english_app_story_v1"]);
      if (s && Array.isArray(s.history) && s.history.length) parts.push("故事 " + s.history.length + " 篇");
    } catch (e) { /* 该 key 缺失或为空 */ }
    try {
      var c = JSON.parse(obj.data["english_app_custom_v1"]);
      if (c && Array.isArray(c.banks) && c.banks.length) {
        var total = 0;
        c.banks.forEach(function (b) { total += (b.words || []).length; });
        parts.push("词库 " + c.banks.length + " 个 · " + total + " 词");
      }
    } catch (e) { /* 该 key 缺失或为空 */ }
    return parts.length ? parts.join(" · ") : "（空进度）";
  }

  /* ---------- 弹窗与流程 ---------- */
  var modal, btnOpen, btnExport, btnImport, fileInput, hint, confirmBox, confirmText;
  var btnConfirm, btnAbort, btnClose, actionsRow;
  var pendingData = null;

  function setHint(msg, isError) {
    hint.textContent = msg || "";
    hint.classList.toggle("is-error", !!isError);
  }
  function showConfirm(show) {
    confirmBox.hidden = !show;
    actionsRow.hidden = show; // 确认时先收起导出/导入两颗按钮，避免双流程
    if (!show) pendingData = null;
  }

  function openModal() {
    setHint("", false);
    showConfirm(false);
    fileInput.value = "";
    modal.hidden = false;
  }
  function closeModal() {
    modal.hidden = true;
    showConfirm(false);
    fileInput.value = "";
  }

  function onExport() {
    download(buildBackupObject(), "xdictionary-backup-" + datePart() + ".json");
    setHint("备份文件已开始下载（API Key 不包含在内）。", false);
    toast("备份文件已开始下载");
  }

  function onFileChosen() {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var obj = null;
      try { obj = JSON.parse(String(reader.result)); } catch (e) { obj = null; }
      var valid = validateBackup(obj);
      if (!valid) {
        showConfirm(false);
        setHint("这不是本应用的备份文件（或内容已损坏），没有做任何改动。", true);
        return;
      }
      pendingData = valid;
      confirmText.textContent = "这份备份包含：" + summarize(valid) + "。导入会覆盖当前进度（当前进度会先自动另存一份），确定导入吗？";
      setHint("", false);
      showConfirm(true);
    };
    reader.onerror = function () {
      showConfirm(false);
      setHint("文件读取失败，请重试。", true);
    };
    reader.readAsText(file, "utf-8");
  }

  function doImport() {
    if (!pendingData) return;
    // 后悔药：覆盖前先把当前进度自动另存一份
    download(buildBackupObject(), "xdictionary-backup-导入前自动保存-" + datePart() + ".json");
    KEYS.forEach(function (k) {
      var v = pendingData.data[k];
      if (typeof v === "string") lsSet(k, v);
      else lsDel(k); // 备份里缺失的 key 回到默认
    });
    toast("导入完成，页面即将刷新");
    setTimeout(function () { location.reload(); }, 800);
  }

  function init() {
    modal = $("#backup-modal");
    btnOpen = $("#btn-backup");
    if (!modal || !btnOpen) return; // index.html 无入口，早退

    btnExport = $("#btn-backup-export");
    btnImport = $("#btn-backup-import");
    fileInput = $("#backup-file-input");
    hint = $("#backup-hint");
    confirmBox = $("#backup-confirm");
    confirmText = $("#backup-confirm-text");
    btnConfirm = $("#btn-backup-confirm");
    btnAbort = $("#btn-backup-abort");
    btnClose = $("#btn-backup-close");
    actionsRow = modal.querySelector(".backup-actions");

    btnOpen.addEventListener("click", openModal);
    btnExport.addEventListener("click", onExport);
    btnImport.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", onFileChosen);
    btnConfirm.addEventListener("click", doImport);
    btnAbort.addEventListener("click", function () { showConfirm(false); fileInput.value = ""; });
    btnClose.addEventListener("click", closeModal);

    // 点遮罩空白处 / Esc 关闭（与重置弹窗同款交互）
    modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeModal();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
