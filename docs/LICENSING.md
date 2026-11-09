# Licensing and provenance / 许可与来源

English reference below · [中文说明](#中文说明)

NexusRoom first-party source uses the [MIT license](../LICENSE). Preserve its copyright and license notice when copying or redistributing it. Third-party code, models, runtime packages and assets retain their own terms; the first-party license does not replace them.

Source paths are relative to the repository root. Dependency notices are in `docs/licenses/`, Android asset licenses and the runtime trees embedded in the published Windows EXE. The Windows EXE extracts its original runtime LICENSE/NOTICE files with its payload. WebRTC core BSD and SDK-wrapper MIT terms apply to separate dependency layers.

The pinned Harness source is supplied as an immutable archive with its original source/provenance manifest and license. See [third-party source instructions](../third_party/README.md). Restoring the archive preserves upstream contents rather than presenting its documentation as first-party project guidance. NexusRoom overlays are in `src/NexusRoom.Host/Agent/`.

Versions, sources and component-level license locations are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `release.json`, lock files, voice model identities and release checksums provide additional file identity. Production Android signing material remains external; only the public certificate digest is supplied.

## 中文说明

NexusRoom 自有源码使用 [MIT 许可证](../LICENSE)，复制或再分发时须保留版权与许可声明。第三方代码、模型、运行时与资源分别遵循各自条款，自有项目的 MIT 不替代依赖许可。

源码路径相对于仓库根目录。依赖许可见 `docs/licenses/`、Android assets 与发布 EXE 内完整运行时树；EXE 提取时保留原始 LICENSE/NOTICE。WebRTC 核心的 BSD 与 SDK 包装层的 MIT 适用于不同依赖层。

固定 Harness 源码作为不可变归档保留，附原始来源清单和许可证，恢复方法见 [第三方依赖说明](../third_party/README.md)。恢复时保留上游原貌；NexusRoom 自有覆盖层位于 `src/NexusRoom.Host/Agent/`。

组件版本、来源与许可位置见 [第三方声明](THIRD_PARTY_NOTICES.md)。`release.json`、锁文件、语音模型清单与发布校验和提供文件身份。Android 私有签名材料不进入仓库，只保留公开证书摘要。上游许可证正文保持原文，以免翻译改变法律含义。
