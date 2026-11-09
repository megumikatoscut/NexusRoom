$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$fixture=Join-Path $projectRoot ('.local\android-pc-viewport-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
& javac -encoding UTF-8 --release 17 -d $fixture (Join-Path $projectRoot 'android\app\src\main\java\com\nexusroom\android\PcViewport.java') (Join-Path $projectRoot 'android\app\src\main\java\com\nexusroom\android\PcImeState.java') (Join-Path $PSScriptRoot 'java\com\nexusroom\android\PcViewportTest.java') (Join-Path $PSScriptRoot 'java\com\nexusroom\android\PcImeStateTest.java')
if ($LASTEXITCODE -ne 0) {throw 'Android PC viewport regression compilation failed.'}
& java -cp $fixture com.nexusroom.android.PcViewportTest
if ($LASTEXITCODE -ne 0) {throw 'Android PC viewport regression checks failed.'}
& java -cp $fixture com.nexusroom.android.PcImeStateTest
if ($LASTEXITCODE -ne 0) {throw 'Android direct IME regression checks failed.'}
