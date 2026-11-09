using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using NexusRoom.Host.Agent;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;

namespace NexusRoom.Host.Communication;

public sealed class CommunicationService : BackgroundService
{
    private sealed class Participant(string id, string name, string system)
    {
        public string DeviceId { get; } = id;
        public string Name { get; } = name;
        public string System { get; } = system;
        public DateTimeOffset JoinedAt { get; } = DateTimeOffset.UtcNow;
        public bool Microphone { get; set; }
        public bool Camera { get; set; }
        public bool Screen { get; set; }
        public bool ScreenAudio { get; set; }
        public CommunicationParticipantView View() => new(DeviceId, Name, System, JoinedAt, Microphone, Camera, Screen, ScreenAudio);
    }
    private sealed class Session
    {
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public required string RoomId { get; init; }
        public required string Kind { get; init; }
        public required string Title { get; init; }
        public required string Visibility { get; init; }
        public required string HostId { get; init; }
        public string CallerId { get; init; } = "";
        public string CalleeId { get; init; } = "";
        public string Status { get; set; } = "active";
        public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
        public DateTimeOffset? ExpiresAt { get; set; }
        public DateTimeOffset? EndedAt { get; set; }
        public string EndReason { get; set; } = "";
        public Dictionary<string, Participant> Participants { get; } = [];
        public HashSet<string> KnownMembers { get; } = [];
        public HashSet<string> RemovedMembers { get; } = [];
        public List<CommunicationMessage> Messages { get; } = [];
    }
    private sealed record Invitation(string Id, string SessionId, string DeviceId,
        DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt);
    private sealed class Connection(CommunicationActor actor, WebSocket socket)
    {
        public CommunicationActor Actor { get; } = actor;
        public WebSocket Socket { get; } = socket;
        public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
        public Channel<object> Outgoing { get; } = Channel.CreateBounded<object>(64);
        public DateTimeOffset RateWindow { get; set; } = DateTimeOffset.UtcNow;
        public int Signals { get; set; }
    }
    private readonly StateStore store;
    private readonly DeviceHub hub;
    // One lock also protects room membership, so revocation and an operation's
    // authorization check are atomic and there is no inverse lock order.
    private readonly Dictionary<string, Session> sessions = [];
    private readonly Dictionary<string, Invitation> invitations = [];
    private readonly Dictionary<string, Connection> connections = [];

