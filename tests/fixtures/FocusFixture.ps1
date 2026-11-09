param([Parameter(Mandatory=$true)][string]$StateFile,[switch]$Activate,[switch]$Click)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class FixtureNative {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
 [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
 [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort Key,Scan; public uint Flags,Time; public UIntPtr Extra; }
 [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
 [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public Union Data; }
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr w);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool BringWindowToTop(IntPtr w);
 [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SetActiveWindow(IntPtr w);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool ShowWindow(IntPtr w,int n);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr w,IntPtr after,int x,int y,int cx,int cy,uint flags);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool IsIconic(IntPtr w);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowRect(IntPtr w,out Rect r);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetClipCursor(out Rect r);
 [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint process);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool AttachThreadInput(uint a,uint b,bool on);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SystemParametersInfo(uint action,uint param,out uint value,uint flags);
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,Input[] input,int size);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint process);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token,int info,IntPtr data,int size,out int need);
 public static uint Pid(IntPtr window) { uint p; GetWindowThreadProcessId(window,out p);return p; }
 public static string Integrity(uint id) { var p=OpenProcess(0x1000,false,id);if(p==IntPtr.Zero)return "unavailable"; IntPtr token=IntPtr.Zero;try{if(!OpenProcessToken(p,8,out token))return "unavailable";int size;GetTokenInformation(token,25,IntPtr.Zero,0,out size);var buffer=Marshal.AllocHGlobal(size);try{if(!GetTokenInformation(token,25,buffer,size,out size))return "unavailable";return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;}finally{Marshal.FreeHGlobal(buffer);}}finally{if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(p);} }
 public static uint ClickAt(int x,int y) { var values=new Input[]{new Input{Type=0,Data=new Union{Mouse=new MouseInput{Flags=2}}},new Input{Type=0,Data=new Union{Mouse=new MouseInput{Flags=4}}}};return SendInput(2,values,Marshal.SizeOf(typeof(Input))); }
 public static uint UnlockForeground() { var values=new Input[]{new Input{Type=1,Data=new Union{Keyboard=new KeyboardInput{Key=0x12}}},new Input{Type=1,Data=new Union{Keyboard=new KeyboardInput{Key=0x12,Flags=2}}}};return SendInput(2,values,Marshal.SizeOf(typeof(Input))); }
}
'@
$taskState=$null
for($taskReadAttempt=0;$taskReadAttempt -lt 40;$taskReadAttempt++) {
 try {
  $taskCandidate=[IO.File]::ReadAllText($StateFile)|ConvertFrom-Json
  if($null -ne $taskCandidate -and $taskCandidate.pid -gt 0 -and $taskCandidate.hwnd -gt 0 -and $taskCandidate.textbox.width -gt 0 -and $taskCandidate.textbox.height -gt 0 -and $taskCandidate.snapshotAt -gt 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$taskCandidate.snapshotAt -lt 1000) {$taskState=$taskCandidate;break}
 }catch {}
 Start-Sleep -Milliseconds 25
}
if($null -eq $taskState){throw 'Refusing activation: no complete, fresh fixture snapshot'}
$taskWindow=[IntPtr]$taskState.hwnd
$taskForeground=[FixtureNative]::GetForegroundWindow()
[uint32]$taskForegroundPid=0
$taskForegroundThread=[FixtureNative]::GetWindowThreadProcessId($taskForeground,[ref]$taskForegroundPid)
[uint32]$taskFixturePid=0
$taskFixtureThread=[FixtureNative]::GetWindowThreadProcessId($taskWindow,[ref]$taskFixturePid)
if($taskFixturePid -ne $taskState.pid -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$taskState.snapshotAt -gt 1000){throw 'Refusing activation: fixture identity or snapshot is stale'}
$taskNativePoint=[FixtureNative+Point]::new();$taskNativePoint.X=[int]($taskState.textbox.x+$taskState.textbox.width/2);$taskNativePoint.Y=[int]($taskState.textbox.y+$taskState.textbox.height/2)
$taskHit=[FixtureNative]::WindowFromPoint($taskNativePoint)
$taskClip=[FixtureNative+Rect]::new();[FixtureNative]::GetClipCursor([ref]$taskClip)|Out-Null
$taskRect=[FixtureNative+Rect]::new();[FixtureNative]::GetWindowRect($taskWindow,[ref]$taskRect)|Out-Null
$taskCursor=[FixtureNative+Point]::new();[FixtureNative]::GetCursorPos([ref]$taskCursor)|Out-Null
[uint32]$taskLock=0;[FixtureNative]::SystemParametersInfo(0x2000,0,[ref]$taskLock,0)|Out-Null
$taskResult=[ordered]@{fixturePid=$taskFixturePid;foregroundPid=$taskForegroundPid;fixtureIntegrity=([FixtureNative]::Integrity($taskFixturePid));foregroundIntegrity=([FixtureNative]::Integrity($taskForegroundPid));fixtureVisible=[FixtureNative]::IsWindowVisible($taskWindow);fixtureIconic=[FixtureNative]::IsIconic($taskWindow);fixtureRect=$taskRect;point=$taskNativePoint;hitPid=([FixtureNative]::Pid($taskHit));clip=$taskClip;cursor=$taskCursor;foregroundLockTimeout=$taskLock;fixtureThread=$taskFixtureThread;foregroundThread=$taskForegroundThread}
if($Activate){
 $taskResult.altNavigation=[FixtureNative]::UnlockForeground()
 $taskCurrent=[FixtureNative]::GetCurrentThreadId();$taskAttachedForeground=[FixtureNative]::AttachThreadInput($taskCurrent,$taskForegroundThread,$true);$taskAttachedFixture=[FixtureNative]::AttachThreadInput($taskCurrent,$taskFixtureThread,$true)
 try{
  # A hidden helper's STARTUPINFO overrides its first ShowWindow call even
  # when the HWND belongs to another process. SWP_SHOWWINDOW is explicit.
  [FixtureNative]::ShowWindow($taskWindow,5)|Out-Null;[FixtureNative]::SetWindowPos($taskWindow,[IntPtr](-1),0,0,0,0,0x43)|Out-Null
  $taskResult.bring=[FixtureNative]::BringWindowToTop($taskWindow);$taskResult.active=[FixtureNative]::SetActiveWindow($taskWindow).ToInt64();$taskResult.foreground=[FixtureNative]::SetForegroundWindow($taskWindow);$taskResult.error=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
 }finally{if($taskAttachedFixture){[FixtureNative]::AttachThreadInput($taskCurrent,$taskFixtureThread,$false)|Out-Null};if($taskAttachedForeground){[FixtureNative]::AttachThreadInput($taskCurrent,$taskForegroundThread,$false)|Out-Null}}
 $taskResult.afterPid=[FixtureNative]::Pid([FixtureNative]::GetForegroundWindow())
 $taskResult.afterHitPid=[FixtureNative]::Pid([FixtureNative]::WindowFromPoint($taskNativePoint))
 $taskResult.afterVisible=[FixtureNative]::IsWindowVisible($taskWindow)
 $taskAfterRect=[FixtureNative+Rect]::new();[FixtureNative]::GetWindowRect($taskWindow,[ref]$taskAfterRect)|Out-Null;$taskResult.afterRect=$taskAfterRect
}
if($Click){
 if([FixtureNative]::Pid([FixtureNative]::WindowFromPoint($taskNativePoint)) -ne $taskFixturePid){$taskResult.refused='point does not hit fixture';$taskResult|ConvertTo-Json -Depth 4 -Compress;exit 1}
 $taskResult.moved=[FixtureNative]::SetCursorPos($taskNativePoint.X,$taskNativePoint.Y)
 [FixtureNative]::GetCursorPos([ref]$taskCursor)|Out-Null
 if([FixtureNative]::Pid([FixtureNative]::WindowFromPoint($taskCursor)) -ne $taskFixturePid){throw 'Refusing initial activation click: actual cursor does not hit fixture'}
 $taskResult.click=[FixtureNative]::ClickAt($taskCursor.X,$taskCursor.Y)
}
$taskResult|ConvertTo-Json -Depth 4 -Compress
