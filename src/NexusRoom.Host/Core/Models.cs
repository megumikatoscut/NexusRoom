using System.Text.Json;

namespace NexusRoom.Host.Core;

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = false };
    public static JsonElement Element(object value) => JsonSerializer.SerializeToElement(value, Options);
}
public sealed class Room
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "我的 NexusRoom";
    public string Password { get; set; } = "";
    public string Salt { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public bool Open { get; set; } = true;
    public AgentSettings? Agent { get; set; }
    public List<AgentProfile> AgentProfiles { get; set; } = [];
    public string DefaultAgentProfileId { get; set; } = "";
    public bool PcAgentEnabled { get; set; } = true;
    public PcRemotePermissions PcRemotePermissions { get; set; } = new();
    public List<SharedFolder> SharedFolders { get; set; } = [];
}
public sealed class PcRemotePermissions
{
    public bool Screen { get; set; }
    public bool Control { get; set; }
    public bool Audio { get; set; }
    public bool Clipboard { get; set; }
    public PcRemotePermissions Copy() => new() { Screen = Screen, Control = Control, Audio = Audio, Clipboard = Clipboard };
}
public sealed class SharedFolder { public string Id { get; set; } = Guid.NewGuid().ToString("N"); public string Name { get; set; } = ""; public string Path { get; set; } = ""; }
public sealed class Permissions
{
    public bool Screen { get; set; }
    public bool Control { get; set; }
    public bool Files { get; set; }
    public bool Clipboard { get; set; }
    public bool Agent { get; set; }
    public bool Audio { get; set; }
    public bool ScreenAllowed { get; set; }
}
public sealed class Device
{
    public string Id { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string PhysicalId { get; set; } = "";
    public string Activity { get; set; } = "online";
    public string OwnerRoom { get; set; } = "";
    public bool Revoked { get; set; }
    public string Name { get; set; } = "Android";
    public string Model { get; set; } = "";
    public string System { get; set; } = "Android";
    public string Version { get; set; } = "";
    public string Ip { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public int Battery { get; set; } = -1;
    public bool Charging { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public DateTimeOffset LastSeen { get; set; }
    public Permissions Permissions { get; set; } = new();
}
public sealed class AgentSettings
{
    public string ApiUrl { get; set; } = "https://api.openai.com/v1";
    public string ApiKey { get; set; } = "";
    public string Model { get; set; } = "";
    public bool ConfirmMutations { get; set; } = true;
}
public sealed class AgentProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "默认方案";
    public string ApiType { get; set; } = "chat_completions";
    public string ApiUrl { get; set; } = "https://api.openai.com/v1";
    public string ApiKey { get; set; } = "";
    public string Model { get; set; } = "";
    public int MaxCalls { get; set; } = 24;
    public int MaxSteps { get; set; } = 24;
    public int TimeoutSeconds { get; set; } = 900;
}
public sealed class SavedState
{
    public Room Room { get; set; } = new();
    public List<Room> Rooms { get; set; } = [];
    public int SchemaVersion { get; set; }
    public List<Device> Devices { get; set; } = [];
    public List<Transfer> Transfers { get; set; } = [];
    public AgentSettings Agent { get; set; } = new();
    public string ExternalTokenHash { get; set; } = "";
}
public sealed class Transfer
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string Direction { get; set; } = "toAndroid";
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";
    public string Status { get; set; } = "ready";
    public string? Error { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed record AuditEntry(string Id, DateTimeOffset Time, string Category, string Action, string DeviceId, string Result);
public sealed class ApiException(int status, string message) : Exception(message) { public int Status { get; } = status; }
public sealed record JoinRequest(string RoomId, string Password, string Name, string Version, string PhysicalId = "", string Model = "");
public sealed record CommandRequest(string Tool, JsonElement Arguments);
public sealed record ApprovalDecision(bool Allow);
public sealed record DeviceAgentStart(string Task, string Mode = "request", string DeviceId = "", string ProfileId = "", string TargetDeviceId = "", string? WorkspacePath = null);
public sealed record AgentStart(string DeviceId = "", string Task = "", string Mode = "request", string ProfileId = "", string TargetId = "", string? WorkspacePath = null);
public sealed record AgentProfileInput(string Name, string ApiType, string ApiUrl, string Model, string? ApiKey, int MaxCalls = 24, int MaxSteps = 24, int TimeoutSeconds = 900);
public sealed record AgentProfileTestInput(string? ProfileId = null, string? Name = null, string? ApiType = null, string? ApiUrl = null, string? Model = null, string? ApiKey = null, int? MaxCalls = null, int? MaxSteps = null, int? TimeoutSeconds = null);
public sealed record MirrorRequest(int MaxSize = 1600, int Fps = 60, int Bitrate = 8);
public sealed record PcRemoteStart(int MaxSize = 1600, int Fps = 15, int Quality = 75, bool Audio = true);
public sealed record PcRemoteSessionRequest(string SessionId);
public sealed record PcRemoteDecision(string SessionId, bool Allow);
