# Build and package / 构建与打包

English reference below · [中文说明](#中文说明)

Unless another working directory is stated, run commands from the repository root. Source paths below are relative to that root.

Versions and dependencies are constrained by `release.json`, `global.json`, dependency locks and project declarations. Prepare tools with [SETUP.md](SETUP.md).

## Compile and verify

```powershell
./scripts/setup-dev.ps1 -ConfigureOnly -NoInstall -AndroidSdk $env:ANDROID_HOME
./scripts/build.ps1 -SkipPackage
```

For compilation without regressions or packaging, run `./scripts/build.ps1 -SkipPackage -SkipTests`; it can obtain pinned Node directly and does not require the published Windows EXE. The `-SkipPackage` command above also runs broader regressions, so download matching runtime resources first with `./scripts/download-release.ps1 -Platform Windows`.

Build order is icon resources, Web, Windows Host, Android, regressions and optional release packaging. `-SkipPackage` compiles and tests while retaining existing releases; `-SkipTests` performs compilation without the regression stage. `-DesktopRegression` adds desktop interaction checks. Device/live-model tests have separate prerequisites in the [test index](../tests/README.md).

Before build/package, `prepare-voice.ps1` verifies all eight voice model files against `config/voice-models.json`. Windows includes the Sherpa CPU runtime and `voice/kws` / `voice/asr`; Android packages local assets and the official AAR JNI libraries for ARM64, ARMv7 and x64. Device model downloads are unnecessary.

## Manual compilation

```powershell
./scripts/prepare-icons.ps1
. ./scripts/common.ps1
Set-NexusBuildEnvironment -AndroidSdk $env:ANDROID_HOME
Initialize-NexusNpmProject (Join-Path (Get-NexusRoot) 'src/NexusRoom.Web') 'web'
$node = Get-NexusReleaseNode
& $node.Executable $node.NpmCli run build --prefix ./src/NexusRoom.Web
dotnet restore ./NexusRoom.sln --locked-mode
dotnet build ./src/NexusRoom.Host --no-restore --disable-build-servers
./scripts/gradle.ps1 clean assembleDebug lintDebug assembleRelease lintRelease --console=plain
./scripts/verify.ps1
```

Vite writes to `src/NexusRoom.Host/wwwroot/`. `PIC/PC.png` and `PIC/APK.png` are source artwork; `prepare-icons.py` generates Windows ICO and Android resources, checked by `PIC/ICON_MANIFEST.json`. Matching resources are already supplied. Regeneration requires a Python interpreter with Pillow, selected by the PowerShell wrapper or `-PythonExecutable`.

## Signing and release generation

The published EXE and APK are attached to [GitHub Releases v1.0.0](https://github.com/megumikatoscut/NexusRoom/releases/tag/v1.0.0). A build does not inherit the maintainer's private signing key. To produce a separate development package explicitly use:

```powershell
./scripts/build.ps1 -DevelopmentSigning
```

Production packaging uses `-SigningDirectory $env:NEXUS_SIGNING_DIR` with an externally managed identity. The public certificate SHA-256 is declared in `release.json`. A development-signed APK cannot replace an installed APK with another signature. Keep keystores, passwords and DPAPI-protected password files outside the repository.

Packaging stages self-contained .NET, Node, Chromium, Harness/Cua and Office resources, retains license trees, verifies the payload and signs the APK before creating the Windows single EXE. The bootstrap is compiled using the Windows .NET Framework compiler.

New packaging outputs go to the version-specific external NexusRoom build cache under `release-output/Windows/` and `release-output/Android/`. To choose another dedicated external output directory, set `NEXUS_BUILD_ARTIFACT_DIR` to an absolute path outside the repository. The packaging scripts reject output directories inside the repository and do not automatically replace downloaded release assets in `artifacts/`. Record the new hashes and validation before deliberately selecting replacement deliverables. See [distribution](DISTRIBUTION.md).

## Cleanup and provenance

```powershell
./scripts/clean.ps1 -ExternalIntermediates
```

Close build/test processes before cleaning. Cleanup removes generated project and Android intermediate directories and dependency links; it retains release artifacts, dependency downloads, SDKs, external signing material and historical evidence. Re-run applicable source and release-integrity checks after a rebuild. A newly generated EXE has a new content hash and must be described as a new artifact even if its application version stays 1.0.0.

## 中文说明

除另行说明外，在仓库根目录执行命令。版本由 `release.json`、`global.json`、依赖锁文件和项目配置约束；先按 [环境配置](SETUP.md) 准备工具。仅编译用 `./scripts/build.ps1 -SkipPackage -SkipTests`，可直接获取固定 Node，无需发布 EXE；上方默认 `-SkipPackage` 还会执行广泛回归，因此先通过 `./scripts/download-release.ps1 -Platform Windows` 把匹配 EXE 下载到本地 `artifacts/`。

### 编译与验证

`scripts/build.ps1 -SkipPackage` 依次校验语音模型、准备图标、构建 Web、Windows Host、Android，再运行回归。`-SkipTests` 仅跳过回归阶段；`-DesktopRegression` 增加桌面交互检查。原生、物理设备和真实模型测试有额外前提，见 [测试索引](../tests/README.md)。上方代码块同时提供自动入口与手工编译步骤。

`prepare-voice.ps1` 根据 `config/voice-models.json` 校验八个模型文件。Windows 包含 Sherpa CPU 运行时与 `voice/kws`、`voice/asr`；Android 打包本地模型与官方 AAR 中的 ARM64、ARMv7、x86_64 JNI 库，运行设备无需另行下载模型。

Vite 输出到 `src/NexusRoom.Host/wwwroot/`。`PIC/PC.png` 与 `PIC/APK.png` 为图标原稿，生成结果由 `PIC/ICON_MANIFEST.json` 校验；仓库已附匹配资源。重新生成图标需要安装 Pillow 的 Python，由 PowerShell 包装脚本或 `-PythonExecutable` 选择。

### 签名与发布

正式 EXE/APK 在 [GitHub Releases](https://github.com/megumikatoscut/NexusRoom/releases/tag/v1.0.0) 发布，源码构建不包含维护者的私有签名密钥。使用 `scripts/build.ps1 -DevelopmentSigning` 可显式生成开发签名包；不同签名的 APK 不能覆盖现有安装。生产签名通过 `-SigningDirectory $env:NEXUS_SIGNING_DIR` 指定仓库外身份，公开证书摘要见 `release.json`。密钥库、密码及 DPAPI 保护的密码文件均置于仓库外。

打包阶段发布自包含 .NET，整合 Node、Chromium、Harness/Cua、Office 与完整许可树，校验内容并签署 APK，最后使用 Windows 自带的 .NET Framework 编译器生成单文件 EXE 引导程序。

新包写入版本隔离的外部构建缓存 `release-output/Windows/` 和 `release-output/Android/`。`NEXUS_BUILD_ARTIFACT_DIR` 可指定仓库外的绝对专用目录；脚本拒绝仓库内部输出，不会自动覆盖下载到 `artifacts/` 的发布包。选择新产物发布前重新记录哈希与验证结果，见 [分发指南](DISTRIBUTION.md)。

### 清理与产物身份

关闭构建和测试进程后执行 `scripts/clean.ps1 -ExternalIntermediates`。该命令清理生成的项目/Android 中间目录及依赖连接，保留发布包、依赖下载、SDK、外部签名材料与独立测试证据。重新构建后检查源码与产物一致性；即使版本仍为 1.0.0，新生成 EXE 的哈希也可能变化，必须作为新的产物记录。
