using System.Collections.Concurrent;
using System.Text.Json;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Agent;

public sealed class Approval
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string DeviceId { get; init; } = "";
    public string RoomId { get; init; } = "";
    public string Tool { get; init; } = "";
    public JsonElement Arguments { get; init; }
    public string RunId { get; init; } = "";
    public string RequestId { get; init; } = "";
    public DateTimeOffset ExpiresAt { get; } = DateTimeOffset.UtcNow.AddMinutes(3);
    public TaskCompletionSource<bool> Decision { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}
public sealed class ApprovalService(StateStore store)
{
    private readonly ConcurrentDictionary<string, Approval> pending = new();
    public event Action<Approval, bool>? Decided;
    private void Expire()
    {
        foreach (var item in pending.Where(p => p.Value.ExpiresAt <= DateTimeOffset.UtcNow).ToArray())
            if (pending.TryRemove(item.Key, out var approval))
            {
                approval.Decision.TrySetResult(false);
                Decided?.Invoke(approval, false);
            }
    }
    public object[] List(string? roomId=null)
    {
        Expire();
        return pending.Values.Where(a=>roomId==null||a.RoomId==roomId).OrderBy(a => a.ExpiresAt).Select(a => (object)new { a.Id, a.DeviceId, a.Tool, a.Arguments, a.RunId, a.RequestId, a.ExpiresAt }).ToArray();
    }
    public async Task Require(string device, string tool, JsonElement arguments, string run, CancellationToken ct)
    {
        var approval = new Approval { DeviceId = device, RoomId = store.GetDevice(device).RoomId, Tool = tool, Arguments = arguments.Clone(), RunId = run };
        if (!await Wait(approval, ct)) throw new ApiException(403, "用户拒绝此操作，请停止任务");
    }
    public Task<bool> AskPc(string roomId, string targetId, string tool, JsonElement arguments, string run,
        string requestId, Action<Approval> onCreated, CancellationToken ct)
    {
        var approval = new Approval { DeviceId = targetId, RoomId = roomId, Tool = tool, Arguments = arguments.Clone(),
            RunId = run, RequestId = requestId };
        return Wait(approval, ct, onCreated);
    }
    private async Task<bool> Wait(Approval approval, CancellationToken ct, Action<Approval>? onCreated = null)
    {
        pending[approval.Id] = approval;
        store.Audit("agent", $"等待确认：{approval.Tool}", approval.DeviceId, "pending");
        try
        {
            onCreated?.Invoke(approval);
            var decision = await approval.Decision.Task.WaitAsync(TimeSpan.FromMinutes(3), ct);
            if (approval.ExpiresAt <= DateTimeOffset.UtcNow) throw new ApiException(408, "用户确认已超时，操作未执行");
            return decision;
        }
        catch (TimeoutException) { throw new ApiException(408, "用户确认已超时，操作未执行"); }
        finally { pending.TryRemove(approval.Id, out _); }
    }
    public Approval CreateRemote(string device, string tool, JsonElement arguments, string run, string requestId)
    {
        lock (store.Gate)
        {
            Expire();
            var existing = pending.Values.FirstOrDefault(a => a.DeviceId == device && a.RunId == run && a.RequestId == requestId);
            if (existing != null) return existing;
            if (pending.Count >= 1024 || pending.Values.Count(a => a.RunId == run) >= 16)
                throw new ApiException(429, "任务待确认请求过多，请完成已有确认后重试");
            var approval = new Approval { DeviceId = device, RoomId = store.GetDevice(device).RoomId, Tool = tool, Arguments = arguments.Clone(), RunId = run, RequestId = requestId };
            pending[approval.Id] = approval;
            store.Audit("agent", $"手机任务等待确认：{tool}", device, "pending");
            return approval;
        }
    }
    public void CancelRun(string run)
    {
        foreach (var pair in pending.Where(p => p.Value.RunId == run).ToArray())
            if (pending.TryRemove(pair.Key, out var approval)) approval.Decision.TrySetResult(false);
    }
    public void Decide(string id, bool allow, string? roomId = null)
    {
        if (roomId != null && pending.TryGetValue(id, out var scoped) && scoped.RoomId != roomId)
            throw new ApiException(403, "确认不属于当前房间");
        if (!pending.TryRemove(id, out var approval) || approval.ExpiresAt < DateTimeOffset.UtcNow) throw new ApiException(404, "该确认已失效");
        approval.Decision.TrySetResult(allow);
        store.Audit("agent", allow ? "用户批准操作" : "用户拒绝操作", approval.DeviceId, allow ? "success" : "denied");
        Decided?.Invoke(approval, allow);
    }
    public void DecideRemote(string deviceId, string runId, string requestId, bool allow)
    {
        var actor = store.GetDevice(deviceId);
        var approval = pending.Values.FirstOrDefault(a => a.RunId == runId && a.RequestId == requestId && a.RoomId == actor.RoomId);
        if (approval == null) throw new ApiException(404, "该手机确认请求已失效");
        Decide(approval.Id, allow);
    }
}
