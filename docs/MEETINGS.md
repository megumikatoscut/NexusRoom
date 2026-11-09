# Room calls and video meetings / 房间通话与视频会议

English reference below · [中文说明](#中文说明)

Unless another working directory is stated, run commands from the repository root. Source paths are relative to that root.

NexusRoom 1.0.0 supports Android-to-Android and Windows-to-Android audio calls and meetings in a room. Windows coordinates admission and signalling; participants exchange WebRTC media on the LAN.

## Calls and admission

Choose a room device and place a call. The recipient accepts or rejects it; unanswered calls expire after 45 seconds. A manual call/accept action requests microphone access and attempts to enable audio. Either party can mute or hang up. Private calls carry audio only. A physical device can have only one ringing/active call or meeting across its rooms; competing requests return busy.

For meetings, choose a title and visibility. Public room meetings can be seen and joined by room members; nonparticipants cannot read chat. Private meetings require an invitation accepted by its recipient; unauthorized members cannot inspect participants, chat or signalling. Invitations expire after 120 seconds. Meetings support up to eight participants. Only the host invites/removes members or ends the meeting. Host departure/disconnection ends it; another participant's disconnection removes that participant.

A voluntary public-meeting leaver may rejoin. A removed participant needs a new invitation. Leaving a private meeting also requires a new invitation. Ended/revoked connections cannot continue receiving media or messages.

## Media and display

Microphone, camera, screen and device sound have independent switches and start disabled for meeting entry. The browser provides its own screen-sharing stop control. Android requests system MediaProjection consent for each capture; meeting capture and Android remote-control capture are mutually exclusive. Screen sharing grants viewing, without granting keyboard or pointer control.

Camera frames preserve their full aspect ratio. Both clients provide screen-view fullscreen; Android fullscreen supports landscape and restores the original presentation on exit. Capture stop, participant removal or meeting end closes the corresponding view and releases stale frames.

Chat is bounded in memory: at most 200 messages, each at most 2,000 UTF-16 code units. It is not restored after Host restart. The package contains no meeting recordings.

## Device sound and echo handling

Device sound starts disabled and requires active screen sharing. Stopping capture, leaving, disconnecting or revoking membership releases sound capture. If device sound is unavailable, the application keeps screen sharing and reports the missing capability.

| Sender | Capture source and boundary |
| --- | --- |
| Windows | Process loopback on Windows 11/Server 2022 build 20348 or later. The embedded WebView/Chromium must be an actual Host child process; the Host resolves its TCP peer PID. Host and child-process sound are excluded to prevent meeting playback feedback. Ordinary localhost browser sessions do not receive this capture capability. Earlier Windows systems can still share the screen. |
| Android | Current MediaProjection and microphone permission; only permitted USAGE_MEDIA/USAGE_GAME sources, excluding NexusRoom's own UID. Protected or capture-prohibited application sound and voice-call usages remain unavailable. |

Windows device sound can include other capturable application output even when one window is selected; it is not restricted to that window. Android's visual capture picker does not override the source application's audio policy.

Each client uses one remote playback path and avoids audible local preview. Windows requests browser echo processing; Android uses SDK voice processing and VOICE_COMMUNICATION routing. Android-to-Android shared PCM is outside the SDK RTP mixer; when supported, platform AEC supplies a system-output reference. Without it, microphone use falls back to earpiece/headphones. Physical echo performance depends on device, route and volume and requires its own measurement.

Windows shared sound uses independent RTP MID 3, separate from microphone MID 0. Android shared sound uses the encrypted `nr-screen-audio` DataChannel, 48 kHz mono PCM16, unordered delivery, zero retransmits and bounded queues. This transport is for live sound; it does not provide reliable file delivery. See the [wire reference](API.md).

## Agent scheduling

Choose the current task device as the Agent target and ask, for example, “Call Pixel 8” or “Create a private project meeting and invite the room devices.” The registered `arrange_communication` tool sends a request/creates a meeting using the authenticated task device identity. Request mode approves the specific action before sending; automatic mode sends it directly. The recipient still decides whether to answer or accept. A scheduling receipt proves creation, not successful media connection or remote consent.

Use unique device IDs when names/models are ambiguous. Tools cannot answer on another device, enable its camera or grant screen capture.

## Connectivity and verification

Participants need mutually reachable LAN UDP in addition to certificate-pinned HTTPS/WSS signalling. No external TURN configuration is included. AP isolation, enterprise UDP restrictions and VPN routing can block media independently of signalling. Android microphone/camera permission and capture foreground-service notifications remain system controlled. Lock screens and protected content retain platform restrictions.

Read [validation](VALIDATION.md) for recorded devices/media directions and untested areas, and [API](API.md) for admission and signalling contracts.

## 中文说明

NexusRoom 1.0.0 支持房间内 Android–Android 与 Windows–Android 音频通话和会议，Windows 管理入会/信令，媒体经局域网 WebRTC 交换。

### 呼叫与入会

选择房间设备呼叫，由接收方接受/拒绝；45 秒未接听自动过期。手动呼叫或接听会请求麦克风并尝试开启声音，双方可静音或挂断，私密通话仅承载音频。同一物理设备跨房间只能有一个振铃/活动通话或会议，冲突返回忙。

会议需标题和可见性。公开会议对房间成员可见且可加入，但未入会者不能读聊天；私密会议需本人接受邀请，未授权成员不能查看参与者、聊天或信令。邀请 120 秒过期，最多八人；主持人独有邀请/移除/结束权限。主持人离开或断线结束会议，普通成员断线仅移除本人。主动离开公开会可再加入；被移除或离开私密会需新邀请。已结束/撤权连接不能继续接收消息或媒体。

### 媒体与显示

麦克风、相机、屏幕、设备声音开关独立，会议入会时均关闭。浏览器提供系统停屏入口；Android 每次 MediaProjection 需系统确认，会议捕获与远控手机捕获互斥。共享屏幕只授予观看。相机保持完整比例，两端支持屏幕全屏，Android 全屏支持横屏并在退出恢复；捕获停止、成员移除或会议结束释放视图和旧帧。

聊天仅在内存中保存最多 200 条，每条最多 2,000 UTF-16 单元，Host 重启不恢复；包内无会议录制。

### 设备声音与回声

设备声音默认关闭且必须先共享屏幕；停止捕获、离会、断线、撤权均释放。不可用时保留屏幕并报告缺失能力。

Windows 使用 Windows 11/Server 2022 build 20348+ 进程回环，要求 WebView/Chromium 确为 Host 子进程并校验 TCP PID，排除 Host 及其子进程声音以避免回放反馈；普通 localhost 浏览器无此能力，旧系统仍可共享屏幕。只选一个窗口也可能包含其他可捕获应用声音。

Android 需现有 MediaProjection 与麦克风权限，仅捕获允许的 USAGE_MEDIA/USAGE_GAME 来源并排除本应用 UID；受保护/禁止捕获/通话音频不可用。系统选屏不覆盖来源应用的音频政策。

两端均使用一条远端回放路径且不播放本地预览。Windows 请求浏览器回声处理；Android 使用 SDK 语音处理和 VOICE_COMMUNICATION 路由。Android–Android 共享 PCM 不进入 SDK RTP 混音器，支持时使用平台 AEC 的系统输出参考，否则麦克风回落到听筒/耳机。实际回声效果取决于设备、路由和音量，需物理测试。

Windows 共享声音独占 RTP MID 3，麦克风为 MID 0；Android 使用加密 `nr-screen-audio` DataChannel：48 kHz、单声道 PCM16、无序、零重传、有界队列，适合实时声音而非可靠文件交付。

### Agent 调度与网络

将当前任务设备设为 Agent 目标，可要求“呼叫 Pixel 8”或“创建私密项目会议并邀请房间设备”。`arrange_communication` 以认证任务设备身份创建请求；request 审批具体动作，automatic 直接发送，但接收者仍控制接听/入会。调度回执证明请求已创建，不证明媒体连通。名称歧义时使用唯一 ID；工具不能代另一设备接听或授予相机/屏幕权限。

除固定证书 HTTPS/WSS 外还需参与者间 LAN UDP 可达，未附外部 TURN 配置。AP 隔离、企业 UDP 策略、VPN 可能只阻断媒体；Android 权限与前台服务通知、锁屏及受保护内容仍由系统约束。验证范围见 [VALIDATION.md](VALIDATION.md)，协议细节见 [API.md](API.md)。
