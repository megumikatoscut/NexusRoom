using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;
using NexusRoom.Host.Files;
using NexusRoom.Host.Desktop;
using NexusRoom.Host.Communication;

namespace NexusRoom.Host.Agent;

public sealed class PcAgentRunner(StateStore store, ApprovalService approvals, DeviceHub hub, FileService files, PcWorkCoordinator work, CommunicationService communication) : IAsyncDisposable
{
    private sealed class PcRun
    {
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public required string RoomId { get; init; }
        public required string DeviceId { get; init; }
        public required string ProfileId { get; init; }
        public required string ProfileName { get; init; }
        public required string Task { get; init; }
        public required string Mode { get; init; }
        public required string WorkspacePath { get; init; }
        public required string Secret { get; init; }
        public required CancellationTokenSource Cancellation { get; init; }
        public string Status { get; set; } = "running";
        public string Result { get; set; } = "";
        public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
        public List<AgentEvent> Events { get; } = [];
        public Process? Process { get; set; }
        public Task? Execution { get; set; }
        public Dictionary<string, string> ToolNames { get; } = [];
        public string PolicyError { get; set; } = "";
        public string FileTransferError { get; set; } = "";
        public string CommunicationError { get; set; } = "";
        public string TurnEnd { get; set; } = "";
        public string Diagnostic { get; set; } = "";
        public bool SeenRunning { get; set; }
        public bool SeenIdle { get; set; }
    }

    private readonly ConcurrentDictionary<string, PcRun> runs = new();
    private readonly object gate = new();
    private bool disposed;

    public object[] List(string? roomId = null, string? targetId = null) => runs.Values
        .Where(r => (roomId == null || r.RoomId == roomId) && (targetId == null || r.DeviceId == targetId))
        .OrderByDescending(r => r.StartedAt).Select(View).ToArray();

    public object Start(string roomId, string targetId, string task, string mode, string profileId, string? workspacePath)
    {
        if (mode is not ("request" or "automatic")) throw new ApiException(400, "请选择请求模式或自动模式");
        if (string.IsNullOrWhiteSpace(task) || task.Length > 8000) throw new ApiException(400, "请输入 1 到 8000 字的任务");
        var selected = store.ProfileFor(roomId, profileId);
        AgentRunner.ValidatePhoneProfileUrl(selected.ApiUrl);
        if (selected.ApiKey.Length == 0) throw new ApiException(409, "请先配置模型方案的 API Key");
        AgentProfile profile;
        lock (store.Gate) profile = new() { Id = selected.Id, Name = selected.Name, ApiType = selected.ApiType,
            ApiUrl = selected.ApiUrl, ApiKey = selected.ApiKey, Model = selected.Model, MaxCalls = selected.MaxCalls,
            MaxSteps = selected.MaxSteps, TimeoutSeconds = selected.TimeoutSeconds };

        var cwd = PcWorkspace.Normalize(workspacePath);

