using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;

namespace NexusRoom.Host.Agent;

public sealed record AgentEvent(
    DateTimeOffset Time,
    string Kind,
    string Text,
    string Tool = "",
    string RequestId = "",
    int Step = 0,
    string Result = "",
    string ErrorType = "",
    JsonElement? Arguments = null);
public sealed class AgentRun
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string DeviceId { get; init; } = "";
    public string RoomId { get; init; } = "";
    public string ProfileId { get; init; } = "";
    public string ProfileName { get; init; } = "";
    public string Task { get; init; } = "";
    public string Secret { get; init; } = "";
    public string Mode { get; init; } = "request";
    public string Status { get; set; } = "running";
    public string Result { get; set; } = "";
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
    public List<AgentEvent> Events { get; } = [];
    public CancellationTokenSource Cancellation { get; init; } = new(TimeSpan.FromMinutes(15));
    public TaskCompletionSource<bool> Finished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}

public sealed class AgentRunner : IDisposable
{
    private readonly StateStore store;
    private readonly ToolService tools;
    private readonly DeviceHub hub;
    private readonly ApprovalService approvals;
    private readonly ConcurrentDictionary<string, AgentRun> runs = new();
    private readonly object gate = new();
    private readonly HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) };

    public AgentRunner(StateStore store, ToolService tools, DeviceHub hub, ApprovalService approvals)
    {
        this.store = store;
        this.tools = tools;
        this.hub = hub;
        this.approvals = approvals;
        hub.AgentEventReceived += OnAgentEvent;
        hub.Disconnected += OnDeviceDisconnected;
        approvals.Decided += OnApprovalDecided;
    }

    public object[] List(string? deviceId = null, string? roomId = null) => runs.Values
        .Where(r => (deviceId == null || r.DeviceId == deviceId) && (roomId == null || r.RoomId == roomId))
        .OrderByDescending(r => r.StartedAt).Select(View).ToArray();

    public void CancelDevice(string id)
    {
        foreach (var run in runs.Values.Where(r => r.DeviceId == id && r.Status == "running")) run.Cancellation.Cancel();
    }
    private void OnDeviceDisconnected(Device device) => CancelDevice(device.Id);

    private static object View(AgentRun run)
    {
        lock (run.Events) return new { run.Id, run.DeviceId, run.RoomId, run.ProfileId, run.ProfileName, run.Task, run.Mode, run.Status, run.Result, run.StartedAt, events = run.Events.ToArray() };
    }

    public object Start(AgentStart start)
    {
        if (start.Mode is not ("request" or "automatic")) throw new ApiException(400, "请选择请求模式或自动模式");
        if (string.IsNullOrWhiteSpace(start.Task) || start.Task.Length > 8000) throw new ApiException(400, "请输入 1 到 8000 字的任务");
        var device = store.GetDevice(start.DeviceId);
        hub.Require(device, "info", true);
        var selected = store.ProfileFor(device.RoomId, start.ProfileId);
        ValidatePhoneProfileUrl(selected.ApiUrl);
        if (selected.ApiKey.Length == 0) throw new ApiException(409, "请先配置模型方案的 API Key");
        AgentProfile profile;
        lock (store.Gate) profile = new() { Id = selected.Id, Name = selected.Name, ApiType = selected.ApiType, ApiUrl = selected.ApiUrl,
            ApiKey = selected.ApiKey, Model = selected.Model, MaxCalls = selected.MaxCalls, MaxSteps = selected.MaxSteps, TimeoutSeconds = selected.TimeoutSeconds };
        lock (gate)
        {
            if (runs.Values.Any(r => r.Status == "running" && r.DeviceId == device.Id)) throw new ApiException(409, "此设备已有任务执行中，请先完成或停止");
            foreach (var old in runs.Values.Where(r => r.Status != "running").OrderByDescending(r => r.StartedAt).Skip(99)) if (runs.TryRemove(old.Id, out _)) old.Cancellation.Dispose();
            var run = new AgentRun { DeviceId = device.Id, RoomId = device.RoomId, ProfileId = profile.Id, ProfileName = profile.Name,
                Task = start.Task.Trim(), Secret = profile.ApiKey, Mode = start.Mode, Cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Clamp(profile.TimeoutSeconds, 30, 3600))) };
            runs[run.Id] = run;
            _ = Execute(run, profile);
            return View(run);
        }
    }

    public void Cancel(string id, string? roomId = null)
    {
        if (!runs.TryGetValue(id, out var run) || roomId != null && run.RoomId != roomId) throw new ApiException(404, "任务不存在");
        run.Cancellation.Cancel();
    }

    public CancellationToken RequireActiveDeviceRun(string taskId, Device device)
    {
        if (string.IsNullOrWhiteSpace(taskId) || taskId.Length > 100) throw new ApiException(400, "任务标识无效");
        if (!runs.TryGetValue(taskId, out var run) || run.DeviceId != device.Id || run.RoomId != device.RoomId)
            throw new ApiException(404, "当前手机的 Agent 任务不存在");
        if (run.Status != "running" || run.Cancellation.IsCancellationRequested || !hub.HasLease(device.Id, "agent:" + taskId))
            throw new ApiException(409, "Agent 任务已结束或尚未取得设备控制权");
        return run.Cancellation.Token;
    }

    private static void Event(AgentRun run, string kind, string text, string tool = "", string requestId = "", int step = 0, string result = "", string errorType = "", JsonElement? arguments = null)
    {
        lock (run.Events)
        {
            string Clean(string value, int maximum) => Shorten(run.Secret.Length > 0 ? value.Replace(run.Secret, "[REDACTED]", StringComparison.Ordinal) : value, maximum);
            if (run.Events.Count >= 600) run.Events.RemoveAt(0);
            if (arguments is { } value && run.Secret.Length > 0)
            {
                var escaped = JsonSerializer.Serialize(run.Secret)[1..^1];
                using var clean = JsonDocument.Parse(value.GetRawText().Replace(escaped, "[REDACTED]", StringComparison.Ordinal));
                arguments = clean.RootElement.Clone();
            }
            run.Events.Add(new(DateTimeOffset.UtcNow, kind, Clean(text, 4000), Clean(tool, 160), Clean(requestId, 100), step,
                Clean(result, 8000), Clean(errorType, 80), arguments));
        }
    }

    private void OnAgentEvent(Device device, JsonElement message)
    {
        var id = message.GetProperty("taskId").GetString();
        if (id == null || !runs.TryGetValue(id, out var run) || run.DeviceId != device.Id || run.Status != "running") return;
        var status = message.TryGetProperty("status", out var value) ? value.GetString() : message.TryGetProperty("event", out var legacy) ? legacy.GetString() : null;
        // `permission_required` is emitted by the Android-local engine before a
        // request-mode tool call. Keep it in the protocol allow-list so the
        // desktop can create the corresponding approval and send the decision
        // back through `agent_approve`.
        if (status is not ("accepted" or "progress" or "tool_started" or "tool_finished" or "permission_required" or "completed" or "failed" or "cancelled")) return;
        var text = message.TryGetProperty("text", out var detail) && detail.ValueKind == JsonValueKind.String ? detail.GetString() ?? "" : "";
        if (text.Length > 4000) text = text[..4000];
        var step = message.TryGetProperty("step", out var stepValue) && stepValue.TryGetInt32(out var parsedStep) ? Math.Clamp(parsedStep, 0, 10000) : 0;
        var toolName = message.TryGetProperty("tool", out var toolValue2) && toolValue2.ValueKind == JsonValueKind.String ? Shorten(toolValue2.GetString() ?? "", 160) : "";
        var resultText = message.TryGetProperty("result", out var resultValue) && resultValue.ValueKind == JsonValueKind.String ? resultValue.GetString() ?? "" : "";
        if (resultText.Length > 8000) resultText = resultText[..8000];
        var errorType = message.TryGetProperty("errorType", out var errorValue) && errorValue.ValueKind == JsonValueKind.String ? errorValue.GetString() ?? "" : "";
        if (errorType.Length == 0 && status == "failed")
        {
            var separator = text.IndexOf(':');
            if (separator is > 0 and < 40) errorType = text[..separator].Trim();
        }
        if (status == "permission_required")
        {
            var requestId = message.TryGetProperty("requestId", out var request) && request.ValueKind == JsonValueKind.String ? request.GetString() ?? "" : "";
            var tool = toolName.Length > 0 ? toolName : "手机操作";
            var summary = ApprovalSummary(message, tool);
            Event(run, "permission_required", text.Length > 0 ? text : "等待确认：" + tool, tool, requestId, step, arguments: summary);
            if (requestId.Length > 0 && requestId.Length <= 100) approvals.CreateRemote(device.Id, tool, summary, run.Id, requestId);
        }
        else if (text.Length > 0 || resultText.Length > 0)
            Event(run, status == "failed" ? "error" : status == "tool_started" ? "tool" : status == "completed" ? "assistant" : "status", text, toolName, "", step, resultText, errorType);
        if (status is "completed" or "failed" or "cancelled")
        {
            run.Status = status;
            if (resultText.Length > 0) run.Result = resultText;
            else run.Result = text;
            if (run.Secret.Length > 0) run.Result = run.Result.Replace(run.Secret, "[REDACTED]", StringComparison.Ordinal);
            run.Finished.TrySetResult(true);
            approvals.CancelRun(run.Id);
        }
    }

    private void OnApprovalDecided(Approval approval, bool allowed)
    {
        if (!runs.TryGetValue(approval.RunId, out var run) || run.Status != "running" || approval.RequestId.Length == 0) return;
        _ = Task.Run(async () => { try { await hub.Call(run.DeviceId, "agent_approve", Json.Element(new { taskId = run.Id, requestId = approval.RequestId, approved = allowed }), run.Cancellation.Token); } catch (Exception) { } });
    }

    private async Task Execute(AgentRun run, AgentProfile profile)
    {
        var lease = false;
        try
        {
            Event(run, "status", "已发送到手机，等待执行");
            await tools.ReserveRun(run.DeviceId, run.Id, run.Cancellation.Token);
            lease = true;
            var accepted = await hub.Call(run.DeviceId, "agent_start", Json.Element(new
            {
                taskId = run.Id, prompt = run.Task, mode = run.Mode,
                profile = new { apiType = profile.ApiType, baseUrl = profile.ApiUrl, model = profile.Model, apiKey = profile.ApiKey,
                    maxCalls = profile.MaxCalls, maxSteps = profile.MaxSteps, timeoutSeconds = profile.TimeoutSeconds }
            }), run.Cancellation.Token);
            if (!accepted.TryGetProperty("accepted", out var ack) || !ack.GetBoolean()) throw new ApiException(502, "手机未接受 Agent 任务");
            await run.Finished.Task.WaitAsync(run.Cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            if (lease) try { using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await hub.Call(run.DeviceId, "agent_cancel", Json.Element(new { taskId = run.Id }), stop.Token); } catch (Exception) { }
            if (run.Status == "running") { run.Status = "cancelled"; run.Result = "任务已停止或超时"; Event(run, "status", run.Result, errorType: "OperationCanceled"); }
        }
        catch (Exception error)
        {
            run.Status = "failed"; run.Result = error is ApiException ? error.Message : "手机任务连接中断，请检查设备和模型服务"; Event(run, "error", run.Result, errorType: error.GetType().Name);
        }
        finally { approvals.CancelRun(run.Id); if (lease) await tools.ReleaseRun(run.DeviceId, run.Id); }
    }

    public async Task<object> Test(CancellationToken ct, string? roomId = null, string? profileId = null)
    {
        var profile = store.ProfileFor(store.GetRoom(roomId).Id, profileId);
        return await TestProfile(ct, profile);
    }

    public async Task<object> TestProfile(CancellationToken ct, AgentProfile profile)
    {
        ValidatePhoneProfileUrl(profile.ApiUrl);
        if (profile.ApiKey.Length == 0) throw new ApiException(409, "模型方案尚未配置 API Key");
        var source = new Uri(profile.ApiUrl);
        var path = source.AbsolutePath.TrimEnd('/');
        if (path.EndsWith("/chat/completions", StringComparison.Ordinal)) path = path[..^"/chat/completions".Length];
        if (path.EndsWith("/responses", StringComparison.Ordinal)) path = path[..^"/responses".Length];
        if (!System.Text.RegularExpressions.Regex.IsMatch(path, @"/v\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) path += "/v1";
        var suffix = profile.ApiType == "responses" ? "/responses" : "/chat/completions";
        var url = new UriBuilder(source) { Path = path + suffix, Query = "", Fragment = "" }.Uri;
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile.ApiKey);
        request.Content = JsonContent.Create(profile.ApiType == "responses" ? (object)new { model = profile.Model, input = "请只回复 NexusRoom OK。", max_output_tokens = 100 } : new { model = profile.Model, messages = new[] { new { role = "user", content = "请只回复 NexusRoom OK。" } }, max_completion_tokens = 100 });
        using var response = await http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) throw new ApiException(502, $"模型服务返回 HTTP {(int)response.StatusCode}");
        using var data = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(ct));
        var root = data.RootElement;
        var reply = profile.ApiType == "responses" ? ReadResponsesText(root) : root.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
        if (string.IsNullOrWhiteSpace(reply)) throw new ApiException(502, "模型未返回有效文字");
        return new { ok = true, profile = profile.Name, model = profile.Model, reply };
    }

    public void Dispose() { hub.AgentEventReceived -= OnAgentEvent; hub.Disconnected -= OnDeviceDisconnected; approvals.Decided -= OnApprovalDecided; foreach (var run in runs.Values) run.Cancellation.Cancel(); http.Dispose(); }

    public static void ValidatePhoneProfileUrl(string apiUrl)
    {
        if (string.IsNullOrWhiteSpace(apiUrl) || apiUrl.Length > 2048 || !Uri.TryCreate(apiUrl, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps || string.IsNullOrWhiteSpace(uri.Host)
            || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0
            || !uri.IsWellFormedOriginalString())
            throw new ApiException(400, "手机 Agent 模型 API 必须使用 HTTPS，且不能包含账号、查询参数或片段");
    }

    private static readonly HashSet<string> ApprovalFields = new(StringComparer.Ordinal)
    {
        "name", "page", "packageName", "url", "text", "resourceId", "description", "className", "index",
        "x", "y", "endX", "endY", "duration", "direction", "query", "type", "limit", "fileId",
        "fileName", "photoId", "to", "subject", "body", "bodyPrefix", "action", "key", "target",
        "textPreview", "textLength", "bodyPreview", "bodyLength", "bodyPrefixPreview", "bodyPrefixLength",
        "targetId", "title", "visibility", "inviteeIds", "deviceId", "deviceIds"
    };

    private static JsonElement ApprovalSummary(JsonElement message, string tool)
    {
        if (!message.TryGetProperty("arguments", out var source) || source.ValueKind != JsonValueKind.Object)
            return Json.Element(new { });
        var summary = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var field in source.EnumerateObject())
        {
            if (summary.Count >= 16 || !ApprovalFields.Contains(field.Name)) continue;
            var value = field.Value;
            if (value.ValueKind == JsonValueKind.String)
            {
                var raw = value.GetString() ?? "";
                if (field.Name is "text" or "textPreview" && tool == "clipboard_set")
                    summary[field.Name] = "[剪贴板内容未记录]";
                else if (field.Name == "url" && Uri.TryCreate(raw, UriKind.Absolute, out var url))
                {
                    var visible = new UriBuilder(url) { UserName = "", Password = "", Query = "", Fragment = "" }.Uri;
                    summary[field.Name] = Shorten(visible.GetLeftPart(UriPartial.Path) + (url.Query.Length > 0 ? "?…" : ""), 400);
                }
                else
                    summary[field.Name] = Shorten(raw, field.Name is "body" or "bodyPrefix" or "text" or "textPreview" or "bodyPreview" or "bodyPrefixPreview" ? 240 : 400);
            }
            else if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number))
                summary[field.Name] = number;
            else if (value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                summary[field.Name] = value.GetBoolean();
            else if (value.ValueKind == JsonValueKind.Array && field.Name is "inviteeIds" or "deviceIds")
                summary[field.Name] = value.EnumerateArray().Take(32).Where(v => v.ValueKind == JsonValueKind.String)
                    .Select(v => Shorten(v.GetString() ?? "", 100)).ToArray();
        }
        return Json.Element(summary);
    }

    private static string Shorten(string value, int limit) => value.Length <= limit ? value : value[..limit] + $"…（共 {value.Length} 字）";

    private static string? ReadResponsesText(JsonElement root)
    {
        if (root.TryGetProperty("output_text", out var direct) && direct.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(direct.GetString()))
            return direct.GetString();
        if (!root.TryGetProperty("output", out var items) || items.ValueKind != JsonValueKind.Array) return null;
        var text = new StringBuilder();
        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "message"
                || !item.TryGetProperty("content", out var parts) || parts.ValueKind != JsonValueKind.Array) continue;
            foreach (var part in parts.EnumerateArray())
                if (part.ValueKind == JsonValueKind.Object && part.TryGetProperty("type", out var partType) && partType.ValueKind == JsonValueKind.String && partType.GetString() == "output_text"
                    && part.TryGetProperty("text", out var value) && value.ValueKind == JsonValueKind.String)
                    text.Append(value.GetString());
        }
        return text.ToString();
    }
}
