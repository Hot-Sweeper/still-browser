# Saves the icon Windows shows for a process's main window (taskbar/Alt+Tab).
param([int]$ProcessId, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class StillIcon {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetClassLongPtr(IntPtr h, int i);
}
"@
$h = (Get-Process -Id $ProcessId).MainWindowHandle
$icon = [StillIcon]::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]0)
if ($icon -eq [IntPtr]::Zero) { $icon = [StillIcon]::GetClassLongPtr($h, -14) }
[System.Drawing.Icon]::FromHandle($icon).ToBitmap().Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
