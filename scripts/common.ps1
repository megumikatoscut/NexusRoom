# Shared Windows PowerShell 5.1 / PowerShell 7 helpers. No installed dependency
# or user data belongs in the source repository.
$script:NexusScriptsRoot=$PSScriptRoot
. (Join-Path $PSScriptRoot 'submission-paths.ps1')
. (Join-Path $PSScriptRoot 'resolve-windows-payload.ps1')

function Get-NexusRoot { return [IO.Path]::GetFullPath((Split-Path $script:NexusScriptsRoot -Parent)).TrimEnd('\') }
function Get-NexusRelease { return (Get-Content -LiteralPath (Join-Path (Get-NexusRoot) 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json) }
function Get-NexusDependencyLock { return (Get-Content -LiteralPath (Join-Path (Get-NexusRoot) 'dependencies.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json) }

function Assert-NexusExternalDirectory([string]$Path,[string]$Label='Dependency directory',[string[]]$Visited=@()) {
    if (!$Path -or ![IO.Path]::IsPathRooted($Path)) {throw ($Label+' must be an absolute directory outside the repository.')}
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) {throw ($Label+' must name a dedicated directory, not a drive root.')}
    if ($full -in $Visited -or $Visited.Count -ge 32) {throw ($Label+' contains a cyclic or overly deep directory link.')}
    $root=Get-NexusRoot
    if ($full.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {throw ($Label+' must stay outside the repository.')}
    # A directory junction must not hide installed dependencies inside the repo.
    $cursor=$full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item=Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                foreach ($target in @($item.Target)) {
                    if (!$target) {continue}
                    $resolved=if ([IO.Path]::IsPathRooted($target)) {[IO.Path]::GetFullPath($target)} else {[IO.Path]::GetFullPath((Join-Path (Split-Path $cursor -Parent) $target))}
                    [void](Assert-NexusExternalDirectory $resolved $Label ($Visited+@($full)))
                }
            }
        }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

function Get-NexusCacheRoot {
    $release=Get-NexusRelease
    $cache=if ($env:NEXUS_CACHE_DIR) {$env:NEXUS_CACHE_DIR} else {Join-Path $env:USERPROFILE ('.cache\NexusRoom\build-cache\v'+$release.version)}
    return (Assert-NexusExternalDirectory $cache 'NEXUS_CACHE_DIR')
}

function Get-NexusToolchainConfiguration {
    $file=Join-Path (Get-NexusCacheRoot) 'toolchain.json'
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $configuration=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($configuration.schemaVersion -ne 1) {throw 'Unsupported external toolchain.json schema; reconfigure the external cache.'}
        return $configuration
    }
    return [pscustomobject]@{schemaVersion=1;androidSdk=''}
}

function Save-NexusAndroidSdkConfiguration([string]$Sdk) {
    $sdkFull=Assert-NexusExternalDirectory $Sdk 'Android SDK'
    if (!(Test-Path -LiteralPath $sdkFull -PathType Container)) {throw 'Cannot remember an Android SDK directory that does not exist.'}
    $cache=Get-NexusCacheRoot
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $configuration=[ordered]@{schemaVersion=1;androidSdk=$sdkFull}
    [IO.File]::WriteAllText((Join-Path $cache 'toolchain.json'),($configuration | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}

function Add-NexusToolPath([string]$Directory) {
    if (!$Directory) {return}
    $remaining=@($env:PATH -split ';' | Where-Object {$_ -and !$_.TrimEnd('\').Equals($Directory.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)})
    $env:PATH=(@($Directory)+$remaining) -join ';'
}

function Get-NexusDotnet([switch]$RequireSdk) {
    $command=Get-Command dotnet -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates=@()
    foreach ($directory in @($env:DOTNET_ROOT_X64,$env:DOTNET_ROOT,(Join-Path $env:ProgramFiles 'dotnet'),(Join-Path $env:USERPROFILE '.dotnet'))) {if ($directory) {$candidates+=@(Join-Path $directory 'dotnet.exe')}}
    if ($command) {$candidates+=@($command.Source)}
    $required=(Get-NexusDependencyLock).dotnet.sdk
    $runtimeFallback=$null
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) {continue}
        $sdks=(& $candidate --list-sdks 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0 -or ($RequireSdk -and $sdks -notmatch ('(?m)^'+[regex]::Escape($required)+'\s'))) {continue}
        $runtimes=(& $candidate --list-runtimes 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0) {continue}
        $result=[pscustomobject]@{Executable=$candidate;Home=(Split-Path $candidate -Parent);Sdks=$sdks;Runtimes=$runtimes}
        if ($RequireSdk) {return $result}
        if ($runtimes -match 'Microsoft.NETCore.App 10\.') {
            if ($runtimes -match 'Microsoft.AspNetCore.App 10\.' -and $runtimes -match 'Microsoft.WindowsDesktop.App 10\.') {return $result}
            if (!$runtimeFallback) {$runtimeFallback=$result}
        }
    }
    if ($runtimeFallback) {return $runtimeFallback}
    throw ('Required .NET '+$(if ($RequireSdk) {'SDK '+$required} else {'10 runtime host'})+' is missing. Run scripts/check-environment.ps1 -InstallMissing.')
}

function Get-NexusGit {
    $command=Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates=@((Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'))
    if ($command) {$candidates=@($command.Source)+$candidates}
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) {continue}
        $version=(& $candidate --version 2>$null) -join ' '
        if ($LASTEXITCODE -eq 0 -and $version -match '^git version 2\.') {return [pscustomobject]@{Executable=$candidate;Home=(Split-Path $candidate -Parent);Version=$version}}
    }
    throw 'Git for Windows 2.x is missing. Run scripts/check-environment.ps1 -InstallMissing, or install Git from https://git-scm.com/downloads/win.'
}

function Get-NexusPaths {
    $cache=Get-NexusCacheRoot
    $release=Get-NexusRelease
    $lock=Get-NexusDependencyLock
    return [pscustomobject]@{
        Cache=$cache; Downloads=(Join-Path $cache 'downloads'); Tools=(Join-Path $cache 'tools')
        Node=(Join-Path $cache ('tools\node-v'+$release.pcKernel.nodeVersion+'-win-x64'))
        Pnpm=(Join-Path $cache ('tools\pnpm-'+$lock.pnpm.version))
        HarnessSource=(Join-Path $cache ('sources\deepseek-harness-'+$release.pcKernel.commit))
        HarnessRuntime=(Join-Path $cache 'harness-runtime'); HarnessPrimary=(Join-Path $cache 'harness-primary')
        Browsers=(Join-Path $cache 'browsers'); GradleWrapper=(Join-Path $cache 'gradle-wrapper')
        GradleUser=(Join-Path $cache 'gradle-user'); AndroidApp=(Join-Path $cache 'android\app')
        AndroidRoot=(Join-Path $cache 'android\root'); Nuget=(Join-Path $cache 'nuget')
        Scrcpy=(Join-Path $cache ('tools\scrcpy-win64-v'+$lock.scrcpy.version))
    }
}

function Assert-NexusChildPath([string]$Path,[string]$Parent) {
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    $parentFull=[IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if (!$full.StartsWith($parentFull+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Generated path escaped its intended parent.'}
    $cursor=$full
    while ($cursor.Length -ge $parentFull.Length) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Refusing a linked generated path.'}
        if ($cursor.Equals($parentFull,[StringComparison]::OrdinalIgnoreCase)) {break}
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

function Remove-NexusGenerated([string]$Path,[string]$Parent) {
    $full=Assert-NexusChildPath $Path $Parent
    if (Test-Path -LiteralPath $full) {Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop}
}

function Invoke-NexusNative([string]$Command,[string[]]$Arguments,[string]$Label) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {throw "$Label failed (exit $LASTEXITCODE)."}
}

function Get-NexusVerifiedDownload([string]$Url,[string]$Sha256,[string]$Destination) {
    if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') {throw 'Downloads must have a pinned SHA-256.'}
    $destinationFull=Assert-NexusChildPath $Destination (Get-NexusCacheRoot)
    if (Test-Path -LiteralPath $destinationFull -PathType Leaf) {
        if ((Get-FileHash -LiteralPath $destinationFull -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256.ToLowerInvariant()) {return $destinationFull}
        throw ('Cached download checksum mismatch; remove the invalid file and retry: '+$destinationFull)
    }
    New-Item -ItemType Directory -Path (Split-Path $destinationFull -Parent) -Force | Out-Null
    $pending=$destinationFull+'.download-'+[guid]::NewGuid().ToString('N')
    $oldProgress=$ProgressPreference
    try {
        [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference='SilentlyContinue'
        for ($attempt=1; $attempt -le 3; $attempt++) {
            try {
                $curl=Join-Path $env:SystemRoot 'System32\curl.exe'
                if (Test-Path -LiteralPath $curl -PathType Leaf) {
                    # curl bounds both connection and transfer time on Windows
                    # where PowerShell 5.1 can stall beyond TimeoutSec.
                    Invoke-NexusNative $curl @('--fail','--location','--silent','--show-error','--connect-timeout','30','--max-time','600','--output',$pending,$Url) 'Official archive download'
                } else {Invoke-WebRequest -Uri $Url -OutFile $pending -UseBasicParsing -TimeoutSec 180}
                break
            }
            catch {
                if ($attempt -eq 3) {throw ('Official download failed after 3 attempts; check network/proxy and rerun. '+$_.Exception.Message)}
                Write-Host ('Download interrupted; retry '+($attempt+1)+'/3.')
                Start-Sleep -Seconds (2*$attempt)
            }
        }
        if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256.ToLowerInvariant()) {throw 'Downloaded archive SHA-256 mismatch.'}
        Move-Item -LiteralPath $pending -Destination $destinationFull
    } finally {
        $ProgressPreference=$oldProgress
        if (Test-Path -LiteralPath $pending) {Remove-Item -LiteralPath $pending -Force}
    }
    return $destinationFull
}

function Get-NexusReleaseNode([string]$WorkspaceRoot='', $Release=$null) {
    if (!$Release) {$Release=Get-NexusRelease}
    $paths=Get-NexusPaths
    $expected='v'+$Release.pcKernel.nodeVersion
    $command=Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates=@($env:NEXUS_NODE_EXE,(Join-Path $paths.Node 'node.exe'))
    if ($command) {$candidates+=@($command.Source)}
    foreach ($candidate in $candidates) {
        if (!$candidate -or !(Test-Path -LiteralPath $candidate -PathType Leaf)) {continue}
        $actual=(& $candidate --version 2>$null)
        $npmCli=Join-Path (Split-Path $candidate -Parent) 'node_modules\npm\bin\npm-cli.js'
        if ($LASTEXITCODE -eq 0 -and $actual -eq $expected -and (Test-Path -LiteralPath $npmCli -PathType Leaf)) {
            return [pscustomobject]@{Executable=[IO.Path]::GetFullPath($candidate);NpmCli=$npmCli;Version=$expected}
        }
    }
    throw "Pinned Node $expected with npm is missing. Run scripts/init.ps1."
}

function Initialize-NexusNode {
    try {return (Get-NexusReleaseNode)} catch { }
    $release=Get-NexusRelease
    $paths=Get-NexusPaths
    $name='node-v'+$release.pcKernel.nodeVersion+'-win-x64.zip'
    $archive=Get-NexusVerifiedDownload ('https://nodejs.org/dist/v'+$release.pcKernel.nodeVersion+'/'+$name) $release.pcKernel.nodeArchiveSha256 (Join-Path $paths.Downloads $name)
    $stage=Join-Path $paths.Cache ('node-extract-'+[guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $stage
        New-Item -ItemType Directory -Path $paths.Tools -Force | Out-Null
        if (Test-Path -LiteralPath $paths.Node) {Remove-NexusGenerated $paths.Node $paths.Cache}
        Move-Item -LiteralPath (Join-Path $stage ('node-v'+$release.pcKernel.nodeVersion+'-win-x64')) -Destination $paths.Node
    } finally {Remove-NexusGenerated $stage $paths.Cache}
    return (Get-NexusReleaseNode)
}

function Initialize-NexusNpmProject([string]$Project,[string]$CacheName) {
    $root=Get-NexusRoot
    $projectFull=Assert-NexusChildPath $Project $root
    $paths=Get-NexusPaths
    $destination=Join-Path $paths.Cache ('npm-projects\'+$CacheName)
    [void](Assert-NexusChildPath $destination $paths.Cache)
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $inputHash=((Get-FileHash -LiteralPath (Join-Path $projectFull 'package.json') -Algorithm SHA256).Hash+(Get-FileHash -LiteralPath (Join-Path $projectFull 'package-lock.json') -Algorithm SHA256).Hash)
    $stamp=Join-Path $destination 'LOCK_INPUTS.sha256'
    $mutex=New-Object Threading.Mutex($false,('Local\NexusRoom-Npm-'+$CacheName+'-'+(Get-NexusRelease).version))
    $locked=$false
    try {
        $locked=$mutex.WaitOne(60000)
        if (!$locked) {throw 'Another process is installing these npm dependencies. Retry after it completes.'}
        $valid=(Test-Path -LiteralPath $stamp -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $destination 'node_modules\.bin') -PathType Container) -and ([IO.File]::ReadAllText($stamp) -eq $inputHash)
        if (!$valid) {
            foreach ($file in @('package.json','package-lock.json')) {Copy-Item -LiteralPath (Join-Path $projectFull $file) -Destination (Join-Path $destination $file) -Force}
            $node=Get-NexusReleaseNode
            Invoke-NexusNative $node.Executable @($node.NpmCli,'ci','--prefix',$destination,'--no-audit','--no-fund') ($CacheName+' locked npm dependencies')
            [IO.File]::WriteAllText($stamp,$inputHash,[Text.UTF8Encoding]::new($false))
        }
    } finally {if ($locked) {$mutex.ReleaseMutex()}; $mutex.Dispose()}
    $link=Join-Path $projectFull 'node_modules'
    $target=Join-Path $destination 'node_modules'
    if (Test-Path -LiteralPath $link) {
        $item=Get-Item -LiteralPath $link -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if (@($item.Target)[0] -eq $target) {return}
            [IO.Directory]::Delete($link)
        } else {Remove-NexusGenerated $link $root}
    }
    # Create the junction with the same runtime that installed the packages.
    # This also avoids differing MSIX filesystem views between Node and .NET.
    $node=Get-NexusReleaseNode
    Invoke-NexusNative $node.Executable @((Join-Path $script:NexusScriptsRoot 'npm-junction.mjs'),$link,$target) ($CacheName+' dependency junction')
}

function Get-NexusJava {
    $candidates=@()
    foreach ($javaHome in @($env:JAVA_HOME,[Environment]::GetEnvironmentVariable('JAVA_HOME','User'),[Environment]::GetEnvironmentVariable('JAVA_HOME','Machine'))) {if ($javaHome) {$candidates+=@(Join-Path $javaHome 'bin\java.exe')}}
    $command=Get-Command java -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {$candidates+=@($command.Source)}
    foreach ($vendor in @('Eclipse Adoptium','Java','Microsoft','OpenJDK','Amazon Corretto','BellSoft')) {
        $vendorRoot=Join-Path $env:ProgramFiles $vendor
        foreach ($directory in Get-ChildItem -LiteralPath $vendorRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending) {
            if ($directory.Name -match '(?i)(jdk|java|corretto|liberica)') {$candidates+=@(Join-Path $directory.FullName 'bin\java.exe')}
        }
    }
    $candidates+=@(Join-Path $env:ProgramFiles 'Android\Android Studio\jbr\bin\java.exe')
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) {continue}
        $previousPreference=$ErrorActionPreference
        try {$ErrorActionPreference='Continue'; $output=(& $candidate -version 2>&1 | ForEach-Object {$_.ToString()}) -join ' '}
        finally {$ErrorActionPreference=$previousPreference}
        $match=[regex]::Match($output,'version\s+"(?:1\.)?(\d+)')
        $javac=Join-Path (Split-Path $candidate -Parent) 'javac.exe'
        if ($match.Success -and [int]$match.Groups[1].Value -ge 17 -and [int]$match.Groups[1].Value -le 23 -and (Test-Path -LiteralPath $javac -PathType Leaf)) {
            return [pscustomobject]@{Executable=$candidate;Home=(Split-Path (Split-Path $candidate -Parent) -Parent);Major=[int]$match.Groups[1].Value}
        }
    }
    throw 'Gradle 8.11.1 requires JDK 17 through 23 for this project. Use JDK 17 or 21 and set JAVA_HOME; scripts/check-environment.ps1 -InstallMissing can install Temurin 17.'
}

function Get-NexusAndroidSdk([string]$Sdk='') {
    if ($Sdk) {
        $sdkFull=Assert-NexusExternalDirectory $Sdk 'Android SDK'
        if (!(Test-Path -LiteralPath $sdkFull -PathType Container)) {throw ('The requested Android SDK does not exist: '+$sdkFull)}
        return $sdkFull
    }
    $configuration=Get-NexusToolchainConfiguration
    $candidates=@($env:ANDROID_HOME,$env:ANDROID_SDK_ROOT,$configuration.androidSdk,[Environment]::GetEnvironmentVariable('ANDROID_HOME','User'),[Environment]::GetEnvironmentVariable('ANDROID_HOME','Machine'),(Join-Path $env:LOCALAPPDATA 'Android\Sdk'),(Join-Path $env:USERPROFILE '.cache\NexusRoom\android-sdk'))
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {return (Assert-NexusExternalDirectory $candidate 'Android SDK')}
    }
    throw 'Android SDK is missing. Run scripts/setup-android-sdk.ps1 or setup-dev.cmd; see docs/SETUP.md.'
}

function Initialize-NexusGradleWrapper {
    $paths=Get-NexusPaths
    $lock=Get-NexusDependencyLock
    $jar=Get-NexusVerifiedDownload $lock.gradle.wrapperUrl $lock.gradle.wrapperSha256 (Join-Path $paths.GradleWrapper 'gradle-wrapper.jar')
    Copy-Item -LiteralPath (Join-Path (Get-NexusRoot) 'android\gradle\wrapper\gradle-wrapper.properties') -Destination (Join-Path $paths.GradleWrapper 'gradle-wrapper.properties') -Force
    return $jar
}

function Save-NexusEnvironment {
    $saved=@{}
    foreach ($name in @('PATH','JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','GRADLE_USER_HOME','NUGET_PACKAGES','NEXUS_ANDROID_APP_BUILD_DIR','NEXUS_ANDROID_BUILD_DIR','NEXUS_NODE_EXE','NEXUS_HARNESS_DIR','NEXUS_PRIMARY_RUNTIME','NEXUS_SCRCPY_DIR','PLAYWRIGHT_BROWSERS_PATH','DSH_CLIENT_COMMIT_HASH','DSH_DESKTOP_BUILD_COMMIT','npm_config_cache','PNPM_HOME','PNPM_STORE_DIR')) {$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
    return $saved
}
function Restore-NexusEnvironment($Saved) { foreach ($name in $Saved.Keys) {[Environment]::SetEnvironmentVariable($name,$Saved[$name],'Process')} }

function Set-NexusBuildEnvironment([string]$AndroidSdk='', [switch]$WithoutAndroid) {
    $paths=Get-NexusPaths
    $node=Get-NexusReleaseNode
    Add-NexusToolPath (Split-Path $node.Executable -Parent)
    $dotnet=Get-NexusDotnet -RequireSdk
    Add-NexusToolPath $dotnet.Home
    try {$git=Get-NexusGit; Add-NexusToolPath $git.Home} catch { }
    $env:NEXUS_NODE_EXE=$node.Executable
    $env:npm_config_cache=Join-Path $paths.Cache 'npm-cache'
    if (!$env:GRADLE_USER_HOME) {$env:GRADLE_USER_HOME=$paths.GradleUser}
    if (!$env:NUGET_PACKAGES) {$env:NUGET_PACKAGES=$paths.Nuget}
    $env:GRADLE_USER_HOME=Assert-NexusExternalDirectory $env:GRADLE_USER_HOME 'GRADLE_USER_HOME'
    $env:NUGET_PACKAGES=Assert-NexusExternalDirectory $env:NUGET_PACKAGES 'NUGET_PACKAGES'
    $env:NEXUS_ANDROID_APP_BUILD_DIR=$paths.AndroidApp
    $env:NEXUS_ANDROID_BUILD_DIR=$paths.AndroidRoot
    $env:PLAYWRIGHT_BROWSERS_PATH=$paths.Browsers
    $env:PNPM_HOME=$paths.Pnpm
    $env:PNPM_STORE_DIR=Join-Path $paths.Cache 'pnpm-store'
    if (!$WithoutAndroid) {
        $java=Get-NexusJava
        $env:JAVA_HOME=$java.Home
        $env:ANDROID_HOME=Get-NexusAndroidSdk $AndroidSdk
        $env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
    }
    Set-NexusRuntimeEnvironment
}

function Set-NexusRuntimeEnvironment {
    $paths=Get-NexusPaths
    $release=Get-NexusRelease
    $runtime=if ($env:NEXUS_HARNESS_DIR) {$env:NEXUS_HARNESS_DIR} else {$paths.HarnessRuntime}
    $manifest=Join-Path $runtime 'runtime-manifest.json'
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $metadata=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($metadata.release -ne $release.version -or $metadata.kernel.commit -ne $release.pcKernel.commit) {throw 'External Harness cache version mismatch. Run scripts/setup-harness.ps1.'}
        $env:NEXUS_HARNESS_DIR=$runtime
    }
    try {$env:NEXUS_NODE_EXE=(Get-NexusReleaseNode).Executable} catch { }
    $primary=if ($env:NEXUS_PRIMARY_RUNTIME) {$env:NEXUS_PRIMARY_RUNTIME} else {Join-Path $paths.HarnessPrimary 'primary-runtime'}
    if (Test-Path -LiteralPath (Join-Path $primary 'runtime.json') -PathType Leaf) {
        $metadata=Get-Content -LiteralPath (Join-Path $primary 'runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($metadata.payloadDigest -ne $release.pcKernel.primaryRuntime.payloadDigest) {throw 'External Office primary runtime digest mismatch.'}
        $env:NEXUS_PRIMARY_RUNTIME=$primary
    }
    if (!$env:PLAYWRIGHT_BROWSERS_PATH) {$env:PLAYWRIGHT_BROWSERS_PATH=$paths.Browsers}
    if (!$env:NEXUS_SCRCPY_DIR) {$env:NEXUS_SCRCPY_DIR=$paths.Scrcpy}
}

function Assert-NexusVersions {
    $root=Get-NexusRoot
    $release=Get-NexusRelease
    $web=(Get-Content -LiteralPath (Join-Path $root 'src\NexusRoom.Web\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $hostVersion=([xml](Get-Content -LiteralPath (Join-Path $root 'src\NexusRoom.Host\NexusRoom.Host.csproj') -Raw -Encoding UTF8)).Project.PropertyGroup.Version
    $gradle=Get-Content -LiteralPath (Join-Path $root 'android\app\build.gradle') -Raw -Encoding UTF8
    $android=[regex]::Match($gradle,"versionName\s+'([^']+)'").Groups[1].Value
    $code=[regex]::Match($gradle,'versionCode\s+(\d+)').Groups[1].Value
    if ($web -ne $release.version -or @($hostVersion)[0] -ne $release.version -or $android -ne $release.version -or [int]$code -ne $release.androidVersionCode) {throw 'Windows / Web / Android versions differ from release.json.'}
}

# Newly built packages are separate from the immutable submitted clients.
function Get-NexusBuildReleaseRoot {
    $target=if ($env:NEXUS_BUILD_ARTIFACT_DIR) {$env:NEXUS_BUILD_ARTIFACT_DIR} else {Join-Path (Get-NexusCacheRoot) 'release-output'}
    $full=Assert-NexusExternalDirectory $target 'NEXUS_BUILD_ARTIFACT_DIR'
    $submission=Get-NexusSubmissionRoot (Get-NexusRoot)
    if ($submission -and ($full.Equals($submission,[StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($submission+'\',[StringComparison]::OrdinalIgnoreCase))) {throw 'New release outputs must stay outside the preserved submission.'}
    return $full
}
function Get-NexusBuildArtifactPath([string]$Name) {
    $folder=if ($Name -match '^NexusRoom-Windows[^\\/]*\.exe$') {'Windows'} elseif ($Name -match '^NexusRoom-Android[^\\/]*\.apk$') {'Android'} else {throw 'Unsupported build artifact name.'}
    return Join-Path (Join-Path (Get-NexusBuildReleaseRoot) $folder) $Name
}
function Get-NexusBuildChecksumName([string]$File) {
    $folder=if ([IO.Path]::GetExtension($File) -eq '.exe') {'Windows/'} else {'Android/'}
    return $folder+[IO.Path]::GetFileName($File)
}
