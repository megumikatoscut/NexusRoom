using System.Runtime.InteropServices;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Desktop;

// Native text access avoids OLE's apartment-dependent clipboard ownership.
// Each operation owns a hidden HWND and never steals a clipboard held by another app.
internal static class PcTextClipboard
{
    private const uint UnicodeText = 13;
    private const int MaxCharacters = 65536;

    public static string Read() => ReadText() ?? "";

    // A non-text clipboard is distinct from an empty text value for automatic sync.
    public static string? ReadText() => WithClipboard<string?>(() =>
    {
        if (!IsClipboardFormatAvailable(UnicodeText)) return null;
        var memory = GetClipboardData(UnicodeText);
        if (memory == 0) throw Unavailable();
        var pointer = GlobalLock(memory);
        if (pointer == 0) throw Unavailable();
        try
        {
            var count = (int)Math.Min((ulong)GlobalSize(memory) / 2, MaxCharacters + 1UL);
            var text = Marshal.PtrToStringUni(pointer, count) ?? "";
            var end = text.IndexOf('\0');
            if (end >= 0) text = text[..end];
            if (text.Length > MaxCharacters) throw new ApiException(400, "剪贴板文本过长");
            return text;
        }
        finally { GlobalUnlock(memory); }
    });

    public static void Write(string text) => WithClipboard(() =>
    {
        if (text.Length > MaxCharacters) throw new ApiException(400, "剪贴板文本过长");
        // Allocate before clearing so an allocation failure leaves prior contents intact.
        nint memory = 0;
        try
        {
            if (text.Length > 0)
            {
                var characters = (text + '\0').ToCharArray();
                memory = GlobalAlloc(0x0042, (nuint)(characters.Length * 2));
                if (memory == 0) throw Unavailable();
                var pointer = GlobalLock(memory);
                if (pointer == 0) throw Unavailable();
                try { Marshal.Copy(characters, 0, pointer, characters.Length); }
                finally { GlobalUnlock(memory); }
            }
            if (!EmptyClipboard()) throw Unavailable();
            if (memory != 0)
            {
                if (SetClipboardData(UnicodeText, memory) == 0) throw Unavailable();
                memory = 0; // Windows owns the allocation after successful publication.
            }
            return true;
        }
        finally { if (memory != 0) GlobalFree(memory); }
    });

    private static T WithClipboard<T>(Func<T> operation)
    {
        var window = CreateWindowExW(0, "STATIC", "", 0, 0, 0, 0, 0, new nint(-3), 0, 0, 0);
        if (window == 0) throw Unavailable();
        var opened = false;
        try
        {
            opened = OpenClipboard(window);
            if (!opened) throw new ApiException(409, "剪贴板正被其他程序使用，请重试");
            return operation();
        }
        finally
        {
            if (opened) CloseClipboard();
            DestroyWindow(window);
        }
    }

    private static ApiException Unavailable() => new(409, "Windows 剪贴板暂不可用，请重试");
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateWindowExW(uint extendedStyle, string className, string name, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint window);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(nint window);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetClipboardData(uint format, nint memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalAlloc(uint flags, nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalLock(nint memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(nint memory);
    [DllImport("kernel32.dll")] private static extern nuint GlobalSize(nint memory);
    [DllImport("kernel32.dll")] private static extern nint GlobalFree(nint memory);
}
