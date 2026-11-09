using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using NexusRoom.Host.Agent;
using NexusRoom.Host.Core;
using NexusRoom.Host.Desktop;
using NexusRoom.Host.Devices;

namespace NexusRoom.Host.Voice;

public sealed record VoiceWakeInput(string EventId, string ProfileId = "", string? WorkspacePath = null);
public sealed record VoiceSubmitInput(string WakeId, string EventId, string Text);
public sealed record VoiceCancelInput(string WakeId, string EventId);
public sealed record VoiceSubmitReply(string TaskId, string WakeId, string Status, string TargetId, string RunId, object? Run, string Error);

public sealed class VoiceCoordinator : IDisposable
{
    private readonly StateStore store;
    private readonly DeviceHub hub;
    private readonly AgentRouter router;
    private readonly PcWorkCoordinator work;
    private readonly VoiceIntentResolver intent;
    private readonly VoiceWakeLedger ledger;
    private readonly ConcurrentDictionary<string, Task<VoiceSubmitReply>> pending = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly object submissionGate = new();
    public VoiceCoordinator(StateStore store, DeviceHub hub, AgentRouter router, PcWorkCoordinator work, VoiceIntentResolver intent)
    {
        this.store = store; this.hub = hub; this.router = router; this.work = work; this.intent = intent;
        Directory.CreateDirectory(Path.Combine(store.DirectoryPath, "voice"));
        ledger = new VoiceWakeLedger(key =>
        {
            var path = Path.Combine(store.DirectoryPath, "voice", key + ".dat");
            if (!File.Exists(path)) return null;
            return JsonSerializer.Deserialize<string>(ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser), Json.Options);
        }, (key, value) => store.WriteProtected(Path.Combine("voice", key + ".dat"), value));
    }
    public void RequireSource(string roomId, string sourceId)
    {
        store.GetRoom(roomId);
        if (sourceId == AgentRouter.PcTargetId(roomId)) return;
        var device = store.GetDevice(sourceId);
        if (device.RoomId != roomId || device.Revoked) throw new ApiException(403, "语音设备不属于本房间");
        hub.Require(device, "info", true);
    }
    public VoiceWakeReply Claim(string roomId, string sourceId, VoiceWakeInput input)
    {
        RequireSource(roomId, sourceId);
        var profile = store.ProfileFor(roomId, input.ProfileId);
        if (input.WorkspacePath?.Length > 32768) throw new ApiException(400, "工作目录过长");
        return ledger.Claim(roomId, sourceId, input.EventId, profile.Id, input.WorkspacePath);
    }
    public async Task<VoiceSubmitReply> Submit(string roomId, string sourceId, VoiceSubmitInput input)
    {
        RequireSource(roomId, sourceId);
        (VoiceWake Wake, VoiceTask Task, bool New) reserved;
        lock (submissionGate)
        {
            reserved = ledger.Reserve(roomId, sourceId, input.WakeId, input.EventId, input.Text);
            if (reserved.New)
            {
                var completion = new TaskCompletionSource<VoiceSubmitReply>(TaskCreationOptions.RunContinuationsAsynchronously);
                pending[reserved.Task.TaskId] = completion.Task;
                _ = Execute(reserved.Wake, reserved.Task, completion);
            }
        }
        if (pending.TryGetValue(reserved.Task.TaskId, out var action))
        {
            var result = await action;
            return reserved.New ? result : result with { Status = result.Status == "started" ? "duplicate" : result.Status };
        }
        return Reply(reserved.Task, true);
    }
    private VoiceDevice[] Devices(string roomId)
    {
        lock (store.Gate) return store.State.Devices.Where(d => !d.Revoked && d.RoomId == roomId)
            .Select(d => new VoiceDevice(d.Id, d.Name, "android", hub.Online(d.Id), d.Permissions.Agent, d.Activity is "busy" or "working"))
            .Append(new(AgentRouter.PcTargetId(roomId), Environment.MachineName, "pc", true, store.GetRoom(roomId).PcAgentEnabled, work.Current != null)).ToArray();
    }
    private async Task Execute(VoiceWake wake, VoiceTask task, TaskCompletionSource<VoiceSubmitReply> completion)
    {
        try
        {
            AgentProfile profile;
            lock (store.Gate)
            {
                var original = store.ProfileFor(wake.RoomId, task.ProfileId);
                profile = new() { Id = original.Id, Name = original.Name, ApiUrl = original.ApiUrl, ApiType = original.ApiType, ApiKey = original.ApiKey, Model = original.Model };
            }
            var target = await intent.Resolve(task.Text, task.SourceId, Devices(wake.RoomId), profile, lifetime.Token);
            RequireSource(wake.RoomId, task.SourceId);
            ledger.Update(wake, task, "dispatching", target);
            // Both existing runners maintain their own device leases, busy
            // checks, permissions, execution events and cancellation paths.
            var run = router.Start(wake.RoomId, target, task.Text, "automatic", task.ProfileId, task.WorkspacePath);
            var runId = Json.Element(run).GetProperty("id").GetString() ?? "";
            ledger.Update(wake, task, "started", target, runId);
            store.Audit("voice", "语音任务已通过 Room Agent 发送", target);
            completion.TrySetResult(new(task.TaskId, wake.WakeId, "started", target, runId, run, ""));
        }
        catch (Exception error)
        {
            var detail = error is ApiException ? error.Message : error is OperationCanceledException ? "语音意图分析已取消或超时" : "语音任务处理失败，请检查模型配置与设备状态";
            try { ledger.Update(wake, task, task.Status == "dispatching" ? "interrupted" : "failed", error: detail); } catch { task.Status = "interrupted"; task.Error = detail; }
            completion.TrySetResult(Reply(task, false));
        }
        finally { foreach (var old in pending.Where(p => p.Value.IsCompleted).Take(Math.Max(0, pending.Count - 100)).ToArray()) pending.TryRemove(old.Key, out _); }
    }
    private VoiceSubmitReply Reply(VoiceTask task, bool duplicate)
    {
        var run = task.RunId.Length > 0 ? router.List(task.RoomId).FirstOrDefault(r => Json.Element(r).GetProperty("id").GetString() == task.RunId) : null;
        return new(task.TaskId, task.WakeId, duplicate && task.Status == "started" ? "duplicate" : task.Status, task.TargetId, task.RunId, run, task.Error);
    }
    public void Cancel(string room, string source, VoiceCancelInput input) { RequireSource(room, source); ledger.Cancel(room, source, input.WakeId, input.EventId); }
    public VoiceTask[] List(string room) => ledger.List(room);
    public void Dispose() { lifetime.Cancel(); lifetime.Dispose(); }
}
