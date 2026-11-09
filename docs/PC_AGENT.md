# Windows PC Agent 1.0.0 / Windows 智能体

English reference below · [中文说明](#中文说明)

Unless another working directory is stated, run commands from the repository root. Source paths are relative to that root.

PC Harness tasks, Android-to-Windows remote control and external PC tools share machine occupancy. An existing remote session/task can make another room's request busy. Agent permission is separate from screen, input, sound and clipboard grants. Full desktop tools act with the current Windows user's capabilities; the selected working directory is not an OS sandbox.

## Runtime and overlays

The preserved Windows EXE bundles Node 24.21.0 and DeepSeek Harness 0.2.0-rc.2 at commit `639ed015397290b3745d163aafe02ffee4aa3f84`. NexusRoom keeps its own version 1.0.0 and adds separate task overlays instead of changing pinned upstream source.

| Payload component | Role |
| --- | --- |
| Official CLI, sdk-app, sdk-jsonrpc-server and base plugin | Model/session transport and native file/PowerShell tools |
| computer-use / native Cua driver | Desktop tools and platform dependency |
| browser-use / Playwright MCP | Browser tools with matching bundled Chromium |
| `Agent/harness-approval.mjs` | One-time room approval bridge |
| `Agent/harness-limits.mjs` | Model/tool budget hooks |
| `Agent/harness-room-files.mjs` | Device listing, room file delivery and communication scheduling |
| `Agent/harness-sdk.patch.yml` | Task-specific model/plugin configuration template |

Paths in this table describe the extracted runtime payload, not the repository root. Runtime manifests and adjacent notices remain embedded in the preserved EXE. The Office environment includes Python 3.12.14, Node 24.21.0, pnpm 11.7.0 and locked document libraries. The Host sets `DSH_BUNDLED_PRIMARY_RUNTIME`; an explicit `DSH_PRIMARY_RUNTIME` override selects another environment.

## Target and working directory

The Windows target is `pc:<roomId>`; Android targets are member IDs. `AgentRouter` validates the authenticated room and invokes `PcAgentRunner` or Android execution. Both client UIs can submit PC tasks and browse a PC folder as the working directory. Browsing shows roots, home, parent, folders and file metadata, supports name search before truncation, and limits each file/folder category to 1,000 returned entries. The Host revalidates the chosen directory at task start. The default is the current Windows user's home directory.

New rooms enable PC Agent by default. Disabling it immediately cancels that room's active PC runs. Model identifiers and keys start blank. External `/agent/v1` folder/handle grants apply to that separate API and do not constrain Harness native tools.

Runtime lookup uses an explicit `NEXUS_HARNESS_DIR`, an extracted payload runtime or restored pinned source as supported by the runner. Bundled execution selects its own Node/browser and removes inherited `NODE_PATH`/`NODE_OPTIONS`. Native Office loading uses verified short-path junctions under `%TEMP%/NexusRoom-runtime/`, plus controlled preserve-symlinks flags. Keep the bundled hierarchy intact.

Source restoration and rebuilding start with [third-party instructions](../third_party/README.md) and `scripts/setup-harness.ps1`. Production dependencies are built in an external cache; matching browser/Office resources come from the release payload.

## Room tools

| Tool | Contract |
| --- | --- |
| `list_room_devices({})` | Current task room's Windows/Android identities, names, models, online state, file/Agent grants and busy state; includes PC `selfId` |
| `send_file_to_phone({path,deviceId?})` | Existing readable Windows file; relative paths resolve against task cwd. Omitted device ID requires exactly one online phone. |
| `arrange_communication(...)` | Create a call or public/private meeting and invitations using the task's PC identity |

For file delivery, the Host checks task/room permission, target online state, file/Agent grants, lease, cancellation and capacity. A file is limited to 512 MiB; the shared active library quota is 10 GiB across rooms. Request mode approves the concrete path, size and recipient before import/delivery. `verified=true` requires the Android saved-file SHA-256 receipt. Retries in the same task reuse identity for unchanged content and verify whether the receipt still represents an existing file.

The bridge uses a current-user named pipe bound to the task/process. Model arguments cannot replace room, mode or cwd. Delivery results contain `ok,verified,fileId,deviceId,name,size,sha256,savedTo,alreadyReceived`; a failure/cancelled transfer must not be reported complete.

Communication scheduling accepts:

```json
{"action":"call","targetId":"unique-room-device-id"}
```

```json
{"action":"meeting","title":"Project discussion","visibility":"private","inviteeIds":["device-a","device-b"]}
```

Calls require `targetId`; meetings use invitation IDs and reject `targetId`. Titles allow up to 80 characters; visibility defaults to private. The runtime default title remains the application's localized meeting title. At most 32 invitation targets and eight participants are accepted. Scheduling creates requests; recipients retain control of admission and media. Natural task completion does not cancel an already created meeting/call.

## Models, approvals and budgets

A run snapshots `apiType,baseUrl,model,apiKey,maxCalls,maxSteps,timeoutSeconds`. Chat Completions maps to `openai-completions`; Responses maps to `openai-responses`. Terminal `/chat/completions` or `/responses` is removed from a configured endpoint. Existing `/vN` paths are preserved; otherwise `/v1` is appended. Provider-specific versioned paths must stay intact. The model ID passes through unchanged. Keys are supplied to the task subprocess environment, omitted from overlay files and redacted from diagnostics.

Request mode maps to Harness `workspace-write` / `ask`. Pending tools appear in the room approval service; Windows uses `/api/approvals/{id}` and an authenticated same-room phone uses `/device/agent/approve`. Approval is one-time, expires after three minutes and is withdrawn by Stop. Automatic mode maps to `danger-full-access` within current-user permissions. The mode is fixed at run creation.

`llm/stream` checks the model-call budget before sending; `tools/execute` checks step budget before side effects. A process's sessions/subagents share budgets. Exceeding them produces `NEXUSROOM_LIMIT`; Host cancellation enforces total timeout. Defaults are 24 calls, 24 steps and 900 seconds, configurable per model profile.

## Lifecycle and stored data

Each PC run starts a Harness SDK JSON-RPC subprocess. The Host initializes it, submits a prompt and accepts line-oriented protocol output with bounded diagnostics. Run ID is the session ID. `DSH_HOME` is the user-state `harness/<roomId>` directory, separate from installation and task cwd; telemetry is disabled on this path.

Success requires the completed turn-end and absence of approval/budget failure. Completion, Stop, timeout and exceptions withdraw approvals, request official shutdown, close stdin, allow five seconds for cleanup, then terminate the process tree if needed. The Host confirms exit and deletes the task patch before publishing terminal state. Normal Host shutdown waits for task cleanup; power loss or forcibly killing the Host bypasses that normal shutdown sequence.

The in-memory run list does not restore ended runs after restart; Harness session material can persist under user state. The UI retains at most 600 bounded events. Runtime packages contain no user sessions.

## Verification

See [validation scope](VALIDATION.md) and the [test index](../tests/README.md) for reproducible checks; historical model-evaluation reports are not distributed in this source repository. Package SDK initialization, fixture contracts, native Cua checks, actual provider calls and physical phone delivery establish different facts.

`tests/pc-agent-live.mjs` uses configured private state and explicit test options. File/communication live scripts need an authorized test phone and valid provider. Use isolated state and keep keys outside the repository. Browser checks use isolated sessions by default. A screenshot-driven task additionally needs a model with image support; desktop tools retain Windows UAC and Android consent boundaries.

## 中文说明

PC Harness、手机控制 Windows 与外部 PC 工具共同占用机器；已有任务/会话可使其他房间请求返回忙。Agent 权限与屏幕/输入/声音/剪贴板独立。完整桌面工具以当前 Windows 用户能力执行，任务工作目录不构成 OS 沙箱。

### 运行时与独立覆盖层

Windows EXE 固定 Node 24.21.0 和 DeepSeek Harness 0.2.0-rc.2，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。NexusRoom 自身版本 1.0.0，以独立覆盖层添加能力，不修改上游固定源码。

官方 CLI/sdk-app/sdk-jsonrpc-server/base plugin 提供模型会话、原生文件及 PowerShell；computer-use/Cua 提供桌面工具；browser-use/Playwright MCP 使用匹配 Chromium。提取载荷的 Agent/harness-approval、harness-limits、harness-room-files 分别提供一次性审批、预算、房间文件/通信桥，harness-sdk.patch.yml 为每任务配置模板。Office 环境固定 Python 3.12.14、Node 24.21.0、pnpm 11.7.0 及锁定库。Host 设置 `DSH_BUNDLED_PRIMARY_RUNTIME`，显式 `DSH_PRIMARY_RUNTIME` 可覆盖。

### 目标与工作目录

Windows 目标 ID 为 `pc:<roomId>`，Android 为成员 ID；AgentRouter 认证后转发至 PcAgentRunner 或手机。两端 UI 可发起 PC 任务并浏览工作目录，支持根目录、主目录、父目录、文件元数据和名称查询，先筛选再将文件/文件夹各限 1,000。启动重验路径，默认 Windows 当前用户主目录。

新房间默认启用 PC Agent；禁用立即取消该房间 PC 任务。模型 ID/密钥初始为空。外部 /agent/v1 文件夹/句柄授权仅约束该 API，不限制 Harness 原生工具。运行时可从 `NEXUS_HARNESS_DIR`、提取载荷或已恢复固定源查找；内嵌执行选择自己的 Node/浏览器并移除继承的 NODE_PATH/NODE_OPTIONS。Office 使用 %TEMP%/NexusRoom-runtime 下校验过的短路径连接及受控 preserve-symlinks 标记，保持层级完整。

源码恢复见 [第三方依赖](../third_party/README.md) 与 setup-harness.ps1，生产依赖在外部缓存构建，匹配浏览器/Office 来自发布载荷。

### 房间工具

`list_room_devices` 返回当前任务房间 Windows/Android 身份、名称/型号、在线、文件/Agent 授权和忙状态，并提供 PC selfId。`send_file_to_phone` 接受现有可读路径，相对路径按任务 cwd；省略 deviceId 仅在一部在线手机时有效。`arrange_communication` 以任务 PC 身份创建通话或公开/私密会议与邀请。

文件桥检查任务/房间权限、目标在线、文件/Agent 授权、租约、取消和容量；单文件 512 MiB，跨房间活动库 10 GiB。request 审批具体路径、大小、接收者后导入，verified=true 必须有 Android 保存文件的 SHA-256 回执。同任务未改内容重试复用身份并确认回执对应的文件仍存在。

命名管道绑定当前用户、任务和进程；模型参数不能替换 room/mode/cwd。结果含 ok/verified/fileId/deviceId/name/size/sha256/savedTo/alreadyReceived，失败或取消不得报告成功。

call 需要 targetId 且拒绝会议参数；meeting 需要邀请 ID 且拒绝 targetId。标题最多 80 字符，默认 private，未指定标题时沿用应用本地化默认。最多 32 个邀请目标、八人。任务自然结束不取消已创建会话，接收者仍保留入会/媒体同意。

### 模型、审批与预算

每运行快照 apiType/baseUrl/model/apiKey/maxCalls/maxSteps/timeoutSeconds。Chat Completions 对应 openai-completions，Responses 对应 openai-responses；去除末尾 chat/completions 或 responses，保留现有 /vN，其他情况追加 /v1，不破坏服务商版本路径。模型 ID 原样传递，密钥仅进入子进程环境，不写覆盖文件，并在诊断中隐藏。

request 对应 workspace-write/ask，具体工具在房间审批服务显示；PC 经 /api/approvals/{id}，同房间手机经 /device/agent/approve。审批一次性、三分钟失效，Stop 撤回。automatic 对应当前用户权限内 danger-full-access，模式创建后固定。

llm/stream 发送前检查调用预算，tools/execute 副作用前检查步骤预算，同进程会话/子智能体共享预算。超限返回 NEXUSROOM_LIMIT，Host 取消保证总超时。默认 24 次调用、24 步、900 秒，可在模型配置中调整。

### 生命周期与验证

每运行启动 Harness SDK JSON-RPC 子进程，初始化并提交提示，接收有界逐行协议诊断，runId 即 sessionId。DSH_HOME 为用户状态 harness/<roomId>，与安装/工作目录分离，该路径禁用遥测。

成功需 turn-end 完成且无审批/预算失败。完成、停止、超时和异常均撤回审批、请求正常关闭、关闭 stdin，等待五秒后必要时终止进程树；确认退出并删除任务配置后才发布终态。正常 Host 退出会等清理，断电或强杀无法保证该流程。结束任务列表不在重启后恢复，但 Harness 会话材料可持久保留；UI 最多 600 条有界事件，发布运行时不含用户会话。

不同检查分别验证 SDK 初始化、契约、原生 Cua、真实服务商和物理收件，不能互相替代。`tests/pc-agent-live.mjs` 及文件/通信 live 脚本需要隔离状态、授权测试手机与有效模型；凭据放在仓库外。浏览器默认隔离，截图任务还需支持图片的模型；Windows UAC 与 Android 系统同意边界保留。验证范围见 [VALIDATION.md](VALIDATION.md)。
