using NexusRoom.Host.Core;

namespace NexusRoom.Host.Agent;

public enum AgentTargetKind { Android, Pc }

public sealed record AgentTarget(string Id, string RoomId, AgentTargetKind Kind);

public sealed class AgentRouter(StateStore store, AgentRunner android, PcAgentRunner pc)
{
    public static string PcTargetId(string roomId) => "pc:" + roomId;

    public AgentTarget Resolve(string roomId, string targetId)
    {
        if (string.IsNullOrWhiteSpace(targetId)) throw new ApiException(400, "请选择 Agent 设备");
        if (targetId.StartsWith("pc:", StringComparison.Ordinal))
        {
            if (targetId != PcTargetId(roomId)) throw new ApiException(403, "目标设备不在当前房间");
            store.GetRoom(roomId);
            return new(targetId, roomId, AgentTargetKind.Pc);
        }

        var device = store.GetDevice(targetId);
        if (device.RoomId != roomId || device.Revoked) throw new ApiException(403, "目标设备不在当前房间");
        return new(device.Id, roomId, AgentTargetKind.Android);
    }

    public object[] List(string roomId, string? targetId = null)
    {
        if (targetId == null)
            return android.List(roomId: roomId).Concat(pc.List(roomId: roomId)).ToArray();
        var target = Resolve(roomId, targetId);
        return target.Kind == AgentTargetKind.Pc
            ? pc.List(roomId: roomId, targetId: target.Id)
            : android.List(deviceId: target.Id, roomId: roomId);
    }

    public object Start(string roomId, string targetId, string task, string mode, string profileId, string? workspacePath)
    {
        var target = Resolve(roomId, targetId);
        if (target.Kind == AgentTargetKind.Android)
            return android.Start(new AgentStart(target.Id, task, mode, profileId));
        if (!store.GetRoom(roomId).PcAgentEnabled) throw new ApiException(403, "当前房间未开启 Windows Agent");
        return pc.Start(roomId, target.Id, task, mode, profileId, workspacePath);
    }

    public void Cancel(string id, string roomId)
    {
        try { android.Cancel(id, roomId); }
        catch (ApiException error) when (error.Status == 404) { pc.Cancel(id, roomId); }
    }

    public void CancelRoom(string roomId) => pc.CancelRoom(roomId);
}
