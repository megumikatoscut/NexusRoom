# NexusRoom v1.0.0

First GitHub release for Windows x64 and Android. Both applications use version **1.0.0**; Android retains **versionCode 15** and package ID `com.nexusroom.android`.

首次 GitHub 发布，面向 Windows x64 与 Android。双端应用版本均为 **1.0.0**；Android 保留 **versionCode 15**，包名为 `com.nexusroom.android`。

## Downloads / 下载

| Artifact / 产物 | Size / 大小 | Platform / 平台 |
| --- | --- | --- |
| [NexusRoom-Windows-x64-1.0.0.exe](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Windows-x64-1.0.0.exe) | 845,676,963 bytes / 字节 | Windows 10/11 x64 |
| [NexusRoom-Android-1.0.0.apk](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Android-1.0.0.apk) | 166,835,374 bytes / 字节 | Android 10 / API 29+; ARM64, ARMv7, x86_64 |
| [SHA256SUMS.txt](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/SHA256SUMS.txt) | SHA-256 | Both installers / 双端安装包 |

The [tracked checksum file](SHA256SUMS.txt) identifies the exact release bytes. Compare downloaded hashes in PowerShell:

[仓库校验文件](SHA256SUMS.txt) 标识本次发布的精确字节内容。可在 PowerShell 中核对下载哈希：

```powershell
Get-FileHash ./NexusRoom-Windows-x64-1.0.0.exe -Algorithm SHA256
Get-FileHash ./NexusRoom-Android-1.0.0.apk -Algorithm SHA256
```

## Features and installation / 功能与安装

LAN rooms and discovery, bidirectional remote control, files and clipboard, WebRTC calls and meetings, PC/Android Agents, and local bilingual voice recognition. Basic collaboration needs no model account; Agent reasoning needs a compatible user-configured HTTPS model service.

提供局域网房间与发现、双向远程控制、文件与剪贴板、WebRTC 通话与会议、PC/Android Agent 和本地中英语音识别。基础协作无需模型账号；Agent 推理需要用户配置兼容的 HTTPS 模型服务。

Launch the Windows EXE, install the APK and connect both devices to a reachable LAN. Allow approximately 2 GB cache for first Windows launch. Create a room on Windows, join from Android, verify the certificate fingerprint and grant permissions as needed. See [running](../../RUNNING.md).

启动 Windows EXE、安装 APK，并让两端连接可互通局域网。Windows 首次启动请预留约 2 GB 缓存。在 Windows 创建房间，Android 加入并核对证书指纹，按需授权，详见 [运行指南](../../RUNNING.md)。

## Identity and provenance / 身份与来源

EXE/APK files are preserved from the supplied v1.0.0 project and copied without modification. Source organization, bilingual docs and repository tooling changes do not mean these binaries were rebuilt from the publishing commit. Embedded documentation may retain the original layout.

EXE/APK 来自原有 v1.0.0 项目，按原字节复制。源码整理、双语文档和仓库工具调整不代表安装包由发布提交重新构建，内嵌文档可能仍采用原始布局。

Android signature verification passed. The certificate SHA-256 is `164eb0a66eb42b0791e1f8f52c81ec2388134e6fb29bc7e7272ccb1a3f0210a0`, matching [release.json](../../../release.json). Windows FileVersion/ProductVersion is `1.0.0.0`; the EXE has no Authenticode signature. Signing private keys are excluded.

Android 签名验证通过，证书 SHA-256 为 `164eb0a66eb42b0791e1f8f52c81ec2388134e6fb29bc7e7272ccb1a3f0210a0`，与 [release.json](../../../release.json) 一致。Windows FileVersion/ProductVersion 为 `1.0.0.0`，EXE 未进行 Authenticode 签名。发布不包含签名私钥。

## Validation / 验证

Checks cover installer hashes, Windows version resources, APK metadata/signature, EXE payload integrity and equality of its embedded APK with the standalone APK. Repository checks are described in [validation](../../VALIDATION.md). Historical device/model evaluations are not bundled and do not establish fresh binary acceptance. Physical-device, real-model and end-to-end media checks depend on their environments.

已检查安装包哈希、Windows 版本资源、APK 元数据与签名、EXE 载荷完整性，以及内嵌 APK 与独立 APK 的一致性。仓库检查见 [验证说明](../../VALIDATION.md)。历史设备/模型评估未收入仓库，不能作为本次二进制的新验收结果。实体设备、真实模型和端到端媒体检查取决于相应环境。

First-party software uses [MIT](../../../LICENSE); components retain their [licenses and notices](../../THIRD_PARTY_NOTICES.md).

项目自有软件采用 [MIT](../../../LICENSE)，第三方组件保留各自 [许可与声明](../../THIRD_PARTY_NOTICES.md)。
