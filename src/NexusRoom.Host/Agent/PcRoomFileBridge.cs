using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;
using NexusRoom.Host.Files;
using NexusRoom.Host.Communication;

namespace NexusRoom.Host.Agent;

// The pipe fixes room, task, mode and workspace on the Host. Tool arguments
// cannot choose another room or replace a request-mode approval policy.
internal sealed class PcRoomFileBridge(StateStore store, DeviceHub hub, FileService files, ApprovalService approvals, CommunicationService communication,
    string roomId, string targetId, string runId, string mode, string workspacePath, Action<Approval> onCreated,
    CancellationToken runToken) : IAsyncDisposable
{
    private readonly CancellationTokenSource lifetime = CancellationTokenSource.CreateLinkedTokenSource(runToken);
    private readonly ConcurrentDictionary<Guid, Task> handlers = new();
    private readonly SemaphoreSlim sending = new(1, 1);
    private readonly Dictionary<string, Transfer> imported = new(StringComparer.OrdinalIgnoreCase);
    private Task? listener;
    private Process? child;
    public string PipeName { get; } = "NexusRoom-RoomFiles-" + Guid.NewGuid().ToString("N");

    public void Start(Process process) { child = process; listener = Listen(lifetime.Token); }

    private async Task Listen(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try { await pipe.WaitForConnectionAsync(token); }
            catch (OperationCanceledException) { pipe.Dispose(); break; }
            catch (IOException) { pipe.Dispose(); if (!token.IsCancellationRequested) continue; break; }
            if (child is null || child.HasExited || !GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid)
                || pid != (uint)child.Id) { pipe.Dispose(); continue; }
            var id = Guid.NewGuid();
            var handler = Handle(pipe, token);
            handlers[id] = handler;
            _ = handler.ContinueWith(_ => handlers.TryRemove(id, out var ignored), TaskScheduler.Default);
        }
    }

    private async Task Handle(NamedPipeServerStream pipe, CancellationToken token)
    {
        using (pipe)
        using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true))
        using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true, NewLine = "\n" })
        {
            try
            {
                using var initial = CancellationTokenSource.CreateLinkedTokenSource(token);
                initial.CancelAfter(TimeSpan.FromSeconds(10));
                var line = await ReadLine(reader, 64 * 1024, initial.Token);
                if (line is null) return;
                using var document = JsonDocument.Parse(line);
                var request = document.RootElement;
                if (request.ValueKind != JsonValueKind.Object) return;
                var id = Text(request, "id", 64);
                if (id.Length == 0) return;
                var tool = Text(request, "tool", 64);
                var callId = Text(request, "callId", 256);
                var args = request.TryGetProperty("arguments", out var value) ? value.Clone() : default;
                using var operation = CancellationTokenSource.CreateLinkedTokenSource(token);
                var disconnected = reader.ReadLineAsync(operation.Token).AsTask();
                var work = Execute(tool, args, callId, operation.Token);
                if (await Task.WhenAny(work, disconnected) == disconnected) operation.Cancel();
                object answer;
                try { answer = new { id, result = await work }; }
                catch (OperationCanceledException) { answer = new { id, error = new { status = 408, message = "PC Agent 房间工具已停止或超时" } }; }
                catch (ApiException error) { answer = new { id, error = new { status = error.Status, message = error.Message } }; }
                catch (Exception) { answer = new { id, error = new { status = 500, message = "房间工具操作失败，请检查设备连接" } }; }
                operation.Cancel();
                try { await disconnected; } catch (OperationCanceledException) { }
                if (pipe.IsConnected) await writer.WriteLineAsync(JsonSerializer.Serialize(answer, Json.Options));
            }
            catch (Exception error) when (error is IOException or JsonException or OperationCanceledException or ObjectDisposedException or ApiException) { }
        }
    }

    private Room RequireRun(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lifetime.Token.ThrowIfCancellationRequested();
        var room = store.GetRoom(roomId);
        if (!room.PcAgentEnabled) throw new ApiException(403, "当前房间的 Windows Agent 权限已关闭");
        return room;
    }

    private async Task<object> Execute(string tool, JsonElement args, string callId, CancellationToken ct)
    {
        var room = RequireRun(ct);
        if (args.ValueKind != JsonValueKind.Object) throw new ApiException(400, "工具参数必须是 JSON 对象");
        var allowed = tool switch
        {
            "list_room_devices" => Array.Empty<string>(),
            "send_file_to_phone" => new[] { "path", "deviceId" },
            "arrange_communication" => new[] { "action", "targetId", "title", "visibility", "inviteeIds" },
            _ => throw new ApiException(400, "未知房间文件工具")
        };
        if (args.EnumerateObject().Any(p => !allowed.Contains(p.Name))) throw new ApiException(400, "房间文件工具包含未知参数");
        if (tool == "list_room_devices")
        {
            lock (store.Gate) return new { roomId, selfId = targetId, devices = communication.ListDevices(CommunicationService.Pc(roomId))
                .Select(view => { var phone = store.State.Devices.FirstOrDefault(d => d.Id == view.Id); return new {
                    deviceId = view.Id, id = view.Id, view.Name, view.Model, view.System, type = phone == null ? "pc" : "android",
                    view.Online, view.CommunicationOnline, filesAllowed = phone?.Permissions.Files ?? false,
                    agentAllowed = phone?.Permissions.Agent ?? room.PcAgentEnabled, busy = view.Busy || phone?.Activity == "busy" }; }).ToArray() };
        }
        if (tool == "arrange_communication")
        {
            var actor = CommunicationService.Pc(roomId);
            var summary = communication.DescribeArrangement(actor, args);
            if (mode == "request" && !await approvals.AskPc(roomId, targetId, tool, summary, runId,
                Guid.NewGuid().ToString("N"), onCreated, ct)) throw new ApiException(403, "用户拒绝发起通话或会议，请求未发送");
            RequireRun(ct); ct.ThrowIfCancellationRequested();
            return communication.Arrange(actor, args);
        }

        var inputPath = Text(args, "path", 32768);
        if (string.IsNullOrWhiteSpace(inputPath) || inputPath.Any(char.IsControl)) throw new ApiException(400, "请选择电脑上的现有文件路径");
        string path;
        try
        {
            if (Path.IsPathRooted(inputPath) && !Path.IsPathFullyQualified(inputPath)) throw new ArgumentException();
            path = Path.GetFullPath(inputPath, workspacePath);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        { throw new ApiException(400, "电脑文件路径格式无效"); }
        var device = ResolveDevice(Text(args, "deviceId", 100), ct);
        await sending.WaitAsync(ct);
        var leaseReason = "pc-file:" + runId;
        var acquired = false;
        try
        {
            void Guard()
            {
                RequireRun(ct);
                if (device.RoomId != roomId || device.Revoked) throw new ApiException(403, "手机已离开当前房间");
                hub.Require(device, "files", true);
                if (acquired && !hub.HasLease(device.Id, leaseReason)) throw new ApiException(409, "PC 文件任务控制权已失效");
            }
            Guard();
            await using var input = OpenFile(path);
            if (input.Length > FileService.MaxFileSize) throw new ApiException(413, "单个文件最大 512 MB");
            if (mode == "request")
            {
                var summary = Json.Element(new { path, name = Path.GetFileName(path), size = input.Length,
                    deviceId = device.Id, deviceName = device.Name, callId });
                if (!await approvals.AskPc(roomId, targetId, tool, summary, runId, Guid.NewGuid().ToString("N"), onCreated, ct))
                    throw new ApiException(403, "用户拒绝文件发送，文件未发送");
            }
            Guard();
            await hub.Acquire(device.Id, leaseReason, ct);
            acquired = true;
            Guard();
            var importKey = device.Id + "|" + path;
            imported.TryGetValue(importKey, out var transfer);
            if (transfer != null)
            {
                // Reusing a transfer ID lets Android recognize a receipt when
                // the previous acknowledgement was lost. Check the actual
                // source bytes so a changed file is never mistaken for a retry.
                var hash = Convert.ToHexString(await SHA256.HashDataAsync(input, ct)).ToLowerInvariant();
                input.Position = 0;
                Guard();
                lock (store.Gate)
                    if (transfer.Size != input.Length || transfer.Sha256 != hash || !store.State.Transfers.Contains(transfer)
                        || !File.Exists(files.PathFor(transfer.Id))) transfer = null;
            }
            if (transfer == null)
            {
                transfer = await files.Upload(input, Path.GetFileName(path), input.Length, device.Id, false, null, ct, room.Id, guard: Guard);
                imported[importKey] = transfer;
            }
            var receipt = Json.Element(await files.Deliver(transfer.Id, device.Id, true, ct, leaseReason: leaseReason, guard: Guard));
            Guard();
            var savedTo = receipt.TryGetProperty("savedTo", out var saved) && saved.ValueKind == JsonValueKind.String ? saved.GetString() : null;
            var alreadyReceived = receipt.TryGetProperty("alreadyReceived", out var previous) && previous.ValueKind == JsonValueKind.True;
            store.Audit("agent", "PC Agent 房间文件发送已校验：" + transfer.Id, device.Id);
            return new { ok = true, verified = true, fileId = transfer.Id, deviceId = device.Id, name = transfer.Name,
                size = transfer.Size, sha256 = transfer.Sha256, savedTo, alreadyReceived };
        }
        finally
        {
            if (acquired) await hub.Release(device.Id, leaseReason);
            sending.Release();
        }
    }

    private Device ResolveDevice(string id, CancellationToken ct)
    {
        RequireRun(ct);
        Device device;
        lock (store.Gate)
        {
            if (id.Length > 0)
                device = store.State.Devices.FirstOrDefault(d => d.Id == id && d.RoomId == roomId && !d.Revoked)
                    ?? throw new ApiException(403, "目标手机不在当前房间，请使用 list_room_devices 查询");
            else
            {
                var phones = store.State.Devices.Where(d => d.RoomId == roomId && !d.Revoked && hub.Online(d.Id)).ToArray();
                if (phones.Length == 0) throw new ApiException(409, "当前房间没有在线手机，请先连接手机");
                if (phones.Length > 1) throw new ApiException(409, "当前房间有多台在线手机，请先使用 list_room_devices 并指定 deviceId");
                device = phones[0];
            }
        }
        hub.Require(device, "files", true);
        return device;
    }

    private static FileStream OpenFile(string path)
    {
        try
        {
            if (Directory.Exists(path)) throw new ApiException(400, "请选择文件，不能发送整个文件夹");
            return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { throw new ApiException(404, "电脑文件不存在，请检查文件路径"); }
        catch (UnauthorizedAccessException) { throw new ApiException(403, "Windows 不允许读取此文件"); }
        catch (IOException) { throw new ApiException(409, "电脑文件正在被占用或暂时不可读，请稍后重试"); }
    }

    private static string Text(JsonElement source, string key, int maximum)
    {
        if (!source.TryGetProperty(key, out var value)) return "";
        if (value.ValueKind != JsonValueKind.String || value.GetString()!.Length > maximum) throw new ApiException(400, key + " 参数无效");
        return value.GetString()!;
    }

    private static async Task<string?> ReadLine(StreamReader reader, int maximum, CancellationToken ct)
    {
        var text = new StringBuilder();
        var character = new char[1];
        while (await reader.ReadAsync(character.AsMemory(), ct) > 0)
        {
            if (character[0] == '\n') return text.ToString();
            if (text.Length >= maximum) throw new ApiException(413, "房间文件工具参数过大");
            text.Append(character[0]);
        }
        return null;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        if (listener is not null) await listener;
        await Task.WhenAll(handlers.Values);
        sending.Dispose();
        lifetime.Dispose();
    }
}
