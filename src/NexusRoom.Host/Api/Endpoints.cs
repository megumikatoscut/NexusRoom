using System.Net;
using System.Text.Json;
using NexusRoom.Host.Agent;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;
using NexusRoom.Host.Files;
using NexusRoom.Host.Desktop;
using NexusRoom.Host.Communication;

namespace NexusRoom.Host.Api;

public static class Endpoints
{
    public static void MapNexus(this WebApplication app)
    {
        var store = app.Services.GetRequiredService<StateStore>();
        var hub = app.Services.GetRequiredService<DeviceHub>();
        var files = app.Services.GetRequiredService<FileService>();
        var tools = app.Services.GetRequiredService<ToolService>();
        var approvals = app.Services.GetRequiredService<ApprovalService>();
        var agent = app.Services.GetRequiredService<AgentRunner>();
        var agentRouter = app.Services.GetRequiredService<AgentRouter>();
        var pcRemote = app.Services.GetRequiredService<PcRemoteService>();
        var pcWork = app.Services.GetRequiredService<PcWorkCoordinator>();
        app.MapCommunication();
        app.MapGet("/health", () => new { product = "NexusRoom", version = ReleaseInfo.Version, online = true });
        app.MapPost("/api/session", (HttpContext context, JsonElement body) =>
        {
            if (!body.TryGetProperty("token", out var token) || token.ValueKind != JsonValueKind.String || !StateStore.Equal(token.GetString()!, store.BootstrapToken)) throw new ApiException(401, "请从 NexusRoom 桌面应用打开控制中心");
            context.Response.Cookies.Append("nr_session", store.BootstrapToken, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Strict, IsEssential = true, Path = "/", MaxAge = TimeSpan.FromHours(12) });
            return Results.Ok(new { ok = true });
        }).RequireRateLimiting("join");
        Room Current(HttpContext c) => store.GetRoom(c.Request.Headers["X-Nexus-Room"].FirstOrDefault() ?? c.Request.Query["roomId"].FirstOrDefault());
        app.MapGet("/api/rooms", () => { lock (store.Gate) return store.State.Rooms.Select(r=>new{r.Id,r.Name,r.Open}).ToArray(); });
        app.MapPost("/api/rooms", (JsonElement body) => {var room=store.CreateRoom(body.GetProperty("name").GetString()??"");store.Audit("room","创建房间");return new{room.Id,room.Name,room.Open};});
        app.MapDelete("/api/rooms/{id}", async (string id) =>
        {
            var room = store.GetRoom(id); room.Open = false;
            app.Services.GetRequiredService<CommunicationService>().EndRoom(id); agentRouter.CancelRoom(id);
            Device[] members;
            lock (store.Gate) members = store.State.Devices.Where(d => d.RoomId == id && !d.Revoked).ToArray();
            foreach (var d in members) { agent.CancelDevice(d.Id); await hub.Revoke(d.Id, "房间已解散"); }
            string fileArchive;
            lock (store.Gate)
            {
                var index = store.State.Rooms.IndexOf(room);
                if (index < 0) throw new ApiException(404, "房间已解散");
                fileArchive = files.ArchiveRoomFiles(id, () =>
                {
                    store.State.Rooms.RemoveAt(index);
                    try { store.Save(); }
                    catch { store.State.Rooms.Insert(index, room); throw; }
                });
            }
            store.Audit("room", "解散房间；库副本已移至本机可恢复归档");
            return new { ok = true, fileArchive };
        });
        app.MapGet("/api/state", (HttpContext context) =>
        {
            var room = store.State.Rooms.Count==0 ? null : Current(context);
            lock (store.Gate) return Results.Json(new
            {
                room = room==null ? new {id="",name="尚未创建房间",open=false} : new {id=room.Id,name=room.Name,open=room.Open}, rooms=store.State.Rooms.Select(r=>new{r.Id,r.Name,r.Open}).ToArray(),
                host = new { name = Environment.MachineName, system = "Windows", version = Environment.OSVersion.VersionString, online = true, addresses = store.Addresses(), fingerprint = store.Fingerprint,
                    activity = pcWork.Activity(room?.Id), ownerRoom = pcWork.Current?.RoomId ?? "", remote = room == null ? null : pcRemote.Status(room.Id, local: true) },
                devices = store.State.Devices.Where(d=>!d.Revoked&&d.RoomId==room?.Id).Select(hub.View).ToArray(), transfers = store.State.Transfers.Where(t=>t.RoomId==room?.Id).OrderByDescending(t => t.CreatedAt).ToArray(), approvals = room==null?[]:approvals.List(room.Id), media = hub.MediaStatus()
            }, Json.Options);
        });
        app.MapGet("/api/android-apk", () =>
        {
            var apk = Environment.GetEnvironmentVariable("NEXUS_ANDROID_APK") ?? Path.Combine(AppContext.BaseDirectory, "tools", "NexusRoom-Android.apk");
            if (!File.Exists(apk)) throw new ApiException(404, "Android 安装包未找到，请先运行完整构建脚本");
            return Results.File(apk, "application/vnd.android.package-archive", "NexusRoom-Android.apk");
        });
        app.MapGet("/api/invitation", (string? address,HttpContext context) =>
        {
            var room=Current(context);
            var addresses = store.Addresses(); var url = address != null && addresses.Contains(address) ? address : addresses.FirstOrDefault() ?? $"https://127.0.0.1:{store.DevicePort}";
            return new { version = 1, server = url, roomId = room.Id, password = room.Password, fingerprint = store.Fingerprint, name = room.Name };
        });
        app.MapPost("/api/room", (JsonElement body,HttpContext context) =>
        {
            var name = body.TryGetProperty("name", out var n) ? n.GetString()?.Trim() : null;
            if (string.IsNullOrEmpty(name) || name.Length > 60) throw new ApiException(400, "房间名称应为 1 到 60 字");
            lock (store.Gate) { Current(context).Name = name; store.Save(); } store.Audit("room", "修改房间名称"); return new { ok = true };
        });
        app.MapPost("/api/room/rotate", (HttpContext c) => {var room=Current(c);store.RotateRoom(room.Name,room.Id);store.Audit("room","更新房间邀请信息");return Results.Ok(new{ok=true});});
        app.MapPost("/api/room/access", (JsonElement body,HttpContext c) => {var room=Current(c);room.Open=body.GetProperty("open").GetBoolean();store.Save();return new{ok=true};});
        app.MapPost("/device/join", (HttpContext context, JoinRequest request) =>
        {
            if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 80 || request.Version is null || request.Version.Length > 80) throw new ApiException(400, "设备信息无效");
            if(request.PhysicalId is null || request.PhysicalId.Length>100)throw new ApiException(400,"设备标识无效");
            if(request.Model is null || request.Model.Length>100 || request.Model.Any(char.IsControl))throw new ApiException(400,"设备型号无效");
            lock (store.Gate)
            {
                var room = store.State.Rooms.FirstOrDefault(r => r.Id == request.RoomId);
                if (room == null || request.Password is null || request.Password.Length > 128 || !store.CheckPassword(request.Password, room)) throw new ApiException(401, "房间号或密码不正确");
                if (!room.Open) throw new ApiException(403, "房间已暂停新设备加入");
                if (store.State.Devices.Count(x => x.RoomId == room.Id && !x.Revoked) >= 32) throw new ApiException(409, "房间最多保留 32 台设备，请移除旧设备");
                var token = StateStore.Token();
                var device = new Device { Id = Guid.NewGuid().ToString("N"), RoomId = room.Id, PhysicalId = request.PhysicalId, Name = request.Name, Model = request.Model, Version = request.Version, Ip = NormalizeIp(context.Connection.RemoteIpAddress!), TokenHash = StateStore.Hash(token) };
                store.State.Devices.Add(device); store.Save();
                store.Audit("room", "Android 加入房间", device.Id);
                return new { deviceId = device.Id, token, roomId = room.Id, hostName = Environment.MachineName, roomName = room.Name };
            }
        }).RequireRateLimiting("join");
        app.Map("/device/ws", async (HttpContext context) =>
        {
            var d = DeviceAuth(context, store); if (!context.WebSockets.IsWebSocketRequest) throw new ApiException(400, "需要 WebSocket 连接");
            d.Ip = NormalizeIp(context.Connection.RemoteIpAddress!); using var socket = await context.WebSockets.AcceptWebSocketAsync(); await hub.Connect(d, socket, context.RequestAborted, d.Ip);
        });
        app.MapPost("/device/leave", async (HttpContext context) => { var d = DeviceAuth(context, store); agent.CancelDevice(d.Id);await hub.Revoke(d.Id,"已退出房间");store.Audit("room","Android 退出房间",d.Id);return Results.Ok(new{ok=true}); });
        app.MapGet("/device/discovery", () => {lock(store.Gate)return Results.Ok(store.State.Rooms.Select(r=>new{type="nexusroom",version=2,roomId=r.Id,name=r.Name,open=r.Open,host=Environment.MachineName,port=store.DevicePort,fingerprint=store.Fingerprint}).ToArray());});
        app.MapPost("/device/control/start", async (HttpContext c,MirrorRequest req) => {var d=DeviceAuth(c,store);return Results.Ok(await hub.StartRemote(d.Id,req,c.RequestAborted));});
        app.MapPost("/device/control/stop", async (HttpContext c) => {var d=DeviceAuth(c,store);await hub.StopRemote(d.Id);return Results.Ok(new{ok=true});});
        app.MapGet("/device/pc/status", (HttpContext c) => { var d = DeviceAuth(c, store); pcRemote.RequireOnline(d); return Results.Ok(pcRemote.Status(d.RoomId, d.Id)); });
        app.MapPost("/device/pc/start", (HttpContext c, PcRemoteStart input) => Results.Ok(pcRemote.Start(DeviceAuth(c, store), input)));
        app.MapPost("/device/pc/stop", (HttpContext c, PcRemoteSessionRequest input) => { var d = DeviceAuth(c, store); if (string.IsNullOrEmpty(input.SessionId)) throw new ApiException(400, "远控会话标识无效"); pcRemote.Stop(d.RoomId, input.SessionId, d.Id); return Results.Ok(new { ok = true }); });
        app.Map("/device/pc/ws", async (HttpContext c) =>
        {
            var d = DeviceAuth(c, store); var sessionId = c.Request.Query["sessionId"].FirstOrDefault() ?? "";
            if (!c.WebSockets.IsWebSocketRequest) throw new ApiException(400, "需要 WebSocket 连接");
            pcRemote.RequireWatch(d, sessionId);
            using var socket = await c.WebSockets.AcceptWebSocketAsync(); await pcRemote.Watch(d, sessionId, socket, c.RequestAborted);
        });
        app.MapGet("/api/pc/remote/status", (HttpContext c) => Results.Ok(pcRemote.Status(Current(c).Id, local: true)));
        app.MapPost("/api/pc/remote/permissions", (HttpContext c, JsonElement body) =>
        {
            bool Grant(string name) => body.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : throw new ApiException(400, "电脑远控权限必须提供四个布尔开关");
            var next = new PcRemotePermissions { Screen = Grant("screen"), Control = Grant("control"), Audio = Grant("audio"), Clipboard = Grant("clipboard") };
            var room = Current(c); bool changed;
            lock (store.Gate) { changed = JsonSerializer.Serialize(room.PcRemotePermissions, Json.Options) != JsonSerializer.Serialize(next, Json.Options); room.PcRemotePermissions = next; store.Save(); }
            if (changed) pcRemote.PermissionsChanged(room.Id);
            store.Audit("permission", "本机更新 Windows 远控权限"); return Results.Ok(new { permissions = next });
        });
        app.MapPost("/api/pc/remote/decision", (HttpContext c, PcRemoteDecision input) => Results.Ok(pcRemote.Decision(Current(c).Id, input)));
        app.MapPost("/api/pc/remote/stop", (HttpContext c) => { pcRemote.Stop(Current(c).Id); return Results.Ok(new { ok = true }); });
        app.MapGet("/device/room", (HttpContext c) => {var d=DeviceAuth(c,store);var r=store.GetRoom(d.RoomId);lock(store.Gate)return Results.Ok(new{r.Id,roomId=r.Id,r.Name,hostOnline=true,hostName=Environment.MachineName,fingerprint=store.Fingerprint,addresses=store.Addresses(),pcAgentEnabled=r.PcAgentEnabled,pcRemotePermissions=r.PcRemotePermissions.Copy(),pcActivity=pcWork.Activity(r.Id),pcRemote=pcRemote.Status(r.Id,d.Id),defaultProfileId=r.DefaultAgentProfileId,profiles=r.AgentProfiles.Select(ProfileView).ToArray()});});
        app.MapGet("/device/agent/workspace", (HttpContext c) =>
        {
            var device = DeviceAuth(c, store);
            hub.Require(device, "info", true);
            if (!store.GetRoom(device.RoomId).PcAgentEnabled) throw new ApiException(403, "当前房间未开启 Windows Agent");
            return Results.Ok(PcWorkspace.Browse(c.Request.Query["path"].FirstOrDefault(), c.Request.Query["query"].FirstOrDefault()));
        });
        app.MapGet("/device/room/devices", (HttpContext c) =>
        {
            var source = DeviceAuth(c, store);
            hub.Require(source, "info", true);
            lock (store.Gate)
            {
                return Results.Ok(store.State.Devices.Where(d => !d.Revoked && d.RoomId == source.RoomId).Select(d => (object)new
                {
                    d.Id, d.RoomId, d.Name, d.System, type = "android",
                    activity = hub.Online(d.Id) ? d.Activity : "offline",
                    online = hub.Online(d.Id),
                    agent = d.Permissions.Agent
                }).Append(new { id = AgentRouter.PcTargetId(source.RoomId), roomId = source.RoomId,
                    name = Environment.MachineName, system = "Windows", type = "pc", activity = pcWork.Activity(source.RoomId), online = true,
                    ownerRoom = pcWork.Current?.RoomId ?? "", remote = pcRemote.Status(source.RoomId, source.Id), remoteEnabled = store.GetRoom(source.RoomId).PcRemotePermissions.Screen,
                    agent = store.GetRoom(source.RoomId).PcAgentEnabled }).ToArray());
            }
        });
        app.MapPost("/device/room/profiles", (HttpContext c, JsonElement body) =>
        {
            var d = DeviceAuth(c, store); var room = store.GetRoom(d.RoomId); var name = body.TryGetProperty("name", out var nameValue) ? nameValue.GetString()?.Trim() ?? "" : "";
            var type = body.TryGetProperty("apiType", out var typeValue) ? typeValue.GetString() ?? "chat_completions" : "chat_completions";
            var url = body.TryGetProperty("apiUrl", out var urlValue) ? urlValue.GetString() ?? "" : ""; var model = body.TryGetProperty("model", out var modelValue) ? modelValue.GetString()?.Trim() ?? "" : "";
            var key = body.TryGetProperty("apiKey", out var keyValue) && keyValue.ValueKind == JsonValueKind.String ? keyValue.GetString() ?? "" : "";
            var maxCalls = body.TryGetProperty("maxCalls", out var calls) && calls.TryGetInt32(out var callLimit) ? callLimit : 24; var maxSteps = body.TryGetProperty("maxSteps", out var steps) && steps.TryGetInt32(out var stepLimit) ? stepLimit : 24; var timeout = body.TryGetProperty("timeoutSeconds", out var seconds) && seconds.TryGetInt32(out var timeoutLimit) ? timeoutLimit : 900;
            ValidateProfile(type, url, model, maxCalls, maxSteps, timeout); if (name.Length is < 1 or > 80 || key.Length > 1024) throw new ApiException(400, "方案参数无效");
            lock (store.Gate)
            {
                var hasProfileId = body.TryGetProperty("profileId", out var idValue) && idValue.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(idValue.GetString());
                var createNew = body.TryGetProperty("createNew", out var createValue) && createValue.ValueKind == JsonValueKind.True;
                if (createNew && hasProfileId) throw new ApiException(400, "新增方案不能指定已有方案 ID");
                var profile = createNew ? null : room.AgentProfiles.FirstOrDefault(p => p.Id == (hasProfileId ? idValue.GetString() : room.DefaultAgentProfileId));
                if (profile == null)
                {
                    if (hasProfileId) throw new ApiException(404, "模型方案不存在");
                    if (room.AgentProfiles.Count >= 32) throw new ApiException(409, "每个房间最多 32 个模型方案");
                    profile = new AgentProfile(); room.AgentProfiles.Add(profile);
                }
                profile.Name = name; profile.ApiType = type; profile.ApiUrl = url.TrimEnd('/'); profile.Model = model; profile.MaxCalls = maxCalls; profile.MaxSteps = maxSteps; profile.TimeoutSeconds = timeout; if (key.Length > 0) profile.ApiKey = key;
                if (room.DefaultAgentProfileId.Length == 0 || body.TryGetProperty("setDefault", out var setDefault) && setDefault.ValueKind == JsonValueKind.True) room.DefaultAgentProfileId = profile.Id;
                store.Save(); return ProfileView(profile);
            }
        });
        app.MapDelete("/device/room/profiles/{id}", (string id, HttpContext c) =>
        {
            var d = DeviceAuth(c, store);
            var room = store.GetRoom(d.RoomId);
            lock (store.Gate)
            {
                if (room.AgentProfiles.Count <= 1) throw new ApiException(409, "至少保留一个模型方案");
                var profile = room.AgentProfiles.FirstOrDefault(p => p.Id == id) ?? throw new ApiException(404, "模型方案不存在");
                room.AgentProfiles.Remove(profile);
                if (room.DefaultAgentProfileId == id) room.DefaultAgentProfileId = room.AgentProfiles[0].Id;
                store.Save();
                return Results.Ok(new { ok = true, defaultProfileId = room.DefaultAgentProfileId });
            }
        });
        app.MapPost("/device/room/profiles/{id}/default", (string id, HttpContext c) =>
        {
            var d = DeviceAuth(c, store);
            var room = store.GetRoom(d.RoomId);
            lock (store.Gate)
            {
                if (!room.AgentProfiles.Any(p => p.Id == id)) throw new ApiException(404, "模型方案不存在");
                room.DefaultAgentProfileId = id;
                store.Save();
                return Results.Ok(new { ok = true, defaultProfileId = id });
            }
        });
        app.MapPost("/device/room/profiles/{id}/test", async (string id, HttpContext c, AgentProfileTestInput input) =>
        {
            var d = DeviceAuth(c, store);
            if (!string.IsNullOrWhiteSpace(input.ProfileId) && input.ProfileId != id) throw new ApiException(400, "方案 ID 与请求地址不一致");
            var profile = ProfileForTest(store, d.RoomId, input with { ProfileId = id });
            return Results.Ok(await agent.TestProfile(c.RequestAborted, profile));
        });
        app.MapPost("/device/room/profiles/test", async (HttpContext c, AgentProfileTestInput input) =>
        {
            var d = DeviceAuth(c, store);
            var profile = ProfileForTest(store, d.RoomId, input);
            return Results.Ok(await agent.TestProfile(c.RequestAborted, profile));
        });
        app.MapGet("/device/agent/runs", (HttpContext c) =>
        {
            var source = DeviceAuth(c, store);
            hub.Require(source, "info", true);
            var targetId = c.Request.Query["targetDeviceId"].FirstOrDefault();
            if (string.IsNullOrWhiteSpace(targetId)) targetId = source.Id;
            return Results.Ok(agentRouter.List(source.RoomId, targetId));
        });
        app.MapPost("/device/agent/runs", (HttpContext c, DeviceAgentStart req) =>
        {
            var source = DeviceAuth(c, store);
            hub.Require(source, "info", true);
            var targetId = string.IsNullOrWhiteSpace(req.TargetDeviceId) ? req.DeviceId : req.TargetDeviceId;
            if (string.IsNullOrWhiteSpace(targetId)) targetId = source.Id;
            return Results.Ok(agentRouter.Start(source.RoomId, targetId, req.Task, req.Mode, req.ProfileId, req.WorkspacePath));
        });
        app.MapDelete("/device/agent/runs/{id}", (string id,HttpContext c) => {var d=DeviceAuth(c,store);hub.Require(d,"info",true);agentRouter.Cancel(id,d.RoomId);return Results.Ok(new{ok=true});});
        app.MapPost("/device/agent/approve", (HttpContext c, JsonElement body) => { var d = DeviceAuth(c, store); hub.Require(d, "info", true); var taskId = body.TryGetProperty("taskId", out var task) ? task.GetString() ?? "" : ""; var requestId = body.TryGetProperty("requestId", out var request) ? request.GetString() ?? "" : ""; var allow = body.TryGetProperty("approved", out var decision) && decision.GetBoolean(); if (taskId.Length == 0 || requestId.Length == 0) throw new ApiException(400, "确认请求无效"); approvals.DecideRemote(d.Id, taskId, requestId, allow); return Results.Ok(new { ok = true }); });
        app.MapGet("/device/agent/files", (HttpContext c) =>
        {
            var d = DeviceAuth(c, store);
            hub.Require(d, "files", true);
            var taskId = c.Request.Query["taskId"].FirstOrDefault() ?? "";
            var runToken = agent.RequireActiveDeviceRun(taskId, d);
            var result = files.ListPendingForDevice(d.Id, c.Request.Query["query"].FirstOrDefault());
            runToken.ThrowIfCancellationRequested();
            agent.RequireActiveDeviceRun(taskId, d);
            store.Audit("agent", "手机 Agent 列出待收文件", d.Id);
            return Results.Ok(result);
        });
        app.MapPost("/device/agent/files/{fileId}/deliver", async (string fileId, HttpContext c, JsonElement body) =>
        {
            var d = DeviceAuth(c, store);
            hub.Require(d, "files", true);
            var taskId = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("taskId", out var task) && task.ValueKind == JsonValueKind.String ? task.GetString() ?? "" : "";
            var runToken = agent.RequireActiveDeviceRun(taskId, d);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(c.RequestAborted, runToken);
            return Results.Ok(await files.Deliver(fileId, d.Id, true, linked.Token, onlyPending: true, taskId: taskId));
        });
        app.MapPost("/device/files", async (HttpContext context) =>
        {
            var d = DeviceAuth(context, store);
            var taskId = context.Request.Headers["X-Agent-Task-Id"].FirstOrDefault();
            if (taskId == null)
                return await files.Upload(context.Request.Body, DecodeName(context), context.Request.ContentLength, d.Id, true,
                    context.Request.Headers["X-File-SHA256"], context.RequestAborted);
            hub.Require(d, "files", true);
            var runToken = agent.RequireActiveDeviceRun(taskId, d);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, runToken);
            return await files.Upload(context.Request.Body, DecodeName(context), context.Request.ContentLength, d.Id, true,
                context.Request.Headers["X-File-SHA256"], linked.Token, taskId: taskId);
        });
        app.MapGet("/device/files/{id}", (string id, HttpContext context) =>
        {
            var d = DeviceAuth(context, store); hub.Require(d, "files"); var t = files.Get(id);
            if (t.RoomId != d.RoomId || t.DeviceId != d.Id || t.Direction != "toAndroid" || t.Status != "sending") throw new ApiException(403, "没有此文件的下载权限");
            return Results.File(files.PathFor(id), "application/octet-stream", t.Name, enableRangeProcessing: true);
        });
        app.MapDelete("/api/devices/{id}", async (string id, HttpContext c) => {var d=RoomDevice(c,id);agent.CancelDevice(d.Id);await hub.Revoke(d.Id,"已被电脑移出房间，可重新配置加入");store.Audit("room","移除房间成员",d.Id);return new{ok=true};});
        app.MapPost("/api/devices/{id}/disconnect", (string id, HttpContext c) => { var d=RoomDevice(c,id); hub.Disconnect(d.Id); store.Audit("connection", "断开设备连接", d.Id); return new { ok = true }; });
        app.MapGet("/api/devices/{id}/screenshot", (string id, HttpContext c) => Results.Bytes(hub.Screenshot(RoomDevice(c,id)), "image/jpeg"));
        app.Map("/api/devices/{id}/stream", async (string id, HttpContext context) =>
        {
            var d = RoomDevice(context,id); hub.Require(d, "screen"); if (!context.WebSockets.IsWebSocketRequest) throw new ApiException(400, "需要 WebSocket 连接");
            using var socket = await context.WebSockets.AcceptWebSocketAsync(); await hub.Watch(d, socket, context.RequestAborted);
        });
        app.MapPost("/api/devices/{id}/command", async (string id, CommandRequest req, HttpContext context) => { RoomDevice(context,id); return await tools.Execute(id, req.Tool, req.Arguments, false, "", context.RequestAborted); });
        app.MapPost("/api/devices/{id}/mirror", async (string id,MirrorRequest req,HttpContext c)=>{ RoomDevice(c,id); return await hub.StartRemote(id,req,c.RequestAborted); });
        app.Map("/api/devices/{id}/mirror/stream", async (string id, HttpContext context) =>
        {
            var d = RoomDevice(context,id); hub.Require(d, "screen"); hub.Require(d, "control");
            if (!context.WebSockets.IsWebSocketRequest) throw new ApiException(400, "需要 WebSocket 连接");
            using var socket = await context.WebSockets.AcceptWebSocketAsync(); await hub.WatchMedia(id, socket, context.RequestAborted);
        });
        app.MapDelete("/api/devices/{id}/mirror", async (string id, HttpContext c) => { RoomDevice(c,id); await hub.StopRemote(id);return new{ok=true};});
        app.MapPost("/api/devices/{id}/clipboard/pull", async(string id,HttpContext c,CancellationToken ct,ClipboardBridge clipboard)=>{var d=RoomDevice(c,id);var result=Json.Element(await tools.Execute(d.Id,"clipboard_get",Json.Element(new{}),false,"",ct));var source=result.TryGetProperty("source",out var value)?value.GetString():null;if(source is not ("system_fresh" or "system"))throw new ApiException(422,"Android 未返回本次读取到的系统剪贴板，未修改 Windows 剪贴板");var text=result.GetProperty("text").GetString()??"";await clipboard.ReceiveFromDevice(d,text,ct);return new{ok=true,source="android_fresh",written=true};});
        app.MapPost("/api/files", async (HttpContext context) => { var id = context.Request.Query["deviceId"].ToString(); var room=Current(context);if (id.Length > 0 && store.GetDevice(id).RoomId!=room.Id)throw new ApiException(403,"设备不在当前房间");return await files.Upload(context.Request.Body, DecodeName(context), context.Request.ContentLength, id, false, null, context.RequestAborted,room.Id); });
        app.MapGet("/api/files/{id}", (string id, HttpContext c) => { var t = RoomTransfer(c,id); return Results.File(files.PathFor(t.Id), "application/octet-stream", t.Name, enableRangeProcessing: true); });
        app.MapPost("/api/files/{id}/send", async (string id, JsonElement body, HttpContext context) => { RoomTransfer(context,id); return await files.Deliver(id, body.GetProperty("deviceId").GetString() ?? "", false, context.RequestAborted); });
        app.MapDelete("/api/files/{id}", (string id, HttpContext c) => { RoomTransfer(c,id); files.Delete(id); return new { ok = true }; });
        app.MapPost("/api/clipboard", (JsonElement body, ClipboardBridge clipboard) => { clipboard.Set(body.GetProperty("text").GetString() ?? ""); return new { ok = true }; });
        app.MapGet("/api/logs", () => { lock (store.Gate) return store.Logs.AsEnumerable().Reverse().ToArray(); });
        app.MapGet("/api/logs/export", () => { lock (store.Gate) return Results.Text(string.Join('\n', store.Logs.Select(l => JsonSerializer.Serialize(l, Json.Options))), "application/x-ndjson"); });
        app.MapGet("/api/settings", (HttpContext c) => {var room=Current(c);lock(store.Gate)return Results.Ok(new { apiUrl=store.AgentFor(room.Id).ApiUrl,model=store.AgentFor(room.Id).Model,hasKey=store.AgentFor(room.Id).ApiKey.Length>0,confirmMutations=store.AgentFor(room.Id).ConfirmMutations,pcAgentEnabled=room.PcAgentEnabled,pcRemotePermissions=room.PcRemotePermissions.Copy(),sharedFolders=room.SharedFolders.ToArray(),hasExternalToken=store.State.ExternalTokenHash.Length>0,dataDirectory=store.DirectoryPath,defaultProfileId=room.DefaultAgentProfileId,profiles=room.AgentProfiles.Select(ProfileView).ToArray() });});
        app.MapPost("/api/settings/pc-agent", (JsonElement body, HttpContext c) =>
        {
            if (!body.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new ApiException(400, "Windows Agent 开关无效");
            var room = Current(c);
            var enabled = value.GetBoolean();
            lock (store.Gate) { room.PcAgentEnabled = enabled; store.Save(); }
            if (!enabled) agentRouter.CancelRoom(room.Id);
            store.Audit("settings", enabled ? "启用 Windows Agent" : "停用 Windows Agent");
            return new { enabled };
        });
        app.MapPost("/api/settings/profiles", (AgentProfileInput input, HttpContext c) =>
        {
            var room = Current(c); if (input.Name?.Trim().Length is not (>= 1 and <= 80)) throw new ApiException(400, "方案名称应为 1 到 80 字");
            ValidateProfile(input.ApiType, input.ApiUrl, input.Model, input.MaxCalls, input.MaxSteps, input.TimeoutSeconds);
            lock (store.Gate)
            {
                if (room.AgentProfiles.Count >= 32) throw new ApiException(409, "每个房间最多 32 个模型方案");
                var profile = new AgentProfile { Name = input.Name.Trim(), ApiType = input.ApiType, ApiUrl = input.ApiUrl.TrimEnd('/'), Model = input.Model.Trim(), ApiKey = input.ApiKey ?? "", MaxCalls = input.MaxCalls, MaxSteps = input.MaxSteps, TimeoutSeconds = input.TimeoutSeconds };
                if (profile.ApiKey.Length > 1024) throw new ApiException(400, "API Key 过长"); room.AgentProfiles.Add(profile); if (room.DefaultAgentProfileId.Length == 0) room.DefaultAgentProfileId = profile.Id; store.Save(); return ProfileView(profile);
            }
        });
        app.MapPut("/api/settings/profiles/{id}", (string id, AgentProfileInput input, HttpContext c) =>
        {
            var room = Current(c); ValidateProfile(input.ApiType, input.ApiUrl, input.Model, input.MaxCalls, input.MaxSteps, input.TimeoutSeconds);
            if (input.Name?.Trim().Length is not (>= 1 and <= 80)) throw new ApiException(400, "方案名称应为 1 到 80 字");
            if (input.ApiKey?.Length > 1024) throw new ApiException(400, "API Key 过长");
            lock (store.Gate)
            {
                var profile = room.AgentProfiles.FirstOrDefault(p => p.Id == id) ?? throw new ApiException(404, "模型方案不存在");
                profile.Name = input.Name.Trim(); profile.ApiType = input.ApiType; profile.ApiUrl = input.ApiUrl.TrimEnd('/'); profile.Model = input.Model.Trim(); profile.MaxCalls = input.MaxCalls; profile.MaxSteps = input.MaxSteps; profile.TimeoutSeconds = input.TimeoutSeconds; if (!string.IsNullOrWhiteSpace(input.ApiKey)) profile.ApiKey = input.ApiKey; store.Save(); return ProfileView(profile);
            }
        });
        app.MapDelete("/api/settings/profiles/{id}", (string id, HttpContext c) =>
        {
            var room = Current(c); lock (store.Gate) { if (room.AgentProfiles.Count <= 1) throw new ApiException(409, "至少保留一个模型方案"); var profile = room.AgentProfiles.FirstOrDefault(p => p.Id == id) ?? throw new ApiException(404, "模型方案不存在"); room.AgentProfiles.Remove(profile); if (room.DefaultAgentProfileId == id) room.DefaultAgentProfileId = room.AgentProfiles[0].Id; store.Save(); return new { ok = true }; }
        });
        app.MapPost("/api/settings/profiles/{id}/default", (string id, HttpContext c) => { var room = Current(c); lock (store.Gate) { if (!room.AgentProfiles.Any(p => p.Id == id)) throw new ApiException(404, "模型方案不存在"); room.DefaultAgentProfileId = id; store.Save(); return new { ok = true }; } });
        app.MapPost("/api/settings", (JsonElement body,HttpContext c) =>
        {
            var url = body.GetProperty("apiUrl").GetString()?.Trim() ?? ""; var model = body.GetProperty("model").GetString()?.Trim() ?? "";
            AgentRunner.ValidatePhoneProfileUrl(url);
            if (model.Length is < 1 or > 100) throw new ApiException(400, "模型名称无效");
            var key = body.TryGetProperty("apiKey", out var keyValue) ? keyValue.GetString() ?? "" : "";
            if (key.Length > 1024) throw new ApiException(400, "API Key 过长");
            var confirmMutations = !body.TryGetProperty("confirmMutations", out var confirm) || confirm.GetBoolean();
            var profileIdInput = body.TryGetProperty("profileId", out var profileValue) ? profileValue.GetString() : null;
            var nameInput = body.TryGetProperty("profileName", out var nameValue) ? nameValue.GetString()?.Trim() : null;
            if (nameInput is { Length: < 1 or > 80 }) throw new ApiException(400, "方案名称应为 1 到 80 字");
            var apiType = body.TryGetProperty("apiType", out var typeValue) ? typeValue.GetString() ?? "chat_completions" : "chat_completions";
            if (apiType is not ("chat_completions" or "responses")) throw new ApiException(400, "API 类型无效");
            var setDefault = body.TryGetProperty("setDefault", out var defaultValue) && defaultValue.GetBoolean();
            bool? pcAgentEnabled = body.TryGetProperty("pcAgentEnabled", out var pcEnabled) ? pcEnabled.GetBoolean() : null;
            int? Limit(string field, int minimum, int maximum)
            {
                if (!body.TryGetProperty(field, out var value)) return null;
                if (!value.TryGetInt32(out var limit)) throw new ApiException(400, "模型方案参数无效");
                return Math.Clamp(limit, minimum, maximum);
            }
            var maxCalls = Limit("maxCalls", 1, 200);
            var maxSteps = Limit("maxSteps", 1, 100);
            var timeoutSeconds = Limit("timeoutSeconds", 30, 3600);
            string roomId;
            var disablePc = false;
            lock (store.Gate)
            {
                var room = Current(c); roomId = room.Id;
                var profileId = string.IsNullOrWhiteSpace(profileIdInput) ? room.DefaultAgentProfileId : profileIdInput;
                var profile = room.AgentProfiles.FirstOrDefault(p => p.Id == profileId)
                    ?? throw new ApiException(409, "模型方案已被删除或不再属于当前房间，请刷新后重试");
                // Resolve and validate the complete draft before changing persisted
                // or in-memory settings. A rejected stale selection is a no-op.
                var a = new AgentSettings { ApiUrl = url.TrimEnd('/'), Model = model,
                    ApiKey = key.Length > 0 ? key : profile.ApiKey, ConfirmMutations = confirmMutations };
                room.Agent = a;
                if (nameInput != null) profile.Name = nameInput;
                profile.ApiType = apiType;
                profile.ApiUrl = a.ApiUrl; profile.Model = a.Model; if (a.ApiKey.Length > 0) profile.ApiKey = a.ApiKey;
                profile.MaxCalls = maxCalls ?? profile.MaxCalls;
                profile.MaxSteps = maxSteps ?? profile.MaxSteps;
                profile.TimeoutSeconds = timeoutSeconds ?? profile.TimeoutSeconds;
                if (room.DefaultAgentProfileId.Length == 0 || setDefault) room.DefaultAgentProfileId = profile.Id;
                if (pcAgentEnabled is { } enabled) { room.PcAgentEnabled = enabled; disablePc = !enabled; }
                store.Save();
            }
            if (disablePc) agentRouter.CancelRoom(roomId);
            store.Audit("settings", "更新模型配置"); return new { ok = true };
        });
        app.MapPost("/api/settings/test", async (HttpContext c, AgentProfileTestInput input) =>
        {
            var room = Current(c);
            var profileId = input.ProfileId ?? c.Request.Query["profileId"].FirstOrDefault() ?? room.DefaultAgentProfileId;
            var profile = ProfileForTest(store, room.Id, input with { ProfileId = profileId });
            return Results.Ok(await agent.TestProfile(c.RequestAborted, profile));
        });
        app.MapPost("/api/settings/folders", async(HttpContext c)=>{var room=Current(c);var path=await PcTools.PickFolder();if(path!=null)lock(store.Gate){if(!store.State.Rooms.Contains(room))throw new ApiException(409,"房间已解散");if(!room.SharedFolders.Any(f=>f.Path.Equals(path,StringComparison.OrdinalIgnoreCase))){if(room.SharedFolders.Count>=32)throw new ApiException(409,"最多授权 32 个目录");room.SharedFolders.Add(new(){Path=path,Name=Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar))});store.Save();store.Audit("permission","授权 Windows 文件夹");}}return Results.Ok(new{ok=true});});
        app.MapDelete("/api/settings/folders/{id}",(string id,HttpContext c)=>{lock(store.Gate){Current(c).SharedFolders.RemoveAll(f=>f.Id==id);store.Save();}store.Audit("permission","撤销 Windows 文件夹授权");return Results.Ok(new{ok=true});});
        app.MapPost("/api/network/firewall", () => {var script=Path.Combine(AppContext.BaseDirectory,"scripts","configure-firewall.ps1");if(!File.Exists(script))throw new ApiException(404,"请使用完整安装包配置局域网访问");try{System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("powershell.exe"){UseShellExecute=true,Verb="runas",WindowStyle=System.Diagnostics.ProcessWindowStyle.Hidden,Arguments="-NoProfile -ExecutionPolicy Bypass -File \""+script+"\" -Program \""+Environment.ProcessPath+"\""});}catch(System.ComponentModel.Win32Exception){throw new ApiException(409,"未完成系统管理员确认，防火墙规则未修改");}return new{ok=true};});
        app.MapPost("/api/settings/token", () => { var token = StateStore.Token(); store.State.ExternalTokenHash = StateStore.Hash(token); store.Save(); store.Audit("settings", "轮换外部 Agent API 凭据"); return new { token }; });
        app.MapDelete("/api/settings/token", () => { store.State.ExternalTokenHash = ""; store.Save(); return new { ok = true }; });
        app.MapGet("/api/agent/runs", (HttpContext c) => Results.Ok(agentRouter.List(Current(c).Id)));
        app.MapGet("/api/agent/workspace", (HttpContext c) =>
        {
            Current(c);
            return Results.Ok(PcWorkspace.Browse(c.Request.Query["path"].FirstOrDefault(), c.Request.Query["query"].FirstOrDefault()));
        });
        app.MapPost("/api/agent/runs", (AgentStart req, HttpContext c) => agentRouter.Start(Current(c).Id,
            string.IsNullOrWhiteSpace(req.TargetId) ? req.DeviceId : req.TargetId, req.Task, req.Mode, req.ProfileId, req.WorkspacePath));
        app.MapDelete("/api/agent/runs/{id}", (string id, HttpContext c) => { agentRouter.Cancel(id, Current(c).Id); return new { ok = true }; });
        app.MapPost("/api/approvals/{id}", (string id, ApprovalDecision req, HttpContext c) => { approvals.Decide(id, req.Allow, Current(c).Id); return new { ok = true }; });
        app.MapGet("/agent/v1/devices", () => { lock (store.Gate) return store.State.Devices.Where(d=>!d.Revoked).Select(hub.View).ToArray(); });
        app.MapGet("/agent/v1/tools", () => ToolService.Definitions);
        app.MapGet("/agent/v1/devices/{id}/screenshot", (string id) => { var d = store.GetDevice(id); hub.Require(d, "screen", true); store.Audit("agent", "外部 API 获取截图", id); return Results.Bytes(hub.Screenshot(d), "image/jpeg"); });
        app.MapPost("/agent/v1/devices/{id}/actions", async (string id, CommandRequest req, HttpContext context) => await tools.Execute(id, req.Tool, req.Arguments, true, "external", context.RequestAborted));
        app.MapFallback("/api/{**path}", () => Results.NotFound(new { title = "接口不存在", status = 404 }));
        app.MapFallback("/agent/{**path}", () => Results.NotFound(new { title = "接口不存在", status = 404 }));
        app.MapFallback("/device/{**path}", () => Results.NotFound(new { title = "接口不存在", status = 404 }));
        app.MapFallbackToFile("index.html");
    }
    private static string NormalizeIp(IPAddress ip) => ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4().ToString() : ip.ToString();
    private static object ProfileView(AgentProfile p) => new { p.Id, p.Name, p.ApiType, p.ApiUrl, p.Model, p.MaxCalls, p.MaxSteps, p.TimeoutSeconds, hasKey = p.ApiKey.Length > 0 };
    private static AgentProfile ProfileForTest(StateStore store, string roomId, AgentProfileTestInput input)
    {
        AgentProfile? saved = null;
        lock (store.Gate)
        {
            var room = store.GetRoom(roomId);
            if (!string.IsNullOrWhiteSpace(input.ProfileId))
            {
                var source = room.AgentProfiles.FirstOrDefault(p => p.Id == input.ProfileId) ?? throw new ApiException(404, "模型方案不存在");
                saved = new AgentProfile { Id = source.Id, Name = source.Name, ApiType = source.ApiType, ApiUrl = source.ApiUrl, ApiKey = source.ApiKey, Model = source.Model, MaxCalls = source.MaxCalls, MaxSteps = source.MaxSteps, TimeoutSeconds = source.TimeoutSeconds };
            }
        }
        var profile = new AgentProfile
        {
            Id = saved?.Id ?? Guid.NewGuid().ToString("N"),
            Name = input.Name?.Trim() is { Length: > 0 } name ? name : saved?.Name ?? "连接测试",
            ApiType = input.ApiType ?? saved?.ApiType ?? "chat_completions",
            ApiUrl = (input.ApiUrl ?? saved?.ApiUrl ?? "").Trim().TrimEnd('/'),
            Model = (input.Model ?? saved?.Model ?? "").Trim(),
            ApiKey = string.IsNullOrEmpty(input.ApiKey) ? saved?.ApiKey ?? "" : input.ApiKey,
            MaxCalls = input.MaxCalls ?? saved?.MaxCalls ?? 24,
            MaxSteps = input.MaxSteps ?? saved?.MaxSteps ?? 24,
            TimeoutSeconds = input.TimeoutSeconds ?? saved?.TimeoutSeconds ?? 900
        };
        if (profile.ApiKey.Length > 1024) throw new ApiException(400, "API Key 过长");
        ValidateProfile(profile.ApiType, profile.ApiUrl, profile.Model, profile.MaxCalls, profile.MaxSteps, profile.TimeoutSeconds);
        return profile;
    }
    private static void ValidateProfile(string apiType, string apiUrl, string model, int maxCalls, int maxSteps, int timeoutSeconds)
    {
        if (apiType is not ("chat_completions" or "responses")) throw new ApiException(400, "API 类型无效");
        AgentRunner.ValidatePhoneProfileUrl(apiUrl);
        if (model?.Trim().Length is not (>= 1 and <= 100) || maxCalls is < 1 or > 200 || maxSteps is < 1 or > 100 || timeoutSeconds is < 30 or > 3600) throw new ApiException(400, "模型方案参数超出范围");
    }
    private static string DecodeName(HttpContext c) { try { return Uri.UnescapeDataString(c.Request.Headers["X-File-Name"].ToString()); } catch (UriFormatException) { throw new ApiException(400, "文件名编码错误"); } }
    private static Device DeviceAuth(HttpContext c, StateStore store) => store.AuthenticateDevice(c.Request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.Ordinal) ? c.Request.Headers.Authorization.ToString()[7..] : null);

    private static Device RoomDevice(HttpContext c, string id)
    {
        var store = c.RequestServices.GetRequiredService<StateStore>();
        var device = store.GetDevice(id);
        var requestedRoom = c.Request.Headers["X-Nexus-Room"].FirstOrDefault() ?? c.Request.Query["roomId"].FirstOrDefault();
        var room = store.GetRoom(requestedRoom);
        if (device.RoomId != room.Id || device.Revoked) throw new ApiException(403, "设备不在当前房间");
        return device;
    }

    private static Transfer RoomTransfer(HttpContext c, string id)
    {
        var store = c.RequestServices.GetRequiredService<StateStore>();
        var transfer = c.RequestServices.GetRequiredService<FileService>().Get(id);
        var requestedRoom = c.Request.Headers["X-Nexus-Room"].FirstOrDefault() ?? c.Request.Query["roomId"].FirstOrDefault();
        if (transfer.RoomId != store.GetRoom(requestedRoom).Id) throw new ApiException(403, "文件不在当前房间");
        return transfer;
    }
}
