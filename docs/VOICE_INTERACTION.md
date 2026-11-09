# Offline voice on Windows and Android / 双端离线语音

English reference below · [中文说明](#中文说明)

Unless another working directory is stated, run commands from the repository root. Source paths are relative to that root.

Both clients use Sherpa ONNX 1.13.8 CPU inference with bundled English/Chinese models. Capture, KWS, VAD and ASR remain on the local device. Automatic Agent reasoning and text/tool results use the room's configured model service; offline transcription does not provide offline model reasoning.

## Manual input and automatic wake

Windows local voice starts disabled. Enable it in the Agent panel, then hold the microphone and release to transcribe. A keyboard-focused control accepts hold/release with Space or Enter. Android manual voice input is enabled by default and requests microphone permission on first use. Both clients append transcription to the existing draft and require the user to send it. Touch cancellation, room changes, leaving the foreground or hiding the input panel cancels manual capture without clearing the draft.

Hi Nexus starts disabled on both platforms. Configure a valid room model profile and PC workspace before enabling it. Wake capture submits automatically through the normal Agent router and Stop control; enabling this switch authorizes that automatic submission path.

Windows Host capture can listen for its bound room while the control centre is hidden, subject to system microphone privacy settings. Android defaults to foreground listening. Background listening requires explicit enablement while the app is foreground, microphone permission, Android 13+ notification permission and a legally started `microphone` foreground service. The persistent notification offers Stop. Android 14+ while-in-use restrictions, permission removal, microphone conflicts and system termination can interrupt it. Calls/meetings pause voice microphone use; disabling voice/wake releases capture.

## Local presentation

After an accepted local wake and valid capture claim, that device opens the bound room's Agent immediately. Windows restores its WebView2/Chromium window if minimized. Android uses a validated in-process event. Remote room broadcasts/tasks cannot trigger local wake navigation. Each local event is handled once; dismissing the panel does not reopen it for the same event.

A red dot beside the Agent title marks actual local wake/manual recording. It disappears on stop, transcription, cancellation, error or disablement. Waiting for Hi Nexus and remote-device recordings do not activate it. Windows reduced-motion preference uses a steady dot.

Android background Activity opening requires the enabled NexusRoom accessibility service or optional system overlay grant. Without this authority, system background-launch rules apply; the persistent notification can open the bound-room Agent. This is an application panel, not an independent system overlay. Lock-screen and OEM background behavior require device-specific acceptance.

## Models and bounded resources

| Purpose | Pinned asset |
| --- | --- |
| KWS | `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` |
| Streaming bilingual ASR | `sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16` |
| Native runtime | Sherpa ONNX 1.13.8; Windows NuGet/C API and Android AAR/JNI |

Eight required model files total 65,590,913 bytes (about 62.6 MiB). Their sources and SHA-256 values are in [voice-models.json](../config/voice-models.json). The [third-party directory](../third_party/README.md) supplies the models/API references. Windows payload paths are `voice/kws` and `voice/asr`; Android uses local assets. `scripts/prepare-voice.ps1` verifies identities before build/package.

Audio uses 16 kHz mono PCM. KWS uses one CPU thread; ASR uses one on Windows and two on Android. ASR resources are created for capture and released at completion. Windows uses 40 ms frames, a 128-frame maximum queue, adaptive RMS VAD plus recognizer endpoint, 40-second maximum capture and seven-second no-speech timeout; error recovery retries after five seconds. Android uses 20 ms frames, approximately 1.1 seconds of post-speech silence, 25-second maximum and seven-second no-speech timeout. Each preserves at most 400 ms of pre-roll at wake acceptance. Bounded in-memory audio is not saved as raw recording files.

## Room arbitration and idempotency

The room Host authenticates Android events with existing pinned TLS/member tokens and determines source identity itself. Windows local events use the same coordinator. Every local event has a GUID `eventId`; different sources arriving within 3,000 ms can share a room `wakeId`. A new event from the same source creates a separate wake. Host receive time defines the window, without requiring clock synchronization. Capture claims expire after 65 seconds.

Within a wake, conservative normalization removes the wake prefix, selected politeness/device prefixes and ordinary terminal punctuation/spacing to derive a room task identity. Decimal/operator/path contents and quoted case/spacing are preserved. Repeated network submissions and equivalent normalized text return the existing task. Distinct text remains separate. The first valid submission fixes source, model profile and workspace. Before Agent dispatch, the ledger atomically persists `dispatching`; an incomplete dispatch seen after Host restart becomes `interrupted` and is not replayed automatically.

Candidates are online Agent-authorized devices in that room and are rechecked for permission/occupancy before execution. Explicit PC/phone/current-device references and unique names take precedence. “This device” binds to the submitting source. Ambiguous device wording uses the selected room model for text intent; its output must match an exact candidate ID. Unresolved intent fails for clarification instead of choosing a device in another room. Deduplication is scoped to the room, associated wake and normalized text; it is not speaker identification.

## Modules, APIs and evidence

Host modules are under `src/NexusRoom.Host/Voice/`: model loading, Windows service/activity, coordinator, wake ledger, intent resolver, endpoints and Windows bridge. React voice hooks/components are under `src/NexusRoom.Web/src/voice/`. Android VoiceController/VoiceModels/VoiceVad/VoiceService and application lifecycle code are under `android/app/src/main/`. Debug fixtures remain under `app/src/debug/` and are excluded from release.

The [API guide](API.md) documents local `/api/voice` and member `/device/voice` contracts. The normal Agent execution loop, budgets, approval surfaces and Stop flow are reused. Version-specific state stores memberships, drafts and histories on user devices; release files contain none of those records.

See [validation scope](VALIDATION.md), the [test index](../tests/README.md) and the relevant reusable checks. UI fixtures, local model/WAV inference, actual microphones, room model routing, emulator presentation and physical phone lifecycle require separate validation. Acoustic cross-device timing, noisy environments and OEM background durability remain distinct acceptance work.

## 中文说明

两端使用 Sherpa ONNX 1.13.8 CPU 推理与内嵌中英模型。捕获、关键词检测 KWS、VAD 和 ASR 转写均在设备本地；Agent 自动推理及文字/工具结果使用房间配置的模型服务，离线转写不等于离线模型推理。

### 手动输入与自动唤醒

Windows 本地语音默认关闭，在 Agent 面板开启后按住并松开麦克风转写；键盘聚焦时支持 Space/Enter 按下/松开。Android 手动语音默认开启，首次请求麦克风。两端将转写追加草稿，用户自行发送。触摸取消、换房、离开前台或隐藏输入面板取消手动捕获且保留草稿。

Hi Nexus 两端默认关闭，启用前配置有效房间模型和 PC 工作区；该开关授权经常规 Agent 路由自动选目标/提交，沿用 Stop。Windows 控制中心隐藏时可为绑定房间监听，受系统麦克风隐私设置约束。Android 默认前台监听；后台监听需在前台显式开启，具备麦克风、Android 13+ 通知权限并合法启动 microphone 前台服务，常驻通知提供 Stop。Android 14+ 使用中限制、撤权、麦克风冲突或系统终止均可中断。通话/会议暂停语音麦克风，关闭语音/唤醒会释放。

### 本地展示

本地唤醒被接受且捕获声明有效后，该设备立即打开绑定房间 Agent；Windows 恢复最小化 WebView2/Chromium，Android 使用经验证进程内事件。远程广播/任务不能触发本地唤醒导航，每个事件只处理一次，关闭面板不被同一事件重新打开。

标题旁红点仅代表本地实际手动/唤醒录音，停止、转写、取消、错误或禁用时消失；待唤醒与远程录音不点亮。Windows 减少动态效果设置下使用静态红点。Android 后台打开 Activity 需 NexusRoom 无障碍或可选系统悬浮窗授权，否则服从系统后台启动限制，可从常驻通知打开；这是应用内面板。锁屏/OEM 后台行为需逐设备验证。

### 模型与资源边界

固定 KWS 为 `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`，流式双语 ASR 为 `sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16`；运行时为 Windows NuGet/C API 与 Android AAR/JNI。八个必要文件共 65,590,913 字节，约 62.6 MiB，来源/哈希见 [voice-models.json](../config/voice-models.json)。模型在 third_party，Windows 载荷位于 voice/kws、voice/asr，Android 为本地 assets；prepare-voice.ps1 在构建/打包前校验。

音频为 16 kHz 单声道 PCM，KWS 单 CPU 线程，ASR 为 Windows 一线程、Android 两线程。ASR 按捕获创建并在结束释放。Windows 40 ms 帧、有界 128 帧队列、自适应 RMS VAD 加识别终点，最多 40 秒，七秒无声超时，错误五秒后重试。Android 20 ms 帧、约 1.1 秒语后静音、最多 25 秒、七秒无声超时。接受唤醒最多保留 400 ms 预录，有界音频只驻内存，不写原始录音文件。

### 房间仲裁与幂等

Host 通过现有固定 TLS/成员 token 认证 Android 事件并自行确定来源，Windows 使用同一协调器。每本地事件含 GUID eventId；不同来源在 Host 接收时间 3,000 ms 内可共享 wakeId，同一来源的新事件另建唤醒，不要求设备时钟同步。捕获声明 65 秒过期。

同次唤醒保守移除唤醒前缀、指定礼貌/设备前缀和普通末尾标点/空白，生成任务身份；保留小数/运算符/路径以及引号内容的大小写和空白。重复提交或等价文本返回已有任务，不同文本分别处理；首个有效提交固定来源、模型与工作区。分发前原子持久化 dispatching，重启发现未完成分发则标为 interrupted，不自动重放。

候选必须为该房间在线且 Agent 已授权的设备，执行前重验权限/占用；显式 PC/手机/当前设备和唯一名称优先，“本设备”绑定来源。歧义使用当前模型解析文字意图，输出必须精确匹配候选 ID；无法解析则要求澄清，不跳到其他房间。去重仅限房间、同次唤醒与归一化文字，不做人声识别。

### 模块与验证

Host Voice 模块负责模型、服务、协调器、账本、目标解析和端点；React voice hooks/components 与 Android VoiceController/VoiceModels/VoiceVad/VoiceService 管理各自 UI/生命周期。debug fixture 在 app/src/debug，不进入正式 APK。API 详见 [API.md](API.md)，复用普通 Agent 循环、预算、审批和 Stop。成员、草稿、历史留在用户设备，发布包不含这些状态。

[验证范围](VALIDATION.md) 与 [测试索引](../tests/README.md) 区分 UI fixture、本地模型/WAV、真实麦克风、模型路由、模拟器展示和物理手机生命周期。跨设备声学时序、噪声与 OEM 后台持久性仍需专门验收。
