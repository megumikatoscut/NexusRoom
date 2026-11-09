using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Voice;

public sealed class VoiceClaim
{
    public string EventId { get; set; } = "";
    public string SourceId { get; set; } = "";
    public string ProfileId { get; set; } = "";
    public string? WorkspacePath { get; set; }
    public bool Cancelled { get; set; }
    public string TaskId { get; set; } = "";
}
public sealed class VoiceTask
{
    public string TaskId { get; set; } = Guid.NewGuid().ToString("N");
    public string WakeId { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string SourceId { get; set; } = "";
    public string ProfileId { get; set; } = "";
    public string? WorkspacePath { get; set; }
    public string Text { get; set; } = "";
    public string Status { get; set; } = "routing";
    public string TargetId { get; set; } = "";
    public string RunId { get; set; } = "";
    public string Error { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed class VoiceWake
{
    public string WakeId { get; set; } = Guid.NewGuid().ToString("N");
    public string RoomId { get; set; } = "";
    public string SourceId { get; set; } = "";
    public string ProfileId { get; set; } = "";
    public string? WorkspacePath { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; } = DateTimeOffset.UtcNow.AddSeconds(65);
    public List<VoiceClaim> Claims { get; set; } = [];
    public List<VoiceTask> Tasks { get; set; } = [];
}
public sealed record VoiceWakeReply(string WakeId, bool Capture, string SourceId, DateTimeOffset ExpiresAt);

// The disk index is retained as an idempotency tombstone, while the working set
// is bounded. Never evict a token and later treat its retry as a new wake.
public sealed class VoiceWakeLedger
{
    private readonly object gate = new();
    private readonly Dictionary<string, VoiceWake> recent = new();
    private readonly Func<string, string?> read;
    private readonly Action<string, string> write;
    public VoiceWakeLedger(Func<string, string?> read, Action<string, string> write) { this.read = read; this.write = write; }
    private static string ClaimKey(string room, string source, string id) => "claim-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(room + "\n" + source + "\n" + id))).ToLowerInvariant();
    private void Save(VoiceWake wake) => write("wake-" + wake.WakeId, JsonSerializer.Serialize(wake, Json.Options));
    private VoiceWake Load(string id)
    {
        if (recent.TryGetValue(id, out var wake)) return wake;
        var raw = read("wake-" + id) ?? throw new ApiException(404, "语音唤醒已失效，请重新唤醒");
        wake = JsonSerializer.Deserialize<VoiceWake>(raw, Json.Options) ?? throw new ApiException(409, "语音任务记录不可读");
        // A process may have died after dispatch but before saving the Agent id.
        // An uncertain dispatch is never repeated after restart.
        foreach (var task in wake.Tasks.Where(t => t.Status is "routing" or "dispatching"))
        { task.Status = "interrupted"; task.Error = "主机重启中断了语音任务；请检查原任务状态后重新唤醒"; }
        recent[id] = wake;
        return wake;
    }
    private void Trim(DateTimeOffset now)
    {
        foreach (var old in recent.Values.Where(w => w.ExpiresAt < now.AddMinutes(-2)).ToArray()) recent.Remove(old.WakeId);
        if (recent.Count >= 256) throw new ApiException(429, "语音唤醒过于频繁，请稍后重试");
    }
    private static void ValidateId(string id)
    { if (!Guid.TryParse(id, out _)) throw new ApiException(400, "语音事件标识无效"); }
    public VoiceWakeReply Claim(string room, string source, string eventId, string profileId, string? workspacePath)
    {
        ValidateId(eventId); eventId = Guid.Parse(eventId).ToString("N");
        lock (gate)
        {
            var now = DateTimeOffset.UtcNow;
            Trim(now);
            var key = ClaimKey(room, source, eventId);
            var known = read(key);
            if (known != null)
            {
                var existing = Load(known);
                var claim = existing.Claims.Single(c => c.SourceId == source && c.EventId == eventId);
                return new(existing.WakeId, !claim.Cancelled && claim.TaskId.Length == 0 && now < existing.ExpiresAt, source, existing.ExpiresAt);
            }
            if (recent.Values.Count(w => w.RoomId == room && w.CreatedAt > now.AddMinutes(-1)) >= 30)
                throw new ApiException(429, "本房间语音唤醒过于频繁，请稍后重试");
            // Server receipt time avoids unsynchronised phone/PC clocks and
            // bucket boundaries. A second wake from the same source is new.
            var wake = recent.Values.Where(w => w.RoomId == room && now - w.CreatedAt <= TimeSpan.FromSeconds(3)
                && w.Claims.All(c => c.SourceId != source)).OrderByDescending(w => w.CreatedAt).FirstOrDefault();
            wake ??= new VoiceWake { RoomId = room, SourceId = source, ProfileId = profileId, WorkspacePath = workspacePath };
            wake.Claims.Add(new() { EventId = eventId, SourceId = source, ProfileId = profileId, WorkspacePath = workspacePath });
            Save(wake); write(key, wake.WakeId); recent[wake.WakeId] = wake;
            return new(wake.WakeId, true, source, wake.ExpiresAt);
        }
    }
    public (VoiceWake Wake, VoiceTask Task, bool New) Reserve(string room, string source, string wakeId, string eventId, string text)
    {
        ValidateId(wakeId); ValidateId(eventId);
        wakeId = Guid.Parse(wakeId).ToString("N"); eventId = Guid.Parse(eventId).ToString("N");
        text = CleanText(text);
        if (text.Length is < 1 or > 8000 || Fingerprint(text).Length == 0) throw new ApiException(400, "未识别到有效指令，请重新说话");
        lock (gate)
        {
            Trim(DateTimeOffset.UtcNow);
            var wake = Load(wakeId);
            if (wake.RoomId != room) throw new ApiException(403, "语音事件不属于本房间");
            var claim = wake.Claims.FirstOrDefault(c => c.EventId == eventId && c.SourceId == source)
                ?? throw new ApiException(403, "语音事件不属于本设备");
            if (claim.Cancelled) throw new ApiException(409, "语音录音已取消");
            if (claim.TaskId.Length > 0) return (wake, wake.Tasks.Single(t => t.TaskId == claim.TaskId), false);
            if (wake.ExpiresAt < DateTimeOffset.UtcNow) throw new ApiException(409, "语音录音超时，请重新唤醒");
            // Normalise punctuation/case, but preserve numbers and entity names:
            // two different prompts in a coalesced wake still get separate tasks.
            var normal = Fingerprint(text);
            var duplicate = wake.Tasks.FirstOrDefault(t => Fingerprint(t.Text) == normal);
            if (duplicate != null) { claim.TaskId = duplicate.TaskId; Save(wake); return (wake, duplicate, false); }
            var task = new VoiceTask { WakeId = wake.WakeId, RoomId = room, SourceId = source,
                ProfileId = claim.ProfileId, WorkspacePath = claim.WorkspacePath, Text = text };
            claim.TaskId = task.TaskId; wake.Tasks.Add(task); Save(wake);
            return (wake, task, true);
        }
    }
    public void Update(VoiceWake wake, VoiceTask task, string status, string? target = null, string? runId = null, string? error = null)
    {
        lock (gate)
        { task.Status = status; if (target != null) task.TargetId = target; if (runId != null) task.RunId = runId; if (error != null) task.Error = error; Save(wake); }
    }
    public void Cancel(string room, string source, string wakeId, string eventId)
    {
        ValidateId(wakeId); ValidateId(eventId);
        lock (gate)
        {
            var wake = Load(Guid.Parse(wakeId).ToString("N"));
            if (wake.RoomId != room) throw new ApiException(403, "语音事件不属于本房间");
            var claim = wake.Claims.FirstOrDefault(c => c.SourceId == source && c.EventId == Guid.Parse(eventId).ToString("N"))
                ?? throw new ApiException(403, "语音事件不属于本设备");
            if (claim.TaskId.Length > 0) throw new ApiException(409, "任务已提交，请使用 Agent 停止按钮");
            claim.Cancelled = true; Save(wake);
        }
    }
    public VoiceTask[] List(string room) { lock (gate) return recent.Values.Where(w => w.RoomId == room).SelectMany(w => w.Tasks).OrderByDescending(t => t.CreatedAt).Take(100).ToArray(); }
    public static string CleanText(string? text) => Regex.Replace((text ?? "").Trim(), @"^(?:(?:hi|high|hey|嗨|海)\s*[,，]?\s*(?:nexus|next\s*is)|nexus)[\s,，。.!！:：]*", "", RegexOptions.IgnoreCase).Trim();
    public static string Fingerprint(string text)
    {
        var value = CleanText(text).Normalize(NormalizationForm.FormKC);
        // Tested bilingual recognizers can render leading "on" as 哦, or omit
        // polite introductions. Only canonicalise the grammatical introduction;
        // retain the action, names, numbers, operators and path separators.
        value = Regex.Replace(value, @"^(?:(?:请帮我|请|帮我|麻烦你|麻烦|哦|噢|呃|嗯)[,，:：]?\s*)+", "");
        value = Regex.Replace(value, @"^(?:(?:please|oh|um|uh)\s+)+", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"^(?:(?:on|in|at)\s+)?(?:this|the)\s+(computer|pc|phone|device)\b\s*[,，:：]?", "$1:", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"^在(?=电脑|手机|这台设备|这台电脑|这台手机)", "");
        var parts = Regex.Split(value, "(\"[^\"]*\"|'[^']*'|“[^”]*”|‘[^’]*’|(?:[A-Za-z]:[\\\\/]|https?://|/)[^\\s\"“”‘’]+)" );
        for (var i = 0; i < parts.Length; i += 2)
        {
            var plain = Regex.Replace(parts[i].ToLowerInvariant(), @"\s+", " ");
            // Mandarin token spacing is optional; English word/path spacing
            // and quoted literal spacing are significant and are retained.
            parts[i] = Regex.Replace(plain, @"(?<=[\p{IsCJKUnifiedIdeographs}]) | (?=[\p{IsCJKUnifiedIdeographs}])", "");
        }
        return string.Concat(parts).Trim().TrimEnd('。', '！', '？', '!', '?', '.', ',', '，', ':', '：', ';', '；');
    }
}
