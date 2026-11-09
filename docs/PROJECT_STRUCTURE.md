# Project structure / 项目结构

All source paths are relative to the repository root. The Windows solution, Vite frontend and Android Gradle project can be accessed directly from this checkout.

所有源码路径均相对于仓库根目录，Windows 解决方案、Vite 前端与 Android Gradle 项目直接位于该仓库中。

| Path / 路径 | Responsibility / 职责 |
| --- | --- |
| `src/NexusRoom.Host/Core/` | Version, encrypted state, rooms, memberships, profiles / 版本、加密状态、房间、成员、模型配置 |
| `src/NexusRoom.Host/Api/` | Local/device/external endpoints and authorization / 本地、设备和外部端点与授权 |
| `src/NexusRoom.Host/Devices/` | Device WSS, discovery, forwarding, clipboard / 设备 WSS、发现、转发与剪贴板 |
| `src/NexusRoom.Host/Desktop/` | PC input, frame/audio capture, occupancy, wake presentation / PC 输入、画面/声音、占用仲裁、唤醒展示 |
| `src/NexusRoom.Host/Communication/` | Calls, meetings, admission, signalling, sound / 通话、会议、入会、信令与设备声音 |
| `src/NexusRoom.Host/Files/` | Streaming, SHA-256 receipts, archive rollback / 文件流、哈希回执与归档回滚 |
| `src/NexusRoom.Host/Agent/` | Routing, Harness SDK, approvals, budgets, bridges / 任务路由、Harness、审批、预算和房间桥 |
| `src/NexusRoom.Host/Voice/` | Windows KWS/ASR/VAD, wake ledger, intent / Windows 语音、唤醒账本与目标意图 |
| `src/NexusRoom.Web/src/` | React pages, context, API types, components / React 页面、上下文、接口类型和组件 |
| `src/NexusRoom.Web/src/voice/` | Hold/release, recording status and lifecycle / 按住输入、录音状态与生命周期 |
| `android/app/src/main/` | Java activities/services, permissions, files, Agent, WebRTC / Android 生产端实现 |
| `android/app/src/debug/` | Debug-only audio/presentation fixtures / 仅调试包使用的声音与展示夹具 |
| `scripts/` | Setup, build, signing, verification, packaging, cleanup / 环境配置、构建、签名、验证、打包、清理 |
| `scripts/windows/` | Windows bootstrap and bundle implementation / Windows 引导与单文件打包代码 |
| `scripts/templates/windows/` | Self-contained future payload documentation / 后续运行包自包含文档模板 |
| `tests/` | Reusable contracts, units, fixtures and explicit live/device checks / 可复用单元、契约、夹具及设备/模型测试 |
| `third_party/` | Immutable upstream archive, provenance, offline models / 固定上游归档、来源与离线模型 |
| `PIC/` | Source artwork and generated icon resources / 图标原稿与生成资源 |
| `config/` | Credential-free configuration and model identities / 无凭据示例与模型清单 |
| `docs/` | Bilingual architecture, API, build and operation guides / 双语架构、接口、构建和运行说明 |
| `docs/licenses/` | Original dependency licenses / 原始依赖许可证 |
| `docs/releases/v1.0.0/` | Release guide and tracked SHA-256 values / 版本说明与受 Git 跟踪的校验和 |
| `.github/` | CI and issue/PR templates / CI 与 Issue、PR 模板 |
| `artifacts/` | Ignored local copies of downloaded release assets / 本地下载产物，不提交 Git |

Root entry points include `NexusRoom.sln`, `build.cmd`, `setup-dev.cmd`, `start.cmd`, locked dependency identities, MIT license and contribution/security guidance. [Third-party instructions](../third_party/README.md) describe restoration of the pinned upstream source.

根目录包含解决方案与构建/启动入口、依赖锁、MIT 许可及贡献/安全说明。固定上游源码恢复方法见 [第三方说明](../third_party/README.md)。

Generated `.local`, `bin`, `obj`, `build`, `wwwroot` and dependency caches are not source inputs. EXE/APK assets are distributed through [GitHub Releases](https://github.com/megumikatoscut/NexusRoom/releases/tag/v1.0.0); presentation, video, technical-report and historical evaluation bundles are outside this repository.

生成的本地状态、编译输出和依赖缓存不属于源码输入。EXE/APK 经 GitHub Releases 分发；本仓库不包含演示文稿、视频、报告与历史测评材料包。
