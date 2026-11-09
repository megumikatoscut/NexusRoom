# Retained third-party dependencies / 保留的第三方依赖

This directory is `third_party/` at the repository root. Original upstream source and license bodies remain unmodified; this bilingual guide explains their use.

本目录为仓库根目录下的 `third_party/`。上游源码与许可证正文保持原样，本双语说明介绍其用途。

| Item / 项目 | Purpose / 用途 |
| --- | --- |
| [deepseek-harness-source.tar.gz](deepseek-harness-source.tar.gz) | Complete immutable Harness source snapshot; top directory deepseek-harness/ / 完整不可变上游源码快照 |
| [HARNESS_SOURCE.json](HARNESS_SOURCE.json) | Upstream identity and per-file SHA-256 / 上游身份及逐文件校验和 |
| [deepseek-harness-LICENSE.txt](deepseek-harness-LICENSE.txt) | Original Harness license / 原始许可证 |
| [KWS model directory](sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/) | Pinned offline keyword spotting / 固定离线关键词模型 |
| [ASR model directory](sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16/) | Pinned bilingual streaming transcription / 固定中英流式转写模型 |

The archive preserves upstream localization, documentation and fixtures. Setup extracts it into an external build cache and validates source hashes before packaging. NexusRoom overlays live separately under `src/NexusRoom.Host/Agent/`. Do not edit the archive to translate project guidance.

归档保留上游原有本地化、文档和夹具；环境脚本提取到外部缓存并在打包前校验哈希。NexusRoom 覆盖层独立放在 `src/NexusRoom.Host/Agent/`，不要为翻译项目说明修改归档。

NexusRoom consumes the pinned NuGet/AAR packages and local models; no nested upstream Git history is required. The Android AAR is retained in `android/app/libs/`. [dependencies.lock.json](../dependencies.lock.json), [release.json](../release.json) and [voice-models.json](../config/voice-models.json) record exact identities. License texts and model origins are documented in [third-party notices](../docs/THIRD_PARTY_NOTICES.md).

项目使用固定 NuGet/AAR 与本地模型，不需要上游嵌套 Git 历史。Android AAR 保留在 `android/app/libs/`；上述锁文件和清单记录精确身份，第三方声明列出许可与模型来源。
