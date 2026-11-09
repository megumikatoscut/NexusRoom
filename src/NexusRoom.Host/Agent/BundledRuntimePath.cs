using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace NexusRoom.Host.Agent;

internal static class BundledRuntimePath
{
    public static string Resolve(string node, string runtime)
    {
        var start = new ProcessStartInfo(node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "Agent", "harness-runtime-path.mjs"));
        start.ArgumentList.Add(runtime);
        start.Environment.Remove("NODE_OPTIONS");
        start.Environment.Remove("NODE_PATH");
        using var process = Process.Start(start) ?? throw new IOException("Cannot prepare the bundled runtime path");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new IOException("Preparing the bundled runtime path timed out");
        }
        if (process.ExitCode != 0) throw new IOException("Cannot prepare the bundled runtime path: " + error.GetAwaiter().GetResult());
        var path = JsonSerializer.Deserialize<string>(output.GetAwaiter().GetResult().Trim());
        if (path is null || !Directory.Exists(path)) throw new IOException("Invalid bundled runtime path");
        return path;
    }
}
