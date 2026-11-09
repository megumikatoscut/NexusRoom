# Security / 安全说明

## Reporting / 漏洞报告

Use [private vulnerability reporting](https://github.com/megumikatoscut/NexusRoom/security/advisories/new) if enabled, or a private channel offered by the maintainer. Include version, reproduction steps and impact. Remove API keys, member tokens, invitations, protected state, private files and sensitive screenshots. Coordinate privately before publishing an exploitable report.

如已启用，请使用 [私密漏洞报告](https://github.com/megumikatoscut/NexusRoom/security/advisories/new)，或维护者提供的私密渠道。说明版本、复现步骤与影响，移除 API 密钥、成员令牌、邀请、受保护状态、私人文件和敏感截图。公开可利用的漏洞详情前请先私下协调。

## Trust and permissions / 信任与权限

The control centre listens on loopback and exchanges a bootstrap capability for a session cookie. Android uses pinned TLS and room-specific member tokens. Verify the certificate fingerprint when joining. Windows persistence uses CurrentUser DPAPI; Android room credentials use Keystore/AES-GCM. Application grants, control leases and system media/accessibility consent have separate scopes.

控制中心监听回环地址，通过引导凭据交换会话 Cookie。Android 使用证书绑定 TLS 和房间成员令牌；加入时核对证书指纹。Windows 持久化使用 CurrentUser DPAPI，Android 房间凭据使用 Keystore/AES-GCM。应用授权、控制租约与系统媒体/无障碍授权具有不同范围。

PC Agent and desktop control use the current Windows user's capabilities. A task working directory selects files and does not restrict OS permissions. Request-mode approval, automatic execution, folder grants and system permissions are distinct. See [PC Agent](docs/PC_AGENT.md).

PC Agent 和桌面控制使用当前 Windows 用户的能力。任务工作目录用于选择文件，并不限制系统权限。请求模式审批、自动执行、文件夹授权与系统权限相互独立，详见 [PC Agent](docs/PC_AGENT.md)。

## Voice and model data / 语音与模型数据

Capture, KWS, VAD and ASR run locally. Optional automatic wake can dispatch transcription to the configured room model service in automatic Agent mode. Source authentication, candidate validation and a persisted dispatch guard protect routing. Android background recording requires a microphone foreground service started with valid while-in-use permissions; its notification provides a stop action. See [voice](docs/VOICE_INTERACTION.md).

采集、唤醒、活动检测与识别在本地运行。可选自动唤醒会在自动 Agent 模式下将转写发送至房间模型服务。来源认证、候选校验与持久化派发保护约束路由。Android 后台录音需要在有效使用中权限下启动麦克风前台服务，通知提供停止入口，详见 [语音说明](docs/VOICE_INTERACTION.md)。

## Release provenance / 发布来源

Production signing material, model keys, room state and private histories are excluded. Android v1.0.0 uses the certificate in [release.json](release.json). The supplied Windows EXE has no Authenticode signature. Verify downloads against [checksums](docs/releases/v1.0.0/SHA256SUMS.txt); see [validation scope](docs/VALIDATION.md).

项目不包含正式签名私钥、模型密钥、房间状态与私有历史。Android v1.0.0 使用 [release.json](release.json) 中记录的证书。原有 Windows EXE 未进行 Authenticode 签名。请根据 [校验文件](docs/releases/v1.0.0/SHA256SUMS.txt) 验证下载，另见 [验证范围](docs/VALIDATION.md)。
