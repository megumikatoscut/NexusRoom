using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace NexusRoom.Host.Core;

public sealed class StateStore
{
    public readonly object Gate = new();
    public string DirectoryPath { get; }
    public string FileDirectory { get; }
    public SavedState State { get; private set; }
    public List<AuditEntry> Logs { get; } = [];
    public string BootstrapToken { get; } = Token();
    public X509Certificate2 Certificate { get; }
    public string Fingerprint => Certificate.GetCertHashString(HashAlgorithmName.SHA256).ToLowerInvariant();
    public int UiPort { get; } = int.TryParse(Environment.GetEnvironmentVariable("NEXUS_UI_PORT"), out var p) ? p : 17890;
    public int DevicePort { get; } = int.TryParse(Environment.GetEnvironmentVariable("NEXUS_DEVICE_PORT"), out var p) ? p : 17891;
    public int DiscoveryPort { get; } = int.TryParse(Environment.GetEnvironmentVariable("NEXUS_DISCOVERY_PORT"), out var p) ? p : 17892;
    public string UiOrigin => $"http://127.0.0.1:{UiPort}";
    public string LaunchUrl => $"{UiOrigin}/#bootstrap={BootstrapToken}";

    public StateStore()
    {
        DirectoryPath = Environment.GetEnvironmentVariable("NEXUS_DATA_DIR") ?? Path.Combine(AppContext.BaseDirectory, ".local", "user-state-" + ReleaseInfo.DataNamespace);
        Directory.CreateDirectory(DirectoryPath);
        FileDirectory = Path.Combine(DirectoryPath, "files");
        Directory.CreateDirectory(FileDirectory);
        State = ReadProtected<SavedState>("state.dat") ?? new();
        if (State.SchemaVersion < 2) {
            if (State.Room.Id.Length == 0) State.Room = NewRoom("我的 NexusRoom");
            State.Rooms = [State.Room]; State.SchemaVersion = 2;
            foreach (var d in State.Devices) d.RoomId = State.Room.Id;
            foreach (var t in State.Transfers) t.RoomId = State.Room.Id;
        }
        if(State.Agent.ApiKey.Length>0&&State.Rooms.Count>0){State.Rooms[0].Agent??=State.Agent;State.Agent=new();}
        foreach (var room in State.Rooms)
        {
            room.PcRemotePermissions ??= new();
            room.AgentProfiles ??= [];
            if (room.AgentProfiles.Count == 0)
            {
                var legacy = room.Agent;
                room.AgentProfiles.Add(legacy == null ? new AgentProfile() : new AgentProfile { Name = "默认方案", ApiUrl = legacy.ApiUrl, ApiKey = legacy.ApiKey, Model = legacy.Model });
            }
            if (room.AgentProfiles.Count > 0 && !room.AgentProfiles.Any(p => p.Id == room.DefaultAgentProfileId))
                room.DefaultAgentProfileId = room.AgentProfiles[0].Id;
        }
        foreach (var d in State.Devices) { d.Permissions = new(); d.Activity = "offline"; d.OwnerRoom = ""; d.LastSeen = DateTimeOffset.MinValue; }
        foreach (var t in State.Transfers.Where(t => t.Status == "sending")) { t.Status = "failed"; t.Error = "服务重启，请重试"; }
        var certBytes = ReadProtected<byte[]>("certificate.dat");
        if (certBytes == null)
        {
            using var rsa = RSA.Create(3072);
            var request = new CertificateRequest("CN=NexusRoom Local Server", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
            request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
            var usage = new OidCollection { new("1.3.6.1.5.5.7.3.1") };
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(usage, false));
            using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(3));
            certBytes = cert.Export(X509ContentType.Pfx);
            WriteProtected("certificate.dat", certBytes);
        }
        Certificate = X509CertificateLoader.LoadPkcs12(certBytes, null, X509KeyStorageFlags.Exportable);
        var audit = Path.Combine(DirectoryPath, "audit.jsonl");
        if (File.Exists(audit)) foreach (var line in File.ReadLines(audit).TakeLast(500))
        { try { if (JsonSerializer.Deserialize<AuditEntry>(line, Json.Options) is { } entry) Logs.Add(entry); } catch (JsonException) { } }
        foreach (var tmp in Directory.EnumerateFiles(FileDirectory, "*.part")) File.Delete(tmp);
        Save();
    }
    public static string Token() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    public static bool Equal(string a, string b) => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
    public static string PasswordHash(string password, string salt) => Convert.ToHexString(Rfc2898DeriveBytes.Pbkdf2(password, Convert.FromHexString(salt), 150_000, HashAlgorithmName.SHA256, 32));
    public Room GetRoom(string? id = null) { lock (Gate) return (string.IsNullOrEmpty(id) ? State.Rooms.FirstOrDefault() : State.Rooms.FirstOrDefault(r => r.Id == id)) ?? throw new ApiException(404, "房间已解散，请选择或创建房间"); }
    public AgentSettings AgentFor(string roomId) {lock(Gate)return GetRoom(roomId).Agent ??= new();}
    public AgentProfile ProfileFor(string roomId, string? profileId)
    {
        lock (Gate)
        {
            var room = GetRoom(roomId);
            var id = string.IsNullOrWhiteSpace(profileId) ? room.DefaultAgentProfileId : profileId;
            return room.AgentProfiles.FirstOrDefault(p => p.Id == id) ?? throw new ApiException(409, "请选择此房间的模型方案");
        }
    }
    public bool CheckPassword(string password, Room? room = null) { lock (Gate) { room ??= GetRoom(); return Equal(PasswordHash(password, room.Salt), room.PasswordHash); } }
    private static Room NewRoom(string name)
    {
        var salt = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)); var password = Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant();
        var profile = new AgentProfile();
        return new Room { Id = RandomNumberGenerator.GetInt32(100_000, 1_000_000).ToString(), Name = name, Password = password, Salt = salt, PasswordHash = PasswordHash(password, salt), AgentProfiles = [profile], DefaultAgentProfileId = profile.Id };
    }
    public Room CreateRoom(string name) {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > 60) throw new ApiException(400, "房间名称应为 1 到 60 字");
        lock (Gate) { if (State.Rooms.Count >= 32) throw new ApiException(409, "最多创建 32 个房间"); var room = NewRoom(name.Trim()); while (State.Rooms.Any(r => r.Id == room.Id)) room = NewRoom(name.Trim()); State.Rooms.Add(room); Save(); return room; }
    }
    public void RotateRoom(string name, string? id = null)
    {
        lock (Gate)
        {
            var room = GetRoom(id); var next = NewRoom(name);
            room.Salt = next.Salt; room.Password = next.Password; room.PasswordHash = next.PasswordHash;
            Save();
        }
    }
    public Device GetDevice(string id) { lock (Gate) return State.Devices.FirstOrDefault(d => d.Id == id) ?? throw new ApiException(404, "设备不存在"); }
    public Device AuthenticateDevice(string? token)
    {
        if (string.IsNullOrEmpty(token)) throw new ApiException(401, "需要设备凭据");
        var hash = Hash(token);
        lock (Gate) return State.Devices.FirstOrDefault(d => !d.Revoked && Equal(d.TokenHash, hash) && State.Rooms.Any(r => r.Id == d.RoomId)) ?? throw new ApiException(401, "已离开或被移出房间，请重新加入");
    }
    public void Save() { lock (Gate) WriteProtected("state.dat", State); }
    public void Audit(string category, string action, string device = "", string result = "success")
    {
        lock (Gate)
        {
            var entry = new AuditEntry(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow, category, action, device, result);
            Logs.Add(entry);
            if (Logs.Count > 500) Logs.RemoveAt(0);
            var path = Path.Combine(DirectoryPath, "audit.jsonl");
            if (File.Exists(path) && new FileInfo(path).Length > 10 * 1024 * 1024) File.Move(path, path + ".previous", true);
            File.AppendAllText(path, JsonSerializer.Serialize(entry, Json.Options) + "\n");
        }
    }
    private T? ReadProtected<T>(string name)
    {
        var path = Path.Combine(DirectoryPath, name);
        if (!File.Exists(path)) return default;
        var plain = ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser);
        return JsonSerializer.Deserialize<T>(plain, Json.Options);
    }
    public void WriteProtected<T>(string name, T data)
    {
        var bytes = ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(data, Json.Options), null, DataProtectionScope.CurrentUser);
        var path = Path.Combine(DirectoryPath, name);
        File.WriteAllBytes(path + ".tmp", bytes);
        File.Move(path + ".tmp", path, true);
    }
    public static bool PrivateIp(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        return b.Length == 4 && (b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254));
    }
    public string[] Addresses()
    {
        // A machine can have several private addresses (VPN, WSL, Hyper-V and the
        // actual Wi-Fi adapter).  Keep all usable choices, but put an interface
        // with a default gateway first so invitations prefer the reachable LAN.
        var addresses = new List<(IPAddress Address, bool HasGateway, int TypeRank, int Index)>();
        foreach (var network in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (network.OperationalStatus != OperationalStatus.Up || network.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            IPInterfaceProperties properties;
            try { properties = network.GetIPProperties(); }
            catch (NetworkInformationException) { continue; }

            var hasGateway = properties.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(g.Address));
            var typeRank = network.NetworkInterfaceType switch
            {
                NetworkInterfaceType.Wireless80211 => 0,
                NetworkInterfaceType.Ethernet => 1,
                _ => 2
            };
            var index = int.MaxValue;
            try { index = properties.GetIPv4Properties()?.Index ?? int.MaxValue; }
            catch (NetworkInformationException) { }
            foreach (var unicast in properties.UnicastAddresses)
            {
                var address = unicast.Address;
                if (!AdvertisablePrivateIp(address)) continue;
                addresses.Add((address, hasGateway, typeRank, index));
            }
        }
        return addresses
            .DistinctBy(x => x.Address)
            .OrderBy(x => x.HasGateway ? 0 : 1)
            .ThenBy(x => x.TypeRank)
            .ThenBy(x => x.Index)
            .ThenBy(x => x.Address.ToString(), StringComparer.Ordinal)
            .Select(x => $"https://{x.Address}:{DevicePort}")
            .ToArray();
    }

    private static bool AdvertisablePrivateIp(IPAddress ip)
    {
        if (ip.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(ip) || !PrivateIp(ip)) return false;
        var bytes = ip.GetAddressBytes();
        // Link-local addresses do not provide a stable route between the phone
        // and the host and should never be put in an invitation QR code.
        return !(bytes[0] == 169 && bytes[1] == 254);
    }
}
