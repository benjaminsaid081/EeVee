param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('playpause', 'next', 'prev', 'stop', 'volumeup', 'volumedown', 'mute')]
  [string]$Key,
  [int]$Steps = 1
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class EvMediaKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Press(byte k) {
    keybd_event(k, 0, 0, UIntPtr.Zero);
    keybd_event(k, 0, 2, UIntPtr.Zero);
  }
}
"@

$map = @{
  volumeup   = 0xAF
  volumedown = 0xAE
  mute       = 0xAD
  playpause  = 0xB3
  next       = 0xB0
  prev       = 0xB1
  stop       = 0xB2
}

$code = [byte]$map[$Key]
if ($Steps -lt 1) { $Steps = 1 }
if ($Steps -gt 50) { $Steps = 50 }
for ($i = 0; $i -lt $Steps; $i++) {
  [EvMediaKeys]::Press($code)
  Start-Sleep -Milliseconds 60
}
Write-Output "ok"
