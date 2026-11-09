# Installation, operation and data / 安装、运行与数据

English reference below · [中文说明](#中文说明)

Unless another working directory is stated, run commands from the repository root. Source paths below are relative to that root.

## Windows

Download and run [NexusRoom-Windows-x64-1.0.0.exe](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Windows-x64-1.0.0.exe). The EXE can be copied on its own and started from another working directory. It supports Windows 10/11 x64. First launch verifies and extracts the complete embedded .NET, Node, Chromium, Harness/Cua and Office environment; no manual runtime installation or extraction is required.

Program files use `%LOCALAPPDATA%/NexusRoom/packages/<version>-<payload-digest>`. Allow approximately 2.0 GB for that cache plus room files and user data. Later launches verify and reuse the cache. The bootstrap prepares embedded resources without downloading them. System WebView2 is preferred; bundled Chromium is the fallback.

User state uses `%LOCALAPPDATA%/NexusRoom/user-state-v1.0.0`, separate from program files. It includes room identity, protected credentials, files and runtime/session data. Moving the EXE or rebuilding the program cache retains user state. First launch creates a default room. Agent profiles start with blank model/key fields and need a compatible user-provided HTTPS model service. Collaboration features work without a key.

Developer launch helpers, from ``:

```powershell
./scripts/start-local.ps1
./scripts/start-local.ps1 -Headless -DataDirectory .local/isolated-test
```

`NEXUS_DATA_DIR` and `NEXUS_PACKAGE_CACHE` are optional testing overrides. The outer EXE is the user entry point; directly executing an internal Host may use a relative development-state default.

## Android and joining

Install [NexusRoom-Android-1.0.0.apk](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Android-1.0.0.apk) on Android 10/API 29 or later. The identical APK is also embedded in the Windows release and available through the control centre. An APK with the same package and signature retains existing device data; a different signature cannot overwrite it. Android backups are disabled. Use system application settings to clear device data deliberately.

Connect Windows and Android to a mutually reachable LAN. Create a room on Windows, scan its invitation or use nearby discovery, and verify the certificate fingerprint on first join. Grant microphone, camera, screen capture, accessibility, clipboard, file and remote-control access only for the required functions. Local settings and system consent are separate.

## Voice, calls and meetings

Windows local voice starts disabled; Android manual offline input is enabled by default. Hold the microphone beside Agent input and release to append transcription to a draft. Confirm sending yourself. Explicitly enabling Hi Nexus permits automatic target selection and Agent submission. A local accepted wake opens that device's bound-room Agent; the red recording dot reflects local capture and disappears when capture ends. Android background opening requires the accessibility service or optional system overlay grant. See [offline voice](VOICE_INTERACTION.md).

Calls, meeting admission and microphone/camera/screen/device-sound controls have separate consent. See [meetings](MEETINGS.md) for media direction, Windows version requirements and Android capture restrictions.

## Network and maintenance

| Port | Role |
| --- | --- |
| TCP 17890 | Loopback-only control centre |
| TLS TCP 17891 | Device HTTPS/WSS |
| UDP 17892 / 5353 | LAN discovery / mDNS |

WebRTC media requires peer UDP reachability. AP isolation, VPN routing or firewall policies can block devices despite successful local startup. `scripts/configure-firewall.ps1` can create explicit LAN rules when run with the required administrator rights.

After closing the application, removing only a versioned program cache causes re-extraction on next launch and retains user state. `scripts/reset-local-state.ps1` intentionally clears the selected local Windows state; inspect its target/options before use. It does not reset Android. `scripts/clean.ps1 -ExternalIntermediates` handles generated build directories rather than user records.

## 中文说明

### Windows

从 [v1.0.0 发布页](https://github.com/megumikatoscut/NexusRoom/releases/tag/v1.0.0) 下载并双击 `NexusRoom-Windows-x64-1.0.0.exe`，支持 Windows 10/11 x64；EXE 可单独复制并从其他工作目录启动。首次运行校验并提取内嵌 .NET、Node、Chromium、Harness/Cua 与 Office，无需手动安装这些运行时。

程序缓存位于 `%LOCALAPPDATA%/NexusRoom/packages/<version>-<payload-digest>`，约需 2 GB，并另为房间文件和用户数据预留空间。后续启动校验并复用缓存，初始化不下载运行时。优先使用系统 WebView2，缺少时使用内嵌 Chromium。

用户状态独立存放于 `%LOCALAPPDATA%/NexusRoom/user-state-v1.0.0`，包含房间身份、受保护凭据、文件和会话数据。移动 EXE 或重建程序缓存不会清除用户状态；首次启动创建默认房间。模型 ID/密钥初始为空，Agent 使用自行配置的兼容 HTTPS 服务，基础协作无需密钥。

在仓库根目录使用上方 `start-local.ps1` 命令启动开发实例；`-Headless -DataDirectory .local/isolated-test` 可运行隔离实例。`NEXUS_DATA_DIR`、`NEXUS_PACKAGE_CACHE` 为可选测试覆盖项。普通用户从外层 EXE 启动；直接运行内部 Host 可能使用相对的开发数据目录。

### Android 与入房

在 Android 10/API 29 及以上安装 `NexusRoom-Android-1.0.0.apk`。相同 APK 也内嵌在 Windows 包中，可经控制中心获取。相同包名和签名升级保留数据；不同签名不能直接覆盖。Android 备份被禁用，需要清理时使用系统应用设置。

两端接入可互通的局域网，在 Windows 创建房间，Android 扫描邀请或通过附近发现加入，首次连接核对证书指纹。按功能需要授予麦克风、相机、屏幕捕获、无障碍、剪贴板、文件和远程控制权限；应用授权与系统同意分别管理。

### 语音与会议

Windows 本地语音默认关闭，Android 手动离线输入默认开启。按住并松开 Agent 输入旁的麦克风将转写追加到草稿，由用户确认发送。Hi Nexus 默认关闭，显式开启后允许自动选择设备并提交 Agent 任务。接受本地唤醒后显示该设备绑定房间的 Agent；红点只表示本地实际录音，捕获结束即消失。Android 后台打开界面需要无障碍服务或可选悬浮窗授权，详见 [离线语音](VOICE_INTERACTION.md)。

通话、会议入会、麦克风/相机/屏幕/设备声音分别授权；媒体方向、Windows 版本和 Android 捕获限制见 [会议指南](MEETINGS.md)。

### 网络与维护

TCP 17890 仅供回环控制中心；TLS TCP 17891 提供设备 HTTPS/WSS；UDP 17892/5353 用于局域网发现/mDNS。WebRTC 还需参与者之间 UDP 可达。AP 隔离、VPN 或防火墙可导致本机已启动但设备不可达；`scripts/configure-firewall.ps1` 需相应管理员权限才能添加局域网规则。

关闭应用后仅删除版本化程序缓存，下次会重新提取，用户状态保留。`scripts/reset-local-state.ps1` 会主动清空选定 Windows 本地状态，使用前检查目标和选项；它不重置 Android。`scripts/clean.ps1 -ExternalIntermediates` 清理构建中间目录，不负责用户记录。
