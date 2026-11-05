// Starts Still on a copy of the persistent profile (its real tabs and
// session) and samples CPU use of Still's processes for the first seconds.
// Usage: node tools/startup-load.js [seconds]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launch } = require('./session');

const source = 'D:\\Still Firefox Prototype\\profile';
const copy = 'D:\\Still Firefox Prototype\\perf-profile';
const skip = new Set(['cache2', 'startupCache', 'parent.lock', 'lock', 'user.js']);

(async () => {
  const seconds = Number(process.argv[2] || 40);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(source, copy, { recursive: true, filter: (from) => !skip.has(path.basename(from)) });
  const sampler = spawn('powershell', ['-NoProfile', '-Command', `
    Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Shell { [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r); }
"@
    $tray = [Shell]::FindWindow('Shell_TrayWnd', $null)
    $cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
    $start = Get-Date
    while (((Get-Date) - $start).TotalSeconds -lt ${seconds}) {
      $sw = [Diagnostics.Stopwatch]::StartNew(); $r = [IntPtr]::Zero
      $ok = [Shell]::SendMessageTimeout($tray, 0, [IntPtr]::Zero, [IntPtr]::Zero, 2, 4000, [ref]$r)
      $shellMs = $sw.ElapsedMilliseconds
      $ff = @(Get-Process firefox, searxng-sidecar -ErrorAction SilentlyContinue)
      $cpu = 0; foreach ($p in $ff) { $cpu += $p.TotalProcessorTime.TotalMilliseconds }
      $gpu = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
      $gpuTotal = ($gpu | Measure-Object CookedValue -Sum).Sum
      $ffIds = $ff.Id
      $gpuStill = ($gpu | Where-Object { $_.InstanceName -match 'pid_(\d+)_' -and $ffIds -contains [int]$Matches[1] } | Measure-Object CookedValue -Sum).Sum
      $dwm = (Get-Process dwm).TotalProcessorTime.TotalMilliseconds
      "{0,5:N1}s shell={1,5}ms{2} stillCpuMs={5,8:N0} dwmCpuMs={6,8:N0} ws={7,6:N0}MB commit={8,6:N0}MB n={9}" -f ((Get-Date) - $start).TotalSeconds, $shellMs, $(if ($ok -eq [IntPtr]::Zero) {' HUNG'} else {''}), $gpuTotal, $gpuStill, $cpu, $dwm, (($ff | Measure-Object WorkingSet64 -Sum).Sum / 1MB), (($ff | Measure-Object PagedMemorySize64 -Sum).Sum / 1MB), $ff.Count
    }`], { stdio: ['ignore', 'inherit', 'inherit'] });
  const s = await launch({ profile: copy, cleanup: true });
  const pid = await s.marionette.chrome().then(() => s.marionette.run('return Services.appinfo.processID;'));
  console.log('main pid', pid);
  await new Promise((resolve) => sampler.on('exit', resolve));
  const info = await s.marionette.run(`return gBrowser.tabs.map((t) => (t.linkedBrowser.currentURI?.spec || '').slice(0, 80) + ' pid=' + (t.linkedBrowser.browsingContext?.currentWindowGlobal?.osPid || '-') + (t.selected ? ' *' : ''));`);
  console.log(info.join('\n'));
  console.log(require('node:child_process').execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'still-procs.ps1')]).toString());
  await s.stop();
})();
