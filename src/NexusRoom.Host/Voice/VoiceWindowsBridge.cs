using System.Collections.Concurrent;
using NexusRoom.Host.Agent;

namespace NexusRoom.Host.Voice;

// Keeps local audio independent from Room policy and the Agent execution loop.
public sealed class VoiceWindowsBridge(WindowsVoiceService engine, VoiceCoordinator coordinator) : IHostedService
{
    private readonly ConcurrentDictionary<string, (VoiceWakeReply Claim, DateTimeOffset At)> claims = new();
    public Task StartAsync(CancellationToken cancellationToken)
    {
        engine.WakeDetected = wake =>
        {
            foreach (var old in claims.Where(p => p.Value.At < DateTimeOffset.UtcNow.AddMinutes(-2)).ToArray()) claims.TryRemove(old.Key, out _);
            var claim = coordinator.Claim(wake.RoomId, AgentRouter.PcTargetId(wake.RoomId), new(wake.EventId, wake.Options.ProfileId ?? "", wake.Options.WorkspacePath));
            claims[wake.EventId] = (claim, DateTimeOffset.UtcNow);
            return Task.FromResult(claim.Capture);
        };
        engine.WakeTranscript = async transcript =>
        {
            if (!claims.TryRemove(transcript.EventId, out var entry)) throw new InvalidOperationException("语音事件已失效，请重新唤醒。");
            var result = await coordinator.Submit(transcript.RoomId, AgentRouter.PcTargetId(transcript.RoomId), new(entry.Claim.WakeId, transcript.EventId, transcript.Text));
            if (result.Status is not ("started" or "duplicate")) throw new InvalidOperationException(result.Error);
        };
        return Task.CompletedTask;
    }
    public Task StopAsync(CancellationToken cancellationToken) { engine.WakeDetected = null; engine.WakeTranscript = null; claims.Clear(); return Task.CompletedTask; }
}
