# tool-error-show-reason: ToolBlock error body 显式 exit_code + 状态区分

> **Bug 类**。当前 `src/components/Conversation.tsx` 的 `ToolBlock` 在 error 状态
> 下点开 body 也看不到「为什么 error」—— stderr 为空时整个 body 空空如也，
> exit_code 完全不显示，timeout / cancelled / error 三种非 ok 状态视觉一致
> 难以区分。

## 问题

当前 `ToolBlock` 的 body 渲染（`Conversation.tsx:221-231`）：

```tsx
{(r.stdout || "").length > 0 && <pre>{r.stdout}</pre>}
{r.status === "error" && (r.stderr || "").length > 0 && (
  <pre className="stderr">{r.stderr}</pre>
)}
{r.truncated && <div className="trunc">… truncated (budget: {r.budget_id || "-"})</div>}
```

### Case 1：stderr 为空但 exit_code != 0

```
[bash] 查 memory 里 反方模拟
       error    20ms     ▼  (折叠)
```

点开 chev → body 完全空（stdout 空 + stderr 空 + status="error" 但 `(r.stderr || "").length > 0` 为 false）。**用户什么都看不到**。

典型触发：bash 命令执行成功但 `grep` 没匹配（exit_code=1，stderr 为空，stdout 为空）。这是个「合法 silent exit」但用户看到「body 是空的」会怀疑工具卡死。

> 注意：这**不是 error**，只是「退出码非 0」。Body 里**不补**任何 stderr 提示文字（避免误导成「有错」），只显示 `exit 1` 让用户自行根据 exit_code 判断语义（grep 没匹配 / test 不存在 / silent fail）。

### Case 2：stderr 有内容但跟 stdout 挤一起

`max-height: 300px`（styles.css:452），长 stdout 会把 stderr 挤到 scroll 下面，加上 `pre { word-break: break-word }`（line 454），整片红色 + 灰色混杂在一起，stderr 不容易找到。

### Case 3：timeout / cancelled 跟 error 视觉无区分

`status="timeout"` / `"cancelled"` / `"error"` 都只渲染 `r.stderr || ""` —— 用户看到「red text」不知道是 timeout 还是普通 error。badge 在 head 上是 string（`r.status` 透出），但 body 里没有对应的 reason 文字。

### Case 4：exit_code 完全没暴露

exit_code 是「为什么 error」最核心的信号：
- `exit_code = 124` → timeout（sandbox 内 30s 默认）
- `exit_code = 1` → 命令返回非 0（grep 无匹配、命令失败）
- `exit_code = 127` → command not found
- `exit_code = -1` → sandbox / tool 自己抛异常
- `exit_code = 137` → SIGKILL（OOM / 强杀）

但当前 `r.exit_code` 字段在 `ToolResultData` 里完全不渲染。

## 目标

1. **exit_code 永远显示在 body 底部**（一行 monospace），不论 status 是 ok / error / timeout / cancelled
2. **timeout / cancelled 状态在 body 顶部各加一行 reason 摘要**（不用点 chev 就知道「为什么」）
3. **stderr 为空时不补任何提示文字**（silent exit 不是 error，避免误导；只靠 `exit_code` 行说明语义）
4. **不改 stdout / truncated 渲染** —— 现有逻辑 OK

## 设计

### Body 渲染规则（改 `Conversation.tsx` 的 `ToolBlock` body 块）

| status | 顶部 reason 行 | stdout | stderr | exit_code 行 |
|---|---|---|---|---|
| ok | 无 | 有则显示 | 无 | 永远显示 `exit 0` |
| error | 无（head badge 已显示 error） | 有则显示 | 有则显示（红）；空不补任何文字 | 永远显示 `exit N` |
| timeout | `timeout after N.NNs`（dim） | 有则显示 | 有则显示（红）；空不补任何文字 | 永远显示 `exit 124` |
| cancelled | `cancelled by user`（dim） | 有则显示 | 无（cancelled 不显示 stderr，避免误导） | 永远显示 `exit -1` |

### exit_code 渲染样式

放在 body 最底部、stdout/stderr 之后、truncated 提示之前。一行：

```
exit 124
```

dim 灰色 + 小字号（11px），跟 truncated 提示对齐。

### timeout 文字

`timeout after Xs` —— X 从 `latency_ms / 1000` 算出来（tool.latencyMs 字段已经存在）。但更准确是从 `core/protocol.py:ToolResult` 拿超时秒数 —— 当前 ToolResultData 没暴露 timeout_seconds 字段，**这一刀只做近似**（用 latency_ms / 1000 估算，最坏情况精度秒级）。**未来 BashTool 加 timeout_seconds 字段时再精确化**，本 spec 不动 wire 协议。

## 不变量

- **不动 stdout 渲染**：现有 `(r.stdout || "").length > 0 && <pre>{r.stdout}</pre>` 原样
- **不动 truncated 渲染**：现有 `r.truncated && <div className="trunc">… truncated (budget: …)</div>` 原样
- **不动 head badge**：仍是 `r.status ?? "done"`
- **不动 ok 状态视觉**：ok 时只多一个 `exit 0` 行，其他不变
- **不动 wire 协议**：ToolResultData 字段不变；timeout 用 latency_ms 估算
- **不动 styles.css 的 .tool-result .trunc / .stderr 颜色**

## 测试

`src/components/Conversation.test.tsx`（新建或合并到现有文件）覆盖：

| Case | status | stdout | stderr | exit_code | 期望 body 元素 |
|---|---|---|---|---|---|
| 1. ok + exit 0 | ok | "" | "" | 0 | 出现 `exit 0`，无 stdout / stderr / reason |
| 2. ok + stdout 有内容 | ok | "hello" | "" | 0 | 出现 `hello` + `exit 0`，无 stderr |
| 3. error + stderr 有内容 | error | "" | "command failed" | 1 | 出现 `command failed` + `exit 1`，无 reason 行 |
| 4. error + stderr 空（silent exit） | error | "" | "" | 1 | 出现 `exit 1`，无 stderr / 无 .t-empty 提示 |
| 5. error + 都有内容 | error | "out" | "err" | 2 | 出现 `out` + `err` + `exit 2` |
| 6. timeout | timeout | "" | "killed" | 124 | 出现 `timeout after 0.02s` + `killed` + `exit 124` |
| 7. cancelled | cancelled | "partial" | "" | -1 | 出现 `cancelled by user` + `partial` + `exit -1` |

## 验证

```bash
cd MonoDesk && npm run typecheck
cd MonoDesk && npx vitest run src/components/Conversation.test.tsx
cd MonoDesk && npx vitest run  # 全部 130+ 测试过
```

### 手工 e2e

1. MonoX 起 run.py → MonoDesk dev → 触发一条 bash error
2. 观察：body 顶部 reason / 中部 stdout+stderr / 底部 `exit N`
3. silent exit 场景：bash `grep foo nonexistent.txt` → body 只显示 `exit 1`，无任何 stderr 提示文字

## 不动

- wire 协议 ToolResultData
- BashTool 实现
- TaskBlock（fork/cancel/poll）
- ok 状态的 stdout / truncated 渲染
- styles.css 现有 .stderr / .trunc 颜色定义
