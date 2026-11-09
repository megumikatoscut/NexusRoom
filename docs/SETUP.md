# Development setup / 开发环境配置

English reference below · [中文说明](#中文说明)

Unless another working directory is stated, run commands from the repository root. Source paths below are relative to that root.

## Required tools

| Tool | Requirement | Declaration |
| --- | --- | --- |
| Windows / PowerShell | x64; PowerShell 5.1 or 7 | Windows Forms and native desktop APIs |
| .NET SDK | 10.0.401, patch roll-forward | `global.json` |
| JDK | 17–23; Java source target 17 | Gradle and Android project |
| Node / npm | Node 24.21.0 and matching npm | `release.json` |
| Android SDK | platform 35, build-tools 35.0.0, platform-tools | `dependencies.lock.json` |
| Gradle / AGP | 8.11.1 / 8.9.1 | `android/` |
| Git / pnpm | Git 2.x; pnpm 11.7.0 for Harness rebuilds | build tooling and upstream locks |

The npm, NuGet and Gradle lock/configuration files are part of the reproducible source input. Keep them when cleaning caches.

## Configure installed tools

```powershell
./scripts/setup-dev.ps1 -ConfigureOnly -NoInstall -AndroidSdk $env:ANDROID_HOME
./scripts/check-environment.ps1
```

The setup script locates Android SDK components through its argument, process environment, saved toolchain configuration or system defaults. `setup-dev.cmd` can install missing tools interactively. Android SDK licenses require review; automatic acceptance occurs only with the explicit `-AcceptAndroidLicenses` option.

`Get-NexusCacheRoot` locates a version-specific external cache. Use `NEXUS_CACHE_DIR` for a dedicated cache outside the repository. SDKs, Gradle/NuGet/npm caches and local toolchain settings are generated environment state. The [development example](../config/development.example.ps1) contains no credential or fixed personal path.

## Restore runtime resources

Use `./scripts/download-release.ps1 -Platform Windows` to download and verify the release asset. Download the [Windows v1.0.0 release](https://github.com/megumikatoscut/NexusRoom/releases/tag/v1.0.0) into the ignored local `artifacts/` directory as `artifacts/NexusRoom-Windows-x64-1.0.0.exe`. It supplies the matching browser and Office runtime used by the broader native/UI regressions and full packaging. Compile-only source builds (`./scripts/build.ps1 -SkipPackage -SkipTests`) do not require this EXE: `Initialize-NexusNode` can download the pinned Node directly. Broader verification and full packaging need the matching release asset or equivalent explicitly verified resources.

The immutable Harness source archive and restoration instructions are described in [third-party sources](../third_party/README.md). `scripts/setup-harness.ps1` prepares production dependencies in an external cache. Its source identity must match `release.json`; application overlays remain separate from upstream source.

## Troubleshooting

- Compare `dotnet --list-sdks` with `global.json` when the SDK cannot resolve.
- Check `JAVA_HOME`, `ANDROID_HOME` and SDK platform/build-tools before bypassing a failed build.
- Re-run a failed download after checking network/proxy configuration. Do not reuse a file whose checksum failed.
- Keep the runtime directory hierarchy intact. The application creates controlled short-path junctions for native Office tools when needed.
- Use the [build guide](BUILDING.md) for manual commands and signing requirements. Model credentials are unnecessary for compilation and keyless tests.

## 中文说明

除另行说明外，以下命令均在仓库根目录执行；路径也以仓库根目录为基准。

### 工具要求

| 工具 | 要求 |
| --- | --- |
| Windows / PowerShell | x64；PowerShell 5.1 或 7，使用 Windows Forms 与原生桌面 API |
| .NET SDK | 10.0.401，按 `global.json` 的补丁回滚策略解析 |
| JDK | 17–23；Java 源码目标版本 17 |
| Node / npm | Node 24.21.0 及其配套 npm，见 `release.json` |
| Android SDK | platform 35、build-tools 35.0.0、platform-tools |
| Gradle / AGP | 8.11.1 / 8.9.1 |
| Git / pnpm | Git 2.x；重建 Harness 使用 pnpm 11.7.0 |

npm、NuGet 锁文件和 Gradle 配置属于构建输入，清理缓存时保留。使用上方“Configure installed tools”代码块配置已安装工具，并运行环境检查。SDK 查找顺序包括显式参数、进程环境、保存的工具链配置与系统默认位置。`setup-dev.cmd` 提供交互式安装入口；只有显式传入 `-AcceptAndroidLicenses` 才会自动接受 Android SDK 许可。

### 匹配的运行时资源

广泛的原生/UI 回归与完整打包需要已发布 Windows EXE 中匹配的浏览器和 Office 运行时。仅编译源码可运行 `./scripts/build.ps1 -SkipPackage -SkipTests`，无需该 EXE；`Initialize-NexusNode` 可以直接下载固定 Node。推荐运行 `./scripts/download-release.ps1 -Platform Windows` 自动下载并核对仓库中的 SHA-256；下面也提供 gh 的手动下载方式。在仓库根目录执行下列命令，或通过发布页手工下载到本地 `artifacts/`（该目录不提交到 Git）：

```powershell
gh release download v1.0.0 --repo megumikatoscut/NexusRoom --dir artifacts --pattern 'NexusRoom-Windows-x64-1.0.0.exe'
```

脚本从 EXE 中校验并提取所需资源。广泛回归和完整打包需要匹配 EXE，或另外提供经过验证的等效运行资源。Harness 上游源码以不可变归档保留；`scripts/setup-harness.ps1` 在仓库外缓存中恢复并准备生产依赖，其源码标识必须匹配 `release.json`；NexusRoom 自有覆盖层独立保存。

`Get-NexusCacheRoot` 使用版本隔离的外部缓存；可以通过 `NEXUS_CACHE_DIR` 指定仓库外专用目录。SDK、依赖缓存和本地工具链配置均为生成的环境状态。`config/development.example.ps1` 不含凭据或固定个人路径。

### 故障排查

SDK 解析失败时，将 `dotnet --list-sdks` 与 `global.json` 对照。构建前检查 `JAVA_HOME`、`ANDROID_HOME` 与平台/构建工具版本；下载失败先检查网络或代理，不复用校验失败的文件。保持运行时目录层级完整；Office 原生工具需要时会创建受控短路径连接。手工构建与签名见 [构建指南](BUILDING.md)；编译和无需密钥的回归测试不需要模型凭据。
