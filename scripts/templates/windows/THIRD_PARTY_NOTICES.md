# NexusRoom 1.0.0 runtime third-party notices / 运行时第三方声明

This template belongs to `scripts/templates/windows/`. A newly generated Windows package places it at `docs/THIRD_PARTY_NOTICES.md` inside its extracted payload. Every local path below is relative to that extracted payload. These paths identify included runtime resources; they are not links into the companion source repository.

NexusRoom first-party software uses the MIT license in the payload's `LICENSE` file. Each third-party component retains its own copyright, license, notices and redistribution conditions. Preserve the complete runtime and notice trees when redistributing a generated package.

| Component | Version and retained notices |
| --- | --- |
| .NET, ASP.NET Core and Windows Forms | Self-contained .NET 10; MIT and component terms. Runtime notices are retained in `docs/licenses/`, including the runtime-package LICENSE and THIRD-PARTY-NOTICES files. |
| Microsoft WebView2 SDK | 1.0.3650.58; Microsoft terms in `docs/WebView2-LICENSE.txt`. Uses an installed system WebView2 runtime when available; bundled Chromium supplies the fallback. |
| NAudio | 2.2.1; MIT text in `docs/licenses/NAudio-LICENSE.txt`. |
| Sherpa ONNX | 1.13.8; Apache-2.0 text in `docs/licenses/sherpa-onnx-LICENSE.txt`. The Android AAR and embedded APK retain their own license assets. |
| ONNX Runtime | MIT text in `docs/licenses/ONNX-Runtime-LICENSE.txt`. |
| Offline KWS and ASR assets | Fixed bilingual KWS 2025-12-20 and streaming ASR 2023-02-16 release assets; payload model directories are `voice/kws/` and `voice/asr/`. Source identities and hashes are retained in the companion source project's voice-model configuration. |
| Node.js | 24.21.0; Node and bundled component notices in `runtime/node/LICENSE`. |
| Microsoft Visual C++ Runtime | 14.51.36247.0; 12 app-local DLLs beside Node. Complete license text is in `docs/licenses/Microsoft-Visual-C-Runtime-LICENSE.txt`; the original official document is `docs/licenses/Microsoft-Visual-C-Runtime-LICENSE.docx`. The text retains the original French provisions without translation. |
| DeepSeek Harness and Cordis plugins | Harness 0.2.0-rc.2, pinned upstream commit `639ed015397290b3745d163aafe02ffee4aa3f84`; MIT and adjacent component notices. Production inventory and per-file digests are in `runtime/harness/runtime-manifest.json`; notice index is `runtime/harness/THIRD_PARTY_LICENSES.md`. |
| Cua Driver | `@trycua/cua-driver` 0.28.0 and Windows native package; original package notices remain beside the dependencies in `runtime/harness/`. |
| Playwright MCP | `@playwright/mcp` 0.0.80; Apache-2.0 and package notices in `runtime/harness/`. |
| Playwright and Chromium | Matching locked package/browser revisions; Playwright Apache-2.0 and Chromium component notices remain in `runtime/harness/` and `runtime/browsers/`. |
| Harness Office environment | Python 3.12.14, Node 24.21.0, pnpm 11.7.0 and locked Office/document libraries. Environment identity is in `runtime/primary-runtime/runtime.json`; original notices remain with packages under `runtime/primary-runtime/` and `runtime/office-skills/`. |
| React, React DOM, scheduler and qrcode | MIT texts in `docs/licenses/react-LICENSE.txt`, `react-dom-LICENSE.txt`, `scheduler-LICENSE.txt` and `qrcode-LICENSE.txt`. |
| Lucide React | ISC text in `docs/licenses/lucide-react-LICENSE.txt`. |
| AndroidX, OkHttp/Okio, ZXing/ZXing Embedded and Kotlin | Apache-2.0 and applicable dependency notices retained with the companion Android application. |
| Native Android WebRTC SDK | `io.github.webrtc-sdk:android:144.7559.15`; WebRTC core BSD-3-Clause and SDK-wrapper MIT are separate terms. Texts are `docs/licenses/WebRTC-BSD-LICENSE.txt` and `docs/licenses/WebRTC-SDK-MIT-LICENSE.txt`; Android also carries its license assets. |

The EXE extracts its complete embedded runtime and license trees into the current user's program cache. Its distribution bootstrap uses the .NET Framework included in supported Windows installations; the application Host carries its self-contained .NET 10 runtime. Program cache and user state remain separate.

Visual C++ DLLs are taken from the Microsoft-signed redistributable with pinned archive and per-file hashes. The application does not execute that redistributable installer. The official license source URL, retrieval record and original document SHA-256 accompany the text license.

The fallback Chromium keeps its sandbox. Its startup may grant inherited read/execute access for Windows AppContainer package groups to the bundled browser directory; it does not grant write access or disable the sandbox. Browser runtime packages may contain their own FFmpeg utility. ADB and scrcpy are development tools and are not part of the distributed application.

Android remote control uses platform capture/accessibility APIs. Calls and meetings use the pinned WebRTC dependency and platform camera/audio/capture APIs. Windows meeting device sound uses process loopback, separately from NAudio's PC remote-control path. Android shared sound travels through encrypted DataChannel PCM; Windows shared sound uses a separate RTP track.

Original upstream sources include DeepSeek Harness, Sherpa ONNX, ONNX Runtime, .NET, Node.js, React, NAudio, Playwright and the Android WebRTC SDK. The companion source repository contains the pinned source/provenance records and a fuller source-oriented component guide. Those records describe dependencies; they do not replace the original license terms retained in this runtime.

## 中文说明

本文件为源码仓库 scripts/templates/windows/ 下的运行包声明模板，新构建包将其放入载荷 docs/THIRD_PARTY_NOTICES.md。上方所有本地路径均相对于提取出的运行包；各组件版本与原始许可位置详见同表，声明不替代依赖自己的版权、许可、通知及再分发条件。

自有软件使用载荷 LICENSE 中的 MIT；分发时保留完整 runtime 与 notice 树。.NET 10 自包含运行时、WebView2、NAudio、Sherpa/ONNX、离线模型、Node、VC++、Harness/Cordis、Cua、Playwright/Chromium、Office/Python/pnpm、React、Lucide 和 Android 依赖分别遵循原条款。WebRTC 核心 BSD 与 SDK 包装 MIT 属于不同层，须同时保留。

EXE 将完整运行时与许可释放至当前用户程序缓存，引导使用系统 .NET Framework，Host 自带 .NET 10；缓存与用户状态分离。VC++ DLL 来自 Microsoft 签名安装包，固定归档/逐文件哈希，不执行该安装器；原始许可、官方来源 URL、检索记录、DOCX 哈希及法文条款均保留。

Chromium 保持沙箱，必要时仅对内嵌浏览器目录授予 AppContainer 组继承的读/执行，不授权写入。浏览器可能携带其自有 FFmpeg，ADB/scrcpy 不随应用分发。Android 远控使用系统捕获/无障碍；会议使用固定 WebRTC 与系统音视频 API。Windows 会议进程回环与 PC 远控的 NAudio 分开，Android 共享 PCM 经加密 DataChannel，Windows 共享声音经独立 RTP。

上游来源包括 Harness、Sherpa、ONNX Runtime、.NET、Node、React、NAudio、Playwright、Android WebRTC；源码仓库保留固定来源记录与更完整组件指南。原始许可证正文不翻译或改写。
