namespace NexusRoom.Host.Core;

public static class ReleaseInfo
{
    public static string Version { get; } = typeof(ReleaseInfo).Assembly.GetName().Version!.ToString(3);
    public static string DataNamespace => "v" + Version;
}
