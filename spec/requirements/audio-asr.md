# audio-asr: MonoDesk 端音频上传 + ASR 转写 UI 与协议

> 对应 MonoX 侧 spec：`MonoX/spec/requirements/asr.md`（skill 实现）。
> 本文件是 MonoDesk 端的设计：上传组件、附件协议扩展、转写结果展示。

---

## 1. 背景

用户在 MonoDesk 里可以直接拖拽 / 选择音频文件发给 agent。agent 收到后调
MonoX 端的 `asr` skill 转写成文本，再基于文本回答用户（总结、提取要点、找关键词等）。

**关键约束**：

- 音频本身**不**通过 ws 发给 MonoX（太大、带宽贵）。MonoDesk 把音频文件落到本地
  attachments 目录，只把 file path 通过 ws 协议传给 MonoX。MonoX 端的 agent 拿到
  path 后调 skill 转写。
- ASR 转写结果（`.asr.txt`）**也不**回 MonoDesk——MonoX 本地有就行。MonoDesk 端
  只展示「针对转写文本的 agent 回复」。

---

## 2. 上传交互（产品层）

### 2.1 入口 1：拖拽到 Chat Composer

用户把 `audio.m4a` 直接拖到 Composer 文本框：

- 检测到 `DataTransfer.files[0].type` 以 `audio/` 开头
- 落到 `.monox/attachments/<session_key>/<ts>_<safe_name>.<ext>`
- Composer 显示一个 **附件 chip**（类似文件附件）：
  - 文件名 + 大小 + 时长（用 `new Audio()` 读 `duration`）
  - 「×」按钮可移除
- 用户按 Enter / 点 Send → 发送 `user_input` 帧，附件 path 在 `attachments` 字段

### 2.2 入口 2：粘贴文本 → "我想念语音录入"

简化方案，**第一版不做**。用户可以等后续做语音录入（按住说话 → 麦克风 → 实时流式 ASR）。
本 spec 第一版只覆盖「已有音频文件」上传。

### 2.3 上传限制

- 单文件 ≤ 100 MB（MonoX ASR API 单次 ≤ 2h 音频，但桌面端给的限制更保守）
- 支持：`audio/mpeg` / `audio/mp4` / `audio/wav` / `audio/ogg` / `audio/x-m4a` / `audio/aac` / `audio/flac`
- 不支持：`video/*`（视频文件含音频也只取音轨？第一版不支持整视频）

---

## 3. 协议：`attachments` 字段扩展

### 3.1 现状（已有）

`MonoX/core/protocol/events.py` 里 `InboundEvent.attachments` 字段（参考 `async-task.md`
里对 attachments 的描述）。MonoDesk 端 `src/ws/protocol.ts` 已有 `UserInputAttachments` 类型。

### 3.2 新增字段

`UserInputAttachments` 里 audio 类型加 `duration_sec`（从 `new Audio()` 读出）：

```ts
// src/ws/protocol.ts
export interface AudioAttachment {
  kind: "audio";
  path: string;              // 本地绝对 path（attachments 目录下的位置）
  filename: string;          // 原始文件名，给 agent 当 hint
  size_bytes: number;
  mime_type: string;         // "audio/mp4" etc
  duration_sec?: number;     // 从 new Audio() 读取的时长，agent 可用
}

export type Attachment =
  | ImageAttachment
  | FileAttachment
  | AudioAttachment;         // ← 新增
```

### 3.3 帧格式

`user_input` 帧的 `data.attachments: AudioAttachment[]`：

```json
{
  "v": 1,
  "type": "user_input",
  "seq": 42,
  "ts": 1725234567.89,
  "data": {
    "session_key": "default",
    "text": "帮我总结一下这段录音",
    "attachments": [
      {
        "kind": "audio",
        "path": "/Users/.../.monox/attachments/default/20260901_223045_meeting.m4a",
        "filename": "meeting.m4a",
        "size_bytes": 12345678,
        "mime_type": "audio/mp4",
        "duration_sec": 1827.4
      }
    ]
  }
}
```

MonoX 端 agent 收到后：

1. 看到 attachment 是 audio kind
2. 调 skill：`python .monox/skills/asr/asr.py transcribe <path>`
3. 拿到转写文本后，cat `.asr.txt` 直接当 context 喂给 LLM
4. LLM 基于转写文本回答用户问题

---

## 4. UI 组件设计

### 4.1 Composer 附件 chip

```
┌─────────────────────────────────────────────────────┐
│  🎙 meeting.m4a · 30:27 · 12.3 MB            × │
├─────────────────────────────────────────────────────┤
│  Type a message...                                  │
└─────────────────────────────────────────────────────┘
```

实现：

- `Composer.tsx` 加 `attachments` state（`AudioAttachment[]`）
- 拖拽 / 选择文件 → 上传到 attachments 目录 → 加 chip
- chip 显示：图标（按 mime 选 audio wave）+ filename + 时长（mm:ss）+ size + ×
- Enter 发送时 `attachments` 一起进 `user_input` 帧

