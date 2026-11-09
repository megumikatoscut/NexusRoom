using System.Text.Json;
using System.Text.RegularExpressions;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;
using NexusRoom.Host.Files;

namespace NexusRoom.Host.Agent;

public sealed class ToolService(StateStore store, DeviceHub hub, FileService files, ApprovalService approvals,PcTools pc)
{
    public static readonly HashSet<string> Mutations = ["tap", "swipe", "scroll", "text", "edit", "back", "home", "recents", "launch_app", "clipboard_set", "send_file", "export_photo","pc_send_file","pc_click","pc_text","pc_key","pc_screenshot"];
    public static object[] Definitions => [
        Def("pc_info","查看 Windows 主机信息与本房间授权目录列表。",new{}),
        Def("pc_list_files","浏览电脑已授权目录，返回文件和子目录句柄。",new{folderId=Str("pc_info 的 folderId"),directoryId=Str("子目录句柄，可省略")}),
        Def("pc_send_file","将授权目录中的电脑文件发送到当前手机。",new{fileId=Str("pc_list_files 的 fileId")},"fileId"),
        Def("pc_screenshot","取得用户允许操作的 Windows 桌面截图，请求模式下需要本机确认。",new{}),
        Def("pc_click","点击 Windows 桌面，坐标归一化 0..1。",new{x=Number("x"),y=Number("y")},"x","y"),
        Def("pc_text","向 Windows 当前焦点输入文字。",new{text=Str("文本"),windowId=Str("pc_info 的目标 windowId")},"text","windowId"),
        Def("pc_key","Windows 按键：Enter/Tab/Escape/Backspace/ArrowUp/ArrowDown/ArrowLeft/ArrowRight。",new{key=Str("按键"),windowId=Str("pc_info 的目标 windowId")},"key","windowId"),
        Def("device_info", "查看当前 Android 设备信息、分辨率与授权状态。", new { }),
        Def("screenshot", "获取当前屏幕 JPEG 截图。坐标使用截图归一化值 0 到 1。", new { }),
        Def("ui_tree", "读取屏幕上的可访问控件、文本和归一化坐标；部分应用可能不提供。", new { }),
        Def("tap", "点击屏幕坐标。", new { x = Number("0 到 1"), y = Number("0 到 1") }, "x", "y"),
        Def("swipe", "从起点滑动到终点。", new { x = Number("起点 x 0 到 1"), y = Number("起点 y 0 到 1"), endX = Number("终点 x 0 到 1"), endY = Number("终点 y 0 到 1"), duration = new { type = "integer", description = "100 到 3000 毫秒" } }, "x", "y", "endX", "endY"),
        Def("scroll", "滚动当前页面；direction 为 up 或 down，也可提供坐标和 delta。", new { direction = new { type = "string", @enum = new[] { "up", "down" } }, x = Number("可选，0 到 1，默认 0.5"), y = Number("可选，0 到 1，默认 0.55"), delta = new { type = "number", description = "可选，正数向上滚动，负数向下滚动" } }),
        Def("text", "向当前已聚焦的输入框输入文字。", new { text = Str("要输入的文本，最长 8192 字符") }, "text"),
        Def("edit", "编辑当前已聚焦的非密码输入框。", new { action = new { type = "string", @enum = new[] { "insert", "clear", "selectAll", "copy", "cut", "Backspace", "Delete", "Enter", "ArrowLeft", "ArrowRight", "Home", "End" } }, text = Str("insert 时使用的文本，最长 8192 字符") }, "action"),
        Def("clipboard_set", "设置当前 Android 房间的系统剪贴板。", new { text = Str("文本，最长 65536 字符") }, "text"),
        Def("clipboard_get", "读取当前 Android 房间最近一次可读的文本剪贴板。", new { }),
        Def("back", "Android 返回。", new { }), Def("home", "Android 回到主页。", new { }), Def("recents", "Android 最近任务。", new { }),
        Def("launch_app", "按完整包名启动 App；设置为 com.android.settings。", new { package = Str("App 包名") }, "package"),
        Def("list_apps", "列出可启动的 Android 应用包名与名称。", new { }),
        Def("list_files", "列出 Windows 已导入的文件，发送文件必须使用此处的 fileId。", new { }),
        Def("send_file", "把 Windows 文件库中选定文件发送给 Android。", new { fileId = Str("文件 ID") }, "fileId"),
        Def("recent_photos", "列出用户授权照片库中的最新照片，最多 20 张。", new { count = new { type = "integer", description = "1 到 20，默认 3" } }),
        Def("export_photo", "将 Android 已授权照片按 photoId 传回 Windows。", new { photoId = Str("recent_photos 返回的照片 ID") }, "photoId")
    ];
    private static object Str(string description) => new { type = "string", description };
    private static object Number(string description) => new { type = "number", description };
    private static object Def(string name, string description, object properties, params string[] required) => new { type = "function", function = new { name, description, parameters = new { type = "object", properties, required, additionalProperties = false } } };
    public async Task<object> Execute(string id, string tool, JsonElement args, bool agent, string runId, CancellationToken ct, string? executionMode = null)
    {
        var d = store.GetDevice(id);
        if (args.ValueKind != JsonValueKind.Object) throw new ApiException(400, "工具参数必须是 JSON 对象");
        var capability = tool switch
        {
            "device_info" => "info",
            "list_files" => "files",
            "screenshot" => "screen",
            "clipboard_set" or "clipboard_get" => "clipboard",
            "pc_info" or "pc_list_files" or "pc_send_file" or "pc_screenshot" or "pc_click" or "pc_text" or "pc_key" => "info",
            "send_file" or "recent_photos" or "export_photo" => "files",
            "tap" or "swipe" or "scroll" or "text" or "edit" or "back" or "home" or "recents" or "launch_app" or "list_apps" or "ui_tree" => "control",
            _ => throw new ApiException(400, "未知工具；不支持任意命令执行")
        };
        hub.Require(d, capability, agent);
        if (tool is "edit" && args.TryGetProperty("action", out var editAction) && editAction.ValueKind == JsonValueKind.String && editAction.GetString() is "copy" or "cut") hub.Require(d, "clipboard", agent);
        if (tool.StartsWith("pc_", StringComparison.Ordinal) && !store.GetRoom(d.RoomId).PcAgentEnabled) throw new ApiException(403, "请先在电脑为此房间开启 Windows Agent 权限");
        Validate(tool, args);
        // A run's mode is fixed at creation; tool arguments cannot change its approval policy.
        if (executionMode is not (null or "request" or "automatic")) throw new ApiException(400, "无效的任务模式");
        var confirm = executionMode == "request" || executionMode == null && (tool.StartsWith("pc_") || store.AgentFor(d.RoomId).ConfirmMutations);
        if (agent && Mutations.Contains(tool) && confirm)
            await approvals.Require(id, tool, tool.StartsWith("pc_")?Json.Element(pc.Describe(d,tool,args)):args, runId, ct);
        // Permissions can be revoked while an approval is pending.
        hub.Require(d, capability, agent);
        if (tool is "edit" && args.GetProperty("action").GetString() is "copy" or "cut") hub.Require(d, "clipboard", agent);
        if (tool.StartsWith("pc_", StringComparison.Ordinal) && !store.GetRoom(d.RoomId).PcAgentEnabled) throw new ApiException(403, "Windows Agent 权限已撤销");
        ct.ThrowIfCancellationRequested();
        var leaseReason=agent?"agent:"+runId:"input:"+Guid.NewGuid().ToString("N");
        try
        {
            if(capability is "screen" or "control" or "clipboard" || agent)await hub.Acquire(id,leaseReason,ct);
            object result;
            if (tool.StartsWith("pc_")) result=await pc.Execute(d,tool,args,ct,()=>hub.Require(d,capability,agent));
            else if (tool == "device_info") result = hub.View(d);
            else if (tool == "screenshot") result = new { mimeType = "image/jpeg", base64 = Convert.ToBase64String(hub.Screenshot(d)), width = d.Width, height = d.Height };
            else if (tool == "list_files") { lock (store.Gate) result = store.State.Transfers.Where(t => t.RoomId==d.RoomId && t.Direction == "toAndroid" && (t.DeviceId == id || t.DeviceId.Length == 0)).Select(t => new { fileId = t.Id, t.Name, t.Size, t.Status }).ToArray(); }
            else if (tool == "send_file") result = await files.Deliver(args.GetProperty("fileId").GetString()!, id, agent, ct);
            else
            {
                var values = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(args.GetRawText())!;
                if (tool == "scroll" && values.TryGetValue("direction", out var direction))
                {
                    values.TryAdd("x", Json.Element(0.5));
                    values.TryAdd("y", Json.Element(0.55));
                    values["delta"] = Json.Element(direction.GetString() == "up" ? 1 : -1);
                    values.Remove("direction");
                }
                values["agent"] = Json.Element(agent);
                result = await hub.Call(id, tool, Json.Element(values), ct);
            }
            store.Audit(agent ? "agent" : "control", tool, id);
            return result;
        }
        catch { store.Audit(agent ? "agent" : "control", tool, id, "error"); throw; }
        finally {if(!agent)await hub.Release(id,leaseReason);else if(runId=="external")await hub.Release(id,"agent:external");}
    }
    public Task ReserveRun(string id,string runId,CancellationToken ct){hub.Require(store.GetDevice(id),"info",true);return hub.Acquire(id,"agent:"+runId,ct);}
    public Task ReleaseRun(string id,string runId)=>hub.Release(id,"agent:"+runId);
    public static void Validate(string tool, JsonElement a)
    {
        if (tool is "tap" or "swipe" or "scroll")
        {
            if (tool == "scroll" && a.TryGetProperty("direction", out var direction))
            {
                if (direction.ValueKind != JsonValueKind.String || direction.GetString() is not ("up" or "down")) throw new ApiException(400, "滚动方向必须是 up 或 down");
                foreach (var key in new[] { "x", "y" })
                    if (a.TryGetProperty(key, out var n) && (!n.TryGetDouble(out var value) || !double.IsFinite(value) || value < 0 || value > 1)) throw new ApiException(400, $"{key} 必须在 0 到 1 之间");
            }
            else
            {
                foreach (var key in tool == "swipe" ? new[] { "x", "y", "endX", "endY" } : new[] { "x", "y" })
                    if (!a.TryGetProperty(key, out var n) || !n.TryGetDouble(out var value) || !double.IsFinite(value) || value < 0 || value > 1) throw new ApiException(400, $"{key} 必须在 0 到 1 之间");
                if (tool == "scroll" && a.TryGetProperty("delta", out var delta) && (!delta.TryGetDouble(out var amount) || !double.IsFinite(amount) || amount == 0)) throw new ApiException(400, "滚动 delta 无效");
            }
        }
        if (tool == "swipe" && a.TryGetProperty("duration", out var duration) && (!duration.TryGetInt32(out var ms) || ms is < 100 or > 3000)) throw new ApiException(400, "滑动时长超出范围");
        if(tool=="edit") {if(!a.TryGetProperty("action",out var action)||action.ValueKind!=JsonValueKind.String||action.GetString() is not ("insert" or "clear" or "copy" or "cut" or "selectAll" or "Backspace" or "Delete" or "Enter" or "ArrowLeft" or "ArrowRight" or "Home" or "End"))throw new ApiException(400,"不支持的编辑操作");if(action.GetString()=="insert"&&(!a.TryGetProperty("text",out var text)||text.ValueKind!=JsonValueKind.String||text.GetString()!.Length>8192))throw new ApiException(400,"输入文本过长或无效");}
        if (tool is "text" or "clipboard_set") { if (!a.TryGetProperty("text", out var value) || value.ValueKind != JsonValueKind.String || value.GetString()!.Length > (tool == "text" ? 8192 : 65536)) throw new ApiException(400, "文本参数无效或过长"); }
        if (tool == "launch_app" && (!a.TryGetProperty("package", out var p) || p.ValueKind != JsonValueKind.String || !Regex.IsMatch(p.GetString()!, @"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$"))) throw new ApiException(400, "包名不合法");
        if (tool is "send_file" or "export_photo") { var key = tool == "send_file" ? "fileId" : "photoId"; if (!a.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.String || v.GetString()!.Length is < 1 or > 100) throw new ApiException(400, "文件标识无效"); }
        if (tool == "recent_photos" && a.TryGetProperty("count", out var count) && (!count.TryGetInt32(out var photoCount) || photoCount is < 1 or > 20)) throw new ApiException(400, "照片数量应为 1 到 20");
    }
}
