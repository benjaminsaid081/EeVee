
param(
  [string]$OutDir
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

if (-not $OutDir) {
  $OutDir = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'EV Capturas'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

$name = 'EV-' + (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.png'
$file = Join-Path $OutDir $name
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()

Write-Output $file

