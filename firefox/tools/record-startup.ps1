# Records a cold start of Still's runtime as window captures (no automation).
param([string]$Runtime, [string]$Profile, [string]$OutDir)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class StillRec {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[StillRec]::SetProcessDPIAware() | Out-Null
# Only the window this script starts is recorded and closed; any Still that
# was already open is left alone.
$before = @(Get-Process firefox -ErrorAction SilentlyContinue | ForEach-Object Id)
Start-Process -FilePath (Join-Path $Runtime 'firefox.exe') -ArgumentList @('-no-remote', '-profile', "`"$Profile`"")
$sw = [Diagnostics.Stopwatch]::StartNew(); $n = 0
while ($sw.ElapsedMilliseconds -lt 6000) {
  $p = Get-Process firefox -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Runtime*" -and $_.MainWindowHandle -ne 0 -and $before -notcontains $_.Id } | Select-Object -First 1
  if ($p) {
    $r = New-Object StillRec+RECT; [StillRec]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    if ($w -gt 100) {
      $bmp = New-Object System.Drawing.Bitmap $w, $hh; $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
      [StillRec]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
      $bmp.Save((Join-Path $OutDir ("start-{0:D2}-{1}ms.png" -f $n, $sw.ElapsedMilliseconds)), [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); $n++
    }
  }
  Start-Sleep -Milliseconds 90
}
Get-Process firefox -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Runtime*" -and $_.MainWindowHandle -ne 0 -and $before -notcontains $_.Id } | ForEach-Object { $_.CloseMainWindow() | Out-Null }
"frames: $n"
