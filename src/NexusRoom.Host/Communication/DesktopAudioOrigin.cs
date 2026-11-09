using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace NexusRoom.Host.Communication;

// Excluding the Host tree is safe only when the requesting renderer belongs to
// that tree. An independently opened browser would otherwise feed meeting audio
// back into the shared system sound. Identify the actual loopback TCP client;
// headers and User-Agent cannot establish process ownership.
internal static class DesktopAudioOrigin
{
    public static bool IsOwned(HttpContext context)
    {
        IntPtr table = IntPtr.Zero, snapshot = new(-1);
        try
        {
            var remote = context.Connection.RemoteIpAddress;
            var local = context.Connection.LocalIpAddress;
            if (remote == null || local == null) return false;
            if (remote.IsIPv4MappedToIPv6) remote = remote.MapToIPv4();
            if (local.IsIPv4MappedToIPv6) local = local.MapToIPv4();
            var remoteAddress = remote.GetAddressBytes();
            var localAddress = local.GetAddressBytes();
            if (remoteAddress.Length != 4 || localAddress.Length != 4
                || remoteAddress[0] != 127 || localAddress[0] != 127) return false;
            uint size = 0;
            if (GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0) != 122 || size < 4 || size > 16 * 1024 * 1024) return false;
            table = Marshal.AllocHGlobal(checked((int)size));
            if (GetExtendedTcpTable(table, ref size, false, 2, 5, 0) != 0) return false;
            var bytes = new byte[size]; Marshal.Copy(table, bytes, 0, bytes.Length);
            var count = BinaryPrimitives.ReadUInt32LittleEndian(bytes);
            uint client = 0;
            for (var row = 0; row < count; row++)
            {
                var at = 4 + checked((int)row * 24);
                if (at + 24 > bytes.Length) return false;
                // Match the established client's complete reverse tuple. A
                // source port can be reused for a different destination IP.
                if (BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at, 4)) == 5
                    && bytes.AsSpan(at + 4, 4).SequenceEqual(remoteAddress)
                    && bytes.AsSpan(at + 12, 4).SequenceEqual(localAddress)
                    && BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(at + 8, 2)) == context.Connection.RemotePort
                    && BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(at + 16, 2)) == context.Connection.LocalPort)
                { client = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at + 20, 4)); break; }
            }
            if (client == 0) return false;
            snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) return false;
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
            var parents = new Dictionary<uint, uint>();
            if (!Process32First(snapshot, ref entry)) return false;
            do { parents[entry.Id] = entry.Parent; } while (Process32Next(snapshot, ref entry));
            var seen = new HashSet<uint>();
            while (client != 0 && seen.Add(client))
            {
                if (client == (uint)Environment.ProcessId) return true;
                if (!parents.TryGetValue(client, out client)) break;
            }
            return false;
        }
        catch (Exception error) when (error is OverflowException or ArgumentException or ExternalException) { return false; }
        finally
        {
            if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
            if (snapshot != new IntPtr(-1)) CloseHandle(snapshot);
        }
    }
    [DllImport("iphlpapi.dll")] private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, [MarshalAs(UnmanagedType.Bool)] bool order, uint family, uint tableClass, uint reserved);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, Id;
        public IntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Executable;
    }
}
