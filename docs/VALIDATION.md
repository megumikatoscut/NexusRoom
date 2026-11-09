# Validation scope / 验证范围

Application identity is **1.0.0 / Android versionCode 15**. This repository contains reusable tests and source/build metadata. Historical evaluation reports, presentations and videos are outside the repository; their results are not claimed as a new acceptance run of this GitHub release.

应用标识为 **1.0.0 / Android versionCode 15**。本仓库保留可复用测试与源码/构建元数据；历史测评报告、PPT 与视频不纳入仓库，其结果不视为本次 GitHub 发布重新执行的验收。

## Repository preparation checks / 仓库整理检查

On **2026-11-10 (Asia/Shanghai)**, `scripts/build.ps1 -SkipPackage -SkipTests` completed in the prepared Windows environment: React/TypeScript/Vite built successfully, the Windows .NET build reported **0 warnings and 0 errors**, and Android Debug/Release assembly and lint tasks completed (**99 Gradle tasks**). This establishes source compilation in that environment; `-SkipTests` deliberately leaves regression execution to a separate check.

**2026-11-10（Asia/Shanghai）**，在已配置的 Windows 环境执行 `scripts/build.ps1 -SkipPackage -SkipTests` 成功：React/TypeScript/Vite 构建通过，Windows .NET 为 **0 警告、0 错误**，Android Debug/Release 编译与 lint 完成（**99 个 Gradle 任务**）。该结果证明对应环境中的源码编译；回归由单独命令执行。

The separate `scripts/verify.ps1` run also completed successfully. It covered room/authentication integration (41 checks), Host regression (12), PC Agent contracts (10), room-file contracts (13), browser remote/voice/media paths, 28 Node unit checks, two single-EXE format checks, communication protocol deadlines (14), authenticated communication UI/RTP (12), voice arbitration (31), native bilingual KWS/ASR/VAD smoke, Java room identity/session/media lifecycle checks, viewport/IME checks, and three single-EXE startup/cache cases. Native voice smoke used supplied audio, without requesting a microphone. Browser phone peers and Agent transports used fixtures where stated by each test. Existing Java/toolchain deprecation warnings were present; the verification process exited successfully.

独立执行的 `scripts/verify.ps1` 也全部通过，覆盖房间/认证集成（41 项）、Host 回归（12 项）、PC Agent 协议（10 项）、房间文件协议（13 项）、浏览器远控/语音/媒体路径、28 项 Node 单元检查、2 项单文件 EXE 格式检查、通信协议超时（14 项）、认证通信 UI/RTP（12 项）、语音仲裁（31 项）、原生中英 KWS/ASR/VAD、Java 房间身份/会话/媒体生命周期、视口/输入法和 3 项 EXE 启动/缓存检查。原生语音使用提供的音频，没有请求麦克风；浏览器手机端和 Agent 传输按各测试说明使用夹具。存在原有 Java/工具链弃用警告，验证进程成功退出。

`scripts/check-github.ps1 -VerifyArtifacts` passed PowerShell syntax, 24 Markdown documents with 169 local links/anchors, cross-component version declarations, all eight model hashes, retained Harness source identity and both installer hashes. `scripts/verify-voice-apk.ps1` verified the published APK's models, wake tokens, three native ABIs and voice license contents. A Git checkout simulation with Windows automatic newline conversion enabled also passed the source identity/model and documentation checks; byte-pinned assets and original license texts are exempt from conversion in `.gitattributes`.

`scripts/check-github.ps1 -VerifyArtifacts` 通过 PowerShell 语法、24 份 Markdown 的 169 个本地链接/锚点、跨组件版本声明、8 个模型哈希、固定 Harness 来源与双端安装包哈希检查。`scripts/verify-voice-apk.ps1` 验证发布 APK 的模型、唤醒词、3 个原生 ABI 与语音许可内容。启用 Windows 自动换行转换的 Git 检出模拟也通过源码版本/模型和文档检查；`.gitattributes` 对字节固定的资源及许可原文关闭换行转换。

These checks did not run live model-provider tasks, physical Android acceptance, actual microphone/camera capture or the optional desktop GUI suite. They do not replace those environment-specific checks.

本轮未执行真实模型服务任务、物理 Android 验收、真实麦克风/相机采集或可选桌面 GUI 套件，以上结果不能替代对应环境验证。

Release bytes preserve the supplied EXE/APK. Their tracked identities are in [SHA256SUMS.txt](releases/v1.0.0/SHA256SUMS.txt). Source builds performed during preparation do not replace these files or their embedded runtime documents.

发布包保留原 EXE/APK 字节，其受跟踪标识见上述校验和。整理时执行的源码构建不会替换这些产物或其内嵌运行文档。

## Reproducible checks / 可复现检查

Prepare [the toolchain](SETUP.md), download matching release resources and follow [the build guide](BUILDING.md). Commands run from the repository root. The [test index](../tests/README.md) separates keyless checks from device/provider prerequisites.

先配置工具链、下载匹配运行资源并按构建指南操作，命令均在仓库根目录执行。测试索引区分无需模型密钥的检查与需要设备/服务商的检查。

```powershell
./scripts/check-github.ps1 -SkipDistribution
./scripts/build.ps1 -SkipPackage -SkipTests
./scripts/verify.ps1
```

Source/unit, protocol/fixture, emulator, native desktop, physical device and real-provider checks have different scopes. Browser/JVM fixtures cannot establish native capture, acoustic echo performance or arbitrary vision-model success. Record actual results rather than inferring end-to-end success from a schema test.

源码/单元、协议/夹具、模拟器、原生桌面、物理设备与真实服务商检查分别限定范围。浏览器/JVM 夹具不能证明原生捕获、声学回声或任意视觉模型任务成功；按实际结果记录，不从模式检查推断端到端成功。

## Artifact and physical validation / 产物与物理验证

Payload inventory and hash checks establish file identity and package consistency. GUI/native checks establish only the selected platform paths. Physical Android tests require an explicitly selected authorized device; live-model tests additionally need a configured compatible provider. Use isolated state and keep private credentials and histories outside Git.

载荷清单与哈希证明文件身份和包一致性，GUI/原生检查仅覆盖所选平台路径。物理 Android 测试需显式选择授权设备，真实模型还需兼容服务商配置。使用隔离状态，凭据和私人历史不进入 Git。

Further acceptance work includes noisy/two-device wake timing, lock-screen and OEM background policies, long-duration power/resource behavior, physical playback in every media direction, and broader multi-turn/provider/vision tasks. These require dated execution records for the selected source and binary hashes.

后续验收包括噪声/双设备唤醒时序、锁屏/OEM 后台策略、长时耗电/资源、各媒体方向物理播放及更广的多轮/服务商/视觉任务；每项都需对应源码和二进制哈希的带日期执行记录。

## Recording new results / 记录新结果

Record date/timezone, exact command, OS/tool versions, device/method, source commit, artifact SHA-256, prerequisites, pass/fail/NOT_RUN outcome and limitations. Fresh evidence goes to an external version-specific cache, configurable through `NEXUS_TEST_EVIDENCE_DIR`. New packages use external `release-output/Windows/` and `release-output/Android/` directories; retain the distinction between published binaries and new build outputs.

记录日期/时区、精确命令、系统/工具版本、设备/方法、源码提交、产物 SHA-256、前提条件、通过/失败/未执行及限制。新证据写入版本隔离外部缓存，可由 `NEXUS_TEST_EVIDENCE_DIR` 设置；新包写入外部 release-output，始终区分已发布二进制和新构建。