    public CommunicationService(StateStore store, DeviceHub hub)
    {
        this.store = store; this.hub = hub;
        hub.Disconnected += Disconnected;
        hub.Changed += Changed;
    }
    public static CommunicationActor Pc(string roomId) => new(roomId, AgentRouter.PcTargetId(roomId));
    public static CommunicationActor Android(Device device) => new(device.RoomId, device.Id);
    private bool IsPc(CommunicationActor actor) => actor.DeviceId == AgentRouter.PcTargetId(actor.RoomId);
    private void RequireActor(CommunicationActor actor, bool connected = true)
    {
        store.GetRoom(actor.RoomId);
        if (!IsPc(actor))
        {
            var device = store.GetDevice(actor.DeviceId);
            if (device.RoomId != actor.RoomId || device.Revoked) throw new ApiException(403, "设备不在当前房间");
            if (!hub.Online(device.Id)) throw new ApiException(409, "设备离线，请先连接房间");
        }
        if (connected && !Online(actor)) throw new ApiException(409, "设备的通话模块尚未连接，请打开 NexusRoom 后重试");
    }
    private bool Online(CommunicationActor actor) => connections.TryGetValue(actor.DeviceId, out var connection)
        && connection.Actor.RoomId == actor.RoomId && connection.Socket.State == WebSocketState.Open
        && (IsPc(actor) || hub.Online(actor.DeviceId));
    private string Physical(CommunicationActor actor) => IsPc(actor) ? "windows"
        : store.GetDevice(actor.DeviceId).PhysicalId is { Length: > 0 } value ? "android:" + value : "member:" + actor.DeviceId;
    private bool Busy(CommunicationActor actor, string except = "")
    {
        var physical = Physical(actor);
        return sessions.Values.Any(s => s.Status != "ended" && s.Id != except &&
            s.Participants.Keys.Concat(s.Kind == "call" ? new[] { s.CalleeId } : Array.Empty<string>())
                .Any(id => Physical(new(s.RoomId, id)) == physical));
    }
    private void RequireAvailable(CommunicationActor actor, string except = "")
    {
        RequireActor(actor);
        if (Busy(actor, except)) throw new ApiException(409, "这台设备已有通话、会议或来电，请先结束当前会话");
    }
    private (string name, string system) Identity(CommunicationActor actor) => IsPc(actor)
        ? (Environment.MachineName, "Windows") : (store.GetDevice(actor.DeviceId).Name, store.GetDevice(actor.DeviceId).System);
    private Participant ParticipantFor(CommunicationActor actor)
    {
        var (name, system) = Identity(actor); return new(actor.DeviceId, name, system);
    }
    private CommunicationActor Resolve(CommunicationActor source, string input)
    {
        if (string.IsNullOrWhiteSpace(input) || input.Length > 100 || input.Any(char.IsControl))
            throw new ApiException(400, "目标设备名称或 ID 无效");
        var devices = Devices(source.RoomId);
        var exact = devices.FirstOrDefault(d => d.Id == input);
        var matches = exact == null ? devices.Where(d => d.Name.Equals(input.Trim(), StringComparison.OrdinalIgnoreCase)
            || d.Model.Equals(input.Trim(), StringComparison.OrdinalIgnoreCase)).ToArray() : [exact];
        if (matches.Length == 0) throw new ApiException(404, "目标设备不在当前房间，请查询设备列表");
        if (matches.Length > 1) throw new ApiException(409, "设备名称或型号重复，请明确指定设备 ID");
        var target = new CommunicationActor(source.RoomId, matches[0].Id);
        if (Physical(target) == Physical(source)) throw new ApiException(400, "不能向当前物理设备发起通话或邀请");
        RequireActor(target);
        return target;
    }
    private CommunicationActor[] ResolveMany(CommunicationActor source, string[] inputs)
    {
        if (inputs.Length > 32) throw new ApiException(400, "一次最多邀请 32 台设备");
        var targets = inputs.Select(value => Resolve(source, value)).DistinctBy(x => x.DeviceId).ToArray();
        if (targets.Select(Physical).Distinct().Count() != targets.Length)
            throw new ApiException(400, "邀请列表包含同一物理设备的多个成员，请只选择一个");
        return targets;
    }
    private Session Get(CommunicationActor actor, string id)
    {
        if (id.Length > 100 || !sessions.TryGetValue(id, out var session) || session.RoomId != actor.RoomId)
            throw new ApiException(404, "通话或会议不存在");
        // Public metadata is discoverable, but private sessions cannot be probed
        // by guessing an ID, including by a device with only an invitation.
        if (session.Visibility == "private" && !session.KnownMembers.Contains(actor.DeviceId)
            && actor.DeviceId != session.CallerId && actor.DeviceId != session.CalleeId)
            throw new ApiException(404, "通话或会议不存在");
        return session;
    }
    private void Active(Session session)
    {
        if (session.Status != "active") throw new ApiException(409, "通话或会议尚未开始或已结束");
    }
    private void Member(Session session, CommunicationActor actor)
    {
        Active(session);
        if (!session.Participants.ContainsKey(actor.DeviceId)) throw new ApiException(403, "请先加入此通话或会议");
    }
    private void Host(Session session, CommunicationActor actor)
    {
        Member(session, actor);
        if (session.Kind != "meeting" || session.HostId != actor.DeviceId) throw new ApiException(403, "只有会议创建者可以执行此操作");
    }
    private CommunicationSessionView View(Session session, string viewer) => new(session.Id, session.RoomId,
        session.Kind, session.Title, session.Visibility, session.Status, session.HostId, session.CallerId, session.CalleeId,
        session.CreatedAt, session.ExpiresAt, session.EndedAt, session.EndReason,
        session.Participants.Values.Select(p => p.View()).ToArray(),
        session.Participants.ContainsKey(viewer) && session.Status == "active" ? session.Messages.ToArray() : []);
    private CommunicationDeviceView[] Devices(string roomId) => new[] {
        new CommunicationDeviceView(AgentRouter.PcTargetId(roomId), Environment.MachineName, Environment.MachineName,
            "Windows", true, Online(Pc(roomId)), Busy(Pc(roomId)))
        }.Concat(store.State.Devices.Where(d => d.RoomId == roomId && !d.Revoked).Select(d =>
            new CommunicationDeviceView(d.Id, d.Name, string.IsNullOrEmpty(d.Model) ? d.Name : d.Model,
                d.System, hub.Online(d.Id), Online(Android(d)), Busy(Android(d))))).ToArray();
    private CommunicationState Snapshot(CommunicationActor actor)
    {
        var visible = sessions.Values.Where(s => s.RoomId == actor.RoomId &&
            (s.Kind == "call" ? s.CallerId == actor.DeviceId || s.CalleeId == actor.DeviceId
                : s.Status == "ended" ? s.KnownMembers.Contains(actor.DeviceId)
                : s.Visibility == "public" || s.Participants.ContainsKey(actor.DeviceId))).OrderByDescending(s => s.CreatedAt)
            .Take(40).Select(s => View(s, actor.DeviceId)).ToArray();
        var invites = invitations.Values.Where(i => i.DeviceId == actor.DeviceId && sessions.TryGetValue(i.SessionId, out var s)
            && s.RoomId == actor.RoomId && s.Status == "active" && i.ExpiresAt > DateTimeOffset.UtcNow).Select(i =>
            {
                var s = sessions[i.SessionId]; var (name, _) = Identity(new(s.RoomId, s.HostId));
                return new CommunicationInvitationView(i.Id, s.Id, s.HostId, name, s.Title, s.Visibility, i.CreatedAt, i.ExpiresAt);
            }).ToArray();
        var own = sessions.Values.FirstOrDefault(s => s.RoomId == actor.RoomId && s.Status != "ended"
            && (s.Participants.ContainsKey(actor.DeviceId) || s.Kind == "call" && s.CalleeId == actor.DeviceId));
        return new(actor.DeviceId, actor.RoomId, own?.Id ?? "", Devices(actor.RoomId), visible, invites);
    }
    public CommunicationState State(CommunicationActor actor)
    {
        lock (store.Gate) { RequireActor(actor, false); if (Expire()) Broadcast(); return Snapshot(actor); }
    }
    public CommunicationDeviceView[] ListDevices(CommunicationActor actor)
    {
        lock (store.Gate) { RequireActor(actor, false); return Devices(actor.RoomId); }
    }
    private void Broadcast()
    {
        foreach (var connection in connections.Values.ToArray())
        {
            if (!store.State.Rooms.Any(r => r.Id == connection.Actor.RoomId)) continue;
            Queue(connection, new { type = "state", state = Snapshot(connection.Actor) });
        }
    }
    private static void Queue(Connection connection, object message)
    {
        if (!connection.Outgoing.Writer.TryWrite(message)) connection.Socket.Abort();
    }
    private object Result(Session session, CommunicationActor actor) => new { ok = true, session = View(session, actor.DeviceId) };
    public object Call(CommunicationActor caller, string target)
    {
        lock (store.Gate)
        {
            Expire(); RequireAvailable(caller); var callee = Resolve(caller, target); RequireAvailable(callee);
            var session = new Session { RoomId = caller.RoomId, Kind = "call", Title = "私人语音通话", Visibility = "private",
                HostId = caller.DeviceId, CallerId = caller.DeviceId, CalleeId = callee.DeviceId,
                Status = "ringing", ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(45) };
            session.Participants[caller.DeviceId] = ParticipantFor(caller);
            session.KnownMembers.UnionWith([caller.DeviceId, callee.DeviceId]); sessions[session.Id] = session;
            store.Audit("communication", "发起私人语音通话", caller.DeviceId); Broadcast(); return Result(session, caller);
        }
    }
    public object DecideCall(CommunicationActor actor, string id, bool accept)
    {
        lock (store.Gate)
        {
            Expire(); RequireActor(actor); var session = Get(actor, id);
            if (session.Kind != "call" || session.CalleeId != actor.DeviceId) throw new ApiException(403, "只有被叫设备可以接听或拒绝");
            if (session.Status != "ringing") throw new ApiException(409, "来电已处理或已失效");
            if (!accept) Finish(session, "declined");
            else
            {
                RequireAvailable(actor, id); RequireAvailable(new(session.RoomId, session.CallerId), id);
                session.Participants[actor.DeviceId] = ParticipantFor(actor); session.Status = "active"; session.ExpiresAt = null;
                store.Audit("communication", "已接听私人语音通话", actor.DeviceId);
            }
            Broadcast(); return Result(session, actor);
        }
    }
    public object CreateMeeting(CommunicationActor actor, string title, string visibility, string[] inputs)
    {
        lock (store.Gate)
        {
            Expire(); RequireAvailable(actor);
            if (visibility is not ("public" or "private")) throw new ApiException(400, "会议权限必须为 public 或 private");
            title = title.Trim();
            if (title.Length is < 1 or > 80 || title.Any(char.IsControl)) throw new ApiException(400, "会议名称应为 1 到 80 字");
            if (sessions.Values.Count(s => s.RoomId == actor.RoomId && s.Kind == "meeting" && s.Status == "active") >= 8)
                throw new ApiException(409, "一个房间最多有 8 个正在进行的会议");
            var targets = ResolveMany(actor, inputs);
            var session = new Session { RoomId = actor.RoomId, Kind = "meeting", Title = title, Visibility = visibility, HostId = actor.DeviceId };
            session.Participants[actor.DeviceId] = ParticipantFor(actor); session.KnownMembers.Add(actor.DeviceId); sessions[session.Id] = session;
            foreach (var target in targets) Invite(session, target);
            store.Audit("communication", "创建" + (visibility == "private" ? "私密" : "公开") + "会议", actor.DeviceId);
            Broadcast(); return Result(session, actor);
        }
    }
    private void Invite(Session session, CommunicationActor target)
    {
        if (session.Participants.ContainsKey(target.DeviceId)) return;
        if (invitations.Values.Any(i => i.SessionId == session.Id && i.DeviceId == target.DeviceId && i.ExpiresAt > DateTimeOffset.UtcNow)) return;
        session.RemovedMembers.Remove(target.DeviceId);
        var now = DateTimeOffset.UtcNow; var invite = new Invitation(Guid.NewGuid().ToString("N"), session.Id, target.DeviceId, now, now.AddSeconds(120));
        invitations[invite.Id] = invite;
    }
    public object InviteMeeting(CommunicationActor actor, string id, string[] inputs)
    {
        lock (store.Gate)
        {
            Expire(); RequireActor(actor); var session = Get(actor, id); Host(session, actor);
            foreach (var target in ResolveMany(actor, inputs)) Invite(session, target);
            store.Audit("communication", "发送会议邀请", actor.DeviceId); Broadcast(); return Result(session, actor);
        }
    }
    private void Join(Session session, CommunicationActor actor)
    {
        Active(session);
        if (session.Participants.ContainsKey(actor.DeviceId)) return;
        RequireAvailable(actor);
        if (session.Participants.Count >= 8) throw new ApiException(409, "会议最多有 8 台设备");
        if (session.RemovedMembers.Contains(actor.DeviceId)) throw new ApiException(403, "创建者已将你移出会议，请等待新的邀请");
        session.Participants[actor.DeviceId] = ParticipantFor(actor); session.KnownMembers.Add(actor.DeviceId);
        foreach (var invitation in invitations.Values.Where(i => i.SessionId == session.Id && i.DeviceId == actor.DeviceId).ToArray()) invitations.Remove(invitation.Id);
    }
    public object JoinMeeting(CommunicationActor actor, string id)
    {
        lock (store.Gate)
        {
            Expire(); RequireActor(actor); var session = Get(actor, id);
            if (session.Kind != "meeting") throw new ApiException(400, "私人通话需要被叫设备接听");
            if (session.Visibility != "public" && !session.Participants.ContainsKey(actor.DeviceId)) throw new ApiException(403, "私密会议必须接受创建者邀请后加入");
            Join(session, actor); store.Audit("communication", "加入公开会议", actor.DeviceId); Broadcast(); return Result(session, actor);
        }
    }
    public object DecideInvitation(CommunicationActor actor, string id, bool accept)
    {
        lock (store.Gate)
        {
            Expire(); RequireActor(actor);
            if (!invitations.TryGetValue(id, out var invitation) || invitation.DeviceId != actor.DeviceId
                || !sessions.TryGetValue(invitation.SessionId, out var session) || session.RoomId != actor.RoomId)
                throw new ApiException(404, "会议邀请已失效");
            if (!accept) { invitations.Remove(id); Broadcast(); return new { ok = true }; }
            Join(session, actor); store.Audit("communication", "接受会议邀请并加入", actor.DeviceId); Broadcast(); return Result(session, actor);
        }
    }
    public object Remove(CommunicationActor actor, string id, string deviceId)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var session = Get(actor, id); Host(session, actor);
            if (deviceId == actor.DeviceId) throw new ApiException(400, "创建者请使用结束会议");
            if (!session.Participants.Remove(deviceId)) throw new ApiException(404, "设备不在此会议中");
            session.RemovedMembers.Add(deviceId);
            foreach (var invitation in invitations.Values.Where(i => i.SessionId == id && i.DeviceId == deviceId).ToArray()) invitations.Remove(invitation.Id);
            store.Audit("communication", "创建者移出会议成员", actor.DeviceId); Broadcast(); return Result(session, actor);
        }
    }
    public object Leave(CommunicationActor actor, string id)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var session = Get(actor, id);
            if (session.Status == "ended") return Result(session, actor);
            if (!session.Participants.ContainsKey(actor.DeviceId) && session.CalleeId != actor.DeviceId) throw new ApiException(403, "设备不在此会话中");
            if (session.Kind == "call" || session.HostId == actor.DeviceId) Finish(session, session.Kind == "call" ? "hangup" : "host_left");
            else session.Participants.Remove(actor.DeviceId);
            store.Audit("communication", "离开通话或会议", actor.DeviceId); Broadcast(); return Result(session, actor);
        }
    }
    public object End(CommunicationActor actor, string id)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var session = Get(actor, id);
            if (session.Status == "ended") return Result(session, actor);
            if (session.Kind == "meeting") Host(session, actor);
            else if (session.CallerId != actor.DeviceId && session.CalleeId != actor.DeviceId) throw new ApiException(403, "设备不在此通话中");
            Finish(session, session.Kind == "call" ? "hangup" : "host_ended"); Broadcast(); return Result(session, actor);
        }
    }
    public object Chat(CommunicationActor actor, string id, string text)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var session = Get(actor, id); Member(session, actor);
            text = text.Trim();
            if (text.Length is < 1 or > 2000 || text.Any(c => char.IsControl(c) && c is not ('\n' or '\r' or '\t')))
                throw new ApiException(400, "聊天内容应为 1 到 2000 字");
            session.Messages.Add(new(Guid.NewGuid().ToString("N"), actor.DeviceId, Identity(actor).name, text, DateTimeOffset.UtcNow));
            if (session.Messages.Count > 200) session.Messages.RemoveAt(0);
            Broadcast(); return Result(session, actor);
        }
    }
    public object Media(CommunicationActor actor, string id, bool microphone, bool camera, bool screen, bool screenAudio = false)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var session = Get(actor, id); Member(session, actor);
            if (session.Kind == "call" && (camera || screen || screenAudio)) throw new ApiException(400, "私人电话只支持音频");
            if (screenAudio && !screen) throw new ApiException(400, "共享设备声音需要先开启屏幕共享");
            var participant = session.Participants[actor.DeviceId];
            participant.Microphone = microphone; participant.Camera = camera; participant.Screen = screen; participant.ScreenAudio = screenAudio;
            Broadcast(); return Result(session, actor);
        }
    }
    public void RequireScreenAudioCapture(CommunicationActor actor, string id)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var session = Get(actor, id); Member(session, actor);
            if (!IsPc(actor) || session.Kind != "meeting" || !session.Participants[actor.DeviceId].Screen)
                throw new ApiException(409, "请先在当前会议中开启本机屏幕共享");
        }
    }
    public void RequireCameraCapture(CommunicationActor actor, string id)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var session = Get(actor, id); Member(session, actor);
            if (!IsPc(actor) || session.Kind != "meeting" || session.Status != "active")
                throw new ApiException(409, "请先在本机加入视频会议");
        }
    }
    private void Finish(Session session, string reason)
    {
        if (session.Status == "ended") return;
        session.Status = "ended"; session.EndedAt = DateTimeOffset.UtcNow; session.ExpiresAt = null; session.EndReason = reason;
        foreach (var participant in session.Participants.Values) participant.Microphone = participant.Camera = participant.Screen = participant.ScreenAudio = false;
        // Ended metadata conveys why media must stop; chat is no longer exposed.
        session.Messages.Clear();
        foreach (var invitation in invitations.Values.Where(i => i.SessionId == session.Id).ToArray()) invitations.Remove(invitation.Id);
        foreach (var old in sessions.Values.Where(s => s.Status == "ended").OrderByDescending(s => s.EndedAt).Skip(200).ToArray()) sessions.Remove(old.Id);
        store.Audit("communication", "通话或会议已结束：" + reason, session.HostId);
    }
    private bool Expire()
    {
        var changed = false; var now = DateTimeOffset.UtcNow;
        foreach (var session in sessions.Values.Where(s => s.Status == "ringing" && s.ExpiresAt <= now).ToArray()) { Finish(session, "timeout"); changed = true; }
        foreach (var invitation in invitations.Values.Where(i => i.ExpiresAt <= now).ToArray()) { invitations.Remove(invitation.Id); changed = true; }
        return changed;
    }
    public void EndRoom(string roomId)
    {
        lock (store.Gate)
        {
            foreach (var session in sessions.Values.Where(s => s.RoomId == roomId && s.Status != "ended").ToArray()) Finish(session, "room_removed");
            Broadcast();
            foreach (var connection in connections.Values.Where(c => c.Actor.RoomId == roomId).ToArray()) connection.Socket.Abort();
        }
    }
    private void Disconnected(Device device)
    {
        lock (store.Gate)
        {
            DropMember(Android(device), "device_disconnected");
            if (connections.TryGetValue(device.Id, out var connection)) connection.Socket.Abort();
            Broadcast();
        }
    }
    private void Changed(Device device) { lock (store.Gate) Broadcast(); }
    private void DropMember(CommunicationActor actor, string reason)
    {
        foreach (var session in sessions.Values.Where(s => s.RoomId == actor.RoomId && s.Status != "ended"
            && (s.Participants.ContainsKey(actor.DeviceId) || s.Kind == "call" && s.CalleeId == actor.DeviceId)).ToArray())
            if (session.Kind == "call" || session.HostId == actor.DeviceId) Finish(session, reason);
            else session.Participants.Remove(actor.DeviceId);
        foreach (var invitation in invitations.Values.Where(i => i.DeviceId == actor.DeviceId).ToArray()) invitations.Remove(invitation.Id);
    }
    private (string action, string target, string title, string visibility, string[] invitees) Arrangement(CommunicationActor actor, JsonElement args)
    {
        CommunicationRequest.Only(args, "action", "targetId", "title", "visibility", "inviteeIds");
        var action = CommunicationRequest.Text(args, "action", 20, required: true);
        var target = CommunicationRequest.Text(args, "targetId", 100);
        var title = CommunicationRequest.Text(args, "title", 80);
        var visibility = CommunicationRequest.Text(args, "visibility", 20);
        var invitees = CommunicationRequest.Strings(args, "inviteeIds");
        if (action == "call")
        {
            if (title.Length > 0 || visibility.Length > 0 || invitees.Length > 0) throw new ApiException(400, "电话工具只接受 targetId");
            return (action, Resolve(actor, target).DeviceId, "", "", []);
        }
        if (action != "meeting" || target.Length > 0) throw new ApiException(400, "请选择 call 或 meeting，并使用对应参数");
        if (visibility.Length == 0) visibility = "private";
        if (visibility is not ("public" or "private")) throw new ApiException(400, "会议权限必须为 public 或 private");
        return (action, "", title.Length == 0 ? "NexusRoom 会议" : title, visibility,
            ResolveMany(actor, invitees).Select(x => x.DeviceId).ToArray());
    }
    public JsonElement DescribeArrangement(CommunicationActor actor, JsonElement args)
    {
        lock (store.Gate)
        {
            RequireAvailable(actor); var draft = Arrangement(actor, args);
            var devices = Devices(actor.RoomId);
            return Json.Element(new { sourceId = actor.DeviceId, sourceName = Identity(actor).name,
                draft.action, targetId = draft.target, targetName = devices.FirstOrDefault(d => d.Id == draft.target)?.Name ?? "",
                draft.title, draft.visibility, inviteeIds = draft.invitees,
                invitees = devices.Where(d => draft.invitees.Contains(d.Id)).Select(d => new { d.Id, d.Name, d.Model }).ToArray() });
        }
    }
    public object Arrange(CommunicationActor actor, JsonElement args)
    {
        lock (store.Gate)
        {
            RequireActor(actor); var draft = Arrangement(actor, args);
            return draft.action == "call" ? Call(actor, draft.target) : CreateMeeting(actor, draft.title, draft.visibility, draft.invitees);
        }
    }
    public void RequireConnect(CommunicationActor actor) { lock (store.Gate) RequireActor(actor, false); }
    public async Task Watch(CommunicationActor actor, WebSocket socket, CancellationToken cancellation)
    {
        var connection = new Connection(actor, socket);
        lock (store.Gate)
        {
            RequireActor(actor, false);
            if (connections.TryGetValue(actor.DeviceId, out var previous)) { previous.Outgoing.Writer.TryComplete(); previous.Socket.Abort(); }
            connections[actor.DeviceId] = connection; Broadcast();
        }
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        var sender = SendLoop(connection, stop.Token);
        var receiver = ReceiveLoop(connection, stop.Token);
        try { await Task.WhenAny(sender, receiver); }
        finally
        {
            stop.Cancel(); connection.Outgoing.Writer.TryComplete(); socket.Abort();
            try { await Task.WhenAll(sender, receiver); }
            catch (Exception error) when (error is WebSocketException or OperationCanceledException or ApiException or JsonException or ObjectDisposedException or IOException) { }
            lock (store.Gate)
            {
                // A replaced connection's finally must never remove its successor.
                if (connections.TryGetValue(actor.DeviceId, out var current) && ReferenceEquals(current, connection))
                {
                    connections.Remove(actor.DeviceId); DropMember(actor, "connection_lost"); Broadcast();
                }
            }
        }
    }
    private static async Task SendLoop(Connection connection, CancellationToken token)
    {
        await foreach (var message in connection.Outgoing.Reader.ReadAllAsync(token))
            await connection.Socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(message, Json.Options), WebSocketMessageType.Text, true, token);
    }
    private async Task ReceiveLoop(Connection connection, CancellationToken token)
    {
        var buffer = new byte[8192];
        while (connection.Socket.State == WebSocketState.Open && !token.IsCancellationRequested)
        {
            using var message = new MemoryStream(); WebSocketReceiveResult part;
            do
            {
                part = await connection.Socket.ReceiveAsync(buffer, token);
                if (part.MessageType == WebSocketMessageType.Close) return;
                if (part.MessageType != WebSocketMessageType.Text) throw new ApiException(400, "通信连接只接受 JSON 信令");
                message.Write(buffer, 0, part.Count);
                if (message.Length > 256 * 1024) throw new ApiException(413, "通信信令过大");
            } while (!part.EndOfMessage);
            try
            {
                using var document = JsonDocument.Parse(message.ToArray()); var root = document.RootElement;
                var type = CommunicationRequest.Text(root, "type", 20, required: true);
                lock (store.Gate)
                {
                    if (!connections.TryGetValue(connection.Actor.DeviceId, out var current) || !ReferenceEquals(current, connection)) return;
                    RequireActor(connection.Actor); connection.LastSeen = DateTimeOffset.UtcNow;
                    if (type == "ping") { CommunicationRequest.Only(root, "type"); Queue(connection, new { type = "pong" }); }
                    else if (type == "signal") Signal(connection, root);
                    else throw new ApiException(400, "未知通信消息");
                }
            }
            catch (Exception error) when (error is ApiException or JsonException or InvalidOperationException)
            {
                // An invalid or unauthorized signal never reaches another peer.
                // A bounded error lets the client recover without dropping media.
                Queue(connection, new { type = "error", status = error is ApiException api ? api.Status : 400,
                    message = error is ApiException ? error.Message : "通信信令参数无效" });
            }
        }
    }
    private void Signal(Connection source, JsonElement root)
    {
        CommunicationRequest.Only(root, "type", "sessionId", "targetId", "signal");
        var now = DateTimeOffset.UtcNow;
        if ((now - source.RateWindow).TotalSeconds >= 10) { source.RateWindow = now; source.Signals = 0; }
        if (++source.Signals > 600) throw new ApiException(429, "通信信令发送过于频繁");
        var session = Get(source.Actor, CommunicationRequest.Text(root, "sessionId", 100, required: true)); Member(session, source.Actor);
        var targetId = CommunicationRequest.Text(root, "targetId", 100, required: true);
        if (targetId == source.Actor.DeviceId || !session.Participants.ContainsKey(targetId)) throw new ApiException(403, "信令目标未加入同一会话");
        if (!connections.TryGetValue(targetId, out var target) || target.Actor.RoomId != source.Actor.RoomId || !Online(target.Actor))
            throw new ApiException(409, "通话对象的通信连接已断开");
        if (!root.TryGetProperty("signal", out var signal) || signal.ValueKind != JsonValueKind.Object) throw new ApiException(400, "信令参数无效");
        var type = CommunicationRequest.Text(signal, "type", 20, required: true);
        if (type is "offer" or "answer")
        {
            CommunicationRequest.Only(signal, "type", "sdp");
            var sdp = CommunicationRequest.Text(signal, "sdp", 128 * 1024, required: true, controls: true);
            if (!sdp.StartsWith("v=0", StringComparison.Ordinal)) throw new ApiException(400, "SDP 格式无效");
            if (session.Kind == "call")
            {
                // Audio calls retain the agreed video transceiver slots, but
                // those slots must be inactive, with no outgoing video tracks.
                foreach (var section in sdp.Split("\nm=", StringSplitOptions.None).Skip(1))
                    if (section.StartsWith("video ", StringComparison.Ordinal) &&
                        (section.Contains("a=sendrecv", StringComparison.Ordinal) || section.Contains("a=sendonly", StringComparison.Ordinal)))
                        throw new ApiException(400, "私人电话不能发送摄像头或屏幕视频");
            }
        }
        else if (type == "ice")
        {
            CommunicationRequest.Only(signal, "type", "candidate");
            if (!signal.TryGetProperty("candidate", out var candidate) || candidate.ValueKind is not (JsonValueKind.Object or JsonValueKind.Null)
                || candidate.GetRawText().Length > 8192) throw new ApiException(400, "ICE 参数无效");
            if (candidate.ValueKind == JsonValueKind.Object)
            {
                CommunicationRequest.Only(candidate, "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment");
                CommunicationRequest.Text(candidate, "candidate", 4096, controls: true);
                if (candidate.TryGetProperty("sdpMLineIndex", out var index) && index.ValueKind != JsonValueKind.Null
                    && (!index.TryGetInt32(out var value) || value is < 0 or > 4)) throw new ApiException(400, "ICE 媒体索引无效");
            }
        }
        else throw new ApiException(400, "信令类型必须为 offer、answer 或 ice");
        Queue(target, new { type = "signal", sessionId = session.Id, fromId = source.Actor.DeviceId, signal = signal.Clone() });
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                lock (store.Gate)
                {
                    var changed = Expire();
                    foreach (var connection in connections.Values.Where(c => c.LastSeen < DateTimeOffset.UtcNow.AddSeconds(-40)).ToArray())
                    {
                        connections.Remove(connection.Actor.DeviceId); DropMember(connection.Actor, "heartbeat_timeout");
                        connection.Outgoing.Writer.TryComplete(); connection.Socket.Abort(); changed = true;
                    }
                    if (changed) Broadcast();
                }
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            lock (store.Gate)
            {
                foreach (var session in sessions.Values.Where(s => s.Status != "ended").ToArray()) Finish(session, "host_shutdown");
                foreach (var connection in connections.Values) { connection.Outgoing.Writer.TryComplete(); connection.Socket.Abort(); }
                connections.Clear();
            }
        }
    }
    public override void Dispose()
    {
        hub.Disconnected -= Disconnected; hub.Changed -= Changed; base.Dispose();
    }
}
