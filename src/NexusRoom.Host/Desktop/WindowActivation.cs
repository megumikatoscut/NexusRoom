using System.Runtime.InteropServices;

namespace NexusRoom.Host.Desktop;

internal static class WindowActivation
{
    public static bool BringToForeground(IntPtr window)
    {
        if (window == IntPtr.Zero || !IsWindow(window)) return false;
        if (IsIconic(window)) ShowWindowAsync(window, 9); // SW_RESTORE preserves normal/maximized state.
        if (SetForegroundWindow(window)) return true;
        var foreground = GetForegroundWindow();
        var currentThread = GetCurrentThreadId();
        var foregroundThread = GetWindowThreadProcessId(foreground, out _);
        var attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        try { BringWindowToTop(window); return SetForegroundWindow(window); }
        finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
    }

    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
}
