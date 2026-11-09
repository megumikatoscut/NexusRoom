using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Devices;

public sealed class DiscoveryService(StateStore store, ILogger<DiscoveryService> logger) : BackgroundService
{
    private int networkRevision;
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        NetworkAddressChangedEventHandler changed = (_, _) => Interlocked.Increment(ref networkRevision);
        NetworkChange.NetworkAddressChanged += changed;
        try { await Task.WhenAll(Broadcast(ct), Environment.GetEnvironmentVariable("NEXUS_DISABLE_MDNS")=="1"?Task.CompletedTask:Multicast(ct)); }
        finally { NetworkChange.NetworkAddressChanged -= changed; }
    }
    private async Task Broadcast(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var udp = new UdpClient(new IPEndPoint(IPAddress.Any, store.DiscoveryPort));
                var last = new Dictionary<string, DateTimeOffset>();
                while (!ct.IsCancellationRequested)
                {
                    var p = await udp.ReceiveAsync(ct);
                    if (p.Buffer.Length != 21 || Encoding.UTF8.GetString(p.Buffer) != "NEXUSROOM_DISCOVER_V1" || !StateStore.PrivateIp(p.RemoteEndPoint.Address)) continue;
                    var ip = p.RemoteEndPoint.Address.ToString();
                    if (last.TryGetValue(ip, out var at) && at > DateTimeOffset.UtcNow.AddMilliseconds(-350)) continue;
                    if (last.Count > 2048) last.Clear(); last[ip] = DateTimeOffset.UtcNow;
                    byte[][] responses;
                    // Closing admission must not prevent existing, authenticated
                    // members from rediscovering the same host after an IP change.
                    lock (store.Gate) responses = store.State.Rooms.Select(r => JsonSerializer.SerializeToUtf8Bytes(new { type = "nexusroom", version = 2, roomId = r.Id, name = r.Name, open = r.Open, host = Environment.MachineName, port = store.DevicePort, fingerprint = store.Fingerprint }, Json.Options)).ToArray();
                    foreach (var data in responses) await udp.SendAsync(data, p.RemoteEndPoint, ct);
                }
            }
            catch (OperationCanceledException) { return; }
            catch (SocketException e) { logger.LogWarning("UDP discovery: {Code}", e.SocketErrorCode); }
            try { await Task.Delay(10000, ct); } catch (OperationCanceledException) { return; }
        }
    }
    // DNS-SD advertises only the public host identity. Room metadata is fetched over pinned TLS.
    private async Task Multicast(CancellationToken ct)
    {
        var group = IPAddress.Parse("224.0.0.251");
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var udp = new UdpClient(AddressFamily.InterNetwork);
                udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                udp.Client.Bind(new IPEndPoint(IPAddress.Any, 5353));
                var revision = Volatile.Read(ref networkRevision);
                var addresses = CurrentAddresses(store);
                foreach (var ip in addresses) try { udp.JoinMulticastGroup(group, ip); } catch (SocketException) { }
                // Announce on every interface generation, including newly joined Wi-Fi.
                await Announce(udp, group, addresses, DnsPacket(store, addresses), ct);
                var last = DateTimeOffset.MinValue;
                while (!ct.IsCancellationRequested)
                {
                    // A receive can wait forever when the former network disappears.
                    // Bound the wait so multicast memberships and A records are rebuilt.
                    using var refresh = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    refresh.CancelAfter(TimeSpan.FromSeconds(2));
                    UdpReceiveResult p;
                    try { p = await udp.ReceiveAsync(refresh.Token); }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    {
                        if (revision != Volatile.Read(ref networkRevision) || !addresses.SequenceEqual(CurrentAddresses(store))) break;
                        continue;
                    }
                    var currentAddresses = CurrentAddresses(store);
                    if (revision != Volatile.Read(ref networkRevision) || !addresses.SequenceEqual(currentAddresses)) break;
                    if (p.Buffer.Length < 12 || p.Buffer.Length > 9000 || (p.Buffer[2] & 0x80) != 0 || !StateStore.PrivateIp(p.RemoteEndPoint.Address)) continue;
                    var query = Encoding.ASCII.GetString(p.Buffer);
                    if (!query.Contains("_nexusroom", StringComparison.Ordinal) && !query.Contains("nexus-" + store.Fingerprint[..12], StringComparison.Ordinal)) continue;
                    if (last > DateTimeOffset.UtcNow.AddMilliseconds(-150)) continue; last = DateTimeOffset.UtcNow;
                    var response = DnsPacket(store, addresses);
                    await udp.SendAsync(response, p.RemoteEndPoint, ct);
                    await Announce(udp, group, addresses, response, ct);
                }
                // Interface/address changes rebuild immediately; socket errors back off below.
                continue;
            }
            catch (OperationCanceledException) { return; }
            catch (SocketException e) { logger.LogWarning("mDNS discovery: {Code}", e.SocketErrorCode); }
            try { await Task.Delay(10000, ct); } catch (OperationCanceledException) { return; }
        }
    }
    private static IPAddress[] CurrentAddresses(StateStore store) => store.Addresses()
        .Select(a => IPAddress.Parse(new Uri(a).Host)).ToArray();
    private static async Task Announce(UdpClient udp, IPAddress group, IPAddress[] addresses, byte[] response, CancellationToken ct)
    {
        foreach (var ip in addresses)
        {
            try
            {
                udp.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, ip.GetAddressBytes());
                await udp.SendAsync(response, new IPEndPoint(group, 5353), ct);
            }
            catch (SocketException) { }
        }
    }
    private static byte[] DnsPacket(StateStore store, IPAddress[] ips)
    {
        const string service = "_nexusroom._tcp.local";
        var label = "nexus-" + store.Fingerprint[..12]; var instance = label + "." + service; var host = label + ".local";
        using var output = new MemoryStream();
        void U16(Stream s, int n) { s.WriteByte((byte)(n >> 8)); s.WriteByte((byte)n); }
        void Name(Stream s, string n) { foreach (var part in n.Split('.')) { var b = Encoding.UTF8.GetBytes(part); s.WriteByte((byte)b.Length); s.Write(b); } s.WriteByte(0); }
        void Record(string name, int type, bool unique, Action<Stream> content) { Name(output, name); U16(output, type); U16(output, unique ? 0x8001 : 1); output.Write([0, 0, 0, 30]); using var data = new MemoryStream(); content(data); U16(output, (int)data.Length); data.Position = 0; data.CopyTo(output); }
        U16(output, 0); U16(output, 0x8400); U16(output, 0); U16(output, 3 + ips.Length); U16(output, 0); U16(output, 0);
        Record(service, 12, false, s => Name(s, instance));
        Record(instance, 33, true, s => { U16(s, 0); U16(s, 0); U16(s, store.DevicePort); Name(s, host); });
        Record(instance, 16, true, s => { foreach (var item in new[] { "version=2", "fingerprint=" + store.Fingerprint }) { var b = Encoding.ASCII.GetBytes(item); s.WriteByte((byte)b.Length); s.Write(b); } });
        foreach (var ip in ips) Record(host, 1, true, s => s.Write(ip.GetAddressBytes()));
        return output.ToArray();
    }
}
