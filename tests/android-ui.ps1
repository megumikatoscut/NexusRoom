param([ValidateSet('dump','tap','scroll','screenshot')][string]$Action='dump',[string]$Text,[string]$Output='',[string]$Serial='127.0.0.1:16384')
$ErrorActionPreference='Stop'
if (!$Output) {$Output=Join-Path (Split-Path $PSScriptRoot -Parent) '.local\android.png'}
if ($Action -eq 'screenshot') {New-Item -ItemType Directory -Path (Split-Path $Output -Parent) -Force | Out-Null}
if ($Action -eq 'screenshot') {
    & adb -s $Serial shell screencap -p /sdcard/nexusroom-qa.png
    & adb -s $Serial pull /sdcard/nexusroom-qa.png $Output
    exit
}
$raw = (& adb -s $Serial exec-out uiautomator dump /dev/tty) -join "`n"
$start=$raw.IndexOf('<?xml')
$end=$raw.LastIndexOf('</hierarchy>')
if ($start -lt 0 -or $end -lt 0) { throw 'UI tree unavailable' }
[xml]$tree=$raw.Substring($start,$end+12-$start)
$nodes=@($tree.SelectNodes('//node'))
if ($Action -eq 'dump') {
    $nodes | Where-Object { $_.text -ne '' -or $_.scrollable -eq 'true' } | ForEach-Object { $label=if ($_.password -eq 'true') {'[password]'} else {$_.text.Replace("`n",' ')}; if ($label.Length -gt 120) {$label=$label.Substring(0,120)+'…'}; "$label | $($_.class.Split('.')[-1]) | checked=$($_.checked) | $($_.bounds)" }
    exit
}
if ($Action -eq 'tap') { $node=$nodes | Where-Object { $_.text -eq $Text -or $_.'content-desc' -eq $Text } | Select-Object -First 1 }
else { $node=$nodes | Where-Object { $_.scrollable -eq 'true' } | Select-Object -First 1 }
if (!$node) { throw "UI target not found: $Text" }
$coordinates=[regex]::Matches($node.bounds,'\d+') | ForEach-Object {[int]$_.Value}
$cx=[int](($coordinates[0]+$coordinates[2])/2)
$cy=[int](($coordinates[1]+$coordinates[3])/2)
if ($Action -eq 'tap') { & adb -s $Serial shell input tap $cx $cy }
else { $top=[int]($coordinates[1]+($coordinates[3]-$coordinates[1])*0.2); $bottom=[int]($coordinates[1]+($coordinates[3]-$coordinates[1])*0.8); if ($Text -eq 'up') { & adb -s $Serial shell input swipe $cx $top $cx $bottom 400 } else { & adb -s $Serial shell input swipe $cx $bottom $cx $top 400 } }
