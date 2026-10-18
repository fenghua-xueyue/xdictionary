---
name: xdictionary
description: 自用 CET-4 背词工具——三款皮肤三个世界，词卡是主角
colors:
  mint-accent: "#2E9E78"
  mint-accent-deep: "#176B4F"
  mint-accent-hover-bg: "#145944"
  mint-page: "#F5F7F3"
  mint-surface: "#FFFFFF"
  mint-text-primary: "#22302A"
  mint-text-secondary: "#4A5A51"
  mint-text-tertiary: "#5E6C62"
  mint-text-muted: "#657368"
  mint-border-soft: "#D7E2DB"
  mint-border-muted: "#C9DDD3"
  mint-bg-soft: "#F0F4F1"
  mint-subtle-bg: "#E9EEE9"
  mint-mark-on: "#E24B4A"
  mint-danger: "#B5564F"
  warm-page: "#FAF3E7"
  warm-surface: "#FFFDF8"
  warm-accent: "#AE5526"
  warm-accent-deep: "#7E3A15"
  warm-text-primary: "#3B2E1E"
  pixel-page: "#8FBEF0"
  pixel-surface: "#F2F2F2"
  pixel-accent: "#7ADB2B"
  pixel-edge: "#3F3F3F"
typography:
  word-display:
    fontFamily: "Noto Sans SC, PingFang SC, Microsoft YaHei, Hiragino Sans GB, sans-serif"
    fontSize: "48px"
    fontWeight: 600
    lineHeight: 1.2
  title:
    fontFamily: "Noto Sans SC, PingFang SC, Microsoft YaHei, Hiragino Sans GB, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Noto Sans SC, PingFang SC, Microsoft YaHei, Hiragino Sans GB, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  meaning:
    fontFamily: "Noto Sans SC, PingFang SC, Microsoft YaHei, Hiragino Sans GB, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.4
  hint:
    fontFamily: "Noto Sans SC, PingFang SC, Microsoft YaHei, Hiragino Sans GB, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  card: "20px"
  button: "12px"
  switcher: "14px"
  pill: "999px"
  icon-button: "10px"
spacing:
  xs: "8px"
  sm: "14px"
  md: "20px"
  lg: "36px"
  xl: "60px"
components:
  button-primary:
    backgroundColor: "{colors.mint-accent-deep}"
    textColor: "#FFFFFF"
    rounded: "{rounded.button}"
    padding: "14px 26px"
  button-secondary:
    backgroundColor: "{colors.mint-surface}"
    textColor: "{colors.mint-accent-deep}"
    rounded: "{rounded.button}"
    padding: "12px 22px"
  button-hero:
    backgroundColor: "{colors.mint-accent-deep}"
    textColor: "#FFFFFF"
    rounded: "{rounded.pill}"
    padding: "18px 44px"
  flashcard:
    backgroundColor: "{colors.mint-surface}"
    textColor: "{colors.mint-text-primary}"
    rounded: "{rounded.card}"
    padding: "36px 22px"
---

# Design System: xdictionary

## Overview

**Creative North Star: "One App, Three Worlds（一个应用，三个世界）"**

皮肤不是配色方案，是三个完整的世界：**薄荷**是一间安静的书房——纸感卡面悬浮在淡绿空气上；**暖阳米黄**是同一间书房换上暖陶与牛皮纸；**像素风**是另一个宇宙——8-bit 游戏画面，宝剑代替箭头，零圆角零阴影，硬边框与斜面说话。三个世界共享同一副骨架：布局、字号阶梯、信息密度、图标语言、交互结构完全一致；世界只决定色板、材质（阴影 / 圆角 / 边框）与签名动效。

**Key Characteristics:**
- 词卡是绝对主角：48px 单词、40px 级别的操作钮都为它服务
- 按钮三级分明：实底主按钮 / 描边次级 / 浅底魔法动作，一眼分清主次
- 全部颜色经 CSS 变量流动，皮肤 = 变量覆盖，写死色值即掉色
- 图标是自绘 2px 线描 SVG（sprite 复用），跟随文字色换肤
- 安静：一屏只有一种强调色在工作

