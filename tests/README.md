# Tests and reproduction / 测试与复现

Run commands from the repository root unless another directory is stated.

Reusable checks and fixtures remain under `tests/`. See [validation scope](../docs/VALIDATION.md) for current checks and limitations; historical report bundles are outside this repository.

## Build and keyless regression

```powershell
./scripts/setup-dev.ps1 -ConfigureOnly -NoInstall -AndroidSdk $env:ANDROID_HOME
./scripts/build.ps1 -SkipPackage
# With the required build outputs already present:
./scripts/verify.ps1
./scripts/verify.ps1 -DesktopRegression
npm test --prefix ./tests
node ./scripts/check-documentation.mjs
```

The environment helpers resolve pinned Node, .NET, JDK and Android SDK tools. npm dependencies use external caches/junctions. `verify.ps1` covers integration, Host, Agent, files, remote control, communication, voice and Android JVM checks as configured by the script. Device tests and provider calls require their own explicit prerequisites.

## Native and physical checks

```powershell
./scripts/verify-voice-native.ps1 -Microphone -Presentation
./scripts/verify-voice-apk.ps1 -Apk ./artifacts/NexusRoom-Android-1.0.0.apk
./tests/windows-single-exe.ps1 -Gui
```

Native presentation checks may show a short-lived test window. Voice Core/Room/UI checks respectively exercise coordinator code, real Host TLS/WSS and production React with controlled APIs. Debug-only Android fixtures provide actual JNI/AudioRecord and presentation entry points; they are excluded from the release APK.

For an explicitly selected physical test phone:

```powershell
adb devices -l
$env:NEXUS_QA_SERIAL = '<selected-test-device-serial>'
. ./scripts/common.ps1
Set-NexusBuildEnvironment
$node = Get-NexusReleaseNode
& $node.Executable ./tests/current-android-smoke.mjs
```

This smoke uses the phone's saved room and production UI. It requires microphone permission and a visible room. It checks APK identity/version, input and voice settings, local recording indicators, cancellation, restart, Home/return and forged-wake rejection. It restores voice/panel settings and preserves the draft. Output defaults to generated `.local/` state; public evidence uses a separately selected output path.

## Isolated UI run

In a first terminal:

```powershell
./scripts/start-local.ps1 -Headless -DataDirectory .local/isolated-ui
```

In another terminal with the same source working directory:

```powershell
. ./scripts/common.ps1
Set-NexusBuildEnvironment
$node = Get-NexusReleaseNode
$env:NEXUS_UI_LAUNCH_FILE = (Resolve-Path .local/isolated-ui/launch.dat).Path
& $node.Executable ./tests/ui.mjs
```

Browser checks use isolated headless sessions by default. Do not interpret browser fixtures as physical camera, acoustic echo or screen-capture acceptance.

## Live-model and device scripts

`pc-agent-live.mjs`, `voice-agent-live.mjs`, `voice-android-agent-live.mjs` and the communication/file live scripts need isolated Host state, configured model profiles and authorized devices. `pc-room-files-live.mjs` verifies actual phone receipt and hashes plus approve/reject/cancel paths. `android-file-transfer-live.mjs --help` describes the reverse phone-to-PC model workflow. Keep credentials and private state outside the repository.

Classify new outcomes as source/unit, contract/fixture, emulator, physical device or real provider. Record the execution date, artifact hash, command and method. Historical report-generation code is not part of this source repository.

Fresh validation outputs use an external version-specific cache rather than overwrite the preserved historical records. Newly packaged clients likewise use external `release-output/Windows/` and `release-output/Android/` directories; `NEXUS_BUILD_ARTIFACT_DIR` may select another dedicated absolute output directory outside the repository. Downloaded clients under `artifacts/` remain the test subjects unless a check explicitly selects another artifact.

## 中文说明

除另行说明外，在仓库根目录执行。可复用测试与夹具位于 tests/，当前检查和限制见 [验证范围](../docs/VALIDATION.md)，历史报告材料不在本仓库。

### 构建与无需密钥的回归

先通过 `scripts/download-release.ps1` 获取匹配资源，再按上方构建代码块配置工具、编译并回归；已有输出时可单独运行 verify.ps1，-DesktopRegression 增加桌面交互。环境辅助脚本解析固定 Node/.NET/JDK/SDK，npm 使用外部缓存与连接。verify 覆盖集成、Host、Agent、文件、远控、通信、语音及配置的 Android JVM 检查；物理设备和真实服务商另需前提。

### 原生与物理检查

verify-voice-native 的 Microphone/Presentation 选项可能显示短时窗口；verify-voice-apk 从本地 artifacts/ 检查 APK；windows-single-exe -Gui 检查运行包。Voice Core/Room/UI 分别针对协调器、真实 Host TLS/WSS 和带受控 API 的生产 React。Android JNI/AudioRecord/展示 debug 夹具不进入正式 APK。

物理手机需先 adb devices -l 并明确设置 NEXUS_QA_SERIAL，再执行上方 current-android-smoke 命令。它使用手机已保存房间与生产 UI，需要麦克风权限和可见房间，检查 APK 身份/版本、输入/语音设置、录音标记、取消/重启/Home 返回及伪造唤醒拒绝，恢复语音/面板设置并保留草稿。输出路径由脚本配置，不把个人状态或结果提交 Git。

### 隔离 UI 与真实模型

使用 start-local.ps1 -Headless -DataDirectory .local/isolated-ui，在另一同仓库终端设置 NEXUS_UI_LAUNCH_FILE 后运行 ui.mjs。浏览器默认隔离无头会话，不能据此认定物理相机、声学回声或屏幕捕获通过。

pc-agent-live、voice-agent-live、voice-android-agent-live 及通信/文件 live 脚本需要隔离 Host 状态、模型配置和授权设备。pc-room-files-live 检查实际手机收件哈希与批准/拒绝/取消；android-file-transfer-live --help 说明手机向 PC 流程。凭据与私有状态置于仓库外。

新结果注明源码/单元、契约/夹具、模拟器、物理设备或真实服务商类型，记录日期、命令、方法和产物哈希。新证据写入外部版本缓存，不覆盖历史记录；新包使用外部 release-output/Windows 与 Android，NEXUS_BUILD_ARTIFACT_DIR 可指定仓库外专用绝对目录。默认测试 subjects 为本地 artifacts/ 下载包，显式指定其他产物时另记身份。
