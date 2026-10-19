
param(
  [Parameter(Mandatory = $true)]
  [string]$Query,
  [switch]$ListOnly,
  [switch]$Launch
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

$ErrorActionPreference = 'SilentlyContinue'
$q = $Query.Trim().ToLowerInvariant()
$qNoExt = $q -replace '\.(exe|lnk|url)$', ''
$results = New-Object System.Collections.ArrayList

function Add-Result([string]$Name, [string]$Target, [string]$Method, [string]$Path = '') {
  [void]$results.Add([pscustomobject]@{
    name   = $Name
    target = $Target
    method = $Method
    path   = $Path
  })
}

function Start-Result($item) {
  if ($item.method -eq 'startapp') {
    Start-Process 'explorer.exe' -ArgumentList $item.target
  } else {
    Start-Process -FilePath $item.target
  }

  [pscustomobject]@{ ok = $true; name = $item.name; target = $item.target; method = $item.method } |
    ConvertTo-Json -Compress
}

# 1) Accesos directos del escritorio y del menú Inicio
$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  'C:\Users\Public\Desktop',
  [Environment]::GetFolderPath('StartMenu'),
  'C:\ProgramData\Microsoft\Windows\Start Menu\Programs'
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$links = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue
}

foreach ($link in $links) {
  $name = $link.BaseName.ToLowerInvariant()
  $score = -1
  if ($name -eq $q -or $name -eq $qNoExt) { $score = 3 }
  elseif ($name.StartsWith($qNoExt)) { $score = 2 }
  elseif ($name -like "*$qNoExt*") { $score = 1 }
  if ($score -gt 0) {
    Add-Result $link.BaseName $link.FullName 'shortcut' $link.FullName
  }
}

# Coincidencia exacta en un acceso directo: abrir ya, sin seguir buscando.
if ($Launch) {
  $exact = $results | Where-Object {
    $_.name.ToLowerInvariant() -eq $q -or $_.name.ToLowerInvariant() -eq $qNoExt
  } | Select-Object -First 1

  if ($exact) {
    Start-Result $exact
    exit 0
  }
}

# 2) Aplicaciones del menú Inicio / UWP
$startApps = @()
try {
  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.NameSpace('shell:AppsFolder')
  $startApps = @($folder.Items() | ForEach-Object {
      [pscustomobject]@{ Name = $_.Name; AppID = $_.Path }
    })
} catch {}
$shell = $null

foreach ($app in $startApps) {
  $name = $app.Name.ToLowerInvariant()
  if ($name -eq $q -or $name -like "*$qNoExt*") {
    Add-Result $app.Name ("shell:AppsFolder\" + $app.AppID) 'startapp' $app.AppID
  }
}

# 3) App Paths del registro
$appPathRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
)
foreach ($root in $appPathRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($entry in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
    $exe = $entry.PSChildName
    $base = ($exe -replace '\.exe$', '').ToLowerInvariant()
    if ($base -eq $qNoExt -or $base -like "*$qNoExt*") {
      $target = (Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue).'(default)'
      if (-not $target) { $target = (Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue).Path }
      if ($target) { Add-Result $exe $target 'apppath' $target }
    }
  }
}

# 4) Programas instalados (DisplayName -> InstallLocation)
$uninstallRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($app in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
    $props = Get-ItemProperty -LiteralPath $app.PSPath -ErrorAction SilentlyContinue
    if (-not $props.DisplayName) { continue }
    $name = $props.DisplayName.ToLowerInvariant()
    if ($name -ne $q -and $name -notlike "*$qNoExt*") { continue }

    $candidate = $null
    if ($props.DisplayIcon) {
      $icon = ($props.DisplayIcon -replace '^"', '') -replace '",.*$', '' -replace ',\d+$', ''
      if ($icon -match '\.exe$' -and (Test-Path $icon)) { $candidate = $icon }
    }
    if (-not $candidate -and $props.InstallLocation -and (Test-Path $props.InstallLocation)) {
      $exe = Get-ChildItem -LiteralPath $props.InstallLocation -Filter *.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'unins|update|setup' } |
        Sort-Object Length -Descending |
        Select-Object -First 1
      if ($exe) { $candidate = $exe.FullName }
    }
    if ($candidate) { Add-Result $props.DisplayName $candidate 'installed' $candidate }
  }
}

# 5) Comandos del PATH
$cmd = Get-Command $qNoExt -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cmd -and $cmd.Source) { Add-Result $qNoExt $cmd.Source 'path' $cmd.Source }

# Quitar duplicados y ordenar
$unique = @()
$seen = @{}
foreach ($item in $results) {
  $key = ($item.target + '|' + $item.name).ToLowerInvariant()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $unique += $item
}

if ($ListOnly) {
  $unique | Select-Object -First 15 | ConvertTo-Json -Compress
  exit 0
}

$best = $unique | Select-Object -First 1
if (-not $best) {
  [pscustomobject]@{ ok = $false; error = 'not_found'; suggestions = @() } | ConvertTo-Json -Compress
  exit 0
}

if ($Launch) {
  try {
    if ($best.method -eq 'startapp') {
      Start-Process 'explorer.exe' -ArgumentList $best.target
    } else {
      Start-Process -FilePath $best.target
    }
    [pscustomobject]@{ ok = $true; name = $best.name; target = $best.target; method = $best.method } | ConvertTo-Json -Compress
    exit 0
  } catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message; target = $best.target } | ConvertTo-Json -Compress
    exit 0
  }
}

[pscustomobject]@{ ok = $true; name = $best.name; target = $best.target; method = $best.method; suggestions = @($unique | Select-Object -First 5) } | ConvertTo-Json -Compress

