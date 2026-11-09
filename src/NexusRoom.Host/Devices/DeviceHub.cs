using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Devices;

public sealed record CaptureStatus(string State = "idle", string Stage = "", string Error = "", string Encoder = "", int Width = 0, int Height = 0)
{
    public static CaptureStatus Read(JsonElement value) {
        string Text(string key, int limit) => value.TryGetProperty(key,out var item)&&item.ValueKind==JsonValueKind.String ? (item.GetString()??"")[..Math.Min(limit,(item.GetString()??"").Length)] : "";
        int Size(string key) => value.TryGetProperty(key,out var item)&&item.TryGetInt32(out var n) ? Math.Clamp(n,0,4096) : 0;
        var state=Text("state",20);
        return new(state is "requested" or "starting" or "streaming" or "error" or "stopped" ? state : "idle",Text("stage",40),Text("error",500),Text("encoder",120),Size("width"),Size("height"));
    }
}
public sealed class DeviceSession(WebSocket socket)
{
    public WebSocket Socket { get; } = socket;
    public SemaphoreSlim SendLock { get; } = new(1);
    public ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> Pending { get; } = new();
    public byte[]? Frame { get; set; }
    public DateTimeOffset FrameAt { get; set; }
    public ConcurrentDictionary<Guid, Channel<byte[]>> Viewers { get; } = new();
    public MediaRelay Media { get; } = new();
    public CaptureStatus Capture { get; set; } = new();
}
public sealed class DeviceHub(StateStore store) : BackgroundService
{
    private readonly ConcurrentDictionary<string, DeviceSession> sessions = new();
    public event Action<Device>? Changed;
    public event Action<Device>? Disconnected;
    public event Action<Device, string>? ClipboardReceived;
    public event Action<Device, JsonElement>? AgentEventReceived;
    private sealed class Lease { public string Id { get; } = Guid.NewGuid().ToString("N"); public ConcurrentDictionary<string,byte> Reasons { get; } = new(); public DateTimeOffset RequestedAt {get;set;} }
    private readonly ConcurrentDictionary<string, Lease> leases = new();
    private readonly SemaphoreSlim leaseGate = new(1);
    public bool Online(string id) {lock(store.Gate)return sessions.TryGetValue(id, out var s) && s.Socket.State == WebSocketState.Open && store.State.Devices.Any(d => d.Id == id && !d.Revoked && d.LastSeen > DateTimeOffset.UtcNow.AddSeconds(-40));}
    public object View(Device d) => new { d.Id, d.RoomId, d.PhysicalId, d.Name, d.Model, d.System, d.Version, d.Ip, d.Battery, d.Charging, d.Width, d.Height, d.LastSeen, d.Permissions, activity = !Online(d.Id) ? "offline" : d.Activity, d.OwnerRoom, online = Online(d.Id), capture = sessions.TryGetValue(d.Id,out var session) ? session.Capture : new(), media = session?.Media.Status() };
    public bool HasRemoteLease(string id) => leases.TryGetValue(id, out var lease) && lease.Reasons.ContainsKey("remote");
    public bool HasLease(string id, string reason) => leases.TryGetValue(id, out var lease) && lease.Reasons.ContainsKey(reason);
    public bool HasAnyLease(string id) => leases.TryGetValue(id, out var lease) && !lease.Reasons.IsEmpty;
    public void Require(Device d, string capability, bool agent = false)
    {
        if (!Online(d.Id)) throw new ApiException(409, "设备离线，请在 Android 端重新连接");
        if (d.Activity == "busy" && (agent || capability is "screen" or "control" or "clipboard")) throw new ApiException(409, "设备正在其他房间工作，当前房间只能传输文件");
        bool permitted = capability switch { "screen" => d.Permissions.Screen, "control" => d.Permissions.Control, "files" => d.Permissions.Files, "clipboard" => d.Permissions.Clipboard, _ => true };
        if (!permitted || (agent && !d.Permissions.Agent)) throw new ApiException(403, "Android 尚未授予本次操作所需权限");
    }
    public async Task Connect(Device device, WebSocket socket, CancellationToken cancellation, string? remoteIp = null)
    {
        var session = new DeviceSession(socket);
        DeviceSession? old;
        lock (store.Gate)
        {
            if (device.Revoked || !store.State.Rooms.Any(r => r.Id == device.RoomId)) throw new ApiException(401, "设备成员资格已撤销");
            sessions.TryRemove(device.Id, out old);
            leases.TryRemove(device.Id, out _);
            if (old != null) { Close(old); Disconnected?.Invoke(device); }
            sessions[device.Id] = session;
            device.LastSeen = DateTimeOffset.UtcNow;
            if (!string.IsNullOrWhiteSpace(remoteIp)) device.Ip = remoteIp;
            device.Permissions = new(); device.Activity = "online"; device.OwnerRoom = "";
        }
        store.Audit("device", "设备上线", device.Id);
        try
        {
            await Send(session, new { type = "welcome", host = Environment.MachineName, serverTime = DateTimeOffset.UtcNow }, cancellation);
            var buffer = new byte[65536];
            while (socket.State == WebSocketState.Open && !cancellation.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult part;
                do
                {
                    part = await socket.ReceiveAsync(buffer, cancellation);
                    if (part.MessageType == WebSocketMessageType.Close) return;
                    await message.WriteAsync(buffer.AsMemory(0, part.Count), cancellation);
                    if (message.Length > 2 * 1024 * 1024) throw new ApiException(413, "设备消息过大");
                } while (!part.EndOfMessage);
                lock (store.Gate)
                {
                    if (!IsCurrent(device.Id, session)) return;
                    device.LastSeen = DateTimeOffset.UtcNow;
                }
                if (part.MessageType == WebSocketMessageType.Binary)
                {
                    if (!device.Permissions.Screen || device.Activity != "working" || message.Length < 4) continue;
                    var bytes = message.ToArray();
                    if (bytes[0] != 0xff || bytes[1] != 0xd8) { if (bytes.Length>=12 && (bytes[0] != 0x10 || device.Permissions.Audio)) session.Media.Push(bytes); continue; }
                    session.Frame = bytes; session.FrameAt = DateTimeOffset.UtcNow;
                    foreach (var viewer in session.Viewers.Values) viewer.Writer.TryWrite(bytes);
                    continue;
                }
                var root = JsonSerializer.Deserialize<JsonElement>(message.ToArray());
                var type = root.GetProperty("type").GetString();
                if (type is "hello" or "heartbeat" or "permissions")
                {
                    lock (store.Gate)
                    {
                        if (!IsCurrent(device.Id, session)) return;
                        if (root.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.String && model.GetString() is { Length: <= 100 } modelName && !modelName.Any(char.IsControl)) device.Model = modelName;
                        if (root.TryGetProperty("battery", out var battery)) device.Battery = Math.Clamp(battery.GetInt32(), -1, 100);
                        if (root.TryGetProperty("charging", out var charging)) device.Charging = charging.GetBoolean();
                        if (root.TryGetProperty("width", out var width)) device.Width = Math.Clamp(width.GetInt32(), 0, 10000);
                        if (root.TryGetProperty("height", out var height)) device.Height = Math.Clamp(height.GetInt32(), 0, 10000);
                        if (root.TryGetProperty("activity", out var activity)) {var previous=device.Activity;device.Activity = activity.GetString() is "working" ? "working" : activity.GetString() is "busy" ? "busy" : "online";if(previous=="working"&&device.Activity!="working")leases.TryRemove(device.Id,out _);}
                        if (root.TryGetProperty("ownerRoom", out var owner)) device.OwnerRoom = owner.GetString() ?? "";
                        if (root.TryGetProperty("capture",out var capture) && capture.ValueKind==JsonValueKind.Object) {
                            var next=CaptureStatus.Read(capture);
                            if (next.State!=session.Capture.State || next.Error!=session.Capture.Error)
                                store.Audit("media", $"屏幕共享：{next.State} · {next.Stage}" + (next.Error.Length>0 ? $" · {next.Error}" : ""), device.Id, next.State=="error"?"error":"success");
                            session.Capture=next;
                        }
                        if (root.TryGetProperty("permissions", out var perms))
                        {
                            var next = perms.Deserialize<Permissions>(Json.Options) ?? new();
                            if (JsonSerializer.Serialize(next) != JsonSerializer.Serialize(device.Permissions)) store.Audit("permission", "Android 更新权限", device.Id);
                            device.Permissions = next;
                            if (!next.Screen) { session.Frame = null; session.Media.Clear(); foreach (var channel in session.Viewers.Values) channel.Writer.TryComplete(); }
                        }
                    }
                    Changed?.Invoke(device);
                    await Send(session, new { type = "heartbeat", hostOnline = true, roomName = store.GetRoom(device.RoomId).Name, roomId = device.RoomId, lease = leases.TryGetValue(device.Id,out var lease) ? lease.Id : "" }, cancellation);
                }
                else if (type == "result" && root.TryGetProperty("id", out var id))
                {
                    if (session.Pending.TryRemove(id.GetString() ?? "", out var pending))
                    {
                        if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                            pending.TrySetException(new ApiException(422, error.GetString() ?? "Android 执行失败"));
                        else pending.TrySetResult(root.TryGetProperty("result", out var result) ? result.Clone() : Json.Element(new { ok = true }));
                    }
                }
                else if (type == "clipboard" && device.Permissions.Clipboard && device.Activity!="busy")
                {
                    var value = root.GetProperty("text").GetString() ?? "";
                    lock (store.Gate) if (IsCurrent(device.Id, session) && value.Length <= 65536) ClipboardReceived?.Invoke(device, value);
                }
                else if (type == "agent_event" && root.TryGetProperty("taskId", out var taskId) && taskId.ValueKind == JsonValueKind.String)
                {
                    lock (store.Gate) if (IsCurrent(device.Id, session)) AgentEventReceived?.Invoke(device, root.Clone());
                }
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or JsonException or ApiException or InvalidOperationException or KeyNotFoundException) { }
        finally
        {
            var disconnected = false;
            lock (store.Gate)
            {
                if (IsCurrent(device.Id, session))
                {
                    sessions.TryRemove(device.Id, out _);
                    device.Permissions = new();
                    device.Activity = "offline"; device.OwnerRoom = ""; leases.TryRemove(device.Id, out _);
                    store.Save(); disconnected = true;
                    Disconnected?.Invoke(device);
                }
            }
            if (disconnected)
            {
                Changed?.Invoke(device);
                store.Audit("device", "设备离线", device.Id);
            }
            Close(session);
        }
    }
    public async Task<JsonElement> Call(string id, string tool, JsonElement arguments, CancellationToken cancellation = default)
    {
        if (!sessions.TryGetValue(id, out var session)) throw new ApiException(409, "设备离线");
        var commandId = Guid.NewGuid().ToString("N");
        var pending = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Pending[commandId] = pending;
        try
        {
            await Send(session, new { type = "command", id = commandId, tool, arguments, lease = leases.TryGetValue(id,out var lease) ? lease.Id : "" }, cancellation);
            return await pending.Task.WaitAsync(TimeSpan.FromSeconds(tool is "receive_file" or "export_photo" ? 120 : 20), cancellation);
        }
        catch (TimeoutException) { throw new ApiException(504, "Android 操作超时；未自动重放，请检查设备后重试"); }
        finally { session.Pending.TryRemove(commandId, out _); }
    }
    public byte[] Screenshot(Device d)
    {
        Require(d, "screen");
        // Android emits frames on visual changes. A static screen is still current while its authenticated session and capture permission are alive.
        if (!sessions.TryGetValue(d.Id, out var s) || s.Frame == null) throw new ApiException(409, "暂无实时画面，请在 Android 端开始屏幕共享");
        return s.Frame;
    }
    public async Task Watch(Device d, WebSocket viewer, CancellationToken cancellation)
    {
        Require(d, "screen");
        if (!sessions.TryGetValue(d.Id, out var s)) return;
        var key = Guid.NewGuid();
        var frames = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest });
        s.Viewers[key] = frames;
        if (s.Frame != null) frames.Writer.TryWrite(s.Frame);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        var reader = Task.Run(async () => { try { var bytes = new byte[128]; while (viewer.State == WebSocketState.Open) { var r = await viewer.ReceiveAsync(bytes, stop.Token); if (r.MessageType == WebSocketMessageType.Close) break; } } catch (Exception e) when (e is WebSocketException or OperationCanceledException) { } finally { stop.Cancel(); } });
        try { await foreach (var bytes in frames.Reader.ReadAllAsync(stop.Token)) await viewer.SendAsync(bytes, WebSocketMessageType.Binary, true, stop.Token); }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
        finally { s.Viewers.TryRemove(key, out _); stop.Cancel(); await reader; viewer.Abort(); }
    }
    public async Task Acquire(string id, string reason, CancellationToken ct)
    {
        await leaseGate.WaitAsync(ct);
        try { var d=store.GetDevice(id); if(!Online(id)||d.Activity=="busy") throw new ApiException(409,"设备离线或正在其他房间工作"); var lease=leases.GetOrAdd(id,_=>new());
            try { await Call(id,"control_acquire",Json.Element(new{leaseId=lease.Id,reason}),ct); lease.Reasons[reason]=0; }
            catch { if(lease.Reasons.Count==0) leases.TryRemove(id,out _); throw; }
        } finally {leaseGate.Release();}
    }
    public async Task Release(string id,string reason) {
        await leaseGate.WaitAsync();
        try { if(!leases.TryGetValue(id,out var lease))return; lease.Reasons.TryRemove(reason,out _); if(lease.Reasons.Count!=0)return; leases.TryRemove(id,out _); try {await Call(id,"control_release",Json.Element(new{leaseId=lease.Id}));}catch{} }
        finally {leaseGate.Release();}
    }
    public async Task<object> StartRemote(string id,MirrorRequest req,CancellationToken ct) {
        var d=store.GetDevice(id);Require(d,"control");if(req.MaxSize is <640 or >1920 || req.Fps is <15 or >60 || req.Bitrate is <1 or >16)throw new ApiException(400,"画质参数超出范围");
        if(!d.Permissions.ScreenAllowed)throw new ApiException(403,"请先在手机允许电脑请求屏幕");
        await Acquire(id,"remote",ct); try {if(leases.TryGetValue(id,out var lease))lease.RequestedAt=DateTimeOffset.UtcNow;return await Call(id,"stream_start",Json.Element(req),ct);}catch{await Release(id,"remote");throw;}
    }
    public async Task StopRemote(string id) {try{await Call(id,"stream_stop",Json.Element(new{}));}finally{await Release(id,"remote");}}
    public object MediaStatus() {lock(store.Gate)return new {available=true,active=store.State.Devices.Where(d=>Online(d.Id)&&d.Permissions.Screen&&d.Activity=="working").Select(d=>d.Id).ToArray(),pending=store.State.Devices.Where(d=>Online(d.Id)&&!d.Permissions.Screen&&leases.TryGetValue(d.Id,out var l)&&l.Reasons.ContainsKey("remote")).Select(d=>d.Id).ToArray()};}
    public async Task WatchMedia(string id,WebSocket socket,CancellationToken ct){var d=store.GetDevice(id);Require(d,"screen");if(d.Activity!="working")throw new ApiException(409,"请先开始远程控制");if(sessions.TryGetValue(id,out var s))await s.Media.Watch(socket,async()=>{await Call(id,"stream_keyframe",Json.Element(new{}),ct);},ct);}
    public async Task Revoke(string id,string reason) {
        var d=store.GetDevice(id); d.Revoked=true;store.Save();
        if(sessions.TryGetValue(id,out var s)) {try{using var ct=new CancellationTokenSource(1500);await Send(s,new{type="revoked",reason},ct.Token);}catch{}}
        Disconnect(id);
    }
    public void Disconnect(string id)
    {
        DeviceSession? session;
        Device device;
        lock (store.Gate)
        {
            device = store.GetDevice(id);
            sessions.TryRemove(id, out session);
            leases.TryRemove(id, out _);
            device.Permissions = new(); device.Activity = "offline"; device.OwnerRoom = "";
            Disconnected?.Invoke(device);
        }
        if (session != null) Close(session);
        Changed?.Invoke(device);
    }
    private bool IsCurrent(string id, DeviceSession session) => sessions.TryGetValue(id, out var current) && ReferenceEquals(current, session);
    private static void Close(DeviceSession s)
    {
        s.Frame = null;
        s.Media.Clear();
        foreach (var p in s.Pending.Values) p.TrySetException(new ApiException(409, "设备连接已断开"));
        foreach (var v in s.Viewers.Values) v.Writer.TryComplete();
        s.Socket.Abort();
    }
    private static async Task Send(DeviceSession s, object message, CancellationToken ct)
    {
        await s.SendLock.WaitAsync(ct);
        try { await s.Socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(message, Json.Options), WebSocketMessageType.Text, true, ct); }
        finally { s.SendLock.Release(); }
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { while (!stoppingToken.IsCancellationRequested) { await Task.Delay(10000, stoppingToken); foreach (var id in sessions.Keys) {if (!Online(id)) Disconnect(id);else if(leases.TryGetValue(id,out var lease)&&lease.Reasons.ContainsKey("remote")&&!store.GetDevice(id).Permissions.Screen&&lease.RequestedAt<DateTimeOffset.UtcNow.AddMinutes(-2)){try{await StopRemote(id);}catch{}}} } }
        catch (OperationCanceledException) { }
        finally { foreach (var s in sessions.Values) Close(s); }
    }
}
