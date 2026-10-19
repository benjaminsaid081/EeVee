
param(
  [Parameter(Mandatory = $true)]
  [string]$Query,
  [string]$Roots,
  [int]$Max = 15
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

$limit = if ($Max -gt 0 -and $Max -le 60) { $Max } else { 15 }
$found = New-Object System.Collections.ArrayList

$rootList = @()
if ($Roots) { $rootList = $Roots -split '\|' }

foreach ($root in $rootList) {
  if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
  try {
    $items = Get-ChildItem -LiteralPath $root -Recurse -Depth 4 -Filter "*$Query*" -ErrorAction SilentlyContinue
    foreach ($item in $items) {
      if ($found.Count -ge $limit) { break }
      [void]$found.Add($item.FullName)
    }
  } catch { }
  if ($found.Count -ge $limit) { break }
}

$found | ForEach-Object { Write-Output $_ }

