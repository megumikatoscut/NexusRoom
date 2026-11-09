param(
    [Parameter(Mandatory=$true)][long]$WindowHandle,
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$Output
)

# Run in a bounded Windows PowerShell helper: some UI Automation providers block.
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ available=$false; releaseText=$false; roomOverview=$false; localService=$false; roomContent=$false; elements=0 }
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $window = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
    if ($null -eq $window) { throw 'The owned GUI window is no longer available.' }
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $result.available = $true
    $result.elements = $elements.Count
    foreach ($element in $elements) {
        try { $name = [string]$element.Current.Name } catch { continue }
        # Chromium may expose adjacent JSX text as separate accessibility nodes.
        if ($name -match ('(?:NexusRoom\s*)?v?\s*' + [regex]::Escape($Version) + '(?:\b|$)')) { $result.releaseText = $true }
        if ($name -eq '房间总览') { $result.roomOverview = $true }
        if ($name -like '*本地服务运行中*') { $result.localService = $true }
        if ($name -like '*房间设备*') { $result.roomContent = $true }
    }
} catch {
    # Return only an error class, never arbitrary page names or bootstrap tokens.
    $result.errorType = $_.Exception.GetType().Name
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Output), ($result | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
