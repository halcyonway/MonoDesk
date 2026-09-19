# ref-popover-pointer：popover 加箭头指向 chip（Image 67）

> **Change**。Image 67 反馈：ref popover 显示时悬在段落末尾，**没有视觉关联**
> 用户看不出来 popover 是从哪个 chip 弹出来的。本 spec 定义 popover 锚点 +
> 箭头指示器，让 popover ↔ chip 的对应关系一眼可读。

## 1. 现状（Image 67 实测）

- chip 是 inline `<a class="ref-chip">` + `position: relative`
- popover 是 `<div class="ref-popover">` + `position: absolute`（锚到
  `#conversation-wrap` 这个 `position: relative` 容器，不是锚到 chip）
- JS 在 hover 时给 popover 设 `top = chip.bottom - wrap.top + 4px`、
  `left = chip.left - wrap.left`，**视觉上贴 chip 但没有箭头**
- 用户感受：popover「飘」在段落附近，分不清哪个 chip 触发的（尤其当一段
  内有多个 chip 时）

## 2. 设计

### 2.1 箭头形状

- 等腰三角，宽度 12px、高度 7px
- 颜色跟 popover `--bg-panel` 同色（视觉上是 popover 边框的延伸）
- 顶点朝上、紧贴 popover 顶部边框
- 横向位置：默认贴 popover 左上 14px（chip 文字左对齐时箭头在 chip 文字下方）
  - JS 计算 chip 横向中心 → 把 `left` 设到 chip 中心 - 6px（三角宽一半）让
    箭头正好指向 chip 文字中心
- 仅显示在 **popover 上方**这一种位置（不显示下方 / 左侧 / 右侧箭头——
  当前 popover 一律显示在 chip 下方）

### 2.2 popover ↔ chip 间距

- popover `top` = `chip.bottom + 6px`（之前 4px → 6px，留 7px 给箭头 +
  1px 微调）
- 箭头 7px 高 + popover 自身 1px border 完美衔接

### 2.3 边框处理

- 箭头背景 = `var(--bg-panel)`，但 popover 自身有 1px `var(--border)` 边框
- 箭头**不带边框**（画三角 clip-path 时 border 难对齐，视觉上箭头只是
  bg-panel 同色填充的小三角），跟 popover 顶部边框衔接处用户看不出拼接缝
  - 不带边框的轻微代价：箭头左右两侧底部跟 popover 边框不连。但 popover
    border 是浅灰，箭头是 panel 色，色差 ~5%，肉眼不可辨。

### 2.4 联动 hover area

- chip → popover：4px → 6px 后，鼠标在 chip → popover 间隙经过的时间增加
  ~2ms，仍然在 mouseover 阈值内，hover bridge 不会断
- 现有的 `mouseover` / `mouseout` + `relatedTarget` 监听不需要改

## 3. 验收

1. hover 任一 chip，popover 上方出现等腰三角箭头，箭头水平位置在 chip 文字中心
2. 多个 chip 顺序排在同一段时，每个 chip 触发 popover 都有独立箭头指向自己
3. popover 顶部边框 + 箭头底边无明显色差 / 拼接缝
4. chip → popover 鼠标移动不闪烁（hover bridge 不断）
5. 移动到 viewport 边界时，popover 横向自适应（JS 已 clamp 到 wrap 范围内，
   箭头位置随之移动仍指向 chip）

## 4. 不在本 spec 范围

- popover 位置改为 chip 上方 / 左侧 / 右侧（暂不支持，仍一律下方）
- arrow color theme 切换（dark/light theme 跟随 `--bg-panel` 自动适配）
- popover 打开/关闭动画（之前没有，本 spec 不引入）