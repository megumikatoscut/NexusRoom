// Distribution bootstrap for the complete self-contained application payload.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

internal static class Launcher
{
    const string Magic = "NRSEXE01";
    const string ManifestName = ".nexus-payload.tsv";
    static Action<string, int> progress = delegate { };
    static readonly HashSet<string> checkedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    sealed class Item { public string Path, Hash, Target; public long Bytes; }
    sealed class Stamp
    {
        public long Bytes, Created, Written, Changed, Id;
        public uint Volume;
        public bool Matches(Stamp other)
        {
            return other != null && Changed != 0 && Bytes == other.Bytes && Created == other.Created &&
                Written == other.Written && Changed == other.Changed && Id == other.Id && Volume == other.Volume;
        }
        public void Write(BinaryWriter writer)
        { writer.Write(Bytes); writer.Write(Created); writer.Write(Written); writer.Write(Changed); writer.Write(Id); writer.Write(Volume); }
        public static Stamp Read(BinaryReader reader)
        { return new Stamp { Bytes = reader.ReadInt64(), Created = reader.ReadInt64(), Written = reader.ReadInt64(), Changed = reader.ReadInt64(), Id = reader.ReadInt64(), Volume = reader.ReadUInt32() }; }
    }
    sealed class Receipt { public string SourceName; public Stamp Source; public List<Stamp> Files; }
    [StructLayout(LayoutKind.Sequential)]
    struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation
    {
        public uint Attributes; public FileTime Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IdHigh, IdLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInformation { public long Created, Accessed, Written, Changed; public uint Attributes; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out BasicInformation information, uint size);

    [STAThread]
    static int Main(string[] args)
    {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
        bool quiet = args.Contains("--extract-only") || args.Contains("--verify-package") || args.Contains("--headless");
        foreach (string arg in args)
            if (arg != "--extract-only" && arg != "--verify-package" && arg != "--headless") return Fail("Unknown option: " + arg, quiet);
        if (quiet) { try { return Run(args); } catch (Exception e) { return Fail(e.Message, true); } }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new Form { Text = "NexusRoom", Width = 480, Height = 160,
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location),
            StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false, ControlBox = false })
        {
            var label = new Label { Left = 24, Top = 24, Width = 420, Height = 35, Text = "正在准备 NexusRoom…" };
            var bar = new ProgressBar { Left = 24, Top = 70, Width = 420, Height = 20 };
            form.Controls.Add(label); form.Controls.Add(bar);
            string lastMessage = null; int lastValue = -1;
            progress = (message, value) => {
                if (message == lastMessage && value == lastValue) return;
                lastMessage = message; lastValue = value;
                if (!form.IsDisposed) form.BeginInvoke((Action)(() => { label.Text = message; bar.Value = Math.Max(0, Math.Min(100, value)); }));
            };
            int result = 1;
            form.Shown += delegate {
                Task.Factory.StartNew(() => {
                    try { result = Run(args); }
                    catch (Exception e) { result = Fail(e.Message, false); }
                    finally { form.BeginInvoke((Action)(() => form.Close())); }
                });
            };
            Application.Run(form);
            return result;
        }
    }

    static int Fail(string message, bool quiet)
    {
        if (quiet) Console.Error.WriteLine(message);
        else MessageBox.Show("NexusRoom 无法启动：\n" + message, "NexusRoom", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }

    static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    static string Hash(Stream input) { using (var sha = new SHA256Cng()) return Hex(sha.ComputeHash(input)); }
    static bool LocalNtfs(string path)
    {
        try { var drive = new DriveInfo(Path.GetPathRoot(path)); return drive.DriveType == DriveType.Fixed && drive.DriveFormat == "NTFS"; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
    static Stamp GetStamp(SafeFileHandle file)
    {
        FileInformation info; BasicInformation basic;
        if (!GetFileInformationByHandle(file, out info) ||
            !GetFileInformationByHandleEx(file, 0, out basic, (uint)Marshal.SizeOf(typeof(BasicInformation)))) return null;
        if ((info.Attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
            throw new IOException("运行文件不是普通文件。");
        return new Stamp { Bytes = ((long)info.SizeHigh << 32) | info.SizeLow, Created = basic.Created,
            Written = basic.Written, Changed = basic.Changed, Id = ((long)info.IdHigh << 32) | info.IdLow, Volume = info.Volume };
    }
    static SafeFileHandle OpenMetadata(string path)
    {
        // Attribute-only handles avoid reading/scanning unchanged runtime data.
        // Deny writes/deletion until verification finishes, and never follow a file link.
        var handle = CreateFile(path, 0x80, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new IOException("无法检查运行文件：" + path, new System.ComponentModel.Win32Exception(error)); }
        return handle;
    }
    static Receipt ReadReceipt(string destination, string digest)
    {
        string path = Child(destination, ".nexus-complete");
        try
        {
            if (!File.Exists(path) || new FileInfo(path).Length > 16 * 1024 * 1024) return null;
            byte[] bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), Encoding.UTF8.GetBytes(digest), DataProtectionScope.CurrentUser);
            using (var input = new MemoryStream(bytes))
            using (var reader = new BinaryReader(input, Encoding.UTF8))
            {
                if (reader.ReadString() != "NRCACHE1" || reader.ReadString() != destination) return null;
                var receipt = new Receipt { SourceName = reader.ReadString(), Source = Stamp.Read(reader), Files = new List<Stamp>() };
                int count = reader.ReadInt32();
                if (count < 0 || count > 200000 || input.Length - input.Position != (long)count * 44) return null;
                for (int i = 0; i < count; i++) receipt.Files.Add(Stamp.Read(reader));
                return receipt;
            }
        }
        catch (CryptographicException) { return null; } // Includes the legacy plaintext completion marker.
        catch (IOException) { return null; }
        catch (ArgumentException) { return null; }
    }
    static void WriteReceipt(string directory, string destination, string digest, Receipt receipt)
    {
        byte[] bytes;
        using (var output = new MemoryStream())
        {
            using (var writer = new BinaryWriter(output, Encoding.UTF8, true))
            {
                writer.Write("NRCACHE1"); writer.Write(destination); writer.Write(receipt.SourceName);
                (receipt.Source ?? new Stamp()).Write(writer); writer.Write(receipt.Files.Count);
                foreach (var stamp in receipt.Files) (stamp ?? new Stamp()).Write(writer);
            }
            bytes = ProtectedData.Protect(output.ToArray(), Encoding.UTF8.GetBytes(digest), DataProtectionScope.CurrentUser);
        }
        string path = Child(directory, ".nexus-complete"), pending = Child(directory, ".nexus-complete.tmp");
        try
        {
            File.WriteAllBytes(pending, bytes);
            if (File.Exists(path)) File.Replace(pending, path, null); else File.Move(pending, path);
        }
        finally { if (File.Exists(pending)) File.Delete(pending); }
    }
    static void NoLinks(string path)
    {
        for (string current = Path.GetFullPath(path); !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            if (checkedDirectories.Contains(current)) break;
            FileAttributes attributes;
            try { attributes = File.GetAttributes(current); }
            catch (FileNotFoundException) { continue; }
            catch (DirectoryNotFoundException) { continue; }
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("运行目录包含文件系统链接：" + current);
            if ((attributes & FileAttributes.Directory) != 0) checkedDirectories.Add(current);
        }
    }
    static string Child(string root, string relative, bool checkLinks = true)
    {
        if (String.IsNullOrEmpty(relative) || relative.Contains('\\') || relative.Contains(':') || relative.Contains('\t') || relative.Contains('\n'))
            throw new InvalidDataException("Invalid payload path");
        foreach (string part in relative.Split('/'))
            if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new InvalidDataException("Invalid payload component");
        string path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Payload escaped destination");
        if (checkLinks) NoLinks(path);
        return path;
    }

    static int Run(string[] args)
    {
        if (!Environment.Is64BitOperatingSystem) throw new PlatformNotSupportedException("需要 Windows 10/11 x64。");
        string self = Process.GetCurrentProcess().MainModule.FileName;
        using (var file = File.Open(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (file.Length < 56) throw new InvalidDataException("Incomplete executable");
            file.Position = file.Length - 56;
            var reader = new BinaryReader(file, Encoding.UTF8, true);
            if (Encoding.ASCII.GetString(reader.ReadBytes(8)) != Magic) throw new InvalidDataException("Invalid executable footer");
            long offset = reader.ReadInt64(), length = reader.ReadInt64();
            string digest = Hex(reader.ReadBytes(32));
            if (offset < 1024 || length <= 0 || offset > file.Length - 56 || length != file.Length - 56 - offset)
                throw new InvalidDataException("Invalid executable payload length");
            string cacheRoot = Environment.GetEnvironmentVariable("NEXUS_PACKAGE_CACHE");
            if (String.IsNullOrWhiteSpace(cacheRoot)) cacheRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NexusRoom", "packages");
            cacheRoot = Path.GetFullPath(cacheRoot).TrimEnd(Path.DirectorySeparatorChar);
            // Locate the receipt without reading the archive. The destination's
            // version is checked against the embedded manifest below.
            string versionHint = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            string destination = Path.Combine(cacheRoot, versionHint + "-" + digest.Substring(0, 16));
            NoLinks(destination);
            bool cacheStamps = LocalNtfs(destination);
            var receipt = cacheStamps ? ReadReceipt(destination, digest) : null;
            var sourceStamp = LocalNtfs(self) ? GetStamp(file.SafeFileHandle) : null;
            bool sameSource = receipt != null && receipt.SourceName == self && sourceStamp != null && sourceStamp.Matches(receipt.Source);
            using (var payload = new Slice(file, offset, length))
            {
                progress("正在校验内置运行环境…", 5);
                if ((!sameSource || args.Contains("--verify-package")) && Hash(payload) != digest)
                    throw new InvalidDataException("内置文件校验失败，请重新获取完整 EXE。");
                payload.Position = 0;
                using (var zip = new ZipArchive(payload, ZipArchiveMode.Read, true))
                {
                    var manifest = zip.GetEntry(ManifestName);
                    if (manifest == null || manifest.Length > 32 * 1024 * 1024) throw new InvalidDataException("Missing payload inventory");
                    string version;
                    var items = new List<Item>();
                    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    using (var text = new StreamReader(manifest.Open(), Encoding.UTF8))
                    {
                        version = text.ReadLine();
                        if (version == null || !System.Text.RegularExpressions.Regex.IsMatch(version, @"^\d+\.\d+\.\d+$")) throw new InvalidDataException("Invalid release version");
                        string line;
                        while ((line = text.ReadLine()) != null)
                        {
                            var columns = line.Split('\t'); long bytes;
                            if (columns.Length != 3 || !System.Text.RegularExpressions.Regex.IsMatch(columns[0], "^[a-f0-9]{64}$") ||
                                !Int64.TryParse(columns[1], NumberStyles.None, CultureInfo.InvariantCulture, out bytes) || !names.Add(columns[2]))
                                throw new InvalidDataException("Invalid payload inventory");
                            if (columns[2].Equals(".nexus-complete", StringComparison.OrdinalIgnoreCase) ||
                                columns[2].Equals(".nexus-complete.tmp", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Reserved payload path");
                            items.Add(new Item { Hash = columns[0], Bytes = bytes, Path = columns[2] });
                        }
                    }
                    if (zip.Entries.Count != items.Count + 1 || zip.Entries.Select(e => e.FullName).Distinct(StringComparer.OrdinalIgnoreCase).Count() != zip.Entries.Count)
                        throw new InvalidDataException("Unexpected or duplicate payload entries");
                    if (version != versionHint) throw new InvalidDataException("Payload version differs from launcher");
                    NoLinks(destination);
                    var entries = zip.Entries.ToDictionary(e => e.FullName, StringComparer.OrdinalIgnoreCase);
                    foreach (var item in items)
                    {
                        item.Target = Child(destination, item.Path, false);
                        ZipArchiveEntry entry;
                        if (!entries.TryGetValue(item.Path, out entry) || entry.Length != item.Bytes || (entry.ExternalAttributes & 0x400) != 0 || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000)
                            throw new InvalidDataException("Invalid payload entry: " + item.Path);
                    }
                    if (args.Contains("--verify-package"))
                    {
                        foreach (var item in items) using (var stream = entries[item.Path].Open())
                            if (Hash(stream) != item.Hash) throw new InvalidDataException("Payload digest mismatch: " + item.Path);
                        Console.WriteLine("PASS " + version + ": " + items.Count + " files; payload " + digest);
                        return 0;
                    }
                    Directory.CreateDirectory(cacheRoot);
                    NoLinks(cacheRoot);
                    string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
                    using (var mutex = new Mutex(false, "Local\\NexusRoom-package-" + sid + "-" + digest.Substring(0, 16)))
                    {
                        bool locked;
                        try { locked = mutex.WaitOne(TimeSpan.FromMinutes(10)); } catch (AbandonedMutexException) { locked = true; }
                        if (!locked) throw new IOException("另一个启动正在准备环境，请稍后重试。");
                        try
                        {
                            // Another launcher may have completed extraction while
                            // this process waited for the package mutex.
                            receipt = cacheStamps ? ReadReceipt(destination, digest) : null;
                            var current = new Receipt { SourceName = self, Source = sourceStamp, Files = new List<Stamp>(items.Count) };
                            if (!Directory.Exists(destination))
                            {
                                string stage = Path.Combine(cacheRoot, ".extract-" + Guid.NewGuid().ToString("N"));
                                NoLinks(stage);
                                Directory.CreateDirectory(stage);
                                try
                                {
                                    long total = items.Sum(i => i.Bytes), done = 0;
                                    var drive = new DriveInfo(Path.GetPathRoot(stage));
                                    if (drive.AvailableFreeSpace < total + 128L * 1024 * 1024) throw new IOException("磁盘空间不足，需要约 " + (total / (1024 * 1024) + 128) + " MiB 可用空间。");
                                    foreach (var item in items)
                                    {
                                        string target = Child(stage, item.Path, false);
                                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                                        NoLinks(Path.GetDirectoryName(target));
                                        using (var source = entries[item.Path].Open())
                                        using (var output = File.Open(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                                        using (var sha = new SHA256Cng())
                                        using (var crypto = new CryptoStream(output, sha, CryptoStreamMode.Write))
                                        {
                                            source.CopyTo(crypto); crypto.FlushFinalBlock();
                                            if (Hex(sha.Hash) != item.Hash) throw new InvalidDataException("Payload digest mismatch: " + item.Path);
                                        }
                                        using (var handle = OpenMetadata(target)) current.Files.Add(cacheStamps ? GetStamp(handle) : null);
                                        done += item.Bytes;
                                        progress("首次启动：正在准备内置环境…", 10 + (int)(80 * done / Math.Max(1, total)));
                                    }
                                    WriteReceipt(stage, destination, digest, current);
                                    Directory.Move(stage, destination);
                                }
                                finally { if (Directory.Exists(stage)) DeleteTree(stage, cacheRoot); }
                            }
                            else
                            {
                                progress("正在检查运行文件…", 92);
                                NoLinks(destination);
                                if (!File.Exists(Child(destination, ".nexus-complete")))
                                    throw new IOException("运行缓存不完整，请关闭程序后删除该缓存目录并重试：" + destination);
                                bool update = receipt == null || receipt.Files.Count != items.Count || receipt.SourceName != self ||
                                    sourceStamp == null || !sourceStamp.Matches(receipt.Source);
                                for (int i = 0; i < items.Count; i++)
                                {
                                    var item = items[i];
                                    string target = item.Target;
                                    NoLinks(Path.GetDirectoryName(target));
                                    using (var handle = OpenMetadata(target))
                                    {
                                        var observed = GetStamp(handle);
                                        if (observed == null) NoLinks(target);
                                        var stamp = cacheStamps ? observed : null;
                                        if ((stamp == null ? new FileInfo(target).Length : stamp.Bytes) != item.Bytes)
                                            throw new IOException("运行缓存损坏，请删除该缓存目录后重试：" + destination);
                                        if (stamp == null || receipt == null || receipt.Files.Count != items.Count || !stamp.Matches(receipt.Files[i]))
                                        {
                                            using (var stream = File.OpenRead(target)) if (Hash(stream) != item.Hash)
                                                throw new IOException("运行文件校验失败：" + item.Path + "。请删除缓存目录后重试：" + destination);
                                            update = true;
                                        }
                                        current.Files.Add(stamp);
                                    }
                                    progress("正在检查运行文件…", 92 + (int)(7L * (i + 1) / Math.Max(1, items.Count)));
                                }
                                if (update) WriteReceipt(destination, destination, digest, current);
                            }
                        }
                        finally { mutex.ReleaseMutex(); }
                    }
                    if (args.Contains("--extract-only")) { Console.WriteLine(destination); return 0; }
                    var start = new ProcessStartInfo(Path.Combine(destination, "NexusRoom.Host.exe")) { UseShellExecute = false, WorkingDirectory = destination };
                    start.Arguments = args.Contains("--headless") ? "--headless" : "";
                    start.CreateNoWindow = args.Contains("--headless");
                    string data = Environment.GetEnvironmentVariable("NEXUS_DATA_DIR");
                    if (String.IsNullOrWhiteSpace(data)) data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NexusRoom", "user-state-v" + version);
                    start.EnvironmentVariables["NEXUS_DATA_DIR"] = Path.GetFullPath(data);
                    start.EnvironmentVariables["NEXUS_ANDROID_APK"] = Path.Combine(destination, "tools", "NexusRoom-Android.apk");
                    progress("正在启动控制中心…", 100);
                    using (var process = Process.Start(start))
                    {
                        if (process == null) throw new IOException("无法启动控制中心。");
                        // The app owns its window and shutdown. No resident bootstrap is needed.
                    }
                    return 0;
                }
            }
        }
    }

    static void DeleteTree(string path, string root)
    {
        if (!Path.GetFullPath(path).StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Cleanup escaped cache");
        NoLinks(path);
        foreach (string file in Directory.GetFiles(path)) { NoLinks(file); File.Delete(file); }
        foreach (string child in Directory.GetDirectories(path)) DeleteTree(child, root);
        Directory.Delete(path);
    }

    sealed class Slice : Stream
    {
        readonly Stream input; readonly long offset, length; long position;
        public Slice(Stream input, long offset, long length) { this.input = input; this.offset = offset; this.length = length; }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
        public override int Read(byte[] buffer, int start, int count) { input.Position = offset + position; int got = input.Read(buffer, start, (int)Math.Min(count, length - position)); position += got; return got; }
        public override long Seek(long value, SeekOrigin origin) { long next = origin == SeekOrigin.Begin ? value : origin == SeekOrigin.Current ? position + value : length + value; if (next < 0 || next > length) throw new IOException("Seek outside payload"); return position = next; }
        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }
}
