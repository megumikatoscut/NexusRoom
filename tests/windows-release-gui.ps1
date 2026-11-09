param(
    [string]$PackageDirectory = '',
    [int]$PortBase = 18440,
    [string]$ScreenshotHelper = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$release = Get-Content -LiteralPath (Join-Path $project 'release.json') -Raw | ConvertFrom-Json
if (!$PackageDirectory) { . (Join-Path $project 'scripts\resolve-windows-payload.ps1'); $PackageDirectory = Get-NexusWindowsPayload $project $release.version }
$package = [IO.Path]::GetFullPath($PackageDirectory)
$exe = Join-Path $package 'NexusRoom.Host.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Build the current Windows package before GUI acceptance.' }
$metadata = Get-Content -LiteralPath (Join-Path $package 'release.json') -Raw | ConvertFrom-Json
if ($metadata.version -ne $release.version) { throw 'The Windows package is not the current release.' }
if ([version](Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne [version]($release.version + '.0')) { throw 'The packaged EXE has an unexpected file version.' }
if ($PortBase -lt 18400 -or $PortBase + 12 -gt 18499) { throw 'GUI acceptance reserves only the 184xx test ports.' }

$evidence = Join-Path $project ('.local\nexusroom-v' + $release.version + '-gui-' + [Guid]::NewGuid().ToString('N'))
$working = Join-Path $evidence 'outside-project-working-directory'
New-Item -ItemType Directory -Path $working -Force | Out-Null
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$contexts = New-Object 'System.Collections.Generic.List[object]'
$results = New-Object 'System.Collections.Generic.List[object]'
$browserRoot = Join-Path $package 'runtime\browsers'
$browserRevision = @(Get-ChildItem -LiteralPath $browserRoot -Directory -Filter 'chromium-*' | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName 'chrome-win64\chrome.exe')) -or (Test-Path -LiteralPath (Join-Path $_.FullName 'chrome-win\chrome.exe'))
}) | Select-Object -First 1
if (!$browserRevision) { throw 'The package has no real bundled Chromium executable.' }
$browserDirectory = if (Test-Path -LiteralPath (Join-Path $browserRevision.FullName 'chrome-win64\chrome.exe')) { Join-Path $browserRevision.FullName 'chrome-win64' } else { Join-Path $browserRevision.FullName 'chrome-win' }
$ancestorAcls = @{}
foreach ($directory in @($package, (Join-Path $package 'runtime'), $browserRoot, $browserRevision.FullName)) { $ancestorAcls.Add($directory, (Get-Acl -LiteralPath $directory).Sddl) }

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NexusGuiAcceptanceNative {
    public delegate bool EnumWindowProc(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr state);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    public static bool IsNexusRoomWindow(long handle) {
        var title = new StringBuilder(256);
        GetWindowText(new IntPtr(handle), title, title.Capacity);
        return title.ToString().StartsWith("NexusRoom", StringComparison.Ordinal);
    }
    public static long[] VisibleWindows(int[] processIds) {
        var ids = new HashSet<int>(processIds);
        var windows = new List<long>();
        EnumWindows((window, state) => {
            uint id; GetWindowThreadProcessId(window, out id);
            if (ids.Contains((int)id) && IsWindowVisible(window)) windows.Add(window.ToInt64());
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
'@

function Assert-PortsFree($ports) {
    foreach ($port in @($ports.Ui, $ports.Device)) {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$port)
        try { $listener.ExclusiveAddressUse = $true; $listener.Start() }
        catch { throw "TCP test port $port is still occupied." }
        finally { $listener.Stop() }
    }
    $socket = New-Object Net.Sockets.Socket([Net.Sockets.AddressFamily]::InterNetwork, [Net.Sockets.SocketType]::Dgram, [Net.Sockets.ProtocolType]::Udp)
    try { $socket.ExclusiveAddressUse = $true; $socket.Bind((New-Object Net.IPEndPoint([Net.IPAddress]::Loopback, [int]$ports.Discovery))) }
    catch { throw "UDP test port $($ports.Discovery) is still occupied." }
    finally { $socket.Dispose() }
}

function Test-OwnedProcess($entry) {
    try {
        $current = [Diagnostics.Process]::GetProcessById([int]$entry.Id)
        try { return !$current.HasExited -and $current.StartTime.ToUniversalTime().Ticks -eq $entry.StartTicks }
        finally { $current.Dispose() }
    } catch { return $false }
}

function Refresh-OwnedProcesses($context) {
    # Query metadata only; command lines can contain GUI bootstrap credentials.
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($row in $rows) {
            $id = [int]$row.ProcessId
            $parentId = [int]$row.ParentProcessId
            if ($context.Owned.ContainsKey($id) -or !$context.Owned.ContainsKey($parentId)) { continue }
            $parent = $context.Owned[$parentId]
            if ($null -eq $row.CreationDate -or $row.CreationDate.ToUniversalTime().Ticks -lt $parent.StartTicks) { continue }
            try {
                $process = [Diagnostics.Process]::GetProcessById($id)
                try { $ticks = $process.StartTime.ToUniversalTime().Ticks }
                finally { $process.Dispose() }
            } catch { continue }
            $context.Owned.Add($id, [pscustomobject]@{ Id=$id; StartTicks=$ticks; Name=$row.Name; Path=$row.ExecutablePath })
            $changed = $true
        }
    }
}

function Start-OwnedHost([string]$name, [string]$data, $ports, [bool]$fallback) {
    Assert-PortsFree $ports
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $exe
    $start.UseShellExecute = $false
    $start.WorkingDirectory = $working
    # Deliberately exclude developer Node/.NET/config overrides from this child.
    foreach ($key in @($start.EnvironmentVariables.Keys)) {
        if ($key -match '^(?:NEXUS(?:ROOM)?|DSH|NODE|PLAYWRIGHT|OPENAI|DEEPSEEK|ANTHROPIC)_') { $start.EnvironmentVariables.Remove($key) }
    }
    $start.EnvironmentVariables['Path'] = (@($env:SystemRoot, (Join-Path $env:SystemRoot 'System32'), (Join-Path $env:SystemRoot 'System32\Wbem'), (Split-Path $powershell -Parent)) -join ';')
    $start.EnvironmentVariables['NEXUS_DATA_DIR'] = $data
    $start.EnvironmentVariables['NEXUS_UI_PORT'] = [string]$ports.Ui
    $start.EnvironmentVariables['NEXUS_DEVICE_PORT'] = [string]$ports.Device
    $start.EnvironmentVariables['NEXUS_DISCOVERY_PORT'] = [string]$ports.Discovery
    $start.EnvironmentVariables['NEXUS_DISABLE_MDNS'] = '1'
    if ($fallback) { $start.EnvironmentVariables['NEXUS_FORCE_BUNDLED_BROWSER_UI'] = '1' }
    $process = [Diagnostics.Process]::Start($start)
    $context = [pscustomobject]@{
        Name=$name; Data=$data; Ports=$ports; Process=$process
        Owned=(New-Object 'System.Collections.Generic.Dictionary[int,object]')
    }
    $context.Owned.Add($process.Id, [pscustomobject]@{ Id=$process.Id; StartTicks=$process.StartTime.ToUniversalTime().Ticks; Name='NexusRoom.Host.exe'; Path=$exe })
    $contexts.Add($context)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) { throw "$name Host exited during startup with code $($process.ExitCode)." }
        $health = $null
        try {
            $health = Invoke-RestMethod -Uri ("http://127.0.0.1:$($ports.Ui)/health") -TimeoutSec 2
        } catch {
            # PowerShell 7 wraps startup connection/timeout failures differently
            # from Windows PowerShell. A failed bounded readiness probe retries.
        }
        if ($null -ne $health) {
            if ($health.version -ne $release.version) { throw 'Another version responded on a GUI test port.' }
            if (Test-Path -LiteralPath (Join-Path $data 'launch.dat')) { return $context }
        }
        Start-Sleep -Milliseconds 250
    }
    throw "$name Host failed to become ready."
}

