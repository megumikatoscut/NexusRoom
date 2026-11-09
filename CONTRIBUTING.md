# Contributing / 贡献指南

Use the pinned environment in [setup](docs/SETUP.md). Commands and paths start at the repository root. Follow existing Host, Web and Android modules; update affected guides when behavior changes. Change dependency declarations, locks, provenance and license notices together.

使用 [环境配置](docs/SETUP.md) 中的固定工具链。命令和路径以仓库根目录为起点。遵循 Host、Web 与 Android 的现有模块划分；行为变化时同步更新指南。依赖声明、锁文件、来源和许可声明应一并更新。

## Workflow / 流程

1. Describe the problem or intended behavior in an issue; create a focused branch. / 在 Issue 中描述问题或预期行为，并创建专注于该变更的分支。
2. Implement the change and update affected English and Chinese documentation. / 完成变更，并同步受影响文档的中英文内容。
3. Run relevant builds and meaningful tests, recording commands, environment and observed results. State device, media or model tests not run. See [tests](tests/README.md). / 执行相关构建和有效测试，记录命令、环境及实际结果；明确未执行的设备、媒体或模型测试，详见 [测试指南](tests/README.md)。
4. Check documentation and source consistency, then submit a pull request with resulting behavior and validation. / 检查文档与源码一致性，提交 PR 并说明最终行为与验证情况。

```powershell
node ./scripts/check-documentation.mjs
node ./tests/current-release-consistency.mjs --source-only
./scripts/check-github.ps1 -SkipDistribution
```

Keep credentials, signing keys, `.env`, private files, room state, SDKs, caches, `node_modules` and outputs out of Git. Local installers belong in ignored `artifacts/`; public binaries belong in GitHub Releases. New measurements should identify their own date, artifact hash, device and method.

凭据、签名私钥、`.env`、私人文件、房间状态、SDK、缓存、`node_modules` 和构建输出不得进入 Git。本地安装包放在已忽略的 `artifacts/`，公开安装包放在 GitHub Releases。新测试记录应标明自身日期、安装包哈希、设备和方法。

Verify pinned upstream source before modification or rebuild; preserve its license and identity separately from NexusRoom changes. First-party contributions use [MIT](LICENSE). Report security issues through [SECURITY.md](SECURITY.md).

修改或重建前先验证固定上游源码，保留其许可与来源，并与 NexusRoom 修改区分。项目自有代码的贡献采用 [MIT](LICENSE)。安全问题请遵循 [SECURITY.md](SECURITY.md)。
