param(
  [Parameter(Mandatory = $true)]
  [string]$CurrentDirectory,

  [Parameter(Mandatory = $true)]
  [string]$StagedDirectory,

  [Parameter(Mandatory = $true)]
  [int]$ExpectedProcessId
)

$ErrorActionPreference = 'Stop'
$current = [IO.Path]::GetFullPath($CurrentDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$staged = [IO.Path]::GetFullPath($StagedDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$parent = [IO.Path]::GetDirectoryName($current)
$logPath = Join-Path $parent 'still-update-last.log'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$prepared = Join-Path $parent "win-unpacked-prepared-$timestamp"
$backup = Join-Path $parent "win-unpacked-previous-$timestamp"
$validated = $false
$movedCurrent = $false

function Write-UpdateLog([string]$message) {
  try {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $message" -Encoding UTF8
  } catch {}
}

function Rename-DirectoryWithRetry([string]$source, [string]$destination) {
  if ([IO.Path]::GetDirectoryName($source) -ne [IO.Path]::GetDirectoryName($destination)) {
    throw 'Update directories must share a parent.'
  }
  $deadline = (Get-Date).AddSeconds(20)
  do {
    try {
      Rename-Item -LiteralPath $source -NewName ([IO.Path]::GetFileName($destination)) -ErrorAction Stop
      return
    } catch {
      if ((Get-Date) -gt $deadline) { throw }
      Start-Sleep -Milliseconds 500
    }
  } while ($true)
}

try {
  if ([IO.Path]::GetFileName($current) -ne 'win-unpacked' -or
      [IO.Path]::GetDirectoryName($staged) -ne $parent -or
      [IO.Path]::GetFileName($staged) -notlike 'win-unpacked-update*') {
    throw 'The update paths are outside the expected Still installation.'
  }
  $validated = $true
  foreach ($requiredPath in @(
    (Join-Path $current 'Still.exe'),
    (Join-Path $staged 'Still.exe'),
    (Join-Path $staged 'resources\app.asar')
  )) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Required update file is missing: $requiredPath"
    }
  }
  if ((Test-Path -LiteralPath $prepared) -or (Test-Path -LiteralPath $backup)) {
    throw 'An update working directory already exists.'
  }

  Write-UpdateLog "START staged=$staged process=$ExpectedProcessId"
  $deadline = (Get-Date).AddSeconds(35)
  while (Get-Process -Id $ExpectedProcessId -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw 'Still did not exit within 35 seconds.' }
    Start-Sleep -Milliseconds 250
  }

  $deadline = (Get-Date).AddSeconds(45)
  do {
    $usingCurrentDirectory = @(
      Get-CimInstance Win32_Process -Filter "Name = 'Still.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
          $_.ExecutablePath -and
          $_.ExecutablePath.StartsWith($current + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
        }
    )
    if ($usingCurrentDirectory.Count -eq 0) { break }
    if ((Get-Date) -gt $deadline) { throw 'Still still has processes using its old files.' }
    Start-Sleep -Milliseconds 500
  } while ($true)

  # Copy first: Windows can keep the staged app.asar open while Still is
  # running. A prepared sibling is independent and can be renamed atomically.
  Copy-Item -LiteralPath $staged -Destination $prepared -Recurse -Force
  foreach ($requiredPath in @(
    (Join-Path $prepared 'Still.exe'),
    (Join-Path $prepared 'resources\app.asar')
  )) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Prepared update is incomplete: $requiredPath"
    }
  }
  Write-UpdateLog "PREPARED path=$prepared"

  Rename-DirectoryWithRetry $current $backup
  $movedCurrent = $true
  Rename-DirectoryWithRetry $prepared $current
  New-Item -ItemType File -Path (Join-Path $staged '.still-update-applied') -Force | Out-Null
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath (Join-Path $current 'Still.exe') -WorkingDirectory $current -WindowStyle Normal
  Write-UpdateLog "SUCCESS installed=$current backup=$backup"
} catch {
  Write-UpdateLog "FAIL $($_.Exception.Message)"
  if ($validated) {
    try {
      if ($movedCurrent -and -not (Test-Path -LiteralPath $current) -and
          (Test-Path -LiteralPath (Join-Path $backup 'Still.exe'))) {
        Rename-DirectoryWithRetry $backup $current
        Write-UpdateLog 'RESTORED previous build'
      }
      if (Test-Path -LiteralPath (Join-Path $current 'Still.exe')) {
        $running = Get-CimInstance Win32_Process -Filter "Name = 'Still.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.ExecutablePath -eq (Join-Path $current 'Still.exe') }
        if (-not $running) {
          Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
          Start-Process -FilePath (Join-Path $current 'Still.exe') -WorkingDirectory $current -WindowStyle Normal
          Write-UpdateLog 'RELAUNCHED available build after failure'
        }
      }
    } catch {
      Write-UpdateLog "RECOVERY FAILED $($_.Exception.Message)"
    }
  }
  exit 1
}
