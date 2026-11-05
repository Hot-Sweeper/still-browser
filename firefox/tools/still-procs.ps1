# Lists Still's processes (Firefox runtime and Still Search) with private memory.
Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'firefox.exe','searxng-sidecar.exe' } | ForEach-Object {
  $cl = [string]$_.CommandLine
  $kind = 'main'
  if ($cl -match '-contentproc') { $kind = ($cl -split '\s+')[-1] }
  $remote = ''
  if ($cl -match 'remoteType\s+(\S+)') { $remote = $Matches[1] }
  '{0,7} {1,6:N0}MB {2} {3} {4}' -f $_.ProcessId, ($_.PrivatePageCount / 1MB), $_.Name, $kind, $remote
}
