param([string]$Destination = (Join-Path $PSScriptRoot '..\tools\scrcpy'))
$ErrorActionPreference = 'Stop'
$version = '4.1'
$checksum = '5b12172b3264b2889f4583ee64752ce832e29bc8b1089dca81093459697165db'
$archive = Join-Path $env:TEMP "nexusroom-scrcpy-$version.zip"
$staging = Join-Path $env:TEMP ('nexusroom-scrcpy-' + [Guid]::NewGuid().ToString('N'))
Invoke-WebRequest "https://github.com/Genymobile/scrcpy/releases/download/v$version/scrcpy-win64-v$version.zip" -OutFile $archive
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $checksum) { throw 'scrcpy archive SHA-256 mismatch. Installation stopped.' }
Expand-Archive -LiteralPath $archive -DestinationPath $staging
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Copy-Item -Path (Join-Path $staging "scrcpy-win64-v$version\*") -Destination $Destination -Recurse -Force
Write-Host "Verified scrcpy $version installed at $Destination"
