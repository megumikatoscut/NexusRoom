# NexusRoom Windows 1.0.0 / Windows 使用说明

Double-click the outer `NexusRoom-Windows-x64-1.0.0.exe` on Windows 10/11 x64. First launch prepares embedded .NET, Node, Chromium, Harness/Cua and Office resources; allow about 2 GB for program cache. Collaboration needs no model key; Agent tasks require your own compatible HTTPS model service.

在 Windows 10/11 x64 双击外层 EXE，首次运行准备内嵌运行时，程序缓存约需 2 GB。基础协作无需模型密钥，Agent 任务需要自行配置兼容 HTTPS 模型服务。

Program resources use `%LOCALAPPDATA%/NexusRoom/packages/`; separate user state uses `%LOCALAPPDATA%/NexusRoom/user-state-v1.0.0/` and survives moving the EXE. Install the companion APK on Android 10+, join a reachable LAN, scan the room invitation and verify the first-join certificate fingerprint.

程序资源和用户状态分别存放于上述目录，移动 EXE 保留状态。Android 10+ 安装伴侣 APK，两端连入可互通局域网后扫描房间邀请，首次入房核对证书指纹。

Hold/release the Agent microphone to transcribe a draft for confirmation. Hi Nexus starts disabled; explicitly enabling it permits automatic target selection and execution. KWS/ASR stay local, Agent reasoning uses the room provider. An accepted local wake opens the bound-room Agent; the red dot reflects local capture. Android background listening/opening needs the corresponding service and system permissions.

按住/松开麦克风将转写写入草稿，确认后发送。Hi Nexus 默认关闭，显式开启即允许自动选择目标并执行；KWS/ASR 留在本地，Agent 推理使用房间服务商。接受本地唤醒会打开绑定房间 Agent，红点仅表示本地捕获。Android 后台监听/打开需相应服务与系统授权。

This is a template for future packages. [Source and bilingual guides](https://github.com/megumikatoscut/NexusRoom) and [release assets](https://github.com/megumikatoscut/NexusRoom/releases/tag/v1.0.0) are maintained on GitHub. Templates become payload documents only after rebuilding; published binaries retain their embedded documentation.

本文为后续打包模板，源码、双语文档及发布包位于上述 GitHub 链接。模板只有重建后才进入运行包，现有发布包保留原内嵌文档。

First-party software is MIT-licensed. Retain every third-party runtime/dependency LICENSE and NOTICE tree.

自有软件使用 MIT；再分发时保留各第三方运行时/依赖的完整 LICENSE/NOTICE 树。
