using System.Text.Json;
using NexusRoom.Host.Agent;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;

namespace NexusRoom.Host.Communication;

public static class CommunicationEndpoints
{
    public static void MapCommunication(this WebApplication app)
    {
        var store = app.Services.GetRequiredService<StateStore>();
        var service = app.Services.GetRequiredService<CommunicationService>();
        var hub = app.Services.GetRequiredService<DeviceHub>();
        var agent = app.Services.GetRequiredService<AgentRunner>();
        Device DeviceAuth(HttpContext c)
        {
            var authorization = c.Request.Headers.Authorization.ToString();
            return store.AuthenticateDevice(authorization.StartsWith("Bearer ", StringComparison.Ordinal) ? authorization[7..] : null);
        }
        CommunicationActor Actor(HttpContext c, bool local) => local
            ? CommunicationService.Pc(store.GetRoom(c.Request.Headers["X-Nexus-Room"].FirstOrDefault() ?? c.Request.Query["roomId"].FirstOrDefault()).Id)
            : CommunicationService.Android(DeviceAuth(c));
        app.MapGet("/api/communication/camera/capability", (HttpContext c) => new
        {
            supported = WindowsCameraCapture.Supported && DesktopAudioOrigin.IsOwned(c)
        });
        app.Map("/api/communication/sessions/{id}/camera/ws", async (HttpContext c, string id) =>
        {
            var actor = Actor(c, true); service.RequireCameraCapture(actor, id);
            if (!WindowsCameraCapture.Supported || !DesktopAudioOrigin.IsOwned(c)) throw new ApiException(403, "请从 Windows 应用的内置控制中心使用摄像头");
            if (!c.WebSockets.IsWebSocketRequest) throw new ApiException(400, "需要 WebSocket 连接");
            using var socket = await c.WebSockets.AcceptWebSocketAsync();
            await WindowsCameraCapture.Stream(socket, () => service.RequireCameraCapture(actor, id), c.RequestAborted,
                message => store.Audit("communication", "摄像头采集：" + message, actor.DeviceId, "failure"));
        });
        app.MapGet("/api/communication/screen-audio/capability", (HttpContext c) => new
        {
            supported = WindowsScreenAudio.Supported && DesktopAudioOrigin.IsOwned(c),
            reason = !WindowsScreenAudio.Supported ? "当前 Windows 版本不支持排除会议声音的设备声音共享（需要 Windows 11 或 Windows Server 2022 及以上）。"
                : DesktopAudioOrigin.IsOwned(c) ? "" : "请从 Windows 应用的内置控制中心共享设备声音，以便排除会议播放声音。",
            sampleRate = 48000, channels = 1, encoding = "pcm16le"
        });
        app.Map("/api/communication/sessions/{id}/screen-audio/ws", async (HttpContext c, string id) =>
        {
            var actor = Actor(c, true); service.RequireScreenAudioCapture(actor, id);
            if (!WindowsScreenAudio.Supported) throw new ApiException(409, "当前系统不支持安全的设备声音共享");
            if (!DesktopAudioOrigin.IsOwned(c)) throw new ApiException(403, "请从 Windows 应用的内置控制中心共享设备声音");
            if (!c.WebSockets.IsWebSocketRequest) throw new ApiException(400, "需要 WebSocket 连接");
            using var socket = await c.WebSockets.AcceptWebSocketAsync();
            await WindowsScreenAudio.Stream(socket, () => service.RequireScreenAudioCapture(actor, id), c.RequestAborted);
        });
        foreach (var local in new[] { true, false })
        {
            var group = app.MapGroup((local ? "/api" : "/device") + "/communication");
            group.MapGet("/state", (HttpContext c) => service.State(Actor(c, local)));
            group.Map("/ws", async (HttpContext c) =>
            {
                var actor = Actor(c, local); service.RequireConnect(actor);
                if (!c.WebSockets.IsWebSocketRequest) throw new ApiException(400, "需要 WebSocket 连接");
                using var socket = await c.WebSockets.AcceptWebSocketAsync(); await service.Watch(actor, socket, c.RequestAborted);
            });
            group.MapPost("/calls", (HttpContext c, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "targetId");
                return service.Call(Actor(c, local), CommunicationRequest.Text(body, "targetId", 100, required: true));
            });
            group.MapPost("/calls/{id}/decision", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "accept"); return service.DecideCall(Actor(c, local), id, CommunicationRequest.Bool(body, "accept"));
            });
            group.MapPost("/meetings", (HttpContext c, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "title", "visibility", "inviteeIds");
                return service.CreateMeeting(Actor(c, local), CommunicationRequest.Text(body, "title", 80, required: true),
                    CommunicationRequest.Text(body, "visibility", 20, required: true), CommunicationRequest.Strings(body, "inviteeIds"));
            });
            group.MapPost("/meetings/{id}/join", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body); return service.JoinMeeting(Actor(c, local), id);
            });
            group.MapPost("/meetings/{id}/invite", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "deviceIds"); return service.InviteMeeting(Actor(c, local), id, CommunicationRequest.Strings(body, "deviceIds"));
            });
            group.MapPost("/meetings/{id}/remove", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "deviceId"); return service.Remove(Actor(c, local), id, CommunicationRequest.Text(body, "deviceId", 100, required: true));
            });
            group.MapPost("/invitations/{id}/decision", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "accept"); return service.DecideInvitation(Actor(c, local), id, CommunicationRequest.Bool(body, "accept"));
            });
            group.MapPost("/sessions/{id}/leave", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body); return service.Leave(Actor(c, local), id);
            });
            group.MapPost("/sessions/{id}/end", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body); return service.End(Actor(c, local), id);
            });
            group.MapPost("/sessions/{id}/chat", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "text"); return service.Chat(Actor(c, local), id, CommunicationRequest.Text(body, "text", 2000, required: true, controls: true));
            });
            group.MapPost("/sessions/{id}/media", (HttpContext c, string id, JsonElement body) =>
            {
                CommunicationRequest.Only(body, "microphone", "camera", "screen", "screenAudio");
                return service.Media(Actor(c, local), id, CommunicationRequest.Bool(body, "microphone"), CommunicationRequest.Bool(body, "camera"), CommunicationRequest.Bool(body, "screen"), CommunicationRequest.OptionalBool(body, "screenAudio"));
            });
        }
        app.MapGet("/device/agent/communication/devices", (HttpContext c) =>
        {
            var device = DeviceAuth(c); hub.Require(device, "info", true);
            var taskId = c.Request.Query["taskId"].FirstOrDefault() ?? "";
            var token = agent.RequireActiveDeviceRun(taskId, device);
            var devices = service.ListDevices(CommunicationService.Android(device)); token.ThrowIfCancellationRequested();
            return new { roomId = device.RoomId, selfId = device.Id, devices };
        });
        app.MapPost("/device/agent/communication", (HttpContext c, JsonElement body) =>
        {
            CommunicationRequest.Only(body, "taskId", "action", "targetId", "title", "visibility", "inviteeIds");
            var device = DeviceAuth(c); hub.Require(device, "info", true);
            var token = agent.RequireActiveDeviceRun(CommunicationRequest.Text(body, "taskId", 100, required: true), device);
            var args = Json.Element(body.EnumerateObject().Where(p => p.Name != "taskId").ToDictionary(p => p.Name, p => p.Value.Clone()));
            token.ThrowIfCancellationRequested();
            // Android AgentEngine has already performed its request-mode tool
            // approval. Both that approval and the actor are fixed by the run;
            // neither caller nor mode can be replaced by model arguments here.
            var result = service.Arrange(CommunicationService.Android(device), args); token.ThrowIfCancellationRequested(); return result;
        });
    }
}
