param(
  [Parameter(Mandatory = $true)][string]$MigrationDirectory,
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
if (Get-Process -Name TENYING_AI -ErrorAction SilentlyContinue) { throw 'Close TENYING_AI before cleanup.' }

function FullPath([string]$Value) {
  return [IO.Path]::GetFullPath($Value).TrimEnd('\')
}
function Inside([string]$Root, [string]$File) {
  return (FullPath $File).StartsWith((FullPath $Root) + '\', [StringComparison]::OrdinalIgnoreCase)
}
function AssertNoLinks([string]$Root, [string]$File) {
  $current = FullPath $File
  while ($current -and ((Inside $Root $current) -or $current -eq (FullPath $Root))) {
    if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing linked path: $current"
    }
    if ($current -eq (FullPath $Root)) { break }
    $current = [IO.Path]::GetDirectoryName($current)
  }
}

$dataRoot = FullPath (Join-Path $env:APPDATA 'LocalApiImageGenerator_RuntimeData_V1498')
$oldRoot = FullPath (Join-Path $env:APPDATA 'LocalApiImageGenerator_RuntimeData_V1458')
$allowedSources = @((Join-Path $dataRoot 'uploads'), (Join-Path $oldRoot 'uploads'))
$config = Get-Content -LiteralPath (Join-Path $dataRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$runtime = Join-Path $config.output_dir ([string][char]0x8fd0 + [char]0x884c + [char]0x6570 + [char]0x636e + [char]0x76ee + [char]0x5f55)
$work = FullPath $MigrationDirectory
if (-not (Inside $runtime $work)) { throw 'Migration directory is outside configured output.' }
$manifest = Get-Content -LiteralPath (Join-Path $work 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$audit = Get-Content -LiteralPath (Join-Path $work 'audit-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ((FullPath $manifest.dataRoot) -ne $dataRoot -or $audit.mode -ne 'audit' -or $audit.verifiedReferences -ne 0) {
  throw 'Reference audit has not passed.'
}
$destinationRoot = Join-Path $runtime 'uploads'
$records = @($manifest.records)
$checkedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($row in $records) {
  $source = FullPath $row.source
  $validRoot = @($allowedSources | Where-Object { Inside $_ $source })
  if ($validRoot.Count -ne 1 -or -not (Inside $destinationRoot $row.destination) -or -not $row.verified -or $row.sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Unapproved manifest path or checksum: $source"
  }
  $sourceParent = [IO.Path]::GetDirectoryName($source)
  $destParent = [IO.Path]::GetDirectoryName($row.destination)
  if ((Test-Path -LiteralPath $sourceParent) -and $checkedDirectories.Add($sourceParent)) { AssertNoLinks $validRoot[0] $sourceParent }
  if ($checkedDirectories.Add($destParent)) { AssertNoLinks $destinationRoot $destParent }
}
Write-Output ("Validated {0} files, {1:N3} GiB" -f $records.Count, (($records | Measure-Object size -Sum).Sum / 1GB))
if ($ValidateOnly) { return }

$removed = 0
$bytes = [long]0
$lastLog = Get-Date
$failures = [Collections.Generic.List[object]]::new()
$worker = {
  $ErrorActionPreference = 'Stop'
  $row = $_
  function FileSha256([string]$File) {
    $stream = [IO.FileStream]::new($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
  }
  try {
    $source = [IO.Path]::GetFullPath($row.source)
    $dest = Get-Item -LiteralPath $row.destination -Force
    if ($dest.PSIsContainer -or $dest.Length -ne $row.size -or ($dest.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Destination size/type changed' }
    if ((FileSha256 $row.destination) -ne $row.sha256) { throw 'Destination checksum changed' }
    if (Test-Path -LiteralPath $source) {
      $src = Get-Item -LiteralPath $source -Force
      if ($src.PSIsContainer -or $src.Length -ne $row.size -or ($src.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Source size/type changed' }
      $mtime = ([DateTimeOffset]$src.LastWriteTimeUtc).ToUnixTimeMilliseconds()
      if ([Math]::Abs($mtime - $row.mtimeMs) -gt 2) { throw 'Source modified after migration' }
      if ((FileSha256 $source) -ne $row.sha256) { throw 'Source checksum changed' }
      Remove-Item -LiteralPath $source -Force
    }
    [pscustomobject]@{ Source = $source; Bytes = $row.size; Error = $null }
  } catch {
    [pscustomobject]@{ Source = $row.source; Bytes = 0; Error = $_.Exception.Message }
  }
}
$collect = {
  if ($_.Error) { $failures.Add($_) }
  else { $removed++; $bytes += $_.Bytes }
  if ($removed % 500 -eq 0 -or ((Get-Date) - $lastLog).TotalSeconds -ge 30) {
    Write-Output ("Removed/verified {0}/{1}; freed {2:N3} GiB; errors {3}" -f $removed, $records.Count, ($bytes / 1GB), $failures.Count)
    $lastLog = Get-Date
  }
}
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $records | ForEach-Object -Parallel $worker -ThrottleLimit 4 | ForEach-Object $collect
} else {
  $records | ForEach-Object $worker | ForEach-Object $collect
}
if ($failures.Count) {
  $failures | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $work 'cleanup-errors.json') -Encoding utf8
  throw "$($failures.Count) files were kept because verification failed."
}

$cachePaths = @((Join-Path $env:LOCALAPPDATA 'TENYING_AI\HotCache'))
foreach ($root in @($dataRoot, $oldRoot)) {
  foreach ($name in @('Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage')) {
    $cachePaths += Join-Path $root $name
  }
}
$cacheBytes = [long]0
foreach ($target in $cachePaths) {
  $resolved = FullPath $target
  $allowed = (Inside $dataRoot $resolved) -or (Inside $oldRoot $resolved) -or ($resolved -eq (FullPath (Join-Path $env:LOCALAPPDATA 'TENYING_AI\HotCache')))
  if (-not $allowed) { throw "Unsafe cache path: $resolved" }
  if (-not (Test-Path -LiteralPath $resolved)) { continue }
  AssertNoLinks ([IO.Path]::GetDirectoryName($resolved)) $resolved
  $items = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)
  if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw "Linked cache entry: $resolved" }
  $cacheBytes += ($items | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

$remaining = @()
foreach ($root in $allowedSources) {
  if (Test-Path -LiteralPath $root) {
    $remaining += @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)
    if (@(Get-ChildItem -LiteralPath $root -Recurse -File -Force).Count -eq 0) {
      $resolved = FullPath $root
      if ($resolved -notin $allowedSources) { throw 'Unsafe upload directory' }
      AssertNoLinks ([IO.Path]::GetDirectoryName($resolved)) $resolved
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }
}
$report = [ordered]@{ removedFiles = $removed; mediaBytes = $bytes; cacheBytes = $cacheBytes; freedBytes = $bytes + $cacheBytes; remainingUploadFiles = $remaining.Count; at = (Get-Date).ToString('o') }
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $work 'cleanup-report.json') -Encoding utf8
$report | ConvertTo-Json
