[CmdletBinding(DefaultParameterSetName='Start')]
param(
    [Parameter(Mandatory=$true,ParameterSetName='Start')][string]$EvidenceDirectory,
    [Parameter(ParameterSetName='Start')][switch]$Tone,
    [Parameter(Mandatory=$true,ParameterSetName='Stop')][switch]$Stop,
    [Parameter(Mandatory=$true,ParameterSetName='Stop')][ValidateRange(1,2147483647)][int]$ProcessId,
    [Parameter(Mandatory=$true,ParameterSetName='Stop')][ValidateRange(1,[long]::MaxValue)][long]$StartTimeTicks
)
$ErrorActionPreference='Stop'
$taskPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if($Stop){
    $taskCurrent=Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if($null -eq $taskCurrent){@{stopped=$false;reason='already-exited'}|ConvertTo-Json -Compress;return}
    try {
        if($taskCurrent.StartTime.ToUniversalTime().Ticks -ne $StartTimeTicks -or
           ![string]::Equals($taskCurrent.Path,$taskPowerShell,[StringComparison]::OrdinalIgnoreCase)){
            throw 'Refusing to stop a process that does not match the fixture PID, start time and executable.'
        }
        # Kill the exact Process instance owned by this acceptance run, never all
        # PowerShell processes or an unverified process tree.
        $taskCurrent.Kill()
        if(!$taskCurrent.WaitForExit(5000)){throw 'The owned desktop fixture did not exit.'}
        @{stopped=$true;pid=$ProcessId}|ConvertTo-Json -Compress
    } finally {$taskCurrent.Dispose()}
    return
}

function ConvertTo-WindowsArgument([string]$Value){
    # Start-Process joins ArgumentList as command-line text on Windows. Quote by
    # the Windows argv rules, including quotes and trailing backslashes, rather
    # than treating a path with spaces as a PowerShell expression.
    $taskQuoted=[Text.StringBuilder]::new()
    [void]$taskQuoted.Append('"')
    $taskSlashes=0
    foreach($taskCharacter in $Value.ToCharArray()){
        if($taskCharacter -eq '\'){$taskSlashes++;continue}
        if($taskCharacter -eq '"'){
            [void]$taskQuoted.Append('\',($taskSlashes*2+1))
        } elseif($taskSlashes -gt 0){
            [void]$taskQuoted.Append('\',$taskSlashes)
        }
        [void]$taskQuoted.Append($taskCharacter)
        $taskSlashes=0
    }
    if($taskSlashes -gt 0){[void]$taskQuoted.Append('\',($taskSlashes*2))}
    [void]$taskQuoted.Append('"')
    $taskQuoted.ToString()
}

$taskFixture=Join-Path $PSScriptRoot 'PcRemoteFixture.ps1'
if(!(Test-Path -LiteralPath $taskFixture -PathType Leaf)){throw 'Desktop fixture script is missing.'}
$taskEvidence=[IO.Path]::GetFullPath($EvidenceDirectory)
[void][IO.Directory]::CreateDirectory($taskEvidence)
$taskArguments=@('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',$taskFixture,'-EvidenceDirectory',$taskEvidence)
if($Tone){$taskArguments+='-Tone'}
$taskCommandLine=($taskArguments|ForEach-Object {ConvertTo-WindowsArgument $_}) -join ' '

# On Windows, Start-Process without stream redirection uses ShellExecute. This
# isolates WinForms initialization from Node's CREATE_NO_WINDOW helper process;
# the PowerShell console stays hidden, and the disposable fixture shows itself.
$taskProcess=Start-Process -FilePath $taskPowerShell -ArgumentList $taskCommandLine -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
try {
    if($taskProcess.HasExited){throw 'Desktop fixture exited during startup.'}
    @{pid=$taskProcess.Id;startTimeTicks=$taskProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);
      executable=$taskPowerShell;script=$taskFixture;evidenceDirectory=$taskEvidence}|ConvertTo-Json -Compress
} finally {$taskProcess.Dispose()}
