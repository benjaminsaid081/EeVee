# Host persistente para captura de pantalla y control de ratón/teclado.
# Evita pagar el arranque de PowerShell en cada acción (la causa principal de la lentitud).
# Protocolo por stdin/stdout: <id>\t<comando>\t<arg1>\t<arg2>...

[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class EvInputNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint WHEEL = 0x0800;
}
"@

# Coordenadas físicas reales (evita el desfase por escalado de Windows).
[EvInputNative]::SetProcessDPIAware() | Out-Null

function Write-Result([string]$id, $value) {
  $json = $value | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine("$id`t$json")
  [Console]::Out.Flush()
}

function Get-ScreenBounds {
  return [System.Windows.Forms.SystemInformation]::VirtualScreen
}

function Save-ScaledScreenshot([string]$outPath, [int]$targetWidth) {
  $bounds = Get-ScreenBounds
  if ($targetWidth -le 0 -or $targetWidth -gt $bounds.Width) { $targetWidth = $bounds.Width }
  $targetHeight = [Math]::Max(1, [int][Math]::Round($bounds.Height * ($targetWidth / $bounds.Width)))

  $source = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  $sourceGraphics = [System.Drawing.Graphics]::FromImage($source)
  try {
    $sourceGraphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  } finally {
    $sourceGraphics.Dispose()
  }

  $target = [System.Drawing.Bitmap]::new($targetWidth, $targetHeight)
  $targetGraphics = [System.Drawing.Graphics]::FromImage($target)
  try {
    $targetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $targetGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $targetGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $targetGraphics.DrawImage($source, 0, 0, $targetWidth, $targetHeight)
  } finally {
    $targetGraphics.Dispose()
    $source.Dispose()
  }

  try {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' } |
      Select-Object -First 1
    $encoder = [System.Drawing.Imaging.Encoder]::Quality
    $parameters = [System.Drawing.Imaging.EncoderParameters]::new(1)
    $parameters.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new($encoder, [long]78)
    try {
      $target.Save($outPath, $codec, $parameters)
    } finally {
      $parameters.Dispose()
    }
  } finally {
    $target.Dispose()
  }

  return [pscustomobject]@{
    ok      = $true
    file    = $outPath
    width   = $targetWidth
    height  = $targetHeight
    screenW = $bounds.Width
    screenH = $bounds.Height
    screenX = $bounds.X
    screenY = $bounds.Y
  }
}

$running = $true
while ($running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }

  $parts = $line -split "`t"
  $id = $parts[0]
  $command = $parts[1]

  try {
    switch ($command) {
      'ping' {
        Write-Result $id ([pscustomobject]@{ ok = $true })
      }

      'display' {
        $bounds = Get-ScreenBounds
        $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
          [pscustomobject]@{
            name    = $_.DeviceName
            primary = $_.Primary
            x       = $_.Bounds.X
            y       = $_.Bounds.Y
            width   = $_.Bounds.Width
            height  = $_.Bounds.Height
          }
        })
        Write-Result $id ([pscustomobject]@{
          ok      = $true
          x       = $bounds.X
          y       = $bounds.Y
          width   = $bounds.Width
          height  = $bounds.Height
          count   = $screens.Count
          screens = $screens
        })
      }

      'capture' {
        $outPath = $parts[2]
        $targetWidth = 0
        if ($parts.Count -ge 4) { [void][int]::TryParse($parts[3], [ref]$targetWidth) }
        Write-Result $id (Save-ScaledScreenshot $outPath $targetWidth)
      }

      'click' {
        $x = [int]$parts[2]
        $y = [int]$parts[3]
        [EvInputNative]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 15
        [EvInputNative]::mouse_event([EvInputNative]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [EvInputNative]::mouse_event([EvInputNative]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Write-Result $id ([pscustomobject]@{ ok = $true; x = $x; y = $y })
      }

      'double' {
        $x = [int]$parts[2]
        $y = [int]$parts[3]
        [EvInputNative]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 15
        [EvInputNative]::mouse_event([EvInputNative]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [EvInputNative]::mouse_event([EvInputNative]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [EvInputNative]::mouse_event([EvInputNative]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [EvInputNative]::mouse_event([EvInputNative]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Write-Result $id ([pscustomobject]@{ ok = $true; x = $x; y = $y })
      }

      'right' {
        $x = [int]$parts[2]
        $y = [int]$parts[3]
        [EvInputNative]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 15
        [EvInputNative]::mouse_event([EvInputNative]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [EvInputNative]::mouse_event([EvInputNative]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
        Write-Result $id ([pscustomobject]@{ ok = $true; x = $x; y = $y })
      }

      'scroll' {
        $direction = if ($parts[2] -eq 'up') { 'up' } else { 'down' }
        $amount = 120
        if ($parts.Count -ge 4) { [void][int]::TryParse($parts[3], [ref]$amount) }
        $amount = [Math]::Max(1, [Math]::Min(2000, $amount))
        $delta = if ($direction -eq 'down') { -$amount } else { $amount }
        [EvInputNative]::mouse_event([EvInputNative]::WHEEL, 0, 0, $delta, [UIntPtr]::Zero)
        Write-Result $id ([pscustomobject]@{ ok = $true; direction = $direction; amount = $amount })
      }

      'type' {
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
        $escaped = ''
        foreach ($character in $text.ToCharArray()) {
          if ($character -eq "`r") { continue }
          if ($character -eq "`n") { $escaped += '{ENTER}'; continue }
          if ($character -eq "`t") { $escaped += '{TAB}'; continue }
          if ('+^%~(){}[]'.Contains([string]$character)) {
            $escaped += '{' + $character + '}'
          } else {
            $escaped += $character
          }
        }
        [System.Windows.Forms.SendKeys]::SendWait($escaped)
        Write-Result $id ([pscustomobject]@{ ok = $true; mode = 'text' })
      }

      'keys' {
        [System.Windows.Forms.SendKeys]::SendWait([string]$parts[2])
        Write-Result $id ([pscustomobject]@{ ok = $true; mode = 'keys' })
      }

      'exit' {
        $running = $false
        Write-Result $id ([pscustomobject]@{ ok = $true })
      }

      default {
        Write-Result $id ([pscustomobject]@{ ok = $false; error = "Comando desconocido: $command" })
      }
    }
  } catch {
    Write-Result $id ([pscustomobject]@{ ok = $false; error = $_.Exception.Message })
  }
}
