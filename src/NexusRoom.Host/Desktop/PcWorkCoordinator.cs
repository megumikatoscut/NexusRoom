using NexusRoom.Host.Core;

namespace NexusRoom.Host.Desktop;

// Windows has one interactive desktop; rooms cannot independently own its input.
public sealed class PcWorkCoordinator
{
    private readonly object gate = new();
    private Claim? current;
    public sealed record Claim(string Id, string RoomId, string DeviceId, string Kind);
    public Claim Acquire(string id, string roomId, string deviceId, string kind)
    {
        lock (gate)
        {
            if (current != null) throw new ApiException(409, "这台电脑正在远程控制或执行 Agent 任务，请先结束当前工作");
            return current = new(id, roomId, deviceId, kind);
        }
    }
    public void Release(string id) { lock (gate) if (current?.Id == id) current = null; }
    public Claim? Current { get { lock (gate) return current; } }
    public string Activity(string? roomId) { lock (gate) return current == null ? "online" : current.RoomId == roomId ? "working" : "busy"; }
}