function Wait-OwnedWindow($context, [bool]$fallback) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Refresh-OwnedProcesses $context
        $ids = @($context.Owned.Values | Where-Object { Test-OwnedProcess $_ } | ForEach-Object { [int]$_.Id })
        if ($ids.Count -gt 0) {
            $windows = [NexusGuiAcceptanceNative]::VisibleWindows([int[]]$ids)
            foreach ($window in $windows) {
                $windowProcess = [uint32]0
                [NexusGuiAcceptanceNative]::GetWindowThreadProcessId([IntPtr]$window, [ref]$windowProcess) | Out-Null
                $entry = $context.Owned[[int]$windowProcess]
                if ([NexusGuiAcceptanceNative]::IsNexusRoomWindow([long]$window) -and (($fallback -and $entry.Name -eq 'chrome.exe') -or (!$fallback -and [int]$windowProcess -eq $context.Process.Id))) {
                    return [pscustomobject]@{ Handle=[long]$window; Owner=$entry }
                }
            }
        }
        $context.Process.Refresh()
        if ($context.Process.HasExited) { throw "$($context.Name) Host exited before its GUI was available." }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$($context.Name) owned visible GUI window was not found."
}

function Invoke-BoundedHelper([string]$script, [string[]]$arguments, [int]$timeout=20000) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $powershell
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" ' + ($arguments -join ' ')
    $helper = [Diagnostics.Process]::Start($start)
    try {
        if (!$helper.WaitForExit($timeout)) { $helper.Kill(); $helper.WaitForExit(3000) | Out-Null; throw 'GUI evidence helper timed out.' }
        if ($helper.ExitCode -ne 0) { throw "GUI evidence helper exited $($helper.ExitCode)." }
    } finally { $helper.Dispose() }
}

