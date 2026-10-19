param(
  [ValidateSet('move', 'click', 'double', 'right', 'scroll', 'back')]
  [string]$Action = 'click',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Amount = 120,
  [ValidateSet('up', 'down')]
  [string]$Direction = 'down'
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class EvMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint WHEEL = 0x0800;
  public static void Click() { mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero); }
  public static void RightClick() { mouse_event(RIGHTDOWN, 0, 0, 0, UIntPtr.Zero); mouse_event(RIGHTUP, 0, 0, 0, UIntPtr.Zero); }
  public static void Wheel(int delta) { mouse_event(WHEEL, 0, 0, delta, UIntPtr.Zero); }
}
"@

if ($X -ge 0 -and $Y -ge 0) {
  [EvMouse]::SetCursorPos($X, $Y) | Out-Null
}

switch ($Action) {
  'move' { }
  'click' { [EvMouse]::Click() }
  'double' { [EvMouse]::Click(); Start-Sleep -Milliseconds 90; [EvMouse]::Click() }
  'right' { [EvMouse]::RightClick() }
  'scroll' {
    $delta = if ($Direction -eq 'down') { -$Amount } else { $Amount }
    [EvMouse]::Wheel($delta)
  }
  'back' {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
  }
}

[pscustomobject]@{ ok = $true; action = $Action; x = $X; y = $Y } | ConvertTo-Json -Compress
