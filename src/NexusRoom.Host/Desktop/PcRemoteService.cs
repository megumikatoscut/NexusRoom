using System.Buffers.Binary;
using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;

namespace NexusRoom.Host.Desktop;

public sealed class PcRemoteService(StateStore store, DeviceHub hub, PcWorkCoordinator work) : BackgroundService
{
    private sealed class Session
    {
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public required string DeviceId { get; init; }
        public required string DeviceName { get; init; }
        public required string RoomId { get; init; }
        public required string RoomName { get; init; }
        public required PcRemoteStart Options { get; init; }
        public string State { get; set; } = "pending";
        public string Error { get; set; } = "";
        public DateTimeOffset Deadline { get; set; } = DateTimeOffset.UtcNow.AddSeconds(60);
        public Stopwatch Clock { get; } = new();
        public CancellationTokenSource Stop { get; } = new();
        public WebSocket? Socket { get; set; }
        public SemaphoreSlim SendGate { get; } = new(1);
        public object InputGate { get; } = new();
        public PcRemoteInput Input { get; } = new();
        public Channel<byte[]> Media { get; } = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(16) { FullMode = BoundedChannelFullMode.DropOldest });
        public HashSet<string> Commands { get; } = [];
        public bool? SequencedInput { get; set; }
        public long LastSequence { get; set; }
        public long LastPing { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
    }
    private readonly object gate = new();
    private Session? session;
    public PcRemotePermissions Permissions(string roomId) { lock (store.Gate) return store.GetRoom(roomId).PcRemotePermissions.Copy(); }
    public object Status(string roomId, string? deviceId = null, bool local = false)
    {
        var permissions = Permissions(roomId);
        Session? current; lock (gate) current = session;
        var own = local || current?.DeviceId == deviceId;
        return new { permissions, activity = work.Activity(roomId), ownerRoom = work.Current?.RoomId ?? "",
            session = current == null ? null : new { sessionId = own ? current.Id : "", state = current.State, deviceId = own ? current.DeviceId : "",
                deviceName = own ? current.DeviceName : "", roomId = own ? current.RoomId : "", roomName = own ? current.RoomName : "", error = own ? current.Error : "" } };
    }
    public object Start(Device device, PcRemoteStart options)
    {
        RequireMember(device);
        if (options.MaxSize is < 640 or > 2560 || options.Fps is < 5 or > 30 || options.Quality is < 30 or > 95)
            throw new ApiException(400, "电脑画质参数超出范围");
        var permissions = Permissions(device.RoomId);
        if (!permissions.Screen) throw new ApiException(403, "请先在电脑为此房间允许查看电脑屏幕");
        var room = store.GetRoom(device.RoomId);
        Session created;
        lock (gate)
        {
            if (session != null) throw new ApiException(409, "这台电脑已有远控请求或会话，请先结束");
            created = new() { DeviceId = device.Id, DeviceName = device.Name, RoomId = room.Id, RoomName = room.Name, Options = options };
            work.Acquire(created.Id, room.Id, device.Id, "remote");
            session = created;
        }
        store.Audit("pc-remote", "手机请求远程查看或控制 Windows，等待本机确认", device.Id, "pending");
        return new { sessionId = created.Id, state = created.State };
    }
    public void RequireOnline(Device device) => RequireMember(device);
    public object Decision(string roomId, PcRemoteDecision decision)
    {
        var current = RequireSession(decision.SessionId, roomId);
        if (current.State != "pending") throw new ApiException(409, "远控请求已处理");
        if (current.Deadline < DateTimeOffset.UtcNow) { Finish(current, "电脑远控请求已超时"); throw new ApiException(408, "远控请求已超时"); }
        if (!decision.Allow) { Finish(current, "本机拒绝远控请求"); return new { ok = true }; }
        Guard(current);
        lock (gate)
        {
            if (!ReferenceEquals(session, current) || current.State != "pending") throw new ApiException(409, "远控请求已失效");
            current.State = "approved"; current.Deadline = DateTimeOffset.UtcNow.AddSeconds(10);
        }
        store.Audit("pc-remote", "本机批准本次 Windows 远控会话", current.DeviceId);
        return new { ok = true };
    }
    public void Stop(string roomId, string? sessionId = null, string? deviceId = null)
    {
        Session? current; lock (gate) current = session;
        if (current == null) return;
        if (current.RoomId != roomId || deviceId != null && current.DeviceId != deviceId || sessionId != null && current.Id != sessionId)
            throw new ApiException(403, "没有此电脑远控会话的操作权限");
        Finish(current, "远控会话已结束");
    }
    public void PermissionsChanged(string roomId)
    {
        Session? current; lock (gate) current = session;
        if (current?.RoomId != roomId) return;
        Finish(current, "电脑远控权限已变化，请重新发起并确认会话");
    }
    public async Task Watch(Device device, string sessionId, WebSocket socket, CancellationToken cancellation)
    {
        var current = RequireSession(sessionId, device.RoomId, device.Id);
        Guard(current);
        lock (gate)
        {
            if (!ReferenceEquals(session, current) || current.State != "approved" || current.Deadline < DateTimeOffset.UtcNow)
                throw new ApiException(409, "本次电脑远控尚未批准或已过期");
            current.State = "streaming"; current.Socket = socket; current.Clock.Start(); current.LastPing = 0;
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, current.Stop.Token);
        var token = linked.Token;
        Task? capture = null, sender = null;
        try
        {
            var bounds = PcRemoteInput.Bounds();
            var scale = Math.Min(1, (double)current.Options.MaxSize / Math.Max(bounds.Width, bounds.Height));
            current.Width = Math.Max(1, (int)Math.Round(bounds.Width * scale));
            current.Height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
            var permissions = Permissions(current.RoomId);
            await Send(current, new { type = "welcome", sessionId = current.Id, width = current.Width, height = current.Height,
                audio = current.Options.Audio && permissions.Audio, permissions, inputProtocol = "sequence-v1" }, token);
            sender = SendMedia(current, token);
            capture = Task.Run(() => Capture(current, token), token);
            await Receive(current, token);
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or ApiException or JsonException)
        {
            if (error is ApiException api) current.Error = api.Message;
        }
        finally
        {
            Finish(current, current.Error.Length == 0 ? "远控连接已断开" : current.Error);
            linked.Cancel();
            if (capture != null) try { await capture; } catch (OperationCanceledException) { }
            if (sender != null) try { await sender; } catch (Exception error) when (error is OperationCanceledException or WebSocketException or ApiException) { }
            socket.Abort();
        }
    }
    public void RequireWatch(Device device, string sessionId)
    {
        var current = RequireSession(sessionId, device.RoomId, device.Id);
        Guard(current);
        if (current.State != "approved" || current.Deadline < DateTimeOffset.UtcNow) throw new ApiException(409, "远控请求尚未批准或已过期");
    }
    private async Task Receive(Session current, CancellationToken token)
    {
        var buffer = new byte[8192];
        while (!token.IsCancellationRequested && current.Socket?.State == WebSocketState.Open)
        {
            using var message = new MemoryStream(); WebSocketReceiveResult part;
            do
            {
                part = await current.Socket.ReceiveAsync(buffer, token);
                if (part.MessageType == WebSocketMessageType.Close) return;
                if (part.MessageType != WebSocketMessageType.Text) throw new ApiException(400, "电脑远控只接受 JSON 输入");
                message.Write(buffer, 0, part.Count);
                if (message.Length > 512 * 1024) throw new ApiException(413, "输入消息过大");
            } while (!part.EndOfMessage);
            Guard(current);
            var root = JsonSerializer.Deserialize<JsonElement>(message.ToArray());
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String)
                throw new ApiException(400, "远控消息无效");
            if (type.GetString() == "ping")
            {
                current.LastPing = current.Clock.ElapsedMilliseconds;
                await Send(current, new { type = "pong", permissions = Permissions(current.RoomId) }, token); continue;
            }
            if (type.GetString() != "input") throw new ApiException(400, "远控消息类型无效");
            var id = PcRemoteInput.Text(root, "id", 80);
            if (id.Length == 0) throw new ApiException(400, "输入标识不能为空");
            var sequenced = root.TryGetProperty("seq", out var sequence);
            current.SequencedInput ??= sequenced;
            if (current.SequencedInput != sequenced) throw new ApiException(409, "不能在同一会话切换输入序号协议");
            if (sequenced)
            {
                if (sequence.ValueKind != JsonValueKind.Number || !sequence.TryGetInt64(out var ordinal) || ordinal is < 1 or > 9007199254740991L)
                    throw new ApiException(400, "输入序号必须是有效的正整数");
                if (ordinal <= current.LastSequence) throw new ApiException(409, "输入序号重复或已过期，未重放操作");
                // In this protocol seq identifies input; id only correlates replies.
                // Consume before execution: a rejected or interrupted operation must
                // never execute later after focus or permissions have changed.
                current.LastSequence = ordinal;
            }
            else
            {
                if (!current.Commands.Add(id)) throw new ApiException(409, "输入标识重复，未重放操作");
                if (current.Commands.Count > 10000) throw new ApiException(409, "旧版输入协议次数已达上限，请重新发起远控");
            }
            try
            {
                var tool = PcRemoteInput.Text(root, "tool", 40);
                if (!root.TryGetProperty("arguments", out var args) || args.ValueKind != JsonValueKind.Object) throw new ApiException(400, "输入参数无效");
                object result;
                if (tool is "clipboard_get" or "clipboard_set") result = await Clipboard(current, tool, args, token);
                else lock (current.InputGate) result = current.Input.Execute(tool, args, () => Guard(current, "control"));
                await Send(current, new { type = "result", id, result }, token);
            }
            catch (Exception error) when (error is ApiException or InvalidOperationException or KeyNotFoundException or JsonException)
            {
                var detail = error is ApiException ? error.Message : "输入参数无效";
                await Send(current, new { type = "result", id, error = detail }, token);
            }
        }
    }
    private Task<object> Clipboard(Session current, string tool, JsonElement args, CancellationToken token)
    {
        var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                lock (current.InputGate) {
                token.ThrowIfCancellationRequested(); Guard(current, "clipboard"); PcRemoteInput.RequireDesktop();
                object result;
                if (tool == "clipboard_get")
                {
                    var text = PcTextClipboard.Read();
                    Guard(current, "clipboard"); result = new { text };
                }
                else
                {
                    var text = PcRemoteInput.Text(args, "text", 65536); Guard(current, "clipboard");
                    PcTextClipboard.Write(text);
                    result = new { ok = true };
                }
                Guard(current, "clipboard");
                store.Audit("pc-remote", tool, current.DeviceId);
                completion.TrySetResult(result);
                }
            }
            catch (System.Runtime.InteropServices.ExternalException) { completion.TrySetException(new ApiException(409, "剪贴板正被其他程序使用，请重试")); }
            catch (Exception error) { completion.TrySetException(error); }
        }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); return completion.Task;
    }
    private async Task Capture(Session current, CancellationToken token)
    {
        long audioCheck = -2000;
        using var audio = new PcLoopbackAudio(packet => current.Media.Writer.TryWrite(packet), (enabled, error) =>
        {
            _ = AudioStatus(current, enabled, error, token);
        }, current.Clock, () => !token.IsCancellationRequested && IsAuthorized(current, "audio") && current.Options.Audio);
        var encoder = ImageCodecInfo.GetImageEncoders().First(e => e.FormatID == ImageFormat.Jpeg.Guid);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)current.Options.Quality);
        try
        {
            while (!token.IsCancellationRequested)
            {
                var began = current.Clock.ElapsedMilliseconds;
                Guard(current); PcRemoteInput.RequireDesktop();
                if (began - current.LastPing > 30000) throw new ApiException(408, "电脑远控心跳已超时");
                if (began - audioCheck >= 2000) { audioCheck = began; audio.Refresh(); }
                var bounds = PcRemoteInput.Bounds();
                if (bounds.Width <= 0 || bounds.Height <= 0 || (long)bounds.Width * bounds.Height > 80_000_000) throw new ApiException(409, "电脑显示器尺寸不可用");
                var scale = Math.Min(1, (double)current.Options.MaxSize / Math.Max(bounds.Width, bounds.Height));
                var width = Math.Max(1, (int)Math.Round(bounds.Width * scale)); var height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
                using var full = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
                using (var graphics = Graphics.FromImage(full)) { graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy); PcRemoteInput.DrawCursor(graphics, bounds); }
                using var frame = new Bitmap(width, height, PixelFormat.Format24bppRgb);
                using (var graphics = Graphics.FromImage(frame)) { graphics.InterpolationMode = InterpolationMode.HighQualityBilinear; graphics.DrawImage(full, 0, 0, width, height); }
                using var bytes = new MemoryStream(); frame.Save(bytes, encoder, parameters);
                Guard(current); current.Width = width; current.Height = height;
                current.Media.Writer.TryWrite(Packet(1, current.Clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency, width, height, bytes.ToArray()));
                await Task.Delay((int)Math.Max(1, 1000 / current.Options.Fps - (current.Clock.ElapsedMilliseconds - began)), token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            current.Error = error is ApiException ? error.Message : "电脑屏幕捕获失败，请检查显示器与 Windows 会话";
            await AudioStatus(current, false, current.Error, token);
            Finish(current, current.Error);
        }
    }
    private async Task AudioStatus(Session current, bool enabled, string error, CancellationToken token)
    {
        try { await Send(current, new { type = "audio_status", enabled, error }, token); }
        catch (Exception exception) when (exception is OperationCanceledException or WebSocketException or ApiException) { }
    }
    private async Task SendMedia(Session current, CancellationToken token)
    {
        try { await foreach (var packet in current.Media.Reader.ReadAllAsync(token))
        {
            Guard(current);
            var type = BinaryPrimitives.ReadInt32BigEndian(packet.AsSpan(4));
            if (type == 2 && !IsAuthorized(current, "audio")) continue;
            var pts = BinaryPrimitives.ReadInt64BigEndian(packet.AsSpan(8));
            if (current.Clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency - pts > 300_000) continue;
            await current.SendGate.WaitAsync(token);
            try { Guard(current); using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(5000); await current.Socket!.SendAsync(packet, WebSocketMessageType.Binary, true, deadline.Token); }
            finally { current.SendGate.Release(); }
        } }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or ApiException) { Finish(current, "电脑远控媒体连接已中断"); }
    }
    private async Task Send(Session current, object message, CancellationToken token)
    {
        await current.SendGate.WaitAsync(token);
        try { Guard(current); using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(5000); await current.Socket!.SendAsync(JsonSerializer.SerializeToUtf8Bytes(message, Json.Options), WebSocketMessageType.Text, true, deadline.Token); }
        finally { current.SendGate.Release(); }
    }
    public static byte[] Packet(int type, long pts, int first, int second, byte[] payload)
    {
        var packet = new byte[24 + payload.Length]; "NRP3"u8.CopyTo(packet);
        BinaryPrimitives.WriteInt32BigEndian(packet.AsSpan(4), type); BinaryPrimitives.WriteInt64BigEndian(packet.AsSpan(8), pts);
        BinaryPrimitives.WriteInt32BigEndian(packet.AsSpan(16), first); BinaryPrimitives.WriteInt32BigEndian(packet.AsSpan(20), second);
        payload.CopyTo(packet, 24); return packet;
    }
    private Session RequireSession(string id, string roomId, string? deviceId = null)
    {
        lock (gate)
        {
            if (session == null || session.Id != id) throw new ApiException(404, "电脑远控会话已失效");
            if (session.RoomId != roomId || deviceId != null && session.DeviceId != deviceId) throw new ApiException(403, "没有此电脑远控会话的访问权限");
            return session;
        }
    }
    private void RequireMember(Device device)
    {
        lock (store.Gate) if (device.Revoked || !store.State.Rooms.Any(r => r.Id == device.RoomId) || !hub.Online(device.Id)) throw new ApiException(409, "手机已离线或离开房间，请重新连接");
    }
    private bool IsAuthorized(Session current, string permission)
    {
        try { Guard(current, permission); return true; } catch (ApiException) { return false; }
    }
    private void Guard(Session current, string? permission = null)
    {
        if (current.Stop.IsCancellationRequested || !ReferenceEquals(Volatile.Read(ref session), current)) throw new ApiException(409, "电脑远控会话已结束");
        var device = store.GetDevice(current.DeviceId); RequireMember(device);
        var permissions = Permissions(current.RoomId);
        if (!permissions.Screen || permission == "control" && !permissions.Control || permission == "audio" && !permissions.Audio || permission == "clipboard" && !permissions.Clipboard)
            throw new ApiException(403, "电脑未授予本次操作所需权限，或授权已撤销");
    }
    private void Finish(Session current, string reason)
    {
        lock (gate)
        {
            if (!ReferenceEquals(session, current)) return;
            session = null; current.Error = reason; current.Stop.Cancel(); current.Media.Writer.TryComplete();
        }
        lock (current.InputGate) current.Input.ReleaseAll();
        work.Release(current.Id);
        current.Socket?.Abort(); store.Audit("pc-remote", reason, current.DeviceId);
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        void Disconnected(Device device)
        {
            Session? current; lock (gate) current = session;
            // DeviceHub emits this event while holding StateStore.Gate. Cleanup
            // waits for input/clipboard, whose guards also read the state.
            if (current?.DeviceId == device.Id) _ = Task.Run(() => Finish(current, "手机房间连接已断开"));
        }
        hub.Disconnected += Disconnected;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(1000, stoppingToken);
                Session? current; lock (gate) current = session;
                if (current == null) continue;
                try
                {
                    Guard(current);
                    if (current.State != "streaming" && current.Deadline < DateTimeOffset.UtcNow) Finish(current, "电脑远控请求或连接已超时");
                }
                catch (ApiException error) { Finish(current, error.Message); }
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            hub.Disconnected -= Disconnected;
            Session? current; lock (gate) current = session;
            if (current != null) Finish(current, "电脑服务已停止");
        }
    }
}