## Colors

三套色板共用同一个角色模型，每款皮肤独立成套。以下为默认皮肤「薄荷」基线（frontmatter 为准），其余两款给出角色对应的锚点色。

### Primary
- **薄荷祖母绿 Fresh Mint** (`--accent` #2E9E78)：品牌主色。进度条、右翻页箭头、切换器激活段、logo 底。是页面上唯一持续出现的彩色。
- **深松绿 Deep Pine** (`--accent-dark` #176B4F)：主按钮底色（白字 6.5:1）。凡是"白字压绿底"的场合一律用它，不用亮主色。

### Secondary
- **暖陶土 Warm Terracotta**（warm 皮肤 `--accent` #AE5526，深色 #7E3A15）：米黄世界的对应主色，角色完全同上。
- **草地像素绿 Pixel Grass**（pixel 皮肤 `--px-accent` #7ADB2B）：像素世界主色，只配深色文字（#122103），绝不压白字。

### Neutral
- **雾绿纸 Fog Paper** (`--bg-page` #F5F7F3)：页面底色；米黄 #FAF3E7、像素天空蓝 #8FBEF0。
- **卡面白 Card White** (`--surface` #FFFFFF)：一切卡片与面板。
- **墨松 Ink Pine** (`--text-primary` #22302A)：主文字。
- **辅助三级** (`--text-tertiary` #5E6C62 / `--text-muted` #657368)：辅助与弱化文字，全部 ≥4.5:1。
- **书签红 Bookmark Red** (`--mark-fg` #E24B4A)：唯一的功能性红色，只属于"已标记"状态。

### Named Rules
**The Single Voice Rule.** 一屏只允许一种强调色工作。语义色（对错红绿）只在默写校验与破坏性操作上出现。
**The Deep-Pine Rule.** 白字永远压深主色（#176B4F 级），不压亮主色；亮主色上只允许深色文字（像素世界惯例）。

## Typography

**Font:** 全系统字体栈 `Noto Sans SC, PingFang SC, Microsoft YaHei, Hiragino Sans GB, sans-serif`，无外链字体（零依赖硬约束）。

**Character:** 系统黑体的干净利落，靠字号落差而非字体个性制造层级。所有字号为用户"大字号、低密度"要求的落地值，只许调大不许调小。

### Hierarchy
- **Word Display** (600, 48px): 被学习的单词，视觉主角。像素世界放大到 160px。
- **Headline** (600, 24px): 视图标题、释义。
- **Body** (400, 16px): 正文、按钮（按钮 600）。
- **Label** (400, 13px): 弱提示与脚注。是全系统最小字号，禁止更小。

### Named Rules
**The Big-Word Rule.** 单词展示字号只许增大。任何新界面不得把词卡主字号降到 40px 以下。

## Layout

单列流式布局：内容列最大 760px 居中（`--max-width`），顶栏最宽 1280px。竖向节奏宽松——hero 区 60px 上下边距，卡片区与动作区之间 20px。唯一断点 720px：单词降至 38px、卡片与箭头收窄（自用桌面端产品，移动端仅作兜底不作目标）。像素世界脱离流式布局：固定 1440×1200 舞台 + 等比缩放（`pixel.js` 写入 `--px-scale`）。

## Elevation & Depth

薄荷 / 米黄世界：**柔和悬浮**——卡面默认即带大柔影，像悬浮在底色上方；阴影承担层级表达，是常态而非交互态。

### Shadow Vocabulary
- **卡片悬浮** (`0 10px 28px rgba(34,48,42,.12)`): 一切卡面 / 面板的常态。
- **主按钮衬影** (`0 4px 12px rgba(46,158,120,.25)`): 主按钮底部的同色系衬影。
- **浮层压影** (`0 18px 44px` / `0 14px 34px`): 弹窗与下拉浮层，明显更深。

像素世界：**零阴影**——全部阴影 token 归零（`0 0 0 0`），深度靠 `inset box-shadow` 双向斜面 + 4px 硬投影表达。

## Shapes

圆角是世界的性格开关。薄荷 / 米黄：卡片 20px、按钮 12px、切换器胶囊 14px、圆钮与徽标 999px。像素世界：全部归零，边框一律 2px 实线（`--px-edge` #3F3F3F / `--px-edge2` #A8A8A8），斜面用 inset 阴影伪造。描边在薄荷世界是 1-2px 低饱和同系色（`--border-soft` #D7E2DB），永远比卡面浅一档。

## Components

### Buttons
- **Shape:** 圆角 12px（主/次级）；首屏大按钮与圆钮用胶囊 999px。
- **Primary:** 深主色实底 + 白字（`--btn-primary-bg`），padding 14px 26px，底部同色衬影。hover 加深 `#145944` 级并微浮 1px，active 下沉。
- **Secondary:** 白底 + 2px 浅描边 + 深主色文字。hover 边框与文字染主色、底变浅绿。
- **魔法动作（生成本轮故事）:** 主色描边 + 浅绿底 + 火花图标，比次级高半级。
- **Ghost 图标钮（顶栏）:** 透明底无框，线描图标；hover 浮现浅底。破坏性的"重置"例外：保持红字粉边示警。
- **Focus:** 一律 2px `--accent` 焦点环（offset 2px）；像素世界环色换 `--px-edge`。

### Flashcard（签名组件）
- **Corner:** 20px；**Background:** 卡面白；**Shadow:** 卡片悬浮档。
- 内部布局：左上书签钮、右上朗读圆钮（40px 圆、bg-soft 底）、居中词 48px + 音标 18px + 释义 24px、底部默写输入与揭示按钮。像素世界：词 160px、斜面边框、宝剑翻页动效。

### Inputs
- 2px `--border-soft` 描边、白底、圆角 12px；focus 描边转主色 + 3px 同色柔光。默写校验：正确绿框光晕 / 错误红框光晕（`--ok` / `--bad`）。

### Modals & Toast
- 弹窗：卡面白、20px 圆角、深压影、`role=dialog` 全套 ARIA。Toast：深底 `#22302A` 白字圆角条，`aria-live=polite`。

### Icons
- 全站唯一图标体系：内联 SVG sprite（study.html 顶部 `<symbol>` 表），2px 描边、round 线帽、`stroke="currentColor"` 跟随文字换肤。禁止 emoji / Unicode 字符充当图标。

## Do's and Don'ts

### Do:
- **Do** 颜色一律走 CSS 变量；新颜色先进 `:root` 皮肤可覆盖区（38 变量清单），再被三皮肤各自赋值。
- **Do** 任何视觉改动在薄荷 / 米黄 / 像素三皮肤下各验一遍，像素风改动锁 `html[data-skin="pixel"]` 作用域。
- **Do** 新增交互元素必须带 `:focus-visible` 焦点环，文字对比度 ≥4.5:1（每款皮肤独立验证）。
- **Do** 新图标画进 sprite 表复用，24 视框 2px 描边。
- **Do** 主色上压白字前先查对比度（薄荷/米黄用 `--btn-primary-bg` 深主色档）。

### Don't:
- **Don't** 在组件样式区写死色值（皮肤 = 变量覆盖，写死即掉色）。
- **Don't** 用 emoji 或 Unicode 字符充当图标。
- **Don't** 让动效 / 音效拦截点击或修改状态（`app.js` 是状态唯一真相，`sword.js` 只演出）。
- **Don't** 把像素风的样式或节点泄漏到薄荷 / 米黄（新像素节点必须进惰性钩子 display:none 清单）。
- **Don't** 缩小词卡主字号或收紧留白——大字号低密度是产品硬要求。
