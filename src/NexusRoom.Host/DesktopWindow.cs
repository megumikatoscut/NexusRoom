using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using NexusRoom.Host.Core;
using NexusRoom.Host.Desktop;
using NexusRoom.Host.Voice;
using NexusRoom.Host.Communication;

namespace NexusRoom.Host;

public sealed class DesktopWindow : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = System.Drawing.Color.FromArgb(246, 248, 249) };
    private readonly StateStore store;
    private readonly WindowsVoiceService voice;
    private Process? bundledBrowser;
    private FormBorderStyle savedBorderStyle;
    private FormWindowState savedWindowState;
    private Rectangle savedBounds;
    private bool fullScreen;
    public DesktopWindow(StateStore store, WindowsVoiceService voice)
    {
        this.store = store; this.voice = voice; Text = "NexusRoom · 局域网设备工作空间";
        using var iconStream = typeof(DesktopWindow).Assembly.GetManifestResourceStream("NexusRoom.PC.ico")!;
        Icon = new System.Drawing.Icon(iconStream);
        Width = 1440; Height = 940; MinimumSize = new System.Drawing.Size(1000, 720); StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(web); Load += Initialize;
        voice.LocalWake += PresentLocalWake;
        WindowsCameraCapture.RequestConsent = RequestCameraConsent;
    }
    private Task<bool> RequestCameraConsent(CancellationToken token)
    {
        var result = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            BeginInvoke(() =>
            {
                if (token.IsCancellationRequested || IsDisposed || Disposing) { result.TrySetResult(false); return; }
                // Modeless consent keeps WebView2's message loop and meeting
                // signaling running; closing the connection dismisses it.
                var dialog = new Form
                {
                    Text = "NexusRoom · 媒体授权", ClientSize = new Size(460, 170),
                    FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterScreen,
                    MinimizeBox = false, MaximizeBox = false, ShowInTaskbar = false
                };
                dialog.Controls.Add(new Label { Text = "允许 NexusRoom 在本次会议中使用摄像头？\n你可随时关闭摄像头，退出会议后会停止采集。", AutoSize = false, Bounds = new Rectangle(24, 24, 412, 65) });
                var allow = new Button { Text = "允许", Bounds = new Rectangle(230, 110, 96, 34) };
                var deny = new Button { Text = "不允许", Bounds = new Rectangle(340, 110, 96, 34) };
                dialog.Controls.AddRange([allow, deny]); dialog.AcceptButton = allow; dialog.CancelButton = deny;
                allow.Click += (_, _) => { result.TrySetResult(!token.IsCancellationRequested); dialog.Close(); };
                deny.Click += (_, _) => { result.TrySetResult(false); dialog.Close(); };
                var cancellation = token.Register(() =>
                {
                    result.TrySetCanceled(token);
                    try { BeginInvoke(() => { if (!dialog.IsDisposed) dialog.Close(); }); }
                    catch (InvalidOperationException) { }
                });
                dialog.FormClosed += (_, _) => { result.TrySetResult(false); cancellation.Dispose(); dialog.Dispose(); };
                if (token.IsCancellationRequested) { dialog.Dispose(); cancellation.Dispose(); return; }
                dialog.Show(this);
            });
        }
        catch (InvalidOperationException) { result.TrySetResult(false); }
        return result.Task;
    }
    private void PresentLocalWake(WindowsLocalWake wake)
    {
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        try
        {
            BeginInvoke(() =>
            {
                if (IsDisposed || Disposing) return;
                if (bundledBrowser != null)
                {
                    try { bundledBrowser.Refresh(); WindowActivation.BringToForeground(bundledBrowser.MainWindowHandle); }
                    catch (InvalidOperationException) { }
                }
                else { Show(); WindowActivation.BringToForeground(Handle); }
                // React reads the process-local event from voice/status, including in Chromium.
            });
        }
        catch (InvalidOperationException) { }
    }
    private async void Initialize(object? sender, EventArgs e)
    {
        try
        {
            if (Environment.GetEnvironmentVariable("NEXUS_FORCE_BUNDLED_BROWSER_UI") == "1")
            {
                OpenBundledBrowser();
                return;
            }
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(store.DirectoryPath, "webview"));
            await web.EnsureCoreWebView2Async(env);
            // Clear older persisted decisions so an explicit media request can
            // ask again. Each grant below remains limited to this WebView.
            foreach (var permission in new[] { CoreWebView2PermissionKind.Microphone, CoreWebView2PermissionKind.Camera })
                await web.CoreWebView2.Profile.SetPermissionStateAsync(permission, store.UiOrigin, CoreWebView2PermissionState.Default);
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false; web.CoreWebView2.Settings.IsStatusBarEnabled = false; web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.NavigationStarting += (_, args) => { if (!args.Uri.StartsWith(store.UiOrigin + "/", StringComparison.Ordinal)) args.Cancel = true; };
            web.CoreWebView2.NewWindowRequested += (_, args) => { args.Handled = true; };
            web.CoreWebView2.ContainsFullScreenElementChanged += (_, _) =>
            {
                var active = web.CoreWebView2.ContainsFullScreenElement;
                if (active == fullScreen) return;
                fullScreen = active;
                if (active)
                {
                    savedBorderStyle = FormBorderStyle; savedWindowState = WindowState;
                    savedBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                    WindowState = FormWindowState.Normal; FormBorderStyle = FormBorderStyle.None;
                    Bounds = Screen.FromControl(this).Bounds;
                }
                else
                {
                    FormBorderStyle = savedBorderStyle; Bounds = savedBounds; WindowState = savedWindowState;
                }
            };
            web.CoreWebView2.PermissionRequested += (_, args) =>
            {
                // Media hardware is granted only to this local control centre,
                // after its user requests it. Never persist capture permission.
                if (args.PermissionKind is not (CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera)) return;
                args.SavesInProfile = false;
                args.Handled = true;
                args.State = CoreWebView2PermissionState.Deny;
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var origin) ||
                    !string.Equals(origin.GetLeftPart(UriPartial.Authority), store.UiOrigin, StringComparison.OrdinalIgnoreCase))
                    return;
                var hardware = args.PermissionKind == CoreWebView2PermissionKind.Microphone ? "麦克风" : "摄像头";
                // A modal dialog inside a WebView2 callback causes reentrancy.
                // Keep the request pending and show it after the callback returns.
                var deferral = args.GetDeferral();
                try
                {
                    BeginInvoke(() =>
                    {
                        try
                        {
                            if (IsDisposed || Disposing) return;
                            args.State = MessageBox.Show(this, $"允许 NexusRoom 在本次通话或会议中使用{hardware}？\n你可随时在会话中关闭，退出会话后会停止采集。",
                                "NexusRoom · 媒体授权", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes
                                ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                        }
                        finally { deferral.Complete(); }
                    });
                }
                catch (InvalidOperationException) { deferral.Complete(); }
            };
            web.Source = new Uri(store.LaunchUrl);
        }
        catch (Exception error)
        {
            try
            {
                if (bundledBrowser != null) throw new InvalidOperationException("内置控制中心初始化失败", error);
                OpenBundledBrowser();
                store.Audit("server", "WebView2 不可用，已使用内置控制中心");
            }
            catch (Exception fallbackError)
            {
                MessageBox.Show("NexusRoom 控制中心无法打开：" + fallbackError.Message, "NexusRoom", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }
    }

    private void OpenBundledBrowser()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "runtime", "browsers");
        var executable = Directory.Exists(root) ? Directory.EnumerateDirectories(root, "chromium-*")
            .SelectMany(directory => new[] { Path.Combine(directory, "chrome-win64", "chrome.exe"), Path.Combine(directory, "chrome-win", "chrome.exe") })
            .FirstOrDefault(File.Exists) : null;
        if (executable == null) throw new FileNotFoundException("分发包缺少内置 Chromium，请使用完整 Windows 分发目录");
        EnsureBundledBrowserSandboxAccess(root, executable);
        // Keep this version's UI choices across restarts and isolate them from
        // Harness browser state. The host mutex prevents another host instance
        // from opening this profile while its local service is running.
        var browserProfile = Path.Combine(Path.GetFullPath(store.DirectoryPath), "browser-ui", "profile");
        var start = new ProcessStartInfo(executable) { UseShellExecute = false };
        foreach (var argument in new[] { "--app=" + store.LaunchUrl, "--user-data-dir=" + browserProfile,
            "--window-size=1400,900", "--no-first-run", "--no-default-browser-check", "--disable-background-mode" })
            start.ArgumentList.Add(argument);
        bundledBrowser = Process.Start(start) ?? throw new InvalidOperationException("内置 Chromium 启动失败");
        PcRemoteInput.ProtectProcess(bundledBrowser.Id);
        ShowInTaskbar = false;
        BeginInvoke(() => Hide());
        WatchBundledBrowser(bundledBrowser);
    }

    private static void EnsureBundledBrowserSandboxAccess(string browserRoot, string executable)
    {
        // ZIP extraction cannot preserve NTFS ACLs. Chromium's AppContainer
        // processes need RX on their binaries even when the desktop user can
        // already run them. Keep the sandbox and grant no access to user data.
        var root = Path.GetFullPath(browserRoot);
        var directory = new DirectoryInfo(Path.GetDirectoryName(Path.GetFullPath(executable))!);
        if (directory.Name is not ("chrome-win64" or "chrome-win") || directory.Parent == null ||
            !directory.Parent.Name.StartsWith("chromium-", StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(directory.Parent.Parent?.FullName, root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("内置控制中心目录不属于当前分发包");
        // Do not follow a replaced browser directory into another filesystem
        // location when preparing the package's read-only sandbox permissions.
        var packageRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(AppContext.BaseDirectory));
        for (var current = directory; current != null; current = current.Parent)
        {
            if ((current.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("内置控制中心目录包含链接，请重新解压完整分发包");
            if (string.Equals(current.FullName, packageRoot, StringComparison.OrdinalIgnoreCase)) break;
        }
        try
        {
            var security = directory.GetAccessControl(AccessControlSections.Access);
            var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
            var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            var rights = FileSystemRights.ReadAndExecute;
            var changed = false;
            foreach (var value in new[] { "S-1-15-2-1", "S-1-15-2-2" })
            {
                var identity = new SecurityIdentifier(value);
                if (rules.Any(rule => rule.IdentityReference.Equals(identity) && rule.AccessControlType == AccessControlType.Allow &&
                    (rule.FileSystemRights & rights) == rights && (rule.InheritanceFlags & inheritance) == inheritance &&
                    rule.PropagationFlags == PropagationFlags.None)) continue;
                security.AddAccessRule(new FileSystemAccessRule(identity, rights, inheritance, PropagationFlags.None, AccessControlType.Allow));
                changed = true;
            }
            if (changed) directory.SetAccessControl(security);
        }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException or System.Security.SecurityException or PlatformNotSupportedException)
        {
            throw new InvalidOperationException("无法准备内置控制中心的读取权限，请将完整分发包解压到可写的本机文件夹（例如下载或桌面）后重试。", error);
        }
    }

    private async void WatchBundledBrowser(Process browser)
    {
        try { await browser.WaitForExitAsync(); }
        catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException) { }
        if (!IsDisposed && !Disposing) Close();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        voice.LocalWake -= PresentLocalWake;
        WindowsCameraCapture.RequestConsent = null;
        if (bundledBrowser != null)
        {
            try { if (!bundledBrowser.HasExited) { bundledBrowser.Kill(entireProcessTree: true); bundledBrowser.WaitForExit(1500); } }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            bundledBrowser.Dispose();
            bundledBrowser = null;
        }
        base.OnFormClosed(e);
    }
}
