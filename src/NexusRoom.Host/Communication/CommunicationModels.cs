using System.Text.Json;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Communication;

// These sessions are deliberately transient. No calls, invitations, chat, or
// media state are persisted into the application's room history.
public sealed record CommunicationActor(string RoomId, string DeviceId);
public sealed record CommunicationDeviceView(string Id, string Name, string Model, string System,
    bool Online, bool CommunicationOnline, bool Busy);
public sealed record CommunicationParticipantView(string DeviceId, string Name, string System,
    DateTimeOffset JoinedAt, bool Microphone, bool Camera, bool Screen, bool ScreenAudio);
public sealed record CommunicationMessage(string Id, string SenderId, string SenderName,
    string Text, DateTimeOffset SentAt);
public sealed record CommunicationSessionView(string Id, string RoomId, string Kind, string Title,
    string Visibility, string Status, string HostId, string CallerId, string CalleeId,
    DateTimeOffset CreatedAt, DateTimeOffset? ExpiresAt, DateTimeOffset? EndedAt, string EndReason,
    CommunicationParticipantView[] Participants, CommunicationMessage[] Messages);
public sealed record CommunicationInvitationView(string Id, string SessionId, string HostId,
    string HostName, string Title, string Visibility, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt);
public sealed record CommunicationState(string SelfId, string RoomId, string ActiveSessionId,
    CommunicationDeviceView[] Devices, CommunicationSessionView[] Sessions,
    CommunicationInvitationView[] Invitations);

internal static class CommunicationRequest
{
    public static void Only(JsonElement value, params string[] fields)
    {
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Any(p => !fields.Contains(p.Name)))
            throw new ApiException(400, "通信请求包含未知字段或格式无效");
    }
    public static string Text(JsonElement value, string field, int maximum, bool required = false, bool controls = false)
    {
        if (!value.TryGetProperty(field, out var item))
            return required ? throw new ApiException(400, "缺少 " + field) : "";
        if (item.ValueKind != JsonValueKind.String || item.GetString()!.Length > maximum
            || required && string.IsNullOrWhiteSpace(item.GetString()) || !controls && item.GetString()!.Any(char.IsControl))
            throw new ApiException(400, field + " 参数无效");
        return item.GetString()!;
    }
    public static bool Bool(JsonElement value, string field)
    {
        if (!value.TryGetProperty(field, out var item) || item.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new ApiException(400, field + " 必须为布尔值");
        return item.GetBoolean();
    }
    public static bool OptionalBool(JsonElement value, string field) =>
        value.TryGetProperty(field, out _) && Bool(value, field);
    public static string[] Strings(JsonElement value, string field)
    {
        if (!value.TryGetProperty(field, out var items)) return [];
        if (items.ValueKind != JsonValueKind.Array || items.GetArrayLength() > 32) throw new ApiException(400, field + " 必须为设备列表");
        return items.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(item.GetString()) && item.GetString()!.Length <= 100 && !item.GetString()!.Any(char.IsControl)
                ? item.GetString()! : throw new ApiException(400, field + " 包含无效设备")).ToArray();
    }
}
