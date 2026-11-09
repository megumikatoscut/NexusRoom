param([Parameter(ValueFromRemainingArguments=$true)][string[]]$GradleArguments)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$saved=Save-NexusEnvironment
try {
    $java=Get-NexusJava
    $paths=Get-NexusPaths
    $wrapper=Initialize-NexusGradleWrapper
    $env:JAVA_HOME=$java.Home
    $env:ANDROID_HOME=Get-NexusAndroidSdk
    $env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
    if (!$env:GRADLE_USER_HOME) {$env:GRADLE_USER_HOME=$paths.GradleUser}
    $env:GRADLE_USER_HOME=Assert-NexusExternalDirectory $env:GRADLE_USER_HOME 'GRADLE_USER_HOME'
    if (!$env:NEXUS_ANDROID_APP_BUILD_DIR) {$env:NEXUS_ANDROID_APP_BUILD_DIR=$paths.AndroidApp}
    if (!$env:NEXUS_ANDROID_BUILD_DIR) {$env:NEXUS_ANDROID_BUILD_DIR=$paths.AndroidRoot}
    # Avoid keeping redirected CMD/PowerShell output handles alive after a build.
    # Interactive developers can explicitly opt into --daemon.
    $daemonArguments=if ('--daemon' -in $GradleArguments -or '--no-daemon' -in $GradleArguments) {@()} else {@('--no-daemon')}
    $arguments=@('-classpath',$wrapper,'org.gradle.wrapper.GradleWrapperMain','--project-dir',(Join-Path (Get-NexusRoot) 'android'),'--project-cache-dir',(Join-Path $paths.Cache 'android\project-cache'))+$daemonArguments+@($GradleArguments)
    Invoke-NexusNative $java.Executable $arguments 'Gradle'
} finally {Restore-NexusEnvironment $saved}
$global:LASTEXITCODE=0
