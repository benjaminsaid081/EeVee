Add-Type -AssemblyName System.Windows.Forms

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    name   = $_.DeviceName
    primary = $_.Primary
    x      = $_.Bounds.X
    y      = $_.Bounds.Y
    width  = $_.Bounds.Width
    height = $_.Bounds.Height
    scale  = $_.WorkingArea.Width
  }
})

[pscustomobject]@{
  x      = $bounds.X
  y      = $bounds.Y
  width  = $bounds.Width
  height = $bounds.Height
  count  = $screens.Count
  screens = $screens
} | ConvertTo-Json -Compress