### 4.2 转写进度展示

agent 调 skill 时 MonoDesk 怎么知道「正在转写」？

**方案 A（推荐）**：agent 通过 tool_call 暴露

- agent 调 `asr.py transcribe` 时输出 `tool_start` / `tool_end` 帧
- MonoDesk 已经渲染 tool block，加 kind="asr_transcribe" 特殊样式：
  - tool_start → "🎙 正在转写 meeting.m4a..."
  - tool_end（成功）→ "✓ 已转写，耗时 12s，12,847 字"
  - tool_end（失败）→ "✗ 转写失败：<error msg>"

**方案 B（不做）**：进度条。ASR 是单次同步调用，没有分阶段进度。tool 耗时就够了。

### 4.3 转写结果显示

**不做特殊 UI**。agent 拿到转写文本后，正常生成回复（总结 / 提取要点等），MonoDesk
已经在 Chat 流里渲染 agent 回复了。

用户如果想看完整转写文本：

- 鼠标悬停 tool_end block → 「View transcript」链接 → 弹出 Modal 显示 `.asr.txt` 内容
- 或者直接去 Finder / 终端 cat `.monox/workspace/asr/<ts>_<name>.asr.txt`

**第一版不实现 Modal**，只暴露文件 path 给用户 hover 提示：

```
✓ ASR 转写完成 · meeting.m4a · 12.3s · 12,847 字
  ~/.monox/workspace/asr/20260901_223045_meeting.asr.txt
  [点击复制路径]
```

---

## 5. 视觉稿（HTML mockup）

`spec/ui/asr.html`（待做）：展示拖拽 → chip → 发送 → tool_start 转写 → agent 回复的完整流程。

第一版可以不写 mockup，直接进实现。

---

## 6. 错误处理

| 现象 | MonoDesk 端处理 |
|------|------------------|
| 拖入非音频文件 | 显示 toast："Only audio files are supported" |
| 文件 > 100MB | 显示 toast："File too large (max 100MB)" |
| 上传到 attachments 失败（权限） | toast："Upload failed: <error>" |
| agent 调 ASR skill 失败 | tool_end block 显示 ✗ + 错误信息（monoX 端通过 `tool_end.result.error` 字段返回） |

---

## 7. 不做的事

- ❌ 不在 MonoDesk 做实时语音录入（按住说话）
- ❌ 不显示转写原文（第一版）；用户自己 cat 文件
- ❌ 不支持视频文件（哪怕含音轨）
- ❌ 不在 MonoDesk 端调 ASR API（永远走 MonoX skill）

---

## 8. 实现优先级

| 项 | 优先级 |
|---|---|
| 拖拽 → 附件 chip → 发送 | P0 |
| `AudioAttachment` 类型 + ws 帧 | P0 |
| `asr.py transcribe` 触发 + tool block 渲染 | P0 |
| tool_end 显示 ".asr.txt" 路径 + hover 复制 | P1 |
| 完整 HTML 视觉稿 | P2 |
| Modal 显示完整转写 | P2 |
| 实时语音录入 | P3（远期） |

---

## 9. 与 MonoX 协议对齐

MonoDesk 端 ws 帧 schema 必须和 MonoX `core/protocol/events.py` 一字不差。新增的
`AudioAttachment` 类型是 additive 扩展，旧 MonoX Runtime（不识别 audio kind）应该
fallback 到 "unknown attachment" 处理，不应该崩溃。

具体兼容性边界：

- MonoX Runtime < v.skill_asr（没这个 skill）→ MonoDesk 仍然能发送 audio attachment；
  Runtime 会把 path 放在 context 里给 LLM，LLM 可以"假装"处理（或者告诉用户"我没法转写音频"）
- MonoDesk < v.audio_attachment（没这个类型）→ 旧 MonoDesk 发送的附件里没 audio kind，
  MonoX 端当作 `unknown_kind` 处理；不影响图片/文件附件

---

## 10. 测试用例

- 拖拽 `meeting.m4a` 到 Composer → chip 出现 → 发送 → agent 转写 → 渲染回复
- 拖拽 `>100MB` 文件 → toast 提示
- 拖拽 `video.mp4` → toast 提示（不支持）
- 多文件拖拽 → 多 chip → 一次性发送
- 同一个文件拖两次 → 两个 chip（不去重，第一版简单）

---

## 11. 相关 spec

- `MonoX/spec/requirements/asr.md` —— ASR skill 实现（endpoint、协议、持久化）
- `MonoX/spec/ARCHITECTURE.md §12.3` —— ws 帧格式 v1（所有 frame 都在这里定义）
- `MonoX/spec/requirements/async-task.md §3` —— attachments 字段已有定义（image/file）