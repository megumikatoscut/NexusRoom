using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading.Channels;
namespace NexusRoom.Host.Devices;

// Version 2: 12-byte big-endian header; video format/config/keyframe flags 0x80/0x40/0x20.
// Audio 0x10 carries mono PCM16, sample rate at byte 4, channels at byte 8. JPEG is separate.
public sealed class MediaRelay
{
    private readonly object gate = new();
    private byte[]? format, config;
    private long videoPackets, keyframes;
    private DateTimeOffset? lastVideoAt;
    private readonly ConcurrentDictionary<Guid, Channel<byte[]>> viewers = new();
    public object Status() { lock(gate)return new {videoPackets,keyframes,lastVideoAt,viewers=viewers.Count}; }
    public void Push(byte[] packet)
    {
        if (packet.Length < 12) return;
        lock (gate) {
            if ((packet[0] & 0x80) != 0) { format = packet; config = null; }
            else if ((packet[0] & 0x40) != 0) config = packet;
            else if (packet[0]!=0x10) { videoPackets++;if((packet[0]&0x20)!=0)keyframes++;lastVideoAt=DateTimeOffset.UtcNow; }
            foreach (var (id, channel) in viewers) if (!channel.Writer.TryWrite(packet)) { channel.Writer.TryComplete(); viewers.TryRemove(id, out _); }
        }
    }
    public void Clear() { lock(gate) { format = config = null; foreach(var v in viewers.Values) v.Writer.TryComplete(); viewers.Clear(); } }
    public async Task Watch(WebSocket socket, Func<Task> keyframe, CancellationToken ct)
    {
        var id = Guid.NewGuid(); var queue = Channel.CreateBounded<byte[]>(90);
        lock (gate) { if(viewers.Count>=4) throw new Core.ApiException(409,"同一设备最多打开四个画面"); if(format!=null) queue.Writer.TryWrite(format); if(config!=null) queue.Writer.TryWrite(config); viewers[id]=queue; }
        using var stop=CancellationTokenSource.CreateLinkedTokenSource(ct);
        var receive=Task.Run(async()=>{try{await socket.ReceiveAsync(new byte[64],stop.Token);}catch(Exception e) when(e is WebSocketException or OperationCanceledException){}finally{stop.Cancel();}});
        try { await keyframe(); await foreach(var packet in queue.Reader.ReadAllAsync(stop.Token)) await socket.SendAsync(packet,WebSocketMessageType.Binary,true,stop.Token); }
        catch(Exception e) when(e is WebSocketException or OperationCanceledException){}
        finally {viewers.TryRemove(id,out _);stop.Cancel();socket.Abort();await receive;}
    }
}
