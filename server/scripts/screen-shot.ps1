param(
  [string]$OutFile,
  [int]$Width = 1280,
  [int]$Quality = 72
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not $OutFile) {
  $OutFile = Join-Path $env:TEMP ("ev-screen-" + [guid]::NewGuid().ToString('N') + '.jpg')
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$scale = [Math]::Min(1, $Width / $bounds.Width)
$targetWidth = [int]($bounds.Width * $scale)
$targetHeight = [int]($bounds.Height * $scale)

$full = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($full)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)

$scaled = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
$scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
$scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$scaledGraphics.DrawImage($full, 0, 0, $targetWidth, $targetHeight)

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' } |
  Select-Object -First 1
$encoder = New-Object System.Drawing.Imaging.EncoderParameters 1
$encoder.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality,
  [long]$Quality
)
$scaled.Save($OutFile, $codec, $encoder)

[pscustomobject]@{
  ok      = $true
  path    = $OutFile
  width   = $targetWidth
  height  = $targetHeight
  screenW = $bounds.Width
  screenH = $bounds.Height
  screenX = $bounds.X
  screenY = $bounds.Y
} | ConvertTo-Json -Compress

$scaledGraphics.Dispose()
$scaled.Dispose()
$graphics.Dispose()
$full.Dispose()
