param([Parameter(Mandatory=$true)][string]$EvidenceDirectory,[switch]$Tone)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RemoteFixtureFocus {
    public static void SaveSnapshot(string temporary,string destination,string json) {
        System.IO.File.WriteAllText(temporary,json,new System.Text.UTF8Encoding(false));
        if(System.IO.File.Exists(destination))System.IO.File.Replace(temporary,destination,null);
        else System.IO.File.Move(temporary,destination);
    }
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window,IntPtr insertAfter,int x,int y,int cx,int cy,uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
    public static bool Activate(IntPtr window) {
        uint process; var foreground=GetWindowThreadProcessId(GetForegroundWindow(),out process); var current=GetCurrentThreadId();
        var attached=foreground!=0&&foreground!=current&&AttachThreadInput(current,foreground,true);
        try { ShowWindow(window,5);SetWindowPos(window,new IntPtr(-1),0,0,0,0,0x43);return SetForegroundWindow(window); }
        finally { if(attached)AttachThreadInput(current,foreground,false); }
    }
    public static uint ForegroundPid() { uint process; GetWindowThreadProcessId(GetForegroundWindow(), out process); return process; }
}
'@
[Windows.Forms.Application]::EnableVisualStyles()
$taskEvidence=[IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $taskEvidence -Force | Out-Null
$taskForm=[Windows.Forms.Form]::new()
$taskForm.Text='NexusRoom remote control QA'
$taskForm.StartPosition='Manual'
$taskForm.Location=[Drawing.Point]::new(30,30)
$taskForm.Size=[Drawing.Size]::new(620,480)
$taskForm.TopMost=$true
$taskLabel=[Windows.Forms.Label]::new()
$taskLabel.Text='Disposable remote input fixture: text, pointer and wheel'
$taskLabel.Location=[Drawing.Point]::new(20,15)
$taskLabel.AutoSize=$true
$taskForm.Controls.Add($taskLabel)
$taskText=[Windows.Forms.TextBox]::new()
$taskText.Multiline=$true
$taskText.Location=[Drawing.Point]::new(20,45)
$taskText.Size=[Drawing.Size]::new(565,85)
$taskText.Font=[Drawing.Font]::new('Segoe UI',16)
$taskText.Name='remote-text'
$taskForm.Controls.Add($taskText)
$taskButton=[Windows.Forms.Button]::new()
$taskButton.Text='Click target'
$taskButton.Location=[Drawing.Point]::new(20,150)
$taskButton.Size=[Drawing.Size]::new(180,65)
$taskForm.Controls.Add($taskButton)
$taskPanel=[Windows.Forms.Panel]::new()
$taskPanel.Location=[Drawing.Point]::new(20,235)
$taskPanel.Size=[Drawing.Size]::new(565,170)
$taskPanel.BackColor=[Drawing.Color]::LightSteelBlue
$taskPanel.TabStop=$true
$taskForm.Controls.Add($taskPanel)
$script:taskClicks=0
$script:taskRightClicks=0
$script:taskDown=0
$script:taskUp=0
$script:taskMoves=0
$script:taskWheel=0
$script:taskKeys=0
$taskButton.Add_Click({$script:taskClicks++})
$taskPanel.Add_MouseDown({param($sender,$event) $script:taskDown++;if($event.Button -eq 'Right'){$script:taskRightClicks++};$taskPanel.Focus()})
$taskPanel.Add_MouseUp({$script:taskUp++})
$taskPanel.Add_MouseMove({$script:taskMoves++})
$taskPanel.Add_MouseWheel({param($sender,$event) $script:taskWheel+=$event.Delta})
$taskText.Add_KeyDown({$script:taskKeys++})
function Fixture-Bounds($Control){$taskRectangle=$Control.RectangleToScreen($Control.ClientRectangle);@{x=$taskRectangle.X;y=$taskRectangle.Y;width=$taskRectangle.Width;height=$taskRectangle.Height}}
$taskTimer=[Windows.Forms.Timer]::new()
$taskTimer.Interval=150
$taskTimer.Add_Tick({
    $taskVirtual=[Windows.Forms.SystemInformation]::VirtualScreen
    $taskForeground=[RemoteFixtureFocus]::ForegroundPid()
    $taskResult=@{text=$taskText.Text;clicks=$script:taskClicks;rightClicks=$script:taskRightClicks;down=$script:taskDown;up=$script:taskUp;moves=$script:taskMoves;wheel=$script:taskWheel;keys=$script:taskKeys;textbox=(Fixture-Bounds $taskText);button=(Fixture-Bounds $taskButton);panel=(Fixture-Bounds $taskPanel);virtualScreen=@{x=$taskVirtual.X;y=$taskVirtual.Y;width=$taskVirtual.Width;height=$taskVirtual.Height};focused=$taskText.Focused;pid=$PID;hwnd=$taskForm.Handle.ToInt64();foregroundPid=$taskForeground;foreground=($taskForeground -eq $PID);snapshotAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
    $taskSnapshot=Join-Path $taskEvidence 'fixture-state.json'
    $taskTemporary=Join-Path $taskEvidence 'fixture-state.tmp'
    try { [RemoteFixtureFocus]::SaveSnapshot($taskTemporary,$taskSnapshot,($taskResult|ConvertTo-Json -Depth 6 -Compress)) }
    catch [IO.IOException] { } # A transient reader keeps the previous complete snapshot.
})
$taskPlayer=$null
$taskWave=$null
if($Tone){
    [IO.File]::WriteAllText((Join-Path $taskEvidence 'tone-startup.txt'),'generating test signal')
    $taskRate=48000;$taskSamples=$taskRate
    $taskWave=[IO.MemoryStream]::new();$taskWriter=[IO.BinaryWriter]::new($taskWave)
    $taskWriter.Write([Text.Encoding]::ASCII.GetBytes('RIFF'));$taskWriter.Write([int](36+$taskSamples*2));$taskWriter.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '));$taskWriter.Write([int]16);$taskWriter.Write([int16]1);$taskWriter.Write([int16]1);$taskWriter.Write([int]$taskRate);$taskWriter.Write([int]($taskRate*2));$taskWriter.Write([int16]2);$taskWriter.Write([int16]16);$taskWriter.Write([Text.Encoding]::ASCII.GetBytes('data'));$taskWriter.Write([int]($taskSamples*2))
    for($taskI=0;$taskI -lt $taskSamples;$taskI++){$taskWriter.Write([int16](8000*[Math]::Sin(2*[Math]::PI*440*$taskI/$taskRate)))}
    $taskWave.Position=0;$taskPlayer=[Media.SoundPlayer]::new($taskWave)
    [IO.File]::WriteAllText((Join-Path $taskEvidence 'tone-startup.txt'),'loading test signal')
    $taskPlayer.Load()
    [IO.File]::WriteAllText((Join-Path $taskEvidence 'tone-startup.txt'),'starting test signal playback')
    $taskPlayer.PlayLooping()
    [IO.File]::WriteAllText((Join-Path $taskEvidence 'tone-startup.txt'),'test signal playback started')
}
$taskForm.Add_Shown({[RemoteFixtureFocus]::Activate($taskForm.Handle)|Out-Null;$taskText.Focus();$taskTimer.Start()})
try{
    # A hidden helper's STARTUPINFO may suppress its first native ShowWindow.
    # Explicitly show this disposable form before entering the message loop.
    $taskForm.Show()
    [RemoteFixtureFocus]::ShowWindow($taskForm.Handle,5) | Out-Null
    [Windows.Forms.Application]::Run($taskForm)
}finally{$taskTimer.Dispose();if($taskPlayer){$taskPlayer.Stop();$taskPlayer.Dispose();$taskWave.Dispose()};$taskForm.Dispose()}
