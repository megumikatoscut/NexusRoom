# NexusRoom 1.0.0 architecture / 系统架构

English reference below · [中文说明](#中文说明)

Source paths below are relative to the repository root. Paths beginning with `runtime/`, `Agent/` or `voice/` describe the extracted Windows payload.

The system consists of a Windows ASP.NET Core/WinForms host, a React control centre and a native Java Android companion. Production Android control uses platform services, not ADB or scrcpy. The current module layout is documented in [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md).

## Host lifecycle and persistence

`Program.cs` creates `StateStore`, registers room/device/file/Agent/communication services, configures Kestrel listeners and serves the local UI through WebView2 or bundled Chromium. A port-scoped mutex prevents duplicate hosts. Headless startup exposes the same service surface without a desktop window.

Schema 2 stores rooms, membership records, transfers, model profiles and explicit shared-folder grants. Each room has its own identity and model profiles; the initial model identifier and key are blank. Credentials/configuration are encrypted with DPAPI CurrentUser. Certificate, bootstrap material, audit records and room files are generated locally, never delivered as source or executable data.

The distribution bootstrap extracts the Host and complete runtimes into `%LOCALAPPDATA%/NexusRoom/packages/<version>-<payload-digest>`. It sets `NEXUS_DATA_DIR` to `%LOCALAPPDATA%/NexusRoom/user-state-v1.0.0` unless explicitly overridden. Program cache and user state are separate; moving the EXE preserves state. Direct internal Host execution retains its original relative `.local` default, so users should launch the outer EXE. Development uses `.local/development-v1.0.0`. See [RUNNING.md](RUNNING.md).

Android preferences are version-scoped through `ReleaseStorage`; membership credentials use Keystore/AES-GCM. Cloud backup and data extraction are disabled. Installation with the same package and signature retains that device's preferences; APK contents themselves include no preferences or histories. Android system consent remains device-local.

The v1.0.0 namespace stores memberships, drafts, model credentials and Agent history for the current application. Windows creates a default room on first use. Web localStorage keys use the same application version. An explicit developer `NEXUS_DATA_DIR` override takes precedence over the default directory.

## Offline voice

An independent Voice module owns optional local microphone capture, one-thread CPU KWS and on-demand bilingual ASR. Manual hold/release only fills a draft; wake capture submits through the existing Agent router in automatic mode. Room-scoped event/wake/task IDs, persisted dispatch guards and candidate validation provide idempotent submission. Android foreground microphone service startup follows while-in-use permissions, with a persistent notification and stop action. The Agent loops, request approvals, task budget and stop mechanism remain the execution path. See [VOICE_INTERACTION.md](VOICE_INTERACTION.md) for lifecycle, models, arbitration boundaries and verification.

Local wake presentation is independent of the room task feed. WindowsVoiceService publishes a process-local accepted wake and recording room; DesktopWindow restores the local WebView2/Chromium window and React handles each event once. Android VoiceController launches MainActivity with a validated in-process local event, reuses the bound membership, and opens the in-app Agent. Background Activity launch uses an existing accessibility-service authority or an optional user overlay grant; the microphone service alone does not grant Activity launch privileges. Both UI recording dots reflect device-local capture and disappear during transcription/cancellation; remote task updates never trigger the local recording indicator or foreground navigation.

## Rooms and authorities

Room member bearer tokens are random and hashed at rest. A physical identifier correlates memberships but does not authenticate a request. Revocation invalidates tokens and closes active sessions. Offline leave disables local operations and retries acknowledgement until the host observes it. The local administrator capability, host-wide external Agent token, room membership, control lease and system media/accessibility consent are distinct authorities.

Android RoomService arbitrates one controlling membership with a random lease, checking ownership when queued operations execute. The deadline is 45 seconds with authenticated renewal. Competing rooms are busy; ordinary file exchange remains independent. Disconnect, permission removal, lease expiry or system capture stop releases resources. The Windows PcWorkCoordinator arbitrates PC remote sessions, PC Harness tasks and external PC tool operations across rooms.

## Network and discovery

| Surface | Transport / checks |
| --- | --- |
| Control centre | HTTP on loopback TCP 17890; bootstrap URL fragment exchanges for an HttpOnly SameSite=Strict cookie; listener/Host/Origin/mutation checks |
| Android | Certificate-pinned HTTPS/WSS on TCP 17891; room scope derived from authenticated member token |
| Discovery | UDP 17892 plus DNS-SD `_nexusroom._tcp.local` on mDNS 5353; public room metadata only |
| Meetings | Host-authorized room signalling; peer LAN WebRTC with separate fixed media slots |
| External tools | Host-issued bearer capability, explicit grants and room/workspace checks |

Discovery and invitations never grant control. LAN access, firewall and AP isolation determine reachability; media establishment requires peer-to-peer UDP reachability. The local UI selects room context through `X-Nexus-Room` or a roomId query; a phone cannot choose another room by changing those fields.

## Remote control and files

Windows remote viewing/control uses the phone's MediaProjection, encoder, accessibility service and lease. Android-to-PC control uses GDI desktop frames, WASAPI playback capture and ordered Windows input; the phone maps complete-frame coordinates and its native IME commits text. Each PC session requires local approval and separate grants. UAC/secure desktops, protected media and current-user privilege limits remain enforced by Windows.

Room file exchange streams content, checks SHA-256 and enforces 512 MiB file / 10 GiB library limits. Shared-folder grants for external tools differ from the native Harness process's current-user privileges. A PC working directory locates task files; the process operates with current-user OS permissions. Clipboard sharing remains an independent permission.

## Agent execution

`AgentRouter` authenticates room and target. Android tasks run in `AgentEngine/AgentTools`; PC tasks run in a pinned Harness SDK subprocess using bundled Node, desktop/browser tools and Office runtime. NexusRoom overlays provide task approvals, call/step/time budgets and room file/communication bridges without modifying the pinned upstream source.

Model profiles support HTTPS Chat Completions and Responses providers. Windows supplies a task's key through controlled subprocess configuration and removes secrets from diagnostics; task outputs must not be treated as authority for successful side effects. Native tools still act with the executing device user's capabilities. See [PC_AGENT.md](PC_AGENT.md).

## Calls and meetings

CommunicationService manages audio calls, public/private meetings, invitations, participant permissions and signalling. Invitations expire; recipients consent themselves. A meeting supports up to eight participants. Microphone, camera, screen and shared device sound are independent media flags. Media signalling only relays between admitted participants in the same active session.

WebRTC uses four RTP slots for microphone, camera, screen and Windows shared sound; Android shared PCM travels over the encrypted `nr-screen-audio` DataChannel. Queues are bounded and stale media is discarded. Android capture policy and Windows process-loopback capability govern device sound. Calls/meetings are not recorded into the package. Protocol details are in [API.md](API.md) and platform limits in [MEETINGS.md](MEETINGS.md).

## Build and distribution

Vite builds the control centre into Host wwwroot. .NET publishes a self-contained win-x64 payload. Gradle builds Android, and the signing script uses private material outside Git or an explicit development identity. A distribution-only Windows bootstrap compresses that complete payload into a single EXE. SHA-256 checks cover the embedded archive and every file. First extraction uses staging and an atomic rename under a per-user mutex; cached files are verified before launch. The bootstrap uses the .NET Framework provided by Windows, while the Host uses its embedded .NET 10 runtime. Runtime and license trees remain complete inside the EXE.

The immutable Harness source archive and its original `HARNESS_SOURCE.json` verify pinned upstream identity; see [third-party sources](../third_party/README.md). Runtime manifests verify bundled dependencies. This repository retains source, technical documentation and reusable tests; executables and checksums are published through GitHub Releases. Historical reports and demonstrations are outside this repository. Local runtime state is excluded. See [VALIDATION.md](VALIDATION.md), [DISTRIBUTION.md](DISTRIBUTION.md) and [LICENSING.md](LICENSING.md).

## 中文说明

NexusRoom 由 Windows ASP.NET Core/WinForms Host、React 控制中心和原生 Java Android 伴侣组成。Android 生产远控采用系统 API。源码路径以仓库根目录为基准；`runtime/`、`Agent/`、`voice/` 在运行时说明中指 EXE 提取出的载荷目录。模块位置见 [目录结构](PROJECT_STRUCTURE.md)。

### 生命周期与存储

`Program.cs` 创建 `StateStore`、注册房间/设备/文件/Agent/通信服务、配置 Kestrel 并经 WebView2 或 Chromium 展示 UI。按端口区分的互斥量防止重复 Host，无界面启动提供相同服务。

Schema 2 保存房间、成员、传输、模型配置和显式共享文件夹授权；房间身份和模型配置相互隔离。初始模型 ID 与密钥为空，凭据/配置通过 DPAPI CurrentUser 加密。证书、引导材料、审计和房间文件由本机生成。

外层引导程序提取到 `%LOCALAPPDATA%/NexusRoom/packages/<version>-<payload-digest>`，并默认将 `NEXUS_DATA_DIR` 设置为独立的 `%LOCALAPPDATA%/NexusRoom/user-state-v1.0.0`。移动 EXE 保留用户状态；直接执行内部 Host 保留相对 `.local` 默认值，开发使用 `.local/development-v1.0.0`。显式数据目录覆盖优先。

Android 的 `ReleaseStorage` 按版本隔离偏好，Keystore/AES-GCM 保护成员凭据；禁用云备份与数据提取。同包名/签名安装保留该设备数据，APK 不携带偏好或历史。Windows 首次启动创建默认房间，Web localStorage 同样按版本区分。

### 离线语音

独立 Voice 模块负责可选麦克风、单线程 CPU KWS 和按需双语 ASR。手动按住/松开只填草稿；唤醒捕获沿常规 Agent 路由以 automatic 模式提交。房间级事件/唤醒/任务 ID、持久化分发保护与候选验证避免重复执行。Android 麦克风前台服务遵循使用中权限，提供常驻通知和停止入口；任务预算、审批和停止仍经过原 Agent 执行链。

本地唤醒展示与房间任务广播分离。WindowsVoiceService 发布进程内接受事件与录音房间，DesktopWindow 恢复本地窗口，React 对每事件只处理一次。Android VoiceController 验证进程内事件后复用绑定成员身份打开 Agent。后台 Activity 启动需要已启用的无障碍权限或可选悬浮窗授权，单独麦克风服务不足以取得该权限。远程任务不会点亮本地录音标记或强制前台导航；转写/取消后标记消失。

### 房间与权限

成员 Bearer token 随机生成、落盘只留哈希；物理设备 ID 仅用于关联。撤销使 token 失效并关闭会话；离线离房先停用本地操作并重试通知 Host。本地管理员、外部 Agent token、房间成员、控制租约、系统媒体/无障碍同意属于不同权限。

Android RoomService 以随机租约仲裁一个控制成员，在排队操作实际执行时核查所有权；45 秒到期且需认证续期。冲突房间返回忙，文件交换独立。断开、撤权、租约超时或系统停止捕获均释放资源。Windows PcWorkCoordinator 在各房间之间仲裁 PC 远控、Harness 与外部 PC 工具。

### 网络与文件

控制中心仅监听回环 HTTP TCP 17890，通过 URL fragment 引导换取 HttpOnly/SameSite=Strict cookie，并校验监听器、Host、Origin 和变更请求。Android 使用证书固定 HTTPS/WSS TCP 17891，房间从成员 token 推导。UDP 17892 与 mDNS 5353 的 `_nexusroom._tcp.local` 仅广播公开元数据。会议经 Host 授权信令后在局域网点对点交换 WebRTC；外部工具另需能力 token 和房间/工作区授权。邀请或发现本身不授予控制权限。

PC 查看/控制手机使用 MediaProjection、编码器、无障碍和租约；手机控制 PC 使用 GDI 帧、WASAPI 回放捕获与有序输入，手机原生 IME 提交文字。每次 PC 会话均需本地确认及独立授权；UAC/安全桌面、受保护内容和当前用户权限仍有效。

文件以流传输并核验 SHA-256，单文件上限 512 MiB，活动共享库总限额 10 GiB。外部 API 文件夹授权不约束原生 Harness 进程；工作目录仅定位任务文件，进程仍以当前用户权限运行。剪贴板权限独立。

### Agent 与通信

`AgentRouter` 验证房间与目标。Android 的 AgentEngine/AgentTools 在手机执行；PC 使用固定 Harness SDK 子进程和内嵌 Node、桌面/浏览器/Office 工具。NexusRoom 独立覆盖层提供审批、调用/步骤/时间预算及文件/通信桥，不修改固定上游源。

模型配置支持 HTTPS Chat Completions/Responses，Windows 通过受控子进程配置传递密钥并在诊断中隐藏。工具输出不能替代对实际副作用的验证；原生工具受执行设备用户权限约束。

CommunicationService 管理通话、公开/私密会议、邀请、参与者及信令。邀请会过期且由接收者决定，会议最多八人；麦克风、相机、屏幕、共享设备声音独立。信令仅在同一活动会话已入会成员间转发。

WebRTC 使用麦克风、相机、屏幕与 Windows 共享声音四个 RTP 槽；Android 共享 PCM 使用加密 `nr-screen-audio` DataChannel。有界队列丢弃过期媒体；平台播放捕获与 Windows 进程回环能力决定设备声音可用性。发布包不含会议录制。

### 构建与分发

Vite 将 UI 写入 Host wwwroot，.NET 发布自包含 win-x64，Gradle 构建 Android；签名使用仓库外私钥或显式开发身份。Windows 单文件引导程序压缩完整载荷，对压缩包和各文件校验 SHA-256，首次在用户互斥量下暂存并原子发布缓存，后续启动重新校验。引导程序使用 Windows 自带 .NET Framework；Host 使用内嵌 .NET 10。完整依赖运行时及许可树保留于 EXE。

Harness 不可变归档与 `HARNESS_SOURCE.json` 保留上游身份，运行时清单校验内嵌依赖。本仓库分发源码、技术文档和可复用测试；安装包通过 GitHub Releases 发布，历史报告、演示与个人运行状态不属于源码输入。验证范围见 [VALIDATION.md](VALIDATION.md)。
