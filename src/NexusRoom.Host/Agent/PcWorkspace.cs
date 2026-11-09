using NexusRoom.Host.Core;

namespace NexusRoom.Host.Agent;

public sealed record WorkspaceDirectory(string Name, string Path);
public sealed record WorkspaceFile(string Name, string Path, long? Size, DateTimeOffset? ModifiedAt);
public sealed record WorkspaceListing(string Path, string? ParentPath, string DefaultPath,
    WorkspaceDirectory[] Roots, WorkspaceDirectory[] Directories, WorkspaceFile[] Files, bool Truncated);

// Both clients select folders on the host. The same normalization is used again
// when a PC task starts, so a disappeared folder cannot silently change its cwd.
public static class PcWorkspace
{
    private const int MaximumDirectories = 1000;
    private const int MaximumFiles = 1000;
    public static string DefaultPath => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    public static string Normalize(string? input)
    {
        var path = string.IsNullOrWhiteSpace(input) ? DefaultPath : input.Trim();
        if (path.Length > 1024) throw new ApiException(400, "PC 工作目录过长");
        if (path.Length >= 2 && path[0] == '"' && path[^1] == '"') path = path[1..^1];
        if (path.Any(char.IsControl) || path.IndexOfAny(['"', '<', '>', '|', '*', '?']) >= 0)
            throw new ApiException(400, "PC 工作目录格式无效，请选择电脑上的文件夹");
        try
        {
            path = Environment.ExpandEnvironmentVariables(path);
            if (!System.IO.Path.IsPathFullyQualified(path))
                throw new ApiException(400, "PC 工作目录必须是绝对路径，请选择电脑上的文件夹");
            path = System.IO.Path.GetFullPath(path);
            if (path.Length > 1024) throw new ApiException(400, "PC 工作目录过长");
            if ((File.GetAttributes(path) & FileAttributes.Directory) == 0)
                throw new ApiException(400, "PC 工作目录应为文件夹，不能选择文件");
            // Preserve the drive-root slash while removing other trailing slashes.
            return System.IO.Path.TrimEndingDirectorySeparator(path);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        { throw new ApiException(400, "PC 工作目录格式无效，请选择电脑上的文件夹"); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        { throw new ApiException(400, "PC 工作目录不存在，请重新选择文件夹"); }
        catch (UnauthorizedAccessException)
        { throw new ApiException(403, "Windows 不允许访问此文件夹，请选择有权限的文件夹"); }
        catch (IOException)
        { throw new ApiException(409, "文件夹暂时不可访问，请检查磁盘后重试"); }
    }

    public static WorkspaceListing Browse(string? input, string? query = null)
    {
        query = query?.Trim();
        if (query?.Length > 100 || query?.Any(char.IsControl) == true)
            throw new ApiException(400, "文件或文件夹名称关键词应不超过 100 字，且不能包含控制字符");
        var path = Normalize(input);
        var directories = new List<WorkspaceDirectory>();
        var files = new List<WorkspaceFile>();
        var truncated = false;
        try
        {
            var options = new EnumerationOptions
            {
                IgnoreInaccessible = false,
                AttributesToSkip = 0,
                RecurseSubdirectories = false,
                ReturnSpecialDirectories = false
            };
            foreach (var directory in Directory.EnumerateDirectories(path, "*", options))
            {
                var name = System.IO.Path.GetFileName(directory);
                if (!string.IsNullOrEmpty(query) && !name.Contains(query, StringComparison.OrdinalIgnoreCase)) continue;
                if (directories.Count == MaximumDirectories) { truncated = true; break; }
                directories.Add(new(name, directory));
            }
            foreach (var filePath in Directory.EnumerateFiles(path, "*", options))
            {
                var name = System.IO.Path.GetFileName(filePath);
                if (!string.IsNullOrEmpty(query) && !name.Contains(query, StringComparison.OrdinalIgnoreCase)) continue;
                if (files.Count == MaximumFiles) { truncated = true; break; }
                long? size = null;
                DateTimeOffset? modifiedAt = null;
                try
                {
                    var info = new FileInfo(filePath);
                    size = info.Length;
                    modifiedAt = new DateTimeOffset(info.LastWriteTimeUtc);
                }
                catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
                { continue; /* The file disappeared while the directory was being read. */ }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { /* One protected file's metadata must not hide the rest of the directory. */ }
                files.Add(new(name, filePath, size, modifiedAt));
            }
        }
        catch (UnauthorizedAccessException)
        { throw new ApiException(403, "Windows 不允许浏览此文件夹，请选择有权限的文件夹"); }
        catch (DirectoryNotFoundException)
        { throw new ApiException(400, "文件夹已移动或删除，请重新选择"); }
        catch (IOException)
        { throw new ApiException(409, "文件夹暂时不可访问，请检查磁盘后重试"); }

        return new(path, Directory.GetParent(path)?.FullName, DefaultPath, Roots(),
            directories.OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(d => d.Name, StringComparer.Ordinal).ToArray(),
            files.OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(f => f.Name, StringComparer.Ordinal).ToArray(), truncated);
    }

    private static WorkspaceDirectory[] Roots()
    {
        var roots = new List<WorkspaceDirectory>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady) continue;
                var root = drive.RootDirectory.FullName;
                var name = drive.VolumeLabel.Length == 0 ? root : $"{drive.VolumeLabel} ({root.TrimEnd('\\')})";
                roots.Add(new(name, root));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { /* A removable or disconnected drive must not block other drives. */ }
        }
        return roots.OrderBy(d => d.Path, StringComparer.OrdinalIgnoreCase).ToArray();
    }
}