        lock (gate)
        {
            if (disposed) throw new ApiException(503, "PC Agent 正在关闭");
            if (runs.Values.Any(r => r.Status == "running"))
                throw new ApiException(409, "这台电脑已有 Agent 任务，请先完成或停止");
            foreach (var old in runs.Values.Where(r => r.Status != "running").OrderByDescending(r => r.StartedAt).Skip(99))
                if (runs.TryRemove(old.Id, out _)) old.Cancellation.Dispose();
            var run = new PcRun { RoomId = roomId, DeviceId = targetId, ProfileId = profile.Id, ProfileName = profile.Name,
                Task = task.Trim(), Mode = mode, WorkspacePath = cwd, Secret = profile.ApiKey,
                Cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Clamp(profile.TimeoutSeconds, 30, 3600))) };
            try { work.Acquire(run.Id, roomId, targetId, "agent"); }
            catch { run.Cancellation.Dispose(); throw; }
            runs[run.Id] = run;
            run.Execution = Execute(run, profile);
            return View(run);
        }
    }

    public void Cancel(string id, string roomId)
    {
        if (!runs.TryGetValue(id, out var run) || run.RoomId != roomId) throw new ApiException(404, "任务不存在");
        if (run.Status != "running") return;
        run.Cancellation.Cancel();
        approvals.CancelRun(run.Id);
    }

    public void CancelRoom(string roomId)
    {
        foreach (var run in runs.Values.Where(r => r.RoomId == roomId && r.Status == "running")) Cancel(run.Id, roomId);
    }

    private static object View(PcRun run)
    {
        lock (run.Events) return new { run.Id, run.DeviceId, run.RoomId, run.ProfileId, run.ProfileName, run.Task,
            run.Mode, run.WorkspacePath, run.Status, run.Result, run.StartedAt, events = run.Events.ToArray() };
    }

    private static void Event(PcRun run, string kind, string text, string tool = "", int step = 0, string result = "",
        string errorType = "", string requestId = "", JsonElement? arguments = null)
    {
        lock (run.Events)
        {
            if (run.Events.Count >= 600) run.Events.RemoveAt(0);
            if (arguments is { } args)
            {
                var escaped = JsonSerializer.Serialize(run.Secret)[1..^1];
                using var sanitized = JsonDocument.Parse(args.GetRawText().Replace(escaped, "[REDACTED]", StringComparison.Ordinal));
                arguments = sanitized.RootElement.Clone();
            }
            run.Events.Add(new(DateTimeOffset.UtcNow, kind, Short(Redact(run, text), 4000), tool, RequestId: requestId, Step: step,
                Result: Short(Redact(run, result), 8000), ErrorType: errorType, Arguments: arguments));
        }
    }

    private async Task Execute(PcRun run, AgentProfile profile)
    {
        Process? process = null;
        PcApprovalBridge? approvalBridge = null;
        PcRoomFileBridge? roomFileBridge = null;
        Task? stderr = null;
        var finalStatus = "failed";
        try
        {
            var (node, bin, patch, browserPath) = ResolveHarness(run);
            approvalBridge = new PcApprovalBridge(approvals, run.RoomId, run.DeviceId, run.Id, approval =>
                Event(run, "permission_required", "等待确认：" + approval.Tool, approval.Tool,
                    requestId: approval.RequestId, arguments: approval.Arguments), run.Cancellation.Token);
            roomFileBridge = new PcRoomFileBridge(store, hub, files, approvals, communication, run.RoomId, run.DeviceId, run.Id,
                run.Mode, run.WorkspacePath, approval => Event(run, "permission_required", "等待确认：" + (approval.Tool == "arrange_communication" ? "安排会议或通话" : "发送文件到手机"),
                    approval.Tool, requestId: approval.RequestId, arguments: approval.Arguments), run.Cancellation.Token);
            var start = new ProcessStartInfo(node)
            {
                WorkingDirectory = run.WorkspacePath,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true
            };
            if (browserPath != null)
            {
                start.ArgumentList.Add("--preserve-symlinks");
                start.ArgumentList.Add("--preserve-symlinks-main");
            }
            start.ArgumentList.Add(bin);
            start.ArgumentList.Add("--profile");
            start.ArgumentList.Add("sdk");
            start.ArgumentList.Add("--patch");
            start.ArgumentList.Add(patch);
            start.Environment.Remove("NODE_PATH");
            start.Environment.Remove("NODE_OPTIONS");
            if (browserPath != null)
                start.Environment["NODE_OPTIONS"] = "--preserve-symlinks --preserve-symlinks-main";
            if (Path.IsPathFullyQualified(node))
                start.Environment["PATH"] = Path.GetDirectoryName(node) + Path.PathSeparator + start.Environment["PATH"];
            if (browserPath != null) start.Environment["PLAYWRIGHT_BROWSERS_PATH"] = browserPath;
            var primaryRuntime = Path.Combine(browserPath == null ? Path.Combine(AppContext.BaseDirectory, "runtime") : Path.GetDirectoryName(browserPath)!, "primary-runtime");
            if (browserPath != null && File.Exists(Path.Combine(primaryRuntime, "runtime.json")))
                start.Environment["DSH_BUNDLED_PRIMARY_RUNTIME"] = primaryRuntime;
            start.Environment["DSH_HOME"] = Path.Combine(store.DirectoryPath, "harness", run.RoomId);
            start.Environment["DSH_TELEMETRY_DISABLED"] = "1";
            start.Environment["DSH_PERMISSION_MODE"] = run.Mode == "automatic" ? "danger-full-access" : "workspace-write";
            start.Environment["NEXUSROOM_HARNESS_API"] = profile.ApiType == "responses" ? "openai-responses" : "openai-completions";
            start.Environment["NEXUSROOM_HARNESS_BASE_URL"] = NormalizeBaseUrl(profile.ApiUrl);
            start.Environment["NEXUSROOM_HARNESS_MODEL"] = profile.Model;
            start.Environment["NEXUSROOM_HARNESS_API_KEY"] = profile.ApiKey;
            start.Environment["NEXUSROOM_HARNESS_MAX_CALLS"] = profile.MaxCalls.ToString(System.Globalization.CultureInfo.InvariantCulture);
            start.Environment["NEXUSROOM_HARNESS_MAX_STEPS"] = profile.MaxSteps.ToString(System.Globalization.CultureInfo.InvariantCulture);
            start.Environment["NEXUSROOM_APPROVAL_PIPE"] = approvalBridge.PipeName;
            start.Environment["NEXUSROOM_ROOM_FILES_PIPE"] = roomFileBridge.PipeName;
            process = new Process { StartInfo = start };
            if (!process.Start()) throw new InvalidOperationException("DeepSeek Harness 无法启动");
            run.Process = process;
            approvalBridge.Start(process);
            roomFileBridge.Start(process);
            stderr = DrainStderr(process.StandardError, run);
            Event(run, "status", "DeepSeek Harness 正在启动 · " + run.WorkspacePath);

            var reader = process.StandardOutput;
            var writer = process.StandardInput;
            writer.NewLine = "\n";
            writer.AutoFlush = true;
            var initializeId = Guid.NewGuid().ToString("N");
            await Send(writer, initializeId, "initialize", new { cwd = run.WorkspacePath, provider = "nexusroom", model = profile.Model });
            using (var startup = CancellationTokenSource.CreateLinkedTokenSource(run.Cancellation.Token))
            {
                startup.CancelAfter(TimeSpan.FromSeconds(90));
                await Response(reader, initializeId, run, profile, startup.Token);
            }
            Event(run, "status", "模型方案已连接 · " + profile.Name);
            var promptId = Guid.NewGuid().ToString("N");
            await Send(writer, promptId, "session/prompt", new { sessionId = run.Id, contentBlocks = new[] { new { type = "text", text = run.Task } } });
            await Response(reader, promptId, run, profile, run.Cancellation.Token);
            while (!run.SeenIdle)
            {
                var frame = await ReadFrame(reader, run.Cancellation.Token);
                Handle(run, frame, profile);
            }
            finalStatus = run.TurnEnd == "completed" && run.PolicyError.Length == 0 && run.FileTransferError.Length == 0 && run.CommunicationError.Length == 0 ? "completed" : "failed";
            if (run.PolicyError.Length > 0) run.Result = run.PolicyError;
            else if (run.FileTransferError.Length > 0) run.Result = run.FileTransferError;
            else if (run.CommunicationError.Length > 0) run.Result = run.CommunicationError;
            else if (run.TurnEnd != "completed" && run.TurnEnd != "error")
                run.Result = "任务未完成：" + (run.TurnEnd.Length > 0 ? run.TurnEnd : "未收到有效的 Harness turn/end");
            if (run.Result.Length == 0) run.Result = finalStatus == "completed" ? "任务已完成" : "任务未完成：" + run.TurnEnd;
        }
        catch (Exception) when (run.Cancellation.IsCancellationRequested)
        {
            finalStatus = "cancelled";
            run.Result = "任务已停止或超时";
        }
        catch (OperationCanceledException)
        {
            run.Result = "DeepSeek Harness 启动超时（90 秒）";
        }
        catch (Exception error)
        {
            var diagnostic = run.Diagnostic.Replace(profile.ApiKey, "[REDACTED]").Trim();
            run.Result = error is ApiException ? error.Message : "DeepSeek Harness 执行失败：" + Short(error.Message.Replace(profile.ApiKey, "[REDACTED]"), 500)
                + (diagnostic.Length == 0 ? "" : " · " + Short(diagnostic, 700));
            Event(run, "error", run.Result, errorType: error.GetType().Name);
        }
        finally
        {
            try
            {
                if (approvalBridge is not null) await approvalBridge.DisposeAsync();
                if (roomFileBridge is not null) await roomFileBridge.DisposeAsync();
                if (process != null && run.Process != null)
                {
                    await Shutdown(process);
                    if (stderr != null) await stderr;
                    if (finalStatus == "completed" && process.ExitCode != 0)
                    {
                        finalStatus = "failed";
                        run.Result = "DeepSeek Harness 异常退出（" + process.ExitCode + "）";
                    }
                }
            }
            catch (Exception error)
            {
                Kill(process);
                finalStatus = "failed";
                run.Result = "DeepSeek Harness 清理失败：" + Short(Redact(run, error.Message), 500);
            }
            finally
            {
                process?.Dispose();
                run.Process = null;
                var patchFile = Path.Combine(store.DirectoryPath, "harness", "patches", run.Id + ".yml");
                try { if (File.Exists(patchFile)) File.Delete(patchFile); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                if (run.Cancellation.IsCancellationRequested)
                {
                    finalStatus = "cancelled";
                    run.Result = "任务已停止或超时";
                }
                run.Result = Redact(run, run.Result);
                Event(run, finalStatus == "failed" ? "error" : "status", run.Result);
                lock (run.Events) run.Status = finalStatus;
                work.Release(run.Id);
            }
        }
    }

    private static async Task Send(StreamWriter writer, string id, string method, object parameters)
    {
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", id, method, @params = parameters }, Json.Options));
    }

    private static async Task Response(StreamReader reader, string id, PcRun run, AgentProfile profile, CancellationToken token)
    {
        while (true)
        {
            var frame = await ReadFrame(reader, token);
            if (Get(frame, "id") == id)
            {
                if (frame.TryGetProperty("error", out var error)) throw new InvalidOperationException(Get(error, "message") ?? "JSON-RPC 调用失败");
                return;
            }
            Handle(run, frame, profile);
        }
    }

    private static async Task<JsonElement> ReadFrame(StreamReader reader, CancellationToken token)
    {
        while (true)
        {
            var line = await reader.ReadLineAsync(token) ?? throw new IOException("DeepSeek Harness 已断开 JSON-RPC 连接");
            if (line.Length == 0) continue;
            if (line.Length > 4 * 1024 * 1024) throw new IOException("DeepSeek Harness 消息超出大小限制");
            try { using var document = JsonDocument.Parse(line); return document.RootElement.Clone(); }
            catch (JsonException) { throw new IOException("DeepSeek Harness stdout 包含非 JSON-RPC 内容"); }
        }
    }

    private static void Handle(PcRun run, JsonElement frame, AgentProfile? profile)
    {
        var method = Get(frame, "method");
        if (method == "session.status" && frame.TryGetProperty("params", out var status) && Get(status, "sessionId") == run.Id)
        {
            if (Get(status, "status") == "running") { run.SeenRunning = true; Event(run, "status", "PC Agent 正在执行"); }
            if (Get(status, "status") == "idle" && run.SeenRunning) run.SeenIdle = true;
            return;
        }
        if (method != "session.event" || !frame.TryGetProperty("params", out var parameters)
            || Get(parameters, "sessionId") != run.Id || !parameters.TryGetProperty("event", out var source)) return;
        var type = Get(source, "type");
        if (!source.TryGetProperty("data", out var data)) return;
        var step = data.TryGetProperty("step", out var number) && number.TryGetInt32(out var value) ? value : 0;
        switch (type)
        {
            case "assistant/message":
                var answer = ContentText(data, "message");
                if (answer.Length > 0) { run.Result = Short(answer, 16000); Event(run, "assistant", answer, step: step); }
                break;
            case "tool/call":
                var tool = Get(data, "name") ?? "tool";
                var callId = Get(data, "callId") ?? "";
                run.ToolNames[callId] = tool;
                JsonElement? toolArguments = null;
                if (Get(data, "arguments") is { } encoded)
                {
                    try { using var parsed = JsonDocument.Parse(encoded); toolArguments = parsed.RootElement.Clone(); }
                    catch (JsonException) { }
                }
                Event(run, "tool", "调用 " + tool, tool, step, requestId: callId, arguments: toolArguments);
                break;
            case "tool/result":
                var result = ContentText(data, "message");
                var failed = data.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null;
                if (data.TryGetProperty("message", out var toolMessage) && toolMessage.TryGetProperty("isError", out var isError)
                    && isError.ValueKind == JsonValueKind.True) failed = true;
                var resultCallId = Get(data, "callId") ?? Get(toolMessage, "toolCallId") ?? Get(toolMessage, "callId") ?? "";
                run.ToolNames.Remove(resultCallId, out var resultTool);
                var errorCode = Get(error, "code") ?? "";
                if (error.ValueKind == JsonValueKind.Object && error.TryGetProperty("info", out var info))
                    errorCode = Get(info, "code") ?? errorCode;
                if (errorCode == "NEXUSROOM_LIMIT") run.PolicyError = result.Length > 0 ? result : Get(error, "message") ?? "任务操作上限已达到";
                if (resultTool == "send_file_to_phone")
                {
                    run.FileTransferError = failed ? result.Length > 0 ? result : Get(error, "message") ?? "文件未成功发送到手机" : "";
                    if (errorCode == "NEXUSROOM_FILE_DENIED") run.PolicyError = run.FileTransferError;
                }
                if (resultTool == "arrange_communication")
                {
                    run.CommunicationError = failed ? result.Length > 0 ? result : Get(error, "message") ?? "通话或会议请求未发送" : "";
                    if (errorCode == "NEXUSROOM_COMMUNICATION_DENIED") run.PolicyError = run.CommunicationError;
                }
                Event(run, failed ? "error" : "result", result.Length > 0 ? result : "工具调用已结束", resultTool ?? "", step,
                    errorType: errorCode, requestId: resultCallId);
                break;
            case "turn/end":
                if (data.TryGetProperty("reason", out var reason))
                {
                    run.TurnEnd = Get(reason, "kind") ?? "";
                    if (run.TurnEnd == "error" && reason.TryGetProperty("error", out var detail))
                    {
                        var message = Get(detail, "message") ?? "模型请求失败";
                        if (!string.IsNullOrEmpty(profile?.ApiKey)) message = message.Replace(profile.ApiKey, "[REDACTED]", StringComparison.Ordinal);
                        run.Result = Short(message, 1000);
                        Event(run, "error", run.Result, errorType: Get(detail, "code") ?? "HarnessError");
                    }
                }
                break;
            case "approval/asked":
                Event(run, "status", "Harness 请求操作批准", step: step);
                break;
            case "approval/decided":
                var outcome = Get(data, "outcome") ?? "已处理";
                if (outcome is "rejected" or "unavailable" or "cancelled")
                {
                    run.PolicyError = "操作未获批准：" + outcome;
                    Event(run, "error", run.PolicyError, step: step, errorType: "ApprovalDenied");
                }
                else Event(run, "status", "Harness 操作批准结果：" + outcome, step: step);
                break;
        }
    }

    private static string ContentText(JsonElement data, string messageProperty)
    {
        if (!data.TryGetProperty(messageProperty, out var message) || !message.TryGetProperty("content", out var content)
            || content.ValueKind != JsonValueKind.Array) return "";
        var text = new StringBuilder();
        foreach (var block in content.EnumerateArray())
            if (Get(block, "type") == "text" && Get(block, "text") is { } part) text.Append(part);
        return text.ToString();
    }

    private static string? Get(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
    private static string Short(string value, int limit) => value.Length <= limit ? value : value[..limit] + "…";
    private static string Redact(PcRun run, string value) => value.Replace(run.Secret, "[REDACTED]", StringComparison.Ordinal);

    private (string node, string bin, string patch, string? browserPath) ResolveHarness(PcRun run)
    {
        var configured = Environment.GetEnvironmentVariable("NEXUS_HARNESS_DIR");
        var candidate = configured;
        if (string.IsNullOrWhiteSpace(candidate))
        {
            candidate = null;
            var bundled = Path.Combine(AppContext.BaseDirectory, "runtime", "harness");
            if (Directory.Exists(bundled)) candidate = bundled;
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (candidate == null && directory != null)
            {
                var found = Path.Combine(directory.FullName, "third_party", "deepseek-harness");
                if (File.Exists(Path.Combine(found, "apps", "cli", "lib", "bin.js"))) { candidate = found; break; }
                directory = directory.Parent;
            }
        }
        if (string.IsNullOrWhiteSpace(candidate)) throw new ApiException(503, "未找到 DeepSeek Harness；请设置 NEXUS_HARNESS_DIR");
        candidate = Path.GetFullPath(candidate);
        var packaged = File.Exists(Path.Combine(candidate, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
        var bin = packaged ? Path.Combine(candidate, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
            : Path.Combine(candidate, "apps", "cli", "lib", "bin.js");
        if (!File.Exists(bin)) throw new ApiException(503, "DeepSeek Harness 尚未构建：" + bin);
        var bundledNode = Path.Combine(AppContext.BaseDirectory, "runtime", "node", "node.exe");
        var node = packaged ? bundledNode : "node";
        if (packaged && !File.Exists(node)) throw new ApiException(503, "NexusRoom 内置 Node.js 缺失");
        string? browserPath = null;
        if (packaged)
        {
            var runtime = BundledRuntimePath.Resolve(node, Path.Combine(AppContext.BaseDirectory, "runtime"));
            if (Path.GetFullPath(candidate).Equals(Path.Combine(AppContext.BaseDirectory, "runtime", "harness"), StringComparison.OrdinalIgnoreCase))
            {
                candidate = Path.Combine(runtime, "harness");
                bin = Path.Combine(candidate, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
            }
            browserPath = Path.Combine(runtime, "browsers");
        }
        var template = Path.Combine(AppContext.BaseDirectory, "Agent", "harness-sdk.patch.yml");
        if (!File.Exists(template)) throw new ApiException(503, "NexusRoom Harness profile patch 缺失");
        var approvalPlugin = Path.Combine(AppContext.BaseDirectory, "Agent", "harness-approval.mjs");
        if (!File.Exists(approvalPlugin)) throw new ApiException(503, "NexusRoom Harness 审批插件缺失");
        var limitsPlugin = Path.Combine(AppContext.BaseDirectory, "Agent", "harness-limits.mjs");
        if (!File.Exists(limitsPlugin)) throw new ApiException(503, "NexusRoom Harness 上限插件缺失");
        var roomFilesPlugin = Path.Combine(AppContext.BaseDirectory, "Agent", "harness-room-files.mjs");
        if (!File.Exists(roomFilesPlugin)) throw new ApiException(503, "NexusRoom Harness 房间文件插件缺失");
        var patch = Path.Combine(store.DirectoryPath, "harness", "patches", run.Id + ".yml");
        Directory.CreateDirectory(Path.GetDirectoryName(patch)!);
        var source = File.ReadAllText(template);
        var prefix = "../../../third_party/deepseek-harness/";
        source = source.Replace(prefix, candidate.Replace('\\', '/').Replace("'", "''") + "/", StringComparison.Ordinal);
        foreach (var plugin in new[] {
            ("packages/computer-use/computer-use", "dsh-computer-use"),
            ("packages/experimental/computer-use-cua-driver-native", "dsh-experimental-computer-use-cua-driver-native"),
            ("packages/browser-use/browser-use", "dsh-browser-use"),
            ("packages/experimental/browser-use-playwright-mcp", "dsh-experimental-browser-use-playwright-mcp") })
            if (packaged) source = source.Replace(plugin.Item1 + "/lib/index.js", "node_modules/@deepseek-ai/" + plugin.Item2 + "/lib/index.js", StringComparison.Ordinal);
        source = source.Replace("__NEXUSROOM_APPROVAL_PLUGIN__", approvalPlugin.Replace('\\', '/').Replace("'", "''"), StringComparison.Ordinal);
        source = source.Replace("__NEXUSROOM_LIMITS_PLUGIN__", limitsPlugin.Replace('\\', '/').Replace("'", "''"), StringComparison.Ordinal);
        source = source.Replace("__NEXUSROOM_ROOM_FILES_PLUGIN__", roomFilesPlugin.Replace('\\', '/').Replace("'", "''"), StringComparison.Ordinal);
        File.WriteAllText(patch, source);
        return (node, bin, patch, browserPath);
    }

    private static string NormalizeBaseUrl(string apiUrl)
    {
        var uri = new Uri(apiUrl);
        var path = uri.AbsolutePath.TrimEnd('/');
        if (path.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) path = path[..^"/chat/completions".Length];
        if (path.EndsWith("/responses", StringComparison.OrdinalIgnoreCase)) path = path[..^"/responses".Length];
        if (!System.Text.RegularExpressions.Regex.IsMatch(path, @"/v\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) path += "/v1";
        return new UriBuilder(uri) { Path = path, Query = "", Fragment = "" }.Uri.ToString().TrimEnd('/');
    }

    private static async Task DrainStderr(StreamReader reader, PcRun run)
    {
        var buffer = new char[2048];
        while (await reader.ReadAsync(buffer) is var count && count > 0)
        {
            var piece = new string(buffer, 0, count);
            var combined = run.Diagnostic + piece;
            run.Diagnostic = combined.Length <= 8000 ? combined : combined[^8000..];
        }
    }

    private static async Task Shutdown(Process process)
    {
        if (process.HasExited) return;
        var output = process.StandardOutput.ReadToEndAsync();
        try
        {
            await Send(process.StandardInput, Guid.NewGuid().ToString("N"), "shutdown", new { });
            process.StandardInput.Close();
            using var grace = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(grace.Token);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or InvalidOperationException)
        { Kill(process); }
        using var confirmation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await process.WaitForExitAsync(confirmation.Token);
        await output.WaitAsync(confirmation.Token);
    }

    private static void Kill(Process? process)
    {
        if (process == null) return;
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    public async ValueTask DisposeAsync()
    {
        PcRun[] active;
        lock (gate)
        {
            disposed = true;
            active = runs.Values.ToArray();
            foreach (var run in active) run.Cancellation.Cancel();
        }
        var tasks = Task.WhenAll(active.Select(run => run.Execution ?? Task.CompletedTask));
        try { await tasks.WaitAsync(TimeSpan.FromSeconds(7)); }
        catch (TimeoutException)
        {
            foreach (var run in active) Kill(run.Process);
            try { await tasks.WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (TimeoutException) { }
        }
        foreach (var run in active)
        {
            if (run.Execution is { IsCompleted: false } task)
                _ = task.ContinueWith(_ => run.Cancellation.Dispose(), TaskScheduler.Default);
            else run.Cancellation.Dispose();
        }
    }
}
