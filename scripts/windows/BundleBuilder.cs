using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Collections.Generic;

public static class NexusBundleBuilder
{
    public static int Main(string[] args) { try { AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false); AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false); if (args.Length != 5) throw new ArgumentException("Expected source, launcher, output, temporary archive and version."); Build(args[0], args[1], args[2], args[3], args[4]); return 0; } catch (Exception e) { Console.Error.WriteLine(e); return 1; } }
    public static void Build(string source, string stub, string output, string archivePath, string version)
    {
        var inventory = new StringBuilder(version + "\n");
        var files = Directory.GetFiles(source, "*", SearchOption.AllDirectories);
        Array.Sort(files, StringComparer.Ordinal);
        using (var archive = ZipFile.Open(archivePath, ZipArchiveMode.Create))
        {
            foreach (string file in files)
            {
                string relative = file.Substring(source.TrimEnd('\\').Length + 1).Replace('\\', '/');
                if (relative == ".nexus-complete") continue;
                if (relative.IndexOf('\t') >= 0 || relative.IndexOf('\n') >= 0 || relative == ".nexus-payload.tsv") throw new IOException("Invalid payload name");
                var entry = archive.CreateEntry(relative, CompressionLevel.Optimal);
                entry.LastWriteTime = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
                using (var input = File.OpenRead(file))
                using (var dest = entry.Open())
                using (var sha = new SHA256Cng())
                using (var hashed = new CryptoStream(dest, sha, CryptoStreamMode.Write))
                {
                    input.CopyTo(hashed); hashed.FlushFinalBlock();
                    inventory.Append(BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant()).Append('\t').Append(input.Length).Append('\t').Append(relative).Append('\n');
                }
            }
            var manifest = archive.CreateEntry(".nexus-payload.tsv", CompressionLevel.Optimal);
            manifest.LastWriteTime = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
            using (var writer = new StreamWriter(manifest.Open(), new UTF8Encoding(false))) writer.Write(inventory.ToString());
        }
        byte[] digest;
        using (var input = File.OpenRead(archivePath)) using (var sha = new SHA256Cng()) digest = sha.ComputeHash(input);
        using (var dest = File.Create(output))
        {
            using (var stubFile = File.OpenRead(stub)) stubFile.CopyTo(dest);
            long offset = dest.Position, length = new FileInfo(archivePath).Length;
            using (var payload = File.OpenRead(archivePath)) payload.CopyTo(dest);
            using (var writer = new BinaryWriter(dest, Encoding.UTF8, true))
            { writer.Write(Encoding.ASCII.GetBytes("NRSEXE01")); writer.Write(offset); writer.Write(length); writer.Write(digest); }
        }
    }
}
