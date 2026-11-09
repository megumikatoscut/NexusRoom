# NexusRoom

[![Build both clients](https://github.com/megumikatoscut/NexusRoom/actions/workflows/build.yml/badge.svg)](https://github.com/megumikatoscut/NexusRoom/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/megumikatoscut/NexusRoom)](https://github.com/megumikatoscut/NexusRoom/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**LAN-based collaboration and device-local Agents for Windows and Android.**

**面向 Windows 与 Android 的局域网协作与设备端 Agent 系统。**

NexusRoom connects Windows and Android through rooms on a reachable LAN, combining bidirectional remote control, file and clipboard exchange, calls and meetings, device-local AI tasks and offline voice input. Collaboration works without an AI account; Agent reasoning requires a user-configured compatible HTTPS model service.

NexusRoom 通过局域网房间连接 Windows 与 Android，提供双向远程控制、文件与剪贴板共享、通话与会议、设备端 AI 任务和离线语音输入。基础协作无需 AI 账号；Agent 推理需要用户自行配置兼容的 HTTPS 模型服务。

## Download v1.0.0 / 下载 v1.0.0

| Platform / 平台 | Download / 下载 | Requirements / 要求 |
| --- | --- | --- |
| Windows x64 | [NexusRoom-Windows-x64-1.0.0.exe](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Windows-x64-1.0.0.exe) | Windows 10/11 x64; about 2 GB cache / 约 2 GB 缓存空间 |
| Android | [NexusRoom-Android-1.0.0.apk](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Android-1.0.0.apk) | Android 10 / API 29+; versionCode 15 |

See [release details and SHA-256 checksums](docs/releases/v1.0.0/README.md). Both application versions are **1.0.0**, with Git tag **v1.0.0**. Installers live in GitHub Releases; this repository contains source, build dependencies, scripts, tests and documentation.

发布说明和 SHA-256 校验值见 [v1.0.0 发布记录](docs/releases/v1.0.0/README.md)。双端应用版本均为 **1.0.0**，Git 标签为 **v1.0.0**。安装包存放在 GitHub Releases，仓库保存源码、构建依赖、脚本、测试与文档。

## Start using NexusRoom / 开始使用

1. Launch the Windows EXE; first launch extracts the bundled runtime into the current user's cache. / 启动 Windows EXE，首次运行会将内置运行时解压到当前用户缓存。
2. Install the Android APK and connect both devices to a reachable LAN. / 安装 Android APK，两端连接可互通的局域网。
3. Create a room on Windows, join from Android through an invitation or nearby discovery, and verify the certificate fingerprint. / 在 Windows 创建房间，Android 通过邀请或附近发现加入，并核对证书指纹。
4. Grant permissions for the selected features. Configure a model profile in room settings for Agent tasks. / 按功能需要授权；使用 Agent 时在房间设置中配置模型。

The local control centre uses TCP 17890, device TLS APIs use TCP 17891, and discovery uses UDP 17892/5353. See [running and troubleshooting](docs/RUNNING.md).

本机控制中心使用 TCP 17890，设备 TLS 接口使用 TCP 17891，发现服务使用 UDP 17892/5353，详见 [运行与排障指南](docs/RUNNING.md)。

## Features / 功能

| Area / 模块 | Capabilities / 能力 |
| --- | --- |
| Rooms / 房间 | LAN discovery, invitations, pinned TLS, identities and scoped grants / 局域网发现、邀请、TLS 证书绑定、设备身份与权限 |
| Remote control / 远程控制 | Windows → Android and Android → Windows, capture and input / 双向屏幕传输与输入控制 |
| Files and clipboard / 文件与剪贴板 | Room file exchange, Agent file bridging and clipboard sharing / 房间文件交换、Agent 文件桥接与剪贴板共享 |
| Communication / 通信 | WebRTC audio/video calls and room meetings / WebRTC 音视频通话与房间会议 |
| Agents / 智能体 | PC tasks through pinned DeepSeek Harness; Android tasks run on the phone; request/automatic modes / PC 端通过固定版本 DeepSeek Harness 执行，Android 任务在手机端执行，支持请求与自动模式 |
| Voice / 语音 | Local KWS, VAD and bilingual ASR using Sherpa ONNX; optional wake-to-Agent / Sherpa ONNX 本地唤醒、活动检测和中英语音识别，可选语音唤醒 Agent |

Voice recognition runs locally. Agent task content uses the configured model service. Control and Agent tools use granted application permissions and the current OS user's capabilities; see [security](SECURITY.md).

语音识别在本地运行。Agent 任务内容会使用配置的模型服务。控制与 Agent 工具受应用授权及当前系统用户权限约束，详见 [安全说明](SECURITY.md)。

## Develop / 开发

Windows Host uses **ASP.NET Core 10, Windows Forms and WebView2**, with a bundled Chromium fallback. The control centre uses **React 19, TypeScript and Vite**. Android uses **Java 17, native APIs and WebRTC**. Offline voice uses **Sherpa ONNX 1.13.8**.

Windows 主机采用 **ASP.NET Core 10、Windows Forms 与 WebView2**，提供内置 Chromium 回退；控制中心采用 **React 19、TypeScript 与 Vite**；Android 采用 **Java 17、原生 API 与 WebRTC**；离线语音采用 **Sherpa ONNX 1.13.8**。

| Tool / 工具 | Pinned requirement / 固定要求 |
| --- | --- |
| OS / Shell | Windows x64; PowerShell 5.1 or 7 |
| .NET SDK | 10.0.401 |
| Node.js / pnpm | 24.21.0 / 11.7.0; prepared by scripts / 由脚本准备 |
| Java | JDK 17–23; source target 17 / 源码目标 17 |
| Android SDK | Platform 35, build-tools 35.0.0, platform-tools |
| Gradle / AGP | 8.11.1 / 8.9.1 |

After installing the tools, run from the repository root. Compilation alone needs no release binaries or signing credentials:

安装工具后，在仓库根目录执行。仅编译无需发布安装包或签名凭据：

```powershell
git clone https://github.com/megumikatoscut/NexusRoom.git
Set-Location NexusRoom
./scripts/setup-dev.ps1 -ConfigureOnly -NoInstall -AndroidSdk $env:ANDROID_HOME
./scripts/build.ps1 -SkipPackage -SkipTests
```

For the broader runtime regressions, first download the matching release payload. Some tests need devices, system consent or a configured model:

运行完整运行时回归测试前，先下载匹配的发布产物。部分测试还需要实体设备、系统授权或模型服务：

```powershell
./scripts/download-release.ps1
./scripts/verify.ps1
```

See [setup](docs/SETUP.md), [building](docs/BUILDING.md) and [tests](tests/README.md). Exact versions and integrity values are in [release.json](release.json), [dependencies.lock.json](dependencies.lock.json), npm/NuGet locks and Gradle configuration. Full Windows packaging reuses matching bundled runtime resources from the release EXE or an explicit runtime source. Production Android signing needs external maintainer credentials; development signatures have a different update identity.

详见 [环境配置](docs/SETUP.md)、[构建指南](docs/BUILDING.md) 与 [测试指南](tests/README.md)。精确版本与完整性信息保存在 [release.json](release.json)、[dependencies.lock.json](dependencies.lock.json)、npm/NuGet 锁文件和 Gradle 配置中。完整 Windows 打包需要现有 EXE 中的匹配运行时或显式提供运行时来源。Android 正式签名依赖外部维护者凭据，开发签名使用不同的更新身份。

## Repository layout / 仓库结构

```text
NexusRoom/
├── .github/               CI and templates / CI 与协作模板
├── android/               Native Android app / Android 原生应用
├── config/                Examples and model metadata / 示例与模型元数据
├── docs/                  Guides, licenses and release records / 指南、许可与发布记录
├── PIC/                   Artwork and icons / 图稿与图标
├── scripts/               Setup, build, tests and packaging / 配置、构建、测试与打包
├── src/NexusRoom.Host/    Windows host and shell / Windows 主机与外壳
├── src/NexusRoom.Web/     React control centre / React 控制中心
├── tests/                 Automated and device tests / 自动化与设备测试
├── third_party/           Pinned source and offline models / 固定上游源码与离线模型
├── NexusRoom.sln
└── release.json
```

`artifacts/` is an ignored local directory for release downloads. SDKs, installed dependencies, generated outputs and private state stay out of Git. Models, the Android AAR and immutable upstream source are retained to match locked build inputs.

`artifacts/` 是被 Git 忽略的本地安装包目录。SDK、已安装依赖、生成文件和私有状态不进入 Git。仓库保留模型、Android AAR 和不可变上游源码，以匹配固定构建输入。

## Documentation / 文档

[Index / 索引](docs/README.md) · [Architecture / 架构](docs/ARCHITECTURE.md) · [API](docs/API.md) · [PC Agent](docs/PC_AGENT.md) · [Meetings / 会议](docs/MEETINGS.md) · [Voice / 语音](docs/VOICE_INTERACTION.md) · [Validation / 验证](docs/VALIDATION.md) · [Changelog / 更新日志](CHANGELOG.md)

## Contributing and license / 贡献与许可

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). First-party source uses [MIT](LICENSE); dependencies retain their own [licenses and notices](docs/THIRD_PARTY_NOTICES.md). Original third-party license texts remain in their source languages.

参与开发请阅读 [贡献指南](CONTRIBUTING.md) 与 [安全说明](SECURITY.md)。项目自有源码采用 [MIT](LICENSE)，依赖遵循各自 [许可与声明](docs/THIRD_PARTY_NOTICES.md)。第三方许可原文保持原始语言。

Created by **Haoyu Wang, Chenyu Zhang and Tianyu Wang**, South China University of Technology. / 项目团队：**Haoyu Wang、Chenyu Zhang、Tianyu Wang**，华南理工大学。
