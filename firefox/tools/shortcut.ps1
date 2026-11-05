# Writes a Windows shortcut, including its taskbar identity (AppUserModelID),
# so a pinned shortcut and the running Still window share one taskbar button.
param([string]$Lnk, [string]$Exe, [string]$Arguments, [string]$WorkDir, [string]$Icon, [string]$AppId)
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($Lnk)
$s.TargetPath = $Exe; $s.Arguments = $Arguments; $s.WorkingDirectory = $WorkDir
$s.IconLocation = "$Icon,0"; $s.Description = "Still"; $s.Save()
if (-not $AppId) { $AppId = 'HotSweeper.Still' }
Add-Type @"
using System; using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, Pack = 4)] public struct StillPropKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit, Size = 24)] public struct StillPropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IStillPropertyStore {
  int GetCount(out uint c); int GetAt(uint i, out StillPropKey k);
  int GetValue(ref StillPropKey k, out StillPropVariant v); int SetValue(ref StillPropKey k, ref StillPropVariant v); int Commit();
}
public static class StillAppId {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid iid, out IStillPropertyStore store);
  [DllImport("shell32.dll")] static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);
  public static void Set(string path, string id) {
    Guid iid = typeof(IStillPropertyStore).GUID; IStillPropertyStore store;
    SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
    var key = new StillPropKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var value = new StillPropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
    Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
    Marshal.ThrowExceptionForHR(store.Commit());
    Marshal.FreeCoTaskMem(value.p); Marshal.ReleaseComObject(store);
    SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
  }
}
"@
[StillAppId]::Set($Lnk, $AppId)
# Refresh Windows' icon cache so pinned and Start menu icons update now.
Start-Process -FilePath "$env:windir\System32\ie4uinit.exe" -ArgumentList '-show' -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
