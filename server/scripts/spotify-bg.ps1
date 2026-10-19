# Reproduce una URI de Spotify en segundo plano.
# - Arranca Spotify minimizado si no estaba abierto.
# - Envía la URI (canción/álbum/artista) y oculta su ventana.
# - Usa la sesión multimedia de Windows para asegurar la reproducción sin
#   enviar un play/pause ciego que pausaría la música si ya estaba sonando.

param(
  [string]$Uri = '',
  [int]$HideMs = 1400,
  [switch]$DryRun,
  [switch]$StartOnly
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class EvSpotifyNative {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

function Get-SpotifyExe {
  $keys = @(
    'HKCU:\Software\Classes\spotify\shell\open\command',
    'HKLM:\Software\Classes\spotify\shell\open\command'
  )

  foreach ($key in $keys) {
    $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
    if (-not $item) { continue }
    $command = [string]$item.GetValue('')
    if (-not $command) { continue }

    if ($command -match '"([^"]+\.exe)"') { return $matches[1] }
    if ($command -match '([A-Za-z]:\\[^\s"]+\.exe)') { return $matches[1] }
  }

  $candidates = @(
    (Join-Path $env:APPDATA 'Spotify\Spotify.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\Spotify.exe'),
    (Join-Path $env:PROGRAMFILES 'Spotify\Spotify.exe'),
    (Join-Path ${env:PROGRAMFILES(X86)} 'Spotify\Spotify.exe')
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Hide-SpotifyWindows {
  $count = 0
  foreach ($process in @(Get-Process -Name Spotify -ErrorAction SilentlyContinue)) {
    try { $process.Refresh() } catch {}
    $handle = $process.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      [EvSpotifyNative]::ShowWindow($handle, 0) | Out-Null
      $count += 1
    }
  }
  return $count
}

function Await-WinRt($operation, [Type]$resultType, [int]$timeoutMs = 1500) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0].MakeGenericMethod($resultType)

  $task = $asTask.Invoke($null, @($operation))
  if (-not $task.Wait($timeoutMs)) { throw 'Windows Media no respondió.' }
  return $task.Result
}

function Ensure-Playing {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    $manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $managerType
    $session = @($manager.GetSessions()) |
      Where-Object { $_.SourceAppUserModelId -match 'Spotify' } |
      Select-Object -First 1

    if (-not $session) { return 'no-session' }

    $status = $session.GetPlaybackInfo().PlaybackStatus.ToString()
    if ($status -ne 'Playing') {
      Await-WinRt ($session.TryPlayAsync()) ([System.Boolean]) | Out-Null
      return "play-requested:$status"
    }
    return 'playing'
  } catch {
    return 'unknown'
  }
}

if ($HideMs -lt 300) { $HideMs = 300 }

$started = $false
$exe = Get-SpotifyExe

if ($DryRun) {
  [pscustomobject]@{ ok = [bool]$exe; exe = $exe } | ConvertTo-Json -Compress
  exit 0
}

if (-not $Uri -and -not $StartOnly) {
  [pscustomobject]@{ ok = $false; error = 'No indicaste una URI de Spotify.' } | ConvertTo-Json -Compress
  exit 0
}

$running = @(Get-Process -Name Spotify -ErrorAction SilentlyContinue).Count -gt 0
$uriSent = $false

if ($StartOnly) {
  if (-not $running -and -not $exe) {
    [pscustomobject]@{ ok = $false; error = 'No encontré Spotify instalado en este equipo.' } | ConvertTo-Json -Compress
    exit 0
  }

  if (-not $running) {
    $started = $true
    if ($exe) {
      try {
        Start-Process -FilePath $exe -ArgumentList '--minimized' -WindowStyle Minimized -ErrorAction Stop | Out-Null
        $uriSent = $true
      } catch {
        $uriSent = $false
      }

      if ($uriSent) {
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
          if (@(Get-Process -Name Spotify -ErrorAction SilentlyContinue).Count -gt 0) { break }
          Start-Sleep -Milliseconds 250
        }
      }
    }
  }

  Hide-SpotifyWindows | Out-Null
  $end = [DateTime]::UtcNow.AddMilliseconds($HideMs)
  while ([DateTime]::UtcNow -lt $end) {
    Hide-SpotifyWindows | Out-Null
    Start-Sleep -Milliseconds 100
  }

  [pscustomobject]@{
    ok        = $true
    started   = $started
    exe       = $exe
    startOnly = $true
  } | ConvertTo-Json -Compress
  exit 0
}

if (-not $running) {
  $started = $true
  if ($exe) {
    # Arrancar ya con la URI evita una segunda activación y el parpadeo extra.
    try {
      Start-Process -FilePath $exe -ArgumentList @('--minimized', "--protocol-uri=$Uri") -WindowStyle Minimized -ErrorAction Stop | Out-Null
      $uriSent = $true
    } catch {
      $uriSent = $false
    }

    if ($uriSent) {
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
      while ([DateTime]::UtcNow -lt $deadline) {
        if (@(Get-Process -Name Spotify -ErrorAction SilentlyContinue).Count -gt 0) { break }
        Start-Sleep -Milliseconds 250
      }
    }
  }
}

# Ocultar antes de enviar la URI reduce el parpadeo de la ventana.
Hide-SpotifyWindows | Out-Null

if (-not $uriSent) {
  try {
    Start-Process -FilePath $Uri -ErrorAction Stop | Out-Null
  } catch {
    $message = 'No pude abrir Spotify. Comprueba que esté instalado y con sesión iniciada.'
    [pscustomobject]@{ ok = $false; error = $message } | ConvertTo-Json -Compress
    exit 0
  }
}

# Spotify puede mostrarse al procesar la URI: ocultarlo durante un momento.
$end = [DateTime]::UtcNow.AddMilliseconds($HideMs)
while ([DateTime]::UtcNow -lt $end) {
  Hide-SpotifyWindows | Out-Null
  Start-Sleep -Milliseconds 100
}

$playing = Ensure-Playing

[pscustomobject]@{
  ok      = $true
  started = $started
  exe     = $exe
  playing = $playing
} | ConvertTo-Json -Compress
