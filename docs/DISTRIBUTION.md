# Release artifacts and distribution / 发布产物与分发

Run source commands from the repository root. Source code and bilingual project documentation are tracked by Git; executable payloads are attached to [GitHub Releases v1.0.0](https://github.com/megumikatoscut/NexusRoom/releases/tag/v1.0.0).

源码命令在仓库根目录执行。Git 跟踪源码与中英双语文档，二进制程序通过 GitHub Releases v1.0.0 附件分发。

## Published assets / 发布附件

| Asset / 附件 | Purpose / 用途 |
| --- | --- |
| [NexusRoom-Windows-x64-1.0.0.exe](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Windows-x64-1.0.0.exe) | Windows 10/11 x64 executable with embedded runtimes and companion APK / Windows 单文件程序，内嵌运行时及 Android 包 |
| [NexusRoom-Android-1.0.0.apk](https://github.com/megumikatoscut/NexusRoom/releases/download/v1.0.0/NexusRoom-Android-1.0.0.apk) | Signed Android 10/API 29+ companion, versionCode 15 / 已签名 Android 伴侣 |
| [Tracked SHA256SUMS.txt](releases/v1.0.0/SHA256SUMS.txt) | SHA-256 identities for both clients / 双端 SHA-256 标识 |

The uploaded EXE/APK preserve the supplied release bytes. Repository/document organization does not rebuild them or replace their embedded documents. Newly generated outputs require fresh hashes and their own validation records. See the [release guide](releases/v1.0.0/README.md) and [running guide](RUNNING.md).

上传的 EXE/APK 保留原发布字节。整理仓库或文档不会重建程序，也不会替换包内文档；新构建产物必须记录新哈希与验证结果。安装使用见 [版本指南](releases/v1.0.0/README.md) 和 [运行指南](RUNNING.md)。

## Local build inputs / 本地构建输入

`scripts/download-release.ps1` downloads the matching release assets into ignored `artifacts/` and verifies the tracked checksums. The Windows EXE supplies the pinned Node/browser/Office environment required by source tooling. These assets remain outside source commits.

`scripts/download-release.ps1` 将匹配发布包下载到忽略的 `artifacts/` 并核对受 Git 跟踪的校验和。Windows EXE 提供构建工具需要的固定 Node、浏览器与 Office 环境，不将这些产物提交到源码历史。

```powershell
./scripts/download-release.ps1
./scripts/setup-dev.ps1 -ConfigureOnly -NoInstall -AndroidSdk $env:ANDROID_HOME
./scripts/build.ps1 -SkipPackage
```

## Packaging / 打包

`scripts/build.ps1` compiles both clients and runs regressions. `scripts/package.ps1` publishes a self-contained Windows payload, signs Android with externally managed material, preserves runtime/license trees, verifies resources and builds the single EXE. The public signing digest is in `release.json`. See [BUILDING.md](BUILDING.md).

build 脚本编译双端并运行回归；package 脚本发布自包含 Windows 载荷，使用外部材料签署 Android，保留运行时/许可树，校验资源并生成单文件 EXE。公开签名摘要见 `release.json`。

New outputs use the external version-specific cache under `release-output/Windows/` and `release-output/Android/`. `NEXUS_BUILD_ARTIFACT_DIR` can choose another dedicated absolute output directory outside the repository. Packaging rejects an in-repository target and does not replace downloaded `artifacts/` files automatically.

新产物写入版本隔离外部缓存的上述 Windows/Android 子目录。可用 `NEXUS_BUILD_ARTIFACT_DIR` 指定仓库外专用绝对目录；脚本拒绝仓库内输出，不会自动覆盖本地下载的发布包。

`scripts/build-single-exe.ps1 -PackageDirectory <complete-payload-directory>` wraps an existing complete payload. `scripts/finalize-release.ps1` refreshes payload documents/manifests and repackages existing application content; it does not compile application source. Both operations create new release bytes.

build-single-exe 包装完整载荷；finalize-release 更新载荷文档/清单并重新封装现有应用，不编译源码。这两项操作均生成新字节，不能视为原安装包。

The launcher verifies archive and per-file hashes, extracts into staging under a current-user mutex, and atomically publishes the cache. User state is separate. Payloads retain original dependency LICENSE/NOTICE files and exclude model keys, signing keys and room/browser state. New payloads embed self-contained README/notices templates; source architecture, API, build and contribution guides remain in this repository.

引导程序校验压缩包与逐文件哈希，在用户互斥量下暂存提取并原子发布缓存，用户状态独立。完整原始 LICENSE/NOTICE 保留，模型密钥、私钥、房间/浏览器状态不打包。新运行包嵌入自包含 README 与第三方声明，架构/API/构建/贡献文档留在源码仓库。

## Validation / 验证

Source compilation, payload verification, GUI launch, physical-device tests and live-model evaluations establish different facts. Record the command, environment, source/artifact identity and outcome for each. Do not transfer earlier results to new bytes without validation. See [VALIDATION.md](VALIDATION.md). Keep production secrets outside Git and release attachments.

源码编译、载荷校验、GUI 启动、物理设备和真实模型测试证明的事实不同，分别记录命令、环境、源码/产物标识与实际结果；不能直接把旧结果归到新字节。生产秘密不进入 Git 或 Release 附件。
