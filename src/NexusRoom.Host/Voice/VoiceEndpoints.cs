using NexusRoom.Host.Agent;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;

namespace NexusRoom.Host.Voice;

public sealed record VoiceSettingsInput(bool Enabled = false, bool WakeEnabled = false, string ProfileId = "", string? WorkspacePath = null);
public sealed record VoiceRecordingInput(string RecordingId);
public static class VoiceEndpoints
{
    public static void MapVoice(this WebApplication app)
    {
        var store = app.Services.GetRequiredService<StateStore>();
        var engine = app.Services.GetRequiredService<WindowsVoiceService>();
        var coordinator = app.Services.GetRequiredService<VoiceCoordinator>();
        string Room(HttpContext context) => store.GetRoom(context.Request.Headers["X-Nexus-Room"].FirstOrDefault() ?? context.Request.Query["roomId"].FirstOrDefault()).Id;
        Device Source(HttpContext context)
        {
            var auth = context.Request.Headers.Authorization.ToString();
            var device = store.AuthenticateDevice(auth.StartsWith("Bearer ", StringComparison.Ordinal) ? auth[7..] : null);
            coordinator.RequireSource(device.RoomId, device.Id);
            return device;
        }
        app.MapGet("/api/voice/status", () => engine.GetStatus());
        app.MapPost("/api/voice/settings", async (HttpContext context, VoiceSettingsInput input) =>
        {
            var room = Room(context);
            var profile = store.ProfileFor(room, input.ProfileId);
            if (input.WakeEnabled && !input.Enabled) throw new ApiException(400, "启用自动唤醒前请先开启本地语音");
            if (input.Enabled && input.WakeEnabled && (profile.ApiKey.Length == 0 || profile.Model.Length == 0))
                throw new ApiException(409, "自动语音执行需要配置本房间的 Agent 模型方案");
            if (input.WorkspacePath?.Length > 32768) throw new ApiException(400, "工作目录过长");
            return await VoiceAction(() => engine.ConfigureAsync(new(input.Enabled, input.WakeEnabled, room, profile.Id, input.WorkspacePath)));
        });
        app.MapPost("/api/voice/manual/start", async (HttpContext context) => new { recordingId = await VoiceAction(() => engine.BeginManualAsync(Room(context))) });
        app.MapPost("/api/voice/manual/stop", async (HttpContext context, VoiceRecordingInput input) =>
        {
            Room(context); ValidateRecording(input.RecordingId);
            var transcript = await VoiceAction(() => engine.EndManualAsync(input.RecordingId, Room(context)));
            if (transcript.RoomId != Room(context)) throw new ApiException(403, "录音不属于当前房间");
            return new { text = transcript.Text, recordingId = transcript.EventId };
        });
        app.MapPost("/api/voice/manual/cancel", async (HttpContext context, VoiceRecordingInput input) =>
        {
            Room(context); ValidateRecording(input.RecordingId); await VoiceAction(async () => { await engine.CancelManualAsync(input.RecordingId, Room(context)); return true; });
            return new { ok = true };
        });
        app.MapGet("/api/voice/tasks", (HttpContext context) => coordinator.List(Room(context)));
        app.MapPost("/api/voice/wake", (HttpContext context, VoiceWakeInput input) => { var room = Room(context); return coordinator.Claim(room, AgentRouter.PcTargetId(room), input); });
        app.MapPost("/api/voice/submit", (HttpContext context, VoiceSubmitInput input) => { var room = Room(context); return coordinator.Submit(room, AgentRouter.PcTargetId(room), input); });
        app.MapPost("/api/voice/cancel", (HttpContext context, VoiceCancelInput input) => { var room = Room(context); coordinator.Cancel(room, AgentRouter.PcTargetId(room), input); return new { ok = true }; });
        app.MapPost("/device/voice/wake", (HttpContext context, VoiceWakeInput input) => { var source = Source(context); return coordinator.Claim(source.RoomId, source.Id, input); });
        app.MapPost("/device/voice/submit", (HttpContext context, VoiceSubmitInput input) => { var source = Source(context); return coordinator.Submit(source.RoomId, source.Id, input); });
        app.MapPost("/device/voice/cancel", (HttpContext context, VoiceCancelInput input) => { var source = Source(context); coordinator.Cancel(source.RoomId, source.Id, input); return new { ok = true }; });
        app.MapGet("/device/voice/tasks", (HttpContext context) => coordinator.List(Source(context).RoomId));
    }
    private static void ValidateRecording(string id) { if (!Guid.TryParse(id, out _)) throw new ApiException(400, "录音标识无效"); }
    private static async Task<T> VoiceAction<T>(Func<Task<T>> action)
    { try { return await action(); } catch (InvalidOperationException error) { throw new ApiException(409, error.Message); } }
}
