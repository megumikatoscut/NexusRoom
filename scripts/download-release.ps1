param([ValidateSet('All','Windows','Android')][string]$Platform='All')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$version=(Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$checksums=Join-Path $root ('docs\releases\v'+$version+'\SHA256SUMS.txt')
if (!(Test-Path -LiteralPath $checksums -PathType Leaf)) {throw 'The tracked release checksum manifest is missing.'}
$expected=@{}
foreach ($line in Get-Content -LiteralPath $checksums -Encoding UTF8) {
    if ($line -notmatch '^([0-9a-fA-F]{64})  ([^\\/]+)$') {throw 'Invalid release checksum manifest.'}
    $expected[$Matches[2]]=$Matches[1].ToLowerInvariant()
}
$names=@()
if ($Platform -in @('All','Windows')) {$names+='NexusRoom-Windows-x64-'+$version+'.exe'}
if ($Platform -in @('All','Android')) {$names+='NexusRoom-Android-'+$version+'.apk'}
$destination=Join-Path $root 'artifacts'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in $names) {
    if (!$expected.ContainsKey($name)) {throw ('No tracked checksum for '+$name)}
    $target=Join-Path $destination $name
    if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expected[$name]) {
        Write-Host ('PASS existing release asset: '+$name)
        continue
    }
    $temporary=Join-Path $destination ($name+'.download-'+[Guid]::NewGuid().ToString('N'))
    try {
        $url='https://github.com/megumikatoscut/NexusRoom/releases/download/v'+$version+'/'+$name
        Write-Host ('Downloading '+$name)
        Invoke-WebRequest -Uri $url -OutFile $temporary -UseBasicParsing
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected[$name]) {throw ('Release checksum mismatch: '+$name)}
        Move-Item -LiteralPath $temporary -Destination $target -Force
        Write-Host ('PASS downloaded release asset: '+$name)
    } finally {
        if (Test-Path -LiteralPath $temporary) {Remove-Item -LiteralPath $temporary -Force}
    }
}