function Inspect-OwnedWindow($context, $window, [bool]$fallback) {
    if (!(Test-OwnedProcess $window.Owner)) { throw 'The GUI window owner has changed.' }
    [NexusGuiAcceptanceNative]::ShowWindow([IntPtr]$window.Handle, 9) | Out-Null
    [NexusGuiAcceptanceNative]::SetForegroundWindow([IntPtr]$window.Handle) | Out-Null
    $accessibility = $null
    $uiaFile = Join-Path $evidence ($context.Name + '-accessibility.json')
    for ($attempt=0; $attempt -lt 15; $attempt++) {
        Start-Sleep -Milliseconds 900
        try {
            Invoke-BoundedHelper (Join-Path $PSScriptRoot 'windows-ui-accessibility.ps1') @('-WindowHandle', [string]$window.Handle, '-Version', $release.version, '-Output', ('"' + $uiaFile + '"'))
            $accessibility = Get-Content -LiteralPath $uiaFile -Raw | ConvertFrom-Json
            if ($accessibility.releaseText -and $accessibility.roomOverview -and $accessibility.localService -and $accessibility.roomContent) { break }
        } catch { $accessibility = [pscustomobject]@{ available=$false; releaseText=$false; roomOverview=$false; localService=$false; roomContent=$false; errorType=$_.Exception.GetType().Name } }
    }
    Refresh-OwnedProcesses $context
    $renderer = if ($fallback) { 'chrome.exe' } else { 'msedgewebview2.exe' }
    if (!@($context.Owned.Values | Where-Object { $_.Name -eq $renderer -and (Test-OwnedProcess $_) }).Count) { throw "$($context.Name) did not start its expected $renderer renderer." }
    $screenshot = Join-Path $evidence ($context.Name + '.png')
    if ($ScreenshotHelper -and (Test-Path -LiteralPath $ScreenshotHelper -PathType Leaf)) {
        Invoke-BoundedHelper $ScreenshotHelper @('-Path', ('"' + $screenshot + '"'), '-WindowHandle', [string]$window.Handle)
    } else { $screenshot = $null }
    return [pscustomobject]@{
        mode=$context.Name; hostVersion=$release.version; outsideProjectWorkingDirectory=$true; developerRuntimePathExcluded=$true
        ownedVisibleWindow=$true; renderer=$renderer; accessibility=$accessibility
        renderedPageAutomaticallyVerified=($accessibility.releaseText -and $accessibility.roomOverview -and $accessibility.localService -and $accessibility.roomContent)
        screenshot=$screenshot; screenCaptureMayIncludeOccludingWindows=$true
    }
}

