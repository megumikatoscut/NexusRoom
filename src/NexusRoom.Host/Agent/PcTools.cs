using System.Collections.Concurrent;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text;
using NexusRoom.Host.Core;
using NexusRoom.Host.Files;
using NexusRoom.Host.Desktop;
namespace NexusRoom.Host.Agent;

public sealed class PcTools(StateStore store,FileService files,PcWorkCoordinator work)
{
    private sealed record Entry(string RoomId,string FolderId,string Path);
    private readonly ConcurrentDictionary<string,Entry> entries=new();
    private readonly ConcurrentDictionary<string,IntPtr> windows=new();
    private object[] WindowList(){var result=new List<object>();EnumWindows((hwnd,_)=>{if(!IsWindowVisible(hwnd))return true;try { PcRemoteInput.RequireTarget(hwnd); } catch(ApiException) { return true; }var title=new StringBuilder(512);GetWindowText(hwnd,title,title.Capacity);if(title.Length==0)return true;var id=hwnd.ToInt64().ToString("x");windows[id]=hwnd;result.Add(new{windowId=id,title=title.ToString()});return result.Count<100;},IntPtr.Zero);return result.ToArray();}
    private IntPtr Target(JsonElement args){var id=args.TryGetProperty("windowId",out var v)?v.GetString():null;if(id==null||!windows.TryGetValue(id,out var handle)||!IsWindowVisible(handle))throw new ApiException(409,"先用 pc_info 查询并指定目标 windowId");PcRemoteInput.RequireTarget(handle);return handle;}
    private void Focus(JsonElement args){var target=Target(args);ShowWindow(target,9);SetForegroundWindow(target);if(GetForegroundWindow()!=target)throw new ApiException(409,"Windows 阻止切换焦点，请手动切到目标窗口后重试");}
    public object Describe(Device d,string tool,JsonElement args){if(tool is "pc_text" or "pc_key"){var handle=Target(args);var title=new StringBuilder(512);GetWindowText(handle,title,title.Capacity);return new{window=title.ToString(),operation=args};}if(tool!="pc_send_file")return args;var e=Resolve(store.GetRoom(d.RoomId),args.GetProperty("fileId").GetString()!);return new{fileId=args.GetProperty("fileId").GetString(),name=Path.GetFileName(e.Path),path=e.Path};}
    public static async Task<string?> PickFolder() => await Sta(()=> {using var picker=new FolderBrowserDialog{Description="选择允许此房间 Agent 读取的文件夹",UseDescriptionForTitle=true};return picker.ShowDialog()==DialogResult.OK?picker.SelectedPath:null;});
    public async Task<object> Execute(Device d,string tool,JsonElement args,CancellationToken ct, Action? permissionGuard = null)
    {
        var claim = work.Acquire(Guid.NewGuid().ToString("N"), d.RoomId, d.Id, "external-agent");
        try { return await ExecuteOwned(d, tool, args, ct, permissionGuard); }
        finally { work.Release(claim.Id); }
    }
    private async Task<object> ExecuteOwned(Device d,string tool,JsonElement args,CancellationToken ct, Action? permissionGuard)
    {
        var room=store.GetRoom(d.RoomId);
        void Guard()
        {
            ct.ThrowIfCancellationRequested();
            permissionGuard?.Invoke();
            lock(store.Gate)
                if(d.Revoked || !store.State.Rooms.Contains(room) || !room.PcAgentEnabled)
                    throw new ApiException(403,"Windows Agent 授权或房间成员资格已撤销");
        }
        Guard();
        if(tool=="pc_info")return new{name=Environment.MachineName,system="Windows",windows=WindowList(),folders=room.SharedFolders.Select(f=>new{folderId=f.Id,f.Name}),tools="截图、点击、输入、系统按键、授权目录中的文件"};
        if(tool=="pc_list_files") {
            string dir; SharedFolder folder;
            if(args.TryGetProperty("directoryId",out var dirId)&&!string.IsNullOrEmpty(dirId.GetString())){var entry=Resolve(room,dirId.GetString()!);dir=entry.Path;folder=room.SharedFolders.Single(f=>f.Id==entry.FolderId);}
            else {var folderId=args.TryGetProperty("folderId",out var f)?f.GetString():null;folder=room.SharedFolders.FirstOrDefault(f=>f.Id==folderId)??throw new ApiException(400,"请先用 pc_info 查询电脑授权目录的 folderId");dir=folder.Path;}
            ValidatePath(folder,dir);
            if(entries.Count>12000)throw new ApiException(409,"本次启动浏览的文件过多，请重启后继续");
            var result=new List<object>();foreach(var path in Directory.EnumerateFileSystemEntries(dir).Take(201)){ct.ThrowIfCancellationRequested();if(result.Count==200)break;if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)continue;var id=StateStore.Hash(room.Id+"|"+folder.Id+"|"+path);entries[id]=new(room.Id,folder.Id,path);var directory=Directory.Exists(path);result.Add(new{fileId=id,directoryId=directory?id:null,name=Path.GetFileName(path),directory,size=directory?0:new FileInfo(path).Length});}
            return result;
        }
        if(tool=="pc_send_file") {var entry=Resolve(room,args.GetProperty("fileId").GetString()!);if(!File.Exists(entry.Path))throw new ApiException(404,"电脑文件不存在");await using var input=new FileStream(entry.Path,FileMode.Open,FileAccess.Read,FileShare.Read,65536,true);var t=await files.Upload(input,Path.GetFileName(entry.Path),input.Length,d.Id,false,null,ct,room.Id,guard:Guard);return await files.Deliver(t.Id,d.Id,true,ct,guard:Guard);}
        if(tool=="pc_screenshot") return await Sta<object>(()=>{Guard();PcRemoteInput.RequireDesktop();var bounds=PcRemoteInput.Bounds();using var bitmap=new Bitmap(bounds.Width,bounds.Height);using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,bounds.Size);using var output=new MemoryStream();bitmap.Save(output,ImageFormat.Jpeg);Guard();return new{mimeType="image/jpeg",base64=Convert.ToBase64String(output.ToArray()),width=bounds.Width,height=bounds.Height};});
        if(tool is "pc_click" or "pc_text" or "pc_key")
        {
            // Keep the external API's existing key allow-list and windowId focus
            // contract, while sharing remote input's desktop and window guards.
            if(tool=="pc_text") PcRemoteInput.Text(args,"text",8192);
            if(tool=="pc_key" && PcRemoteInput.Text(args,"key",80) is not ("Enter" or "Tab" or "Escape" or "Backspace" or "ArrowUp" or "ArrowDown" or "ArrowLeft" or "ArrowRight"))
                throw new ApiException(400,"不支持此电脑按键");
            return await Sta<object>(()=>
            {
                Guard();PcRemoteInput.RequireDesktop();
                if(tool is "pc_text" or "pc_key") { Focus(args);Guard(); }
                var input = new PcRemoteInput();
                try { return input.Execute(tool[3..],args,Guard); }
                finally { input.ReleaseAll(); }
            });
        }
        throw new ApiException(400,"未知 Windows 工具");
    }
    private Entry Resolve(Room room,string id){if(!entries.TryGetValue(id,out var e)||e.RoomId!=room.Id)throw new ApiException(403,"文件句柄已失效，请重新查询授权目录");var folder=room.SharedFolders.FirstOrDefault(f=>f.Id==e.FolderId)??throw new ApiException(403,"目录授权已撤销");ValidatePath(folder,e.Path);return e;}
    private static void ValidatePath(SharedFolder folder,string path){var root=Path.GetFullPath(folder.Path).TrimEnd(Path.DirectorySeparatorChar);var resolved=Path.GetFullPath(path);if(!resolved.Equals(root,StringComparison.OrdinalIgnoreCase)&&!resolved.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new ApiException(403,"文件不在授权目录中");for(var p=resolved;p!=null;p=Path.GetDirectoryName(p)){if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new ApiException(403,"不允许通过目录链接访问文件");if(p.Equals(root,StringComparison.OrdinalIgnoreCase))return;}throw new ApiException(403,"目录无效");}
    private static Task<T> Sta<T>(Func<T> action){var tcs=new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);var thread=new Thread(()=>{try{tcs.SetResult(action());}catch(Exception e){tcs.SetException(e);}}){IsBackground=true};thread.SetApartmentState(ApartmentState.STA);thread.Start();return tcs.Task;}
    private delegate bool EnumWindow(IntPtr handle,IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback,IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle,StringBuilder title,int length);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle,int command);
}
