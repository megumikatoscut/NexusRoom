using System.Security.Cryptography;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;

namespace NexusRoom.Host.Files;

public sealed class FileService(StateStore store, DeviceHub hub)
{
    public const long MaxFileSize = 512L * 1024 * 1024;
    private const long MaxStorage = 10L * 1024 * 1024 * 1024;
    private readonly SemaphoreSlim uploadGate = new(1, 1);
    private readonly SemaphoreSlim deliveryGate = new(1, 1);
    public string PathFor(string id) => Path.Combine(store.FileDirectory, id + ".blob");
    private static string SafeName(string? name) => Path.GetFileName((name ?? "").Replace('\\', '/'));
    private static bool ValidName(string name) => name.Length is >= 1 and <= 180 && !name.Any(char.IsControl);
    public Transfer Get(string id) { lock (store.Gate) return store.State.Transfers.FirstOrDefault(t => t.Id == id) ?? throw new ApiException(404, "文件不存在"); }
    public object[] ListPendingForDevice(string deviceId, string? query = null)
    {
        var device = store.GetDevice(deviceId);
        query = query?.Trim();
        if (query?.Length > 100) throw new ApiException(400, "文件名关键词过长");
        lock (store.Gate) return store.State.Transfers
            .Where(t => t.RoomId == device.RoomId && t.Direction == "toAndroid"
                && (t.DeviceId.Length == 0 || t.DeviceId == deviceId)
                && t.Status is ("ready" or "failed") && File.Exists(PathFor(t.Id))
                && ValidName(SafeName(t.Name))
                && (string.IsNullOrEmpty(query) || SafeName(t.Name).Contains(query, StringComparison.OrdinalIgnoreCase)))
            .OrderByDescending(t => t.CreatedAt)
            .Take(200)
            .Select(t => (object)new { fileId = t.Id, name = SafeName(t.Name), t.Size, t.Status })
            .ToArray();
    }
    public async Task<Transfer> Upload(Stream body, string name, long? contentLength, string deviceId, bool fromAndroid, string? expectedHash, CancellationToken ct,string? roomId=null,string? taskId=null, Action? guard = null)
    {
        if (taskId != null && (!fromAndroid || taskId.Length == 0)) throw new ApiException(400, "Agent 任务标识无效");
        name = SafeName(name);
        if (string.IsNullOrWhiteSpace(name) || !ValidName(name)) throw new ApiException(400, "文件名不合法");
        if (contentLength > MaxFileSize) throw new ApiException(413, "单个文件最大 512 MB");
        var uploadRoom = store.GetRoom(deviceId.Length > 0 ? store.GetDevice(deviceId).RoomId : roomId).Id;
        void RequireUploadPermission()
        {
            ct.ThrowIfCancellationRequested();
            guard?.Invoke();
            store.GetRoom(uploadRoom);
            if (fromAndroid) hub.Require(store.GetDevice(deviceId), "files", taskId != null);
            if (taskId != null && !hub.HasLease(deviceId, "agent:" + taskId)) throw new ApiException(409, "Agent 任务控制权已失效");
        }
        RequireUploadPermission();
        var transfer = new Transfer { Name = name, DeviceId = deviceId, RoomId = uploadRoom, Direction = fromAndroid ? "toWindows" : "toAndroid" };
        var temporary = Path.Combine(store.FileDirectory, transfer.Id + ".part");
        await uploadGate.WaitAsync(ct);
        try
        {
            long used;
            lock (store.Gate) used = Directory.EnumerateFiles(store.FileDirectory).Sum(p => new FileInfo(p).Length);
            if (used + (contentLength ?? MaxFileSize) > MaxStorage) throw new ApiException(413, "文件库已达到 10 GB，请删除不再需要的文件");
            using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous))
            {
                var buffer = new byte[65536]; int count;
                while ((count = await body.ReadAsync(buffer, ct)) > 0)
                {
                    transfer.Size += count;
                    if (transfer.Size > MaxFileSize || used + transfer.Size > MaxStorage) throw new ApiException(413, "文件超出容量限制");
                    RequireUploadPermission();
                    hasher.AppendData(buffer, 0, count);
                    await file.WriteAsync(buffer.AsMemory(0, count), ct);
                }
                await file.FlushAsync(ct);
            }
            if (contentLength.HasValue && contentLength.Value != transfer.Size) throw new ApiException(400, "文件上传不完整");
            transfer.Sha256 = Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant();
            if (!string.IsNullOrEmpty(expectedHash) && !StateStore.Equal(expectedHash.ToLowerInvariant(), transfer.Sha256)) throw new ApiException(422, "文件校验失败");
            lock (store.Gate)
            {
                RequireUploadPermission();
                File.Move(temporary, PathFor(transfer.Id));
                transfer.Status = fromAndroid ? "completed" : "ready";
                store.State.Transfers.Add(transfer);
                store.Save();
            }
            store.Audit("file", fromAndroid ? "接收 Android 文件" : "导入 Windows 文件", deviceId);
            return transfer;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); uploadGate.Release(); }
    }
    public async Task<object> Deliver(string fileId, string deviceId, bool agent, CancellationToken ct, bool onlyPending = false, string? taskId = null, string? leaseReason = null, Action? guard = null)
    {
        if (taskId != null && (!agent || taskId.Length == 0)) throw new ApiException(400, "Agent 任务标识无效");
        if (!Guid.TryParseExact(fileId, "N", out _)) throw new ApiException(400, "文件标识无效");
        var d = store.GetDevice(deviceId); hub.Require(d, "files", agent);
        void RequireDeliveryPermission()
        {
            ct.ThrowIfCancellationRequested();
            guard?.Invoke();
            hub.Require(d, "files", agent);
            var reason = taskId == null ? leaseReason : "agent:" + taskId;
            if (reason != null && !hub.HasLease(deviceId, reason)) throw new ApiException(409, "Agent 任务控制权已失效");
        }
        RequireDeliveryPermission();
        var t = Get(fileId);
        if (t.RoomId!=d.RoomId || t.Direction != "toAndroid" || (t.DeviceId.Length != 0 && t.DeviceId != deviceId)) throw new ApiException(403, "文件不属于此房间或设备的发送队列");
        await deliveryGate.WaitAsync(ct);
        var sendingStarted = false;
        string deliveryName;
        try
        {
            RequireDeliveryPermission();
            lock (store.Gate)
            {
                if (!store.State.Transfers.Contains(t)) throw new ApiException(404, "文件不存在");
                if (t.RoomId != d.RoomId || t.Direction != "toAndroid" || (t.DeviceId.Length != 0 && t.DeviceId != deviceId))
                    throw new ApiException(403, "文件不属于此房间或设备的发送队列");
                if (onlyPending && t.Status is not ("ready" or "failed")) throw new ApiException(409, "文件已发送或正在传输");
                if (!File.Exists(PathFor(t.Id))) throw new ApiException(404, "文件库副本不存在");
                deliveryName = SafeName(t.Name);
                if (!ValidName(deliveryName)) throw new ApiException(400, "文件名不合法");
                t.DeviceId = deviceId; t.Status = "sending"; t.Error = null; sendingStarted = true; store.Save();
            }
            RequireDeliveryPermission();
            var arguments = taskId == null
                ? Json.Element(new { fileId = t.Id, name = deliveryName, size = t.Size, sha256 = t.Sha256, agent })
                : Json.Element(new { fileId = t.Id, name = deliveryName, size = t.Size, sha256 = t.Sha256, agent, taskId });
            var result = await hub.Call(deviceId, "receive_file", arguments, ct);
            RequireDeliveryPermission();
            if (result.ValueKind != System.Text.Json.JsonValueKind.Object
                || !result.TryGetProperty("sha256", out var checksum)
                || checksum.ValueKind != System.Text.Json.JsonValueKind.String
                || checksum.GetString() != t.Sha256)
                throw new ApiException(422, "Android 未返回正确的文件校验值");
            lock (store.Gate) { t.Status = "completed"; store.Save(); }
            store.Audit("file", "文件发送完成，SHA-256 已校验：" + t.Id, deviceId);
            return result;
        }
        catch (Exception e)
        {
            if (sendingStarted) lock (store.Gate) { if (t.Status == "sending") { t.Status = "failed"; t.Error = e is ApiException ? e.Message : "传输中断，请重试"; store.Save(); } }
            store.Audit("file", "文件发送失败：" + t.Id, deviceId, "error");
            throw;
        }
        finally { deliveryGate.Release(); }
    }
    public void Delete(string id)
    {
        lock (store.Gate)
        {
            var t = Get(id);
            if (t.Status == "sending") throw new ApiException(409, "传输中的文件不能删除");
            File.Delete(PathFor(t.Id)); store.State.Transfers.Remove(t); store.Save();
        }
        store.Audit("file", "移除本地文件副本");
    }
    // Dissolution must release the active library's capacity without silently
    // deleting its copies. Original user files and Android downloads are untouched.
    // Caller holds store.Gate through room removal, closing the upload commit race.
    public string ArchiveRoomFiles(string roomId, Action commit)
    {
        lock (store.Gate)
        {
            store.GetRoom(roomId);
            var transfers = store.State.Transfers.Where(t => t.RoomId == roomId).ToArray();
            if (transfers.Length == 0) { commit(); return ""; }
            var originalTransfers = store.State.Transfers.ToArray();
            var directory = Path.Combine("removed-rooms", roomId + "-" + Guid.NewGuid().ToString("N"));
            var archive = Path.Combine(store.DirectoryPath, directory);
            Directory.CreateDirectory(archive);
            var moved = new List<(string source, string destination)>();
            try
            {
                foreach (var transfer in transfers)
                {
                    if (!Guid.TryParseExact(transfer.Id, "N", out _)) throw new ApiException(409, "文件库记录无效，无法归档");
                    var source = PathFor(transfer.Id);
                    if (!File.Exists(source)) continue;
                    var destination = Path.Combine(archive, transfer.Id + ".blob");
                    File.Move(source, destination); moved.Add((source, destination));
                }
                store.WriteProtected(Path.Combine(directory, "files.dat"), transfers);
                foreach (var transfer in transfers) store.State.Transfers.Remove(transfer);
                commit();
                return directory;
            }
            catch (Exception error)
            {
                store.State.Transfers.Clear();
                store.State.Transfers.AddRange(originalTransfers);
                var rollbackErrors = new List<string>();
                foreach (var (source, destination) in moved.AsEnumerable().Reverse())
                {
                    try { File.Move(destination, source); }
                    catch (Exception rollback) { rollbackErrors.Add(destination + " -> " + source + ": " + rollback.Message); }
                }
                // Keep protected archive metadata for manual recovery, including
                // any copies that could not move back. Preserve the first error.
                error.Data["NexusRoomFileArchive"] = archive;
                if (rollbackErrors.Count > 0)
                {
                    error.Data["NexusRoomFileArchiveRollbackErrors"] = rollbackErrors.ToArray();
                    try { store.Audit("file", "归档回退未完成，可恢复副本目录：" + directory, result: "error"); }
                    catch { /* The original transaction error remains authoritative. */ }
                }
                throw;
            }
        }
    }
}
