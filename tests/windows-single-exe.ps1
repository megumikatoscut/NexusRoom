param([switch]$Gui,[int]$PortBase=18470)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'scripts\submission-paths.ps1')
$version=(Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw | ConvertFrom-Json).version
if ($PortBase -lt 18400 -or $PortBase -gt 18495) {throw 'Use reserved 184xx test ports.'}
$source=Resolve-NexusProjectPath $root ('artifacts\NexusRoom-Windows-x64-'+$version+'.exe')
$evidence=Join-Path $root ('.local\single-exe-'+[guid]::NewGuid().ToString('N'))
$standalone=Join-Path $evidence '独立交付 空格目录'
New-Item -ItemType Directory -Path $standalone -Force | Out-Null
$exe=Join-Path $standalone 'NexusRoom.exe'
Copy-Item -LiteralPath $source -Destination $exe
$cache=Join-Path $evidence 'cache'; $data=Join-Path $evidence 'data'
$results=New-Object 'System.Collections.Generic.List[object]'
$hostProcess=$null
$payload=$null
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NexusSingleExeWindows {
 public delegate bool Callback(IntPtr window, IntPtr state);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr state);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
 public static long Find(int[] ids) { var owners=new HashSet<int>(ids); long found=0;
  EnumWindows((window,state)=>{uint id;GetWindowThreadProcessId(window,out id); var title=new StringBuilder(256);GetWindowText(window,title,256);
   if(owners.Contains((int)id)&&IsWindowVisible(window)&&title.ToString().StartsWith("NexusRoom")){found=window.ToInt64();return false;} return true;},IntPtr.Zero);return found; }
}
'@
function Start-TestLauncher([string]$Arguments,[bool]$Fallback=$false) {
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$exe; $start.WorkingDirectory=$env:SystemRoot; $start.Arguments=$Arguments
    $start.UseShellExecute=$false; $start.CreateNoWindow=($Arguments -ne '')
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false); $start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    foreach ($key in @($start.EnvironmentVariables.Keys)) {if ($key -match '^(?:NEXUS(?:ROOM)?|DSH|NODE|PLAYWRIGHT|OPENAI|DEEPSEEK|ANTHROPIC)_') {$start.EnvironmentVariables.Remove($key)}}
    $start.EnvironmentVariables['Path']=$env:SystemRoot+';'+(Join-Path $env:SystemRoot 'System32')
    $start.EnvironmentVariables['NEXUS_PACKAGE_CACHE']=$cache
    $start.EnvironmentVariables['NEXUS_DATA_DIR']=$data
    $start.EnvironmentVariables['NEXUS_UI_PORT']=[string]$PortBase
    $start.EnvironmentVariables['NEXUS_DEVICE_PORT']=[string]($PortBase+1)
    $start.EnvironmentVariables['NEXUS_DISCOVERY_PORT']=[string]($PortBase+2)
    $start.EnvironmentVariables['NEXUS_DISABLE_MDNS']='1'
    if ($Fallback) {$start.EnvironmentVariables['NEXUS_FORCE_BUNDLED_BROWSER_UI']='1'}
    return [Diagnostics.Process]::Start($start)
}
function Wait-TestHost($launcher) {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $deadline=[DateTime]::UtcNow.AddMinutes(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        $launcher.Refresh()
        if ($launcher.HasExited -and $launcher.ExitCode -ne 0) {throw ('Launcher failed: '+$launcher.StandardError.ReadToEnd())}
        try {$health=Invoke-RestMethod -Uri "http://127.0.0.1:$PortBase/health" -TimeoutSec 1} catch {$health=$null}
        if ($health -and $health.version -eq $version -and (Test-Path -LiteralPath (Join-Path $data 'launch.dat'))) {
            $owned=@(Get-CimInstance Win32_Process -Filter "Name='NexusRoom.Host.exe'" | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($cache+'\',[StringComparison]::OrdinalIgnoreCase)})
            if ($owned.Count -ne 1) {throw 'Expected exactly one owned Host.'}
            $script:hostProcess=Get-Process -Id $owned[0].ProcessId
            $script:payload=Split-Path $owned[0].ExecutablePath -Parent
            return [Math]::Round($timer.Elapsed.TotalSeconds,2)
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Single EXE did not start within five minutes.'
}
function Session {
    $protected=[IO.File]::ReadAllBytes((Join-Path $data 'launch.dat'))
    $url=([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) | ConvertFrom-Json)
    $token=($url -split '#bootstrap=')[1]
    $session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
    Invoke-RestMethod -Uri "http://127.0.0.1:$PortBase/api/session" -Method Post -ContentType application/json -Body (@{token=$token}|ConvertTo-Json) -Headers @{Origin="http://127.0.0.1:$PortBase";'X-Nexus-Request'='1'} -WebSession $session | Out-Null
    return $session
}
function Stop-TestHost([long]$Window=0) {
    if ($script:hostProcess) {
        $script:hostProcess.Refresh()
        if (!$script:hostProcess.HasExited) {
            if ($Window) {
                [NexusSingleExeWindows]::PostMessage([IntPtr]$Window,0x10,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
                if (!$script:hostProcess.WaitForExit(15000)) {throw 'Closing the GUI did not stop its Host.'}
            } else {$script:hostProcess.Kill(); $script:hostProcess.WaitForExit()}
        }
        $script:hostProcess.Dispose(); $script:hostProcess=$null
    }
    for ($i=0;$i -lt 30;$i++) {
        $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$PortBase)
        try {$listener.ExclusiveAddressUse=$true;$listener.Start();return} catch {Start-Sleep -Milliseconds 100} finally {$listener.Stop()}
    }
    throw 'Host port was not released.'
}
function Assert-TestWindowIcon([long]$Window) {
    $handle=[NexusSingleExeWindows]::SendMessage([IntPtr]$Window,0x7F,[IntPtr]1,[IntPtr]::Zero)
    if ($handle -eq [IntPtr]::Zero) {throw 'The desktop window has no application icon.'}
    $icon=[Drawing.Icon]::FromHandle($handle)
    $bitmap=$icon.ToBitmap()
    $expectedIcon=[Drawing.Icon]::new((Join-Path $root 'PIC\PC.ico'),[Drawing.Size]::new($bitmap.Width,$bitmap.Height))
    $expected=$expectedIcon.ToBitmap()
    try {
        for ($x=0;$x -lt $bitmap.Width;$x++) {for ($y=0;$y -lt $bitmap.Height;$y++) {
            if ($bitmap.GetPixel($x,$y).ToArgb() -ne $expected.GetPixel($x,$y).ToArgb()) {throw 'The desktop window icon differs from PIC/PC.ico.'}
        }}
    } finally {$bitmap.Dispose();$expected.Dispose();$expectedIcon.Dispose()}
}
try {
    # A changed payload must be rejected before creating cache or user state.
    $stream=[IO.File]::Open($exe,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $stream.Position=$stream.Length-56
        $footer=New-Object byte[] 56
        if ($stream.Read($footer,0,56) -ne 56 -or [Text.Encoding]::ASCII.GetString($footer,0,8) -ne 'NRSEXE01') {throw 'Invalid EXE footer.'}
        $corruptOffset=[BitConverter]::ToInt64($footer,8)+1024
        $stream.Position=$corruptOffset;$original=$stream.ReadByte();$stream.Position=$corruptOffset;$stream.WriteByte([byte]($original -bxor 1))
    } finally {$stream.Dispose()}
    $invalid=Start-TestLauncher '--extract-only'
    try {
        if (!$invalid.WaitForExit(60000) -or $invalid.ExitCode -eq 0) {throw 'Changed executable payload was accepted.'}
        if ((Test-Path -LiteralPath $cache) -or (Test-Path -LiteralPath $data)) {throw 'Corrupt executable created runtime/user state.'}
        $results.Add(@{case='corrupted payload rejected before extraction';passed=$true})
    } finally {$invalid.Dispose()}
    $stream=[IO.File]::Open($exe,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {$stream.Position=$corruptOffset;$stream.WriteByte([byte]$original)} finally {$stream.Dispose()}
    $first=Start-TestLauncher '--headless'
    try {
        $seconds=Wait-TestHost $first
        $session=Session
        $state=Invoke-RestMethod -Uri "http://127.0.0.1:$PortBase/api/state" -WebSession $session
        if (@($state.rooms).Count -ne 1 -or $state.rooms[0].name -ne '我的 NexusRoom' -or @($state.devices).Count -or @($state.transfers).Count) {throw 'First startup contains unexpected user data.'}
        $savedState=([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $data 'state.dat')),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) | ConvertFrom-Json)
        foreach ($profile in @($savedState.rooms | ForEach-Object {$_.agentProfiles})) {if ($profile.apiKey -or $profile.model) {throw 'A delivered model key/profile is not blank.'}}
        if (@(Get-ChildItem -LiteralPath $standalone -Force).Count -ne 1) {throw 'Standalone EXE wrote beside itself.'}
        $apk=Join-Path $evidence 'downloaded.apk'
        Invoke-WebRequest -Uri "http://127.0.0.1:$PortBase/api/android-apk" -WebSession $session -OutFile $apk -UseBasicParsing
        if ((Get-FileHash -LiteralPath $apk).Hash -ne (Get-FileHash -LiteralPath (Resolve-NexusProjectPath $root ('artifacts\NexusRoom-Android-'+$version+'.apk'))).Hash) {throw 'Embedded APK download differs.'}
        $favicon=Join-Path $evidence 'favicon.ico'
        Invoke-WebRequest -Uri "http://127.0.0.1:$PortBase/favicon.ico" -OutFile $favicon -UseBasicParsing
        if ((Get-FileHash -LiteralPath $favicon).Hash -ne (Get-FileHash -LiteralPath (Join-Path $root 'PIC\PC.ico')).Hash) {throw 'The browser icon differs from PIC/PC.ico.'}
        $room=Invoke-RestMethod -Uri "http://127.0.0.1:$PortBase/api/rooms" -Method Post -WebSession $session -ContentType application/json -Body '{"name":"Packaging persistence test"}' -Headers @{Origin="http://127.0.0.1:$PortBase";'X-Nexus-Request'='1'}
        $results.Add(@{case='cold standalone Chinese/space path; blank state; embedded APK';passed=$true;seconds=$seconds})
    } finally {Stop-TestHost; $first.Dispose()}
    $second=Start-TestLauncher '--headless'
    try {
        $seconds=Wait-TestHost $second; $session=Session
        $rooms=Invoke-RestMethod -Uri "http://127.0.0.1:$PortBase/api/rooms" -WebSession $session
        if ($rooms.Count -ne 2 -or !@($rooms | Where-Object {$_.id -eq $room.id}).Count) {throw 'New user state was not retained.'}
        if (@(Get-ChildItem -LiteralPath $cache -Directory).Count -ne 1) {throw 'Cached startup created a second extraction.'}
        $results.Add(@{case='warm cache; same room persisted; no developer PATH';passed=$true;seconds=$seconds})
    } finally {Stop-TestHost; $second.Dispose()}
    if ($Gui) {
        foreach ($fallback in @($false,$true)) {
            $guiLauncher=Start-TestLauncher '' $fallback
            try {
                $seconds=Wait-TestHost $guiLauncher
                $window=0; $deadline=[DateTime]::UtcNow.AddSeconds(40)
                do {
                    $owned=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -eq $hostProcess.Id -or $_.ParentProcessId -eq $hostProcess.Id})
                    $window=[NexusSingleExeWindows]::Find([int[]]@($owned | ForEach-Object {$_.ProcessId}))
                    if (!$window) {Start-Sleep -Milliseconds 400}
                } while (!$window -and [DateTime]::UtcNow -lt $deadline)
                if (!$window) {throw 'A real NexusRoom window did not open.'}
                $uiaFile=Join-Path $evidence ('ui-'+$fallback+'.json')
                $rendered=$false
                for ($attempt=0;$attempt -lt 10;$attempt++) {
                    $uiaStart=[Diagnostics.ProcessStartInfo]::new(); $uiaStart.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
                    $uiaStart.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'windows-ui-accessibility.ps1')+'" -WindowHandle '+$window+' -Version '+$version+' -Output "'+$uiaFile+'"'
                    $uiaStart.UseShellExecute=$false; $uiaStart.CreateNoWindow=$true
                    $helper=[Diagnostics.Process]::Start($uiaStart)
                    try {
                        if (!$helper.WaitForExit(20000)) {$helper.Kill();throw 'UI inspection timed out.'}
                        if ($helper.ExitCode -eq 0 -and (Test-Path -LiteralPath $uiaFile)) {
                            $ui=Get-Content -LiteralPath $uiaFile -Raw | ConvertFrom-Json
                            if ($ui.releaseText -and $ui.roomOverview -and $ui.localService -and $ui.roomContent) {$rendered=$true;break}
                        }
                    } finally {$helper.Dispose()}
                    Start-Sleep -Seconds 1
                }
                if (!$rendered) {throw 'The window did not render the expected control centre.'}
                if (!$fallback) {Assert-TestWindowIcon $window}
                $results.Add(@{case=if($fallback){'outer EXE bundled Chromium GUI'}else{'outer EXE WebView2 GUI'};passed=$true;renderedPageVerified=$true;nativeWindowIconVerified=(!$fallback);seconds=$seconds})
                Stop-TestHost $window
            } finally {Stop-TestHost; $guiLauncher.Dispose()}
        }
    }
    $result=[ordered]@{version=$version;exeBytes=(Get-Item -LiteralPath $exe).Length;exeSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();payload=$payload;results=$results.ToArray();guiRequested=[bool]$Gui}
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'),($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Write-Host ('PASS single Windows EXE: '+$results.Count+' cases. Evidence: '+(Join-Path $evidence 'results.json'))
} finally {Stop-TestHost}
