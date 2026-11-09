using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Text.Json;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Desktop;

public sealed class PcRemoteInput
{
    private static readonly ConcurrentDictionary<uint, byte> protectedProcesses = new();
    public static void ProtectProcess(int processId) => protectedProcesses[(uint)processId] = 0;
    private readonly HashSet<string> buttons = [];
    private readonly HashSet<ushort> keys = [];
    public static Rectangle Bounds()
    {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        return SystemInformation.VirtualScreen;
    }
    public static void RequireDesktop()
    {
        var desktop = OpenInputDesktop(0, false, 0x0001);
        if (desktop == IntPtr.Zero) throw new ApiException(403, "Windows 安全桌面或锁屏需要本机操作");
        try
        {
            var bytes = new byte[512];
            if (!GetUserObjectInformation(desktop, 2, bytes, bytes.Length, out _) || System.Text.Encoding.Unicode.GetString(bytes).TrimEnd('\0') != "Default")
                throw new ApiException(403, "Windows 安全桌面或锁屏需要本机操作");
        }
        finally { CloseDesktop(desktop); }
    }
    public static void DrawCursor(Graphics graphics, Rectangle bounds)
    {
        var info = new CursorInfo { Size = Marshal.SizeOf<CursorInfo>() };
        if (!GetCursorInfo(ref info) || (info.Flags & 1) == 0) return;
        var copy = CopyIcon(info.Cursor);
        if (copy == IntPtr.Zero) return;
        IconInfo icon = new();
        try
        {
            if (!GetIconInfo(copy, out icon)) return;
            var context = graphics.GetHdc();
            try { DrawIconEx(context, info.Position.X - bounds.Left - (int)icon.HotspotX, info.Position.Y - bounds.Top - (int)icon.HotspotY, copy, 0, 0, 0, IntPtr.Zero, 3); }
            finally { graphics.ReleaseHdc(context); }
        }
        finally
        {
            if (icon.Mask != IntPtr.Zero) DeleteObject(icon.Mask);
            if (icon.Color != IntPtr.Zero) DeleteObject(icon.Color);
            DestroyIcon(copy);
        }
    }
    public object Execute(string tool, JsonElement arguments, Action guard)
    {
        guard(); RequireDesktop();
        if (arguments.ValueKind != JsonValueKind.Object) throw new ApiException(400, "输入参数必须是对象");
        switch (tool)
        {
            case "pointer":
            {
                var action = Text(arguments, "action", 20);
                if (action is not ("move" or "down" or "up")) throw new ApiException(400, "指针动作无效");
                var button = Button(arguments);
                if (action != "up" && action != "move") RequirePointerTarget(arguments);
                Move(arguments);
                if (action == "down") { Send([Mouse(button == "left" ? 2u : 8u)]); buttons.Add(button); }
                if (action == "up") { Send([Mouse(button == "left" ? 4u : 16u)]); buttons.Remove(button); }
                break;
            }
            case "click":
            {
                var button = Button(arguments); RequirePointerTarget(arguments); Move(arguments);
                try { Send([Mouse(button == "left" ? 2u : 8u), Mouse(button == "left" ? 4u : 16u)]); }
                finally { SendRelease([Mouse(button == "left" ? 4u : 16u)]); }
                break;
            }
            case "scroll":
            {
                var x = Delta(arguments, "deltaX"); var y = Delta(arguments, "deltaY");
                RequireForegroundTarget();
                if (x != 0) Send([Mouse(0x1000, x)]);
                if (y != 0) Send([Mouse(0x0800, y)]);
                break;
            }
            case "text":
            {
                var value = Text(arguments, "text", 8192);
                RequireForegroundTarget();
                // Send UTF-16 code units as one ordered sequence, including surrogate pairs.
                for (var offset = 0; offset < value.Length; offset += 128)
                {
                    guard(); RequireForegroundTarget();
                    var inputs = value.Skip(offset).Take(128).SelectMany(ch => new[] { Key(0, ch, 4), Key(0, ch, 6) }).ToArray();
                    Send(inputs);
                }
                break;
            }
            case "key":
            {
                var chord = Text(arguments, "key", 80).Split('+');
                if (chord.Length is < 1 or > 4) throw new ApiException(400, "按键组合无效");
                var codes = chord.Select(Code).ToArray();
                if (codes.Distinct().Count() != codes.Length) throw new ApiException(400, "按键组合重复");
                var count = 1;
                if (arguments.TryGetProperty("count", out var repeated) && (repeated.ValueKind != JsonValueKind.Number || !repeated.TryGetInt32(out count) || count is < 1 or > 64))
                    throw new ApiException(400, "重复按键次数必须是 1 到 64 的整数");
                if (count > 1 && (codes.Length != 1 || codes[0] is not (8 or 46 or 37 or 38 or 39 or 40)))
                    throw new ApiException(400, "只有删除键和方向键可以重复");
                for (var repeat = 0; repeat < count; repeat++)
                {
                    guard(); RequireDesktop(); RequireForegroundTarget();
                    try
                    {
                        foreach (var code in codes) { guard(); RequireForegroundTarget(); Send([Key(code, '\0', 0)]); keys.Add(code); }
                    }
                    finally { foreach (var code in codes.Reverse()) { SendRelease([Key(code, '\0', 2)]); keys.Remove(code); } }
                }
                break;
            }
            default: throw new ApiException(400, "不支持此电脑输入工具");
        }
        return new { ok = true };
    }
    public void ReleaseAll()
    {
        foreach (var button in buttons) SendRelease([Mouse(button == "left" ? 4u : 16u)]);
        foreach (var code in keys) SendRelease([Key(code, '\0', 2)]);
        buttons.Clear(); keys.Clear();
    }
    private static void Move(JsonElement args)
    {
        double Coordinate(string name)
        {
            if (!args.TryGetProperty(name, out var item) || !item.TryGetDouble(out var value) || !double.IsFinite(value) || value is < 0 or > 1)
                throw new ApiException(400, "坐标必须在 0 到 1 之间");
            return value;
        }
        var x = Coordinate("x"); var y = Coordinate("y"); Bounds();
        Send([new() { Type = 0, Data = new() { Mouse = new() { X = (int)Math.Round(x * 65535), Y = (int)Math.Round(y * 65535), Flags = 0x8000 | 0x4000 | 1 } } }]);
    }
    private static void RequireForegroundTarget() => RequireTarget(GetForegroundWindow());
    private static void RequirePointerTarget(JsonElement args)
    {
        if (!args.TryGetProperty("x", out var x) || !x.TryGetDouble(out var px) || !args.TryGetProperty("y", out var y) || !y.TryGetDouble(out var py) || !double.IsFinite(px) || !double.IsFinite(py) || px is < 0 or > 1 || py is < 0 or > 1)
            throw new ApiException(400, "坐标必须在 0 到 1 之间");
        var bounds = Bounds();
        RequireTarget(WindowFromPoint(new() { X = bounds.Left + (int)Math.Round(px * (bounds.Width - 1)), Y = bounds.Top + (int)Math.Round(py * (bounds.Height - 1)) }));
    }
    public static void RequireTarget(IntPtr window)
    {
        if (window == IntPtr.Zero) return;
        var root = GetAncestor(window, 2);
        GetWindowThreadProcessId(root == IntPtr.Zero ? window : root, out var pid);
        if (pid == Environment.ProcessId || protectedProcesses.ContainsKey(pid)) throw new ApiException(403, "NexusRoom 控制中心的授权与审批请在本机操作");
    }
    private static string Button(JsonElement args)
    {
        var button = args.TryGetProperty("button", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : "left";
        return button is "left" or "right" ? button : throw new ApiException(400, "鼠标按钮无效");
    }
    public static string Text(JsonElement args, string name, int maximum)
    {
        if (!args.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String || value.GetString()!.Length > maximum)
            throw new ApiException(400, "文本参数无效或过长");
        return value.GetString()!;
    }
    private static int Delta(JsonElement args, string name)
    {
        if (!args.TryGetProperty(name, out var value)) return 0;
        if (!value.TryGetInt32(out var number) || number is < -12000 or > 12000) throw new ApiException(400, "滚动范围无效");
        return number;
    }
    private static ushort Code(string key) => key switch
    {
        "Ctrl" or "Control" => 0x11, "Alt" => 0x12, "Shift" => 0x10, "Win" or "Meta" => 0x5b,
        "Enter" => 13, "Tab" => 9, "Escape" or "Esc" => 27, "Backspace" => 8, "Delete" => 46,
        "Home" => 36, "End" => 35, "PageUp" => 33, "PageDown" => 34, "Insert" => 45, "Space" => 32,
        "ArrowUp" or "Up" => 38, "ArrowDown" or "Down" => 40, "ArrowLeft" or "Left" => 37, "ArrowRight" or "Right" => 39,
        _ when key.Length == 1 && char.IsAsciiLetterOrDigit(key[0]) => char.ToUpperInvariant(key[0]),
        _ when key.Length is 2 or 3 && key[0] == 'F' && int.TryParse(key[1..], out var n) && n is >= 1 and <= 12 => (ushort)(111 + n),
        _ => throw new ApiException(400, "不支持此电脑按键")
    };
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public Union Data; }
    [StructLayout(LayoutKind.Explicit)] private struct Union { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
    private static Input Mouse(uint flags, int data = 0) => new() { Type = 0, Data = new() { Mouse = new() { Flags = flags, Data = unchecked((uint)data) } } };
    private static Input Key(ushort code, char ch, uint flags) => new() { Type = 1, Data = new() { Keyboard = new() { Key = code, Scan = ch, Flags = flags } } };
    private static void Send(Input[] inputs) { if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length) throw new ApiException(403, "Windows 拒绝输入，高权限窗口需要本机操作"); }
    private static void SendRelease(Input[] inputs) => SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct CursorInfo { public int Size; public int Flags; public IntPtr Cursor; public Point Position; }
    [StructLayout(LayoutKind.Sequential)] private struct IconInfo { [MarshalAs(UnmanagedType.Bool)] public bool Icon; public uint HotspotX, HotspotY; public IntPtr Mask, Color; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, byte[] info, int length, out int needed);
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CursorInfo info);
    [DllImport("user32.dll")] private static extern IntPtr CopyIcon(IntPtr icon);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr context, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
}
