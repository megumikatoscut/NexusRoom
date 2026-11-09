using NexusRoom.Host.Core;
using NexusRoom.Host.Desktop;

namespace NexusRoom.Host.Devices;

public sealed class ClipboardBridge(StateStore store, DeviceHub hub) : IHostedService
{
    private Thread? thread;
    private volatile bool running;
    private sealed record Update(string Text, bool Forward, string? DeviceId = null, TaskCompletionSource? Applied = null, int Attempts = 0);
    // Clipboard state only needs the newest pending value. Do not accumulate stale copies.
    private Update? incoming;
    private string last = "";
    public Task StartAsync(CancellationToken cancellation)
    {
        running = true;
        hub.ClipboardReceived += Receive;
        thread = new Thread(Loop) { IsBackground = true, Name = "NexusRoom Clipboard" };
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); return Task.CompletedTask;
    }
    private void Receive(Device device, string value) => Queue(new Update(value, false, device.Id));
    public async Task ReceiveFromDevice(Device device,string value,CancellationToken cancellation)
    {
        if(value.Length>65536)throw new ApiException(400,"剪贴板文本过长");
        cancellation.ThrowIfCancellationRequested();
        var applied=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration=cancellation.Register(()=>applied.TrySetCanceled(cancellation));
        Queue(new Update(value,false,device.Id,applied));
        await applied.Task;
    }
    private void Queue(Update update)
    {
        var replaced=Interlocked.Exchange(ref incoming,update);
        replaced?.Applied?.TrySetException(new ApiException(409,"剪贴板内容已被另一项同步替换，请重试"));
    }
    private void Loop()
    {
        try { last = PcTextClipboard.ReadText() ?? ""; } catch (ApiException) { }
        while (running)
        {
            try
            {
                var update = Interlocked.Exchange(ref incoming, null);
                if (update is not null)
                {
                    if (update.Applied?.Task.IsCompleted == true) { Thread.Sleep(50); continue; }
                    bool allowed;
                    lock (store.Gate) allowed = update.DeviceId is null || store.State.Devices.Any(d => d.Id == update.DeviceId && d.Permissions.Clipboard && d.Activity != "busy" && hub.Online(d.Id));
                    if (allowed)
                    {
                        try { PcTextClipboard.Write(update.Text); }
                        catch (ApiException error)
                        {
                            // Retry after another application releases the clipboard, unless a newer copy arrived.
                            if (error.Status == 409 && update.Attempts < 2)
                            {
                                var replaced = Interlocked.CompareExchange(ref incoming, update with { Attempts = update.Attempts + 1 }, null);
                                if (replaced is not null) update.Applied?.TrySetException(new ApiException(409, "剪贴板内容已被另一项同步替换，请重试"));
                            }
                            else update.Applied?.TrySetException(error);
                            throw;
                        }
                        last = update.Text;
                        if (update.Forward) Broadcast(update.Text);
                        else store.Audit("clipboard", "Android 文本同步到 Windows", update.DeviceId ?? "");
                        update.Applied?.TrySetResult();
                    }
                    else update.Applied?.TrySetException(new ApiException(403,"设备已离线或剪贴板权限已关闭，未写入 Windows 剪贴板"));
                }
                // Copying an image or file must not erase text on an authorized phone.
                var current = PcTextClipboard.ReadText();
                if (current is not null)
                {
                    if (current != last)
                    {
                        last = current;
                        if (current.Length <= 65536) Broadcast(current);
                    }
                }
            }
            catch (ApiException) { }
            Thread.Sleep(750);
        }
    }
    private void Broadcast(string value)
    {
        Device[] devices;
        lock (store.Gate)
        {
            // Global Windows clipboard contents belong only to the room that
            // currently owns an Android control lease. Idle rooms get no copy.
            var workingRooms = store.State.Devices.Where(d => hub.Online(d.Id) && d.Activity == "working" && hub.HasAnyLease(d.Id)).Select(d => d.RoomId).Distinct().ToArray();
            devices = workingRooms.Length != 1 ? [] : store.State.Devices.Where(d => d.RoomId == workingRooms[0] && d.Permissions.Clipboard && d.Activity != "busy" && hub.Online(d.Id)).ToArray();
        }
        foreach (var device in devices) _ = Sync(device, value);
    }
    private async Task Sync(Device d, string value)
    {
        var reason = "clipboard:" + Guid.NewGuid().ToString("N");
        var acquired = false;
        try
        {
            hub.Require(d, "clipboard");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await hub.Acquire(d.Id, reason, timeout.Token);
            acquired = true;
            hub.Require(d, "clipboard");
            await hub.Call(d.Id, "clipboard_set", Json.Element(new { text = value }), timeout.Token);
            store.Audit("clipboard", "Windows 文本同步到 Android", d.Id);
        }
        catch (Exception e) when (e is ApiException or OperationCanceledException or System.Net.WebSockets.WebSocketException) { }
        finally { if (acquired) await hub.Release(d.Id, reason); }
    }
    public void Set(string value) { if (value.Length > 65536) throw new ApiException(400, "剪贴板文本过长"); Queue(new Update(value, true)); }
    public Task StopAsync(CancellationToken cancellation) { hub.ClipboardReceived -= Receive; running = false; thread?.Join(2000); return Task.CompletedTask; }
}
