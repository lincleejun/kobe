# multiman 子系统 1 — Role-Runner（Design + Plan）

> S0 已建好 role/task/claim/transition/materialize/heartbeat/sweeper。S1 唯一新增：**role-runner
> 常驻进程**，把这些拼成自动闭环；并修一个 materialize 标题小瑕疵。
> 上位：roadmap + S0 spec。日期：2026-06-05。状态：待 review。

## 决策（已拍板）
- 执行模型：**tmux + claude + hook 检测（kobe 原生）**——可附上观察=「点开就是正常 kobe task」。
- 完成语义：turn_complete → **报 in_review**（人/orchestrator 再推 done/打回），不静默收工。
- runner 形态：`kobe multiman runner --role <id>`，前台常驻循环（对应「不同 terminal」）。
- 唤醒：engine/bus 提示 + 慢轮询兜底（S0 #4b 决议）。超时：靠 S0 running-lease sweeper 兜底。

## 已核实可复用的 kobe 积木（file:line 见 explore 记录）
- `tmux/panes/terminal/tmux.ts` `ensureSession(opts)`：建/复用分离 tmux session，在 worktree 跑 claude。
- `tmux/prompt-delivery.ts` `waitForEnginePane` / `deliverFirstPrompt` / `pasteAndSubmit`：投 prompt。
- daemon `engine-state` channel（hooks 全局，`ensureGlobalKobeHooks()`）：广播 `running/turn_complete/idle/error/rate_limited`。
- `engine/claude-code-local/history.ts` `readHistory(sessionId)` / `turn-detector.ts` `latestCompletion(worktree)`：取结果。
- session id：tmux 窗口选项 `@kobe_session_id`。

## 架构：纯循环（multiman）+ kobe 执行器（kobe）
- **`packages/multiman/src/runner.ts`**（纯、可测）：注入端口的编排循环
  ```
  RunnerDeps = {
    claim(): Promise<Task|null>
    transitionRunning(id): Promise<Task>        // = transition(id,'running')，触发物化
    heartbeat(id): void
    report(id, status, result?, error?): Promise<Task>
    execute(task): Promise<{status:'in_review'|'failed'|'blocked', result?, error?}>  // kobe 执行器
    waitForWork(): Promise<void>                 // engine/bus 提示 + 慢轮询
    onHeartbeatTick?(id): 启停心跳
  }
  runOnce(deps): claim→(无→waitForWork) | (有→transitionRunning→execute→report)
  runLoop(deps, {stop}): while(!stop) runOnce
  ```
  - execute 内部 heartbeat 续约（execute 期间定时 heartbeat(id)）。
- **`packages/kobe/src/cli/multiman-runner-cmd.ts`**（kobe，用 tmux/engine）：实现 `execute(task)`：
  ensureSession(claude, work_dir) → deliverFirstPrompt(title+body) → 读 @kobe_session_id →
  订阅 engine-state 等本任务 turn_complete（rate_limited→blocked；error/turn_failed→failed）→
  readHistory 取最后 assistant 消息为 result → 返回 {in_review, result}。
  `kobe multiman runner --role <id>`：连 daemon（MultimanClient + subscribe role:runner 持 lifetime），
  组装 RunnerDeps 跑 runLoop（前台，Ctrl-C 优雅停）。

## materialize 标题修复
S0 materialize 没把 task.title 传给 kobe，导致 kobe TUI 里标题是 ULID。改 server.ts 的 adoptWorktree
适配器：传 `title: t.title`（kobe adoptWorktree 接受 title）。加断言/手测确认 kobe task 标题=multiman 标题。

## 实现任务（TDD）
1. `runner.ts` 纯循环 + `runner.test.ts`（fake deps）：claim 到任务→transitionRunning→execute→report(in_review)；无任务→waitForWork 被调；execute 抛错/返回 failed→report(failed)；execute 返回 blocked→report(blocked)；execute 期间 heartbeat 被调。
2. materialize 标题修复（server.ts 适配器传 title）+ 手测确认。
3. kobe `multiman-runner-cmd.ts` 执行器 + `runner` 子命令：typecheck/lint 干净；手测：起 daemon + 建 role/task(带 repo) + 跑 runner，观察它领任务→tmux 起 claude→投 prompt→（claude 干完）→任务变 in_review，result 落库。
4. 文档：`kobe multiman runner` 用法。

## 验收（M1）
- `runner.test.ts` 全绿；双 typecheck + lint 干净。
- 手测：一个终端跑 `kobe multiman runner --role X`，另一终端 `km task create --role X --repo <git>`；
  runner 自动领取→物化→tmux 起 claude→投 prompt→turn_complete→任务 in_review 且 result 有内容；
  `tmux -L kobe attach -t kobe-<kobeTaskId>` 能附上看（点开=正常 kobe task）。
- kobe TUI 里该任务标题是人类标题（非 ULID）。

## 不做（留后续）
- 多任务并发 runner（先单任务串行；并发是 fan-out 优化）。
- runner 自动把 in_review 推 done（人/S3 orchestrator 决定）。
- 「待人工派发」状态（S3）。
