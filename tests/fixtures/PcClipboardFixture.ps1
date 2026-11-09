param([switch]$FromEnvironment)
$ErrorActionPreference='Stop'
if(-not ('NexusFixtureClipboard' -as [type])){
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;
public static class NexusFixtureClipboard {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(uint ex,string cls,string name,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
 [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
 [DllImport("user32.dll",SetLastError=true)] static extern bool OpenClipboard(IntPtr window);
 [DllImport("user32.dll")] static extern bool CloseClipboard();
 [DllImport("user32.dll",SetLastError=true)] static extern bool EmptyClipboard();
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetClipboardData(uint format,IntPtr memory);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags,UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalLock(IntPtr memory);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
 public static void SetText(string value){
  var owner=CreateWindowEx(0,"STATIC","NexusRoom clipboard QA",0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
  if(owner==IntPtr.Zero)throw new Win32Exception();
  IntPtr memory=IntPtr.Zero;bool opened=false;
  try{
   for(int retry=0;retry<20&&!opened;retry++){opened=OpenClipboard(owner);if(!opened)Thread.Sleep(25);}
   if(!opened)throw new Win32Exception();
   if(!EmptyClipboard())throw new Win32Exception();
   if(String.IsNullOrEmpty(value))return;
   var bytes=System.Text.Encoding.Unicode.GetBytes(value+"\0");memory=GlobalAlloc(0x42,new UIntPtr((uint)bytes.Length));if(memory==IntPtr.Zero)throw new Win32Exception();
   var address=GlobalLock(memory);if(address==IntPtr.Zero)throw new Win32Exception();
   try{Marshal.Copy(bytes,0,address,bytes.Length);}finally{GlobalUnlock(memory);}
   if(SetClipboardData(13,memory)==IntPtr.Zero)throw new Win32Exception();memory=IntPtr.Zero;
  }finally{if(memory!=IntPtr.Zero)GlobalFree(memory);if(opened)CloseClipboard();DestroyWindow(owner);}
 }
}
'@
}
if($FromEnvironment){[NexusFixtureClipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:NEXUS_FIXTURE_CLIPBOARD_TEXT)))}
