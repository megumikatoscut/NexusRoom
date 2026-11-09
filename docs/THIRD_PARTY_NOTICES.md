# NexusRoom v1.0.0 third-party components / 第三方组件声明

English reference below · [中文说明](#中文说明)

Source notice paths are relative to the repository root. Paths beginning with `runtime/` refer to the extracted Windows payload embedded in the published EXE.

Licenses and copyright notices below apply to their respective components. NexusRoom is an independent application; each dependency retains its upstream copyright and license.

| Component | Version / license / source |
| --- | --- |
| .NET, ASP.NET Core, Windows Forms | Self-contained .NET 10 runtime; MIT; https://github.com/dotnet/runtime and https://github.com/dotnet/aspnetcore |
| Microsoft WebView2 SDK | 1.0.3650.58; Microsoft license; docs/WebView2-LICENSE.txt; uses the OS runtime when present and bundled Chromium otherwise |
| NAudio | 2.2.1; MIT; docs/licenses/NAudio-LICENSE.txt; https://github.com/naudio/NAudio; default playback-endpoint loopback for PC remote control |
| Sherpa ONNX | 1.13.8; Apache-2.0; docs/licenses/sherpa-onnx-LICENSE.txt; https://github.com/k2-fsa/sherpa-onnx; official Windows NuGet/C API and Android static ONNX Runtime AAR |
| ONNX Runtime | MIT; docs/licenses/ONNX-Runtime-LICENSE.txt; https://github.com/microsoft/onnxruntime; embedded CPU inference runtime in official Sherpa packages |
| Offline KWS/ASR model assets | Fixed upstream KWS 2025-12-20 and bilingual streaming ASR 2023-02-16 release assets; file identity and source paths in config/voice-models.json; https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models and https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models |
| Node.js | 24.21.0; MIT plus bundled component notices; runtime/node/LICENSE; https://nodejs.org/ |
| Microsoft Visual C++ Runtime | 14.51.36247.0; Microsoft license; 12 app-local DLLs in runtime/node; [complete license text](licenses/Microsoft-Visual-C-Runtime-LICENSE.txt) and [original official DOCX](licenses/Microsoft-Visual-C-Runtime-LICENSE.docx); https://aka.ms/VCRedistLicense |
| DeepSeek Harness and Cordis plugins | Harness 0.2.0-rc.2, commit 639ed015397290b3745d163aafe02ffee4aa3f84; MIT; https://github.com/deepseek-ai/deepseek-harness |
| Cua Driver | @trycua/cua-driver 0.28.0 and its Windows native package; package license texts; https://github.com/trycua/cua |
| Playwright MCP | @playwright/mcp 0.0.80; Apache-2.0; https://github.com/microsoft/playwright-mcp |
| Playwright and Chromium | Matching package/browser revisions; Apache-2.0 and Chromium component notices, retained in runtime/harness and runtime/browsers; https://github.com/microsoft/playwright |
| Harness primary-runtime | Python 3.12.14 (PSF), Node 24.21.0, pnpm 11.7.0 and fixed Office libraries; retained package notices and runtime/primary-runtime/runtime.json |
| React / React DOM / scheduler / qrcode | MIT; dependency license texts in docs/licenses |
| Lucide React | ISC; docs/licenses/lucide-react-LICENSE.txt |
| AndroidX, OkHttp/Okio, ZXing/ZXing Android Embedded, Kotlin stdlib | Apache-2.0; Android dependency notices and upstream licenses |
| Native Android WebRTC SDK | io.github.webrtc-sdk:android:144.7559.15; Maven POM declares BSD-3-Clause for WebRTC core; SDK wrapper repository MIT (Copyright 2023 WebRTC SDKs); docs/licenses/WebRTC-BSD-LICENSE.txt and WebRTC-SDK-MIT-LICENSE.txt; https://github.com/webrtc-sdk/android and https://webrtc.googlesource.com/src/ |

The single Windows EXE embeds the complete runtime and license trees; first launch releases them into the current-user program cache described in RUNNING.md. Its bootstrap uses the .NET Framework included in Windows 10/11 ([Microsoft platform documentation](https://learn.microsoft.com/en-us/dotnet/framework/install/versions-and-dependencies)); the application itself retains its self-contained .NET 10 runtime.

The complete Harness production package inventory, versions, declared licenses and SHA-256 file list are in runtime/harness/runtime-manifest.json. License/NOTICE files remain beside each production dependency, with an index in runtime/harness/THIRD_PARTY_LICENSES.md. Windows runtime license and notices are retained in docs/licenses.

Visual C++ runtime DLLs are extracted from the Microsoft-signed x64 redistributable and carried beside the bundled Node executable for native component loading. The application does not run the redistributable installer. The official archive URL, archive SHA-256 and individual DLL digests are pinned in release.json; the archived license links to Microsoft's official terms.

The fallback Chromium UI retains its sandbox. Because the single EXE releases embedded files without preserving NTFS access rules, the fallback startup grants only inherited read/execute access for the two Windows AppContainer package groups to the bundled Chromium binary directory. It does not change parent-directory or user-data permissions, grant write access, or disable the browser sandbox. Equivalent existing rules are reused.

ADB and scrcpy are development/reference tools and are not distributed. The Playwright browser carrier may include its own upstream FFmpeg utility for browser functions; it is distinct from phone remote streaming. Android remote control uses Android platform APIs; call/conference media uses the pinned native WebRTC SDK and the system Camera2/MediaProjection/audio APIs. Both the WebRTC core BSD text and the SDK wrapper MIT text are retained because they apply to different layers of the distributed Android dependency.

Conference sound on Windows uses the OS ActivateAudioInterfaceAsync process-loopback API, separate from NAudio's PC remote-control path. Android uses the native WebRTC dependency and platform PlaybackCapture/AudioRecord/AudioTrack APIs; Android shared sound travels as encrypted DataChannel PCM, while Windows shared sound uses a separate WebRTC RTP track.

The official Microsoft Visual C++ license DOCX was retrieved from the exact Visual Studio source referenced by the supplied license web page. The retained text extraction preserves the complete license body, including the original French provisions, without translation; its source URL and source SHA-256 are recorded in the text file. The original DOCX is retained for formatting and automatic numbering.

## 中文说明

源码路径相对于仓库根目录；runtime/ 表示发布 Windows EXE 提取出的载荷。上方清单保留每个组件的版本、许可证、来源和通知位置，许可证正文与版权条款保持原文。

### 组件许可概览

| 组件 | 许可与用途 |
| --- | --- |
| .NET / ASP.NET Core / Windows Forms | 自包含 .NET 10；MIT 及组件条款 |
| WebView2 SDK 1.0.3650.58 | Microsoft 条款；优先系统 WebView2，内嵌 Chromium 为后备 |
| NAudio 2.2.1 | MIT；PC 远控默认播放端点回环 |
| Sherpa ONNX 1.13.8 | Apache-2.0；官方 Windows 与 Android CPU 推理库 |
| ONNX Runtime | MIT；随 Sherpa 包提供 |
| 中英 KWS/ASR 模型 | 固定发布资产；来源与逐文件哈希见 config/voice-models.json |
| Node 24.21.0 | MIT 及内嵌组件通知 |
| Visual C++ Runtime 14.51.36247.0 | Microsoft 条款；Node 旁 12 个应用本地 DLL |
| Harness 0.2.0-rc.2 / Cordis | MIT；固定上游提交与原始通知 |
| Cua Driver 0.28.0 | 保留对应包及 Windows 原生组件许可 |
| Playwright MCP 0.0.80 / Playwright | Apache-2.0；Chromium 另保留组件通知 |
| Office 环境 | Python 3.12.14（PSF）、Node 24.21.0、pnpm 11.7.0 与锁定库各自许可 |
| React / React DOM / scheduler / qrcode | MIT |
| Lucide React | ISC |
| AndroidX / OkHttp/Okio / ZXing / Kotlin | Apache-2.0 及依赖通知 |
| WebRTC Android 144.7559.15 | 核心 BSD-3-Clause 与 SDK 包装 MIT 分别适用 |

### 运行时与分发边界

单文件 EXE 内保留完整运行时与许可树，首次运行释放到用户程序缓存。引导程序使用 Windows 自带 .NET Framework，Host 自带 .NET 10。Harness 生产依赖清单、版本、声明许可和逐文件哈希位于 runtime/harness/runtime-manifest.json，逐包 LICENSE/NOTICE 与 THIRD_PARTY_LICENSES.md 保留在依赖旁。

Visual C++ DLL 来自 Microsoft 签名的 x64 redistributable，放在 Node 旁供原生加载，不执行安装器。归档 URL、归档哈希与各 DLL 哈希固定于 release.json，完整许可文本和原始 DOCX 保留在 docs/licenses。文本包含原有法文条款，不作翻译；文本中记录官方来源 URL 与 DOCX SHA-256，DOCX 保留原格式和自动编号。

后备 Chromium 保留沙箱。由于 EXE 释放文件不保存 NTFS ACL，启动时只为两个 Windows AppContainer 组授予浏览器目录继承的读/执行权限，复用已有等效规则；不修改父目录或用户数据权限，不授权写入，也不关闭沙箱。

ADB/scrcpy 仅为开发工具，不随应用分发。浏览器包可能带上游 FFmpeg，用于浏览器功能，区别于手机远控流。Android 远控使用平台捕获/无障碍；通话会议使用固定 WebRTC 与系统 Camera2/MediaProjection/音频 API，须同时保留核心 BSD 和包装 MIT。

Windows 会议声音使用 OS ActivateAudioInterfaceAsync 进程回环，与 NAudio 的 PC 远控声音路径分开。Android 使用 WebRTC 与 PlaybackCapture/AudioRecord/AudioTrack；Android 共享声音通过加密 DataChannel PCM，Windows 使用独立 RTP 轨道。
