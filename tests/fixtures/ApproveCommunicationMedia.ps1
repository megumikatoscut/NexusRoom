param([Parameter(Mandatory=$true)][int]$HostProcessId)
$ErrorActionPreference='Stop'
$InitialDenials=if($env:NEXUS_MEDIA_INITIAL_DENIALS){[int]$env:NEXUS_MEDIA_INITIAL_DENIALS}else{0}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
# QA only: explicitly approve this isolated Host's own hardware dialogs.
# Never interact with another process or change saved product permissions.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CommunicationQaWindow {
    public IntPtr Handle;
    public string Title;
    public string ClassName;
    public bool Enabled;
    public bool Visible;
}

public static class CommunicationQaNative {
    private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);

    private static bool OwnedBy(IntPtr window, int processId) {
        uint actual;
        GetWindowThreadProcessId(window, out actual);
        return actual == (uint)processId;
    }
    private static CommunicationQaWindow Describe(IntPtr window) {
        var title = new StringBuilder(512);
        var className = new StringBuilder(128);
        GetWindowText(window, title, title.Capacity);
        GetClassName(window, className, className.Capacity);
        return new CommunicationQaWindow { Handle=window, Title=title.ToString(), ClassName=className.ToString(), Enabled=IsWindowEnabled(window), Visible=IsWindowVisible(window) };
    }
    public static CommunicationQaWindow[] Snapshot(int processId) {
        var windows = new List<CommunicationQaWindow>();
        EnumWindows((window, parameter) => {
            // Query only the PID before the filter; titles/class names are read
            // solely for windows belonging to the explicitly supplied QA Host.
            if (OwnedBy(window, processId)) windows.Add(Describe(window));
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static CommunicationQaWindow DecisionButton(IntPtr dialog, int processId, int decision) {
        if (!OwnedBy(dialog, processId)) return null;
        if (decision != 6 && decision != 7) return null;
        var button = Describe(dialog).ClassName == "#32770" ? GetDlgItem(dialog, decision) : IntPtr.Zero;
        if (button != IntPtr.Zero && OwnedBy(button, processId) && GetDlgCtrlID(button) == decision) return Describe(button);
        CommunicationQaWindow found = null;
        var text = decision == 6 ? "允许" : "不允许";
        EnumChildWindows(dialog, (child, parameter) => {
            if (!OwnedBy(child, processId)) return true;
            var value = Describe(child);
            if (value.Title == text && (value.ClassName == "Button" || value.ClassName.StartsWith("WindowsForms10.BUTTON"))) found = value;
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool Approve(IntPtr dialog, int processId, string expectedTitle, int decision) {
        if (!OwnedBy(dialog, processId)) return false;
        var current = Describe(dialog);
        if (current.Title != expectedTitle || (current.ClassName != "#32770" && !current.ClassName.StartsWith("WindowsForms10.Window"))) return false;
        var button = DecisionButton(dialog, processId, decision);
        if (button == null || !button.Enabled || (button.ClassName != "Button" && !button.ClassName.StartsWith("WindowsForms10.BUTTON"))) return false;
        UIntPtr result;
        // BM_CLICK invokes only the verified decision button. A bounded send keeps
        // a hung dialog from blocking all subsequent diagnostic output.
        return SendMessageTimeout(button.Handle, 0x00F5, IntPtr.Zero, IntPtr.Zero, 0x0002, 1200, out result) != IntPtr.Zero;
    }
}
'@
$dialogTitle='NexusRoom · 媒体授权'
function Write-Diagnostic($value) {
    [Console]::Error.WriteLine(($value | ConvertTo-Json -Depth 5 -Compress))
}
Write-Diagnostic @{event='started'; hostProcessId=$HostProcessId; powershell=$PSVersionTable.PSVersion.ToString()}
$lastSnapshot=''
$deadline=[DateTime]::UtcNow.AddMinutes(6)
while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $HostProcessId -ErrorAction SilentlyContinue)) {
    $windows=@([CommunicationQaNative]::Snapshot($HostProcessId))
    $snapshotWindows=@($windows | ForEach-Object { @{handle=$_.Handle.ToInt64(); title=$_.Title; className=$_.ClassName; enabled=$_.Enabled; visible=$_.Visible} })
    $snapshot=ConvertTo-Json -InputObject $snapshotWindows -Depth 4 -Compress
    if ($snapshot -ne $lastSnapshot) {
        Write-Diagnostic @{event='owned-windows'; hostProcessId=$HostProcessId; windows=$snapshotWindows}
        $lastSnapshot=$snapshot
    }
    foreach ($window in $windows) {
        if ($window.Title -cne $dialogTitle -or ($window.ClassName -ne '#32770' -and !$window.ClassName.StartsWith('WindowsForms10.Window'))) {continue}
        $decision=if($InitialDenials -gt 0){7}else{6}
        $button=[CommunicationQaNative]::DecisionButton($window.Handle,$HostProcessId,$decision)
        Write-Diagnostic @{event='permission-dialog'; handle=$window.Handle.ToInt64(); buttonFound=($null -ne $button); buttonTitle=if ($button) {$button.Title} else {$null}; buttonClass=if ($button) {$button.ClassName} else {$null}; buttonEnabled=if ($button) {$button.Enabled} else {$false}}
        $approved=[CommunicationQaNative]::Approve($window.Handle,$HostProcessId,$dialogTitle,$decision)
        if(!$approved -and $window.ClassName.StartsWith('WindowsForms10.Window')) {
            try {
                $element=[Windows.Automation.AutomationElement]::FromHandle($window.Handle)
                $name=if($decision -eq 6){'允许'}else{'不允许'}
                $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$name)
                $control=$element.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
                if($control -and $control.Current.ProcessId -eq $HostProcessId -and $control.Current.IsEnabled -and $control.Current.ControlType -eq [Windows.Automation.ControlType]::Button) {
                    $pattern=$null
                    if($control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
                        ([Windows.Automation.InvokePattern]$pattern).Invoke(); $approved=$true
                    }
                }
            } catch { Write-Diagnostic @{event='consent-invoke-error';error=$_.Exception.Message} }
        }
        if($approved -and $InitialDenials -gt 0){$InitialDenials--}
        Write-Diagnostic @{event='permission-click'; handle=$window.Handle.ToInt64(); succeeded=$approved}
    }
    Start-Sleep -Milliseconds 200
}
Write-Diagnostic @{event='finished'; hostProcessId=$HostProcessId}