function Close-OwnedWindow($context, $window) {
    $currentOwner = [uint32]0
    [NexusGuiAcceptanceNative]::GetWindowThreadProcessId([IntPtr]$window.Handle, [ref]$currentOwner) | Out-Null
    if ($currentOwner -ne $window.Owner.Id -or !(Test-OwnedProcess $window.Owner)) { throw 'Refusing to close a GUI whose ownership changed.' }
    if (![NexusGuiAcceptanceNative]::PostMessage([IntPtr]$window.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'The owned window did not accept WM_CLOSE.' }
    if (!$context.Process.WaitForExit(12000)) { throw "$($context.Name) Host remained running after its GUI was closed." }
    if ($context.Process.ExitCode -ne 0) { throw "$($context.Name) Host exited with $($context.Process.ExitCode)." }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $alive = @($context.Owned.Values | Where-Object { Test-OwnedProcess $_ })
        if ($alive.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($alive.Count -gt 0) { throw "$($context.Name) left owned renderer processes running." }
    Assert-PortsFree $context.Ports
}

try {
    $normalPorts = [pscustomobject]@{ Ui=$PortBase; Device=$PortBase+1; Discovery=$PortBase+2 }
    $fallbackPorts = [pscustomobject]@{ Ui=$PortBase+10; Device=$PortBase+11; Discovery=$PortBase+12 }
    $normal = Start-OwnedHost 'webview2' (Join-Path $evidence 'webview-state') $normalPorts $false
    $window = Wait-OwnedWindow $normal $false
    $normalResult = Inspect-OwnedWindow $normal $window $false
    Close-OwnedWindow $normal $window
    $normalResult | Add-Member NoteProperty windowCloseStopsHostAndReleasesPorts $true
    $results.Add($normalResult)
    Write-Host 'PASS WebView2 window, expected renderer, graceful GUI-close shutdown and released ports.'

    $browserData = Join-Path $evidence 'chromium-state'
    $fallback = Start-OwnedHost 'chromium' $browserData $fallbackPorts $true
    $window = Wait-OwnedWindow $fallback $true
    $fallbackResult = Inspect-OwnedWindow $fallback $window $true
    Close-OwnedWindow $fallback $window
    $fallbackResult | Add-Member NoteProperty windowCloseStopsHostAndReleasesPorts $true
    $browserAclAfterFirstStart = Get-Acl -LiteralPath $browserDirectory
    $sandboxRules = $browserAclAfterFirstStart.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    foreach ($identity in @('S-1-15-2-1', 'S-1-15-2-2')) {
        $matches = @($sandboxRules | Where-Object {
            $_.IdentityReference.Value -eq $identity -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            ($_.FileSystemRights -band $rights) -eq $rights -and ($_.InheritanceFlags -band $inheritance) -eq $inheritance -and
            $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
        })
        if (!$matches.Count) { throw 'The fallback did not prepare the bundled browser sandbox read/execute rule.' }
    }
    foreach ($directory in $ancestorAcls.Keys) { if ((Get-Acl -LiteralPath $directory).Sddl -ne $ancestorAcls[$directory]) { throw 'Fallback startup changed an ancestor directory ACL.' } }
    $fallbackResult | Add-Member NoteProperty sandboxReadExecuteRulesPrepared $true
    $fallbackResult | Add-Member NoteProperty ancestorDirectoryAclsUnchanged $true
    $results.Add($fallbackResult)
    Write-Host 'PASS bundled Chromium window, expected renderer, graceful GUI-close shutdown and released ports.'

    $preferencesPath = Join-Path $browserData 'browser-ui\profile\Default\Preferences'
    if (!(Test-Path -LiteralPath $preferencesPath -PathType Leaf)) { throw 'Bundled Chromium did not persist its version-local profile.' }
    $preferences = Get-Content -LiteralPath $preferencesPath -Raw | ConvertFrom-Json
    $downloadDirectory = Join-Path $evidence 'persisted-download-directory'
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    if (!$preferences.PSObject.Properties['download']) { $preferences | Add-Member NoteProperty download ([pscustomobject]@{}) }
    $preferences.download | Add-Member NoteProperty default_directory $downloadDirectory -Force
    [IO.File]::WriteAllText($preferencesPath, ($preferences | ConvertTo-Json -Depth 100 -Compress), (New-Object Text.UTF8Encoding($false)))
    $restart = Start-OwnedHost 'chromium-restart' $browserData $fallbackPorts $true
    $window = Wait-OwnedWindow $restart $true
    $restartResult = Inspect-OwnedWindow $restart $window $true
    Close-OwnedWindow $restart $window
    $persisted = Get-Content -LiteralPath $preferencesPath -Raw | ConvertFrom-Json
    if ($persisted.download.default_directory -ne $downloadDirectory) { throw 'The same-version bundled Chromium preference did not survive restart.' }
    if ((Get-Acl -LiteralPath $browserDirectory).Sddl -ne $browserAclAfterFirstStart.Sddl) { throw 'A repeat fallback startup changed equivalent browser ACL rules.' }
    foreach ($directory in $ancestorAcls.Keys) { if ((Get-Acl -LiteralPath $directory).Sddl -ne $ancestorAcls[$directory]) { throw 'Fallback restart changed an ancestor directory ACL.' } }
    $restartResult | Add-Member NoteProperty windowCloseStopsHostAndReleasesPorts $true
    $restartResult | Add-Member NoteProperty sameVersionProfilePreferencePersisted $true
    $restartResult | Add-Member NoteProperty equivalentBrowserAclsUnchanged $true
    $results.Add($restartResult)
    Write-Host 'PASS bundled Chromium restart preserves the profile preference.'
    $requiresReview = @($results | Where-Object { !$_.renderedPageAutomaticallyVerified }).Count -gt 0
    $packageIdentity = [ordered]@{
        directory=$package
        hostExeSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
        hostDllSha256=(Get-FileHash -LiteralPath (Join-Path $package 'NexusRoom.Host.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
        releaseMetadataSha256=(Get-FileHash -LiteralPath (Join-Path $package 'release.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $report = [ordered]@{ version=$release.version; packageIdentity=$packageIdentity; lifecycleAndPersistencePassed=$true; renderingAutomaticallyVerified=(!$requiresReview); evidenceDirectory=$evidence; tests=$results.ToArray(); visualReviewRequired=$requiresReview }
    $reportPath = Join-Path $evidence 'gui-acceptance.json'
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    Write-Host ("GUI acceptance report: $reportPath")
    if ($report.visualReviewRequired) { throw 'GUI acceptance did not verify every required rendered-page label. The report records the incomplete evidence; this release gate has failed.' }
} finally {
    # Stop only exact PID/start-time pairs created by this test, never by image name.
    foreach ($context in $contexts) {
        try { Refresh-OwnedProcesses $context } catch { }
        foreach ($entry in @($context.Owned.Values | Sort-Object StartTicks -Descending)) {
            if (Test-OwnedProcess $entry) {
                try { Stop-Process -Id $entry.Id -ErrorAction Stop } catch { }
            }
        }
        $context.Process.Dispose()
    }
    Write-Host ("Isolated GUI evidence/state retained at: $evidence")
}
