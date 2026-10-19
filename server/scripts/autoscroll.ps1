param(
  [ValidateSet('up', 'down')]
  [string]$Direction = 'down',
  [int]$Step = 120,
  [int]$IntervalMs = 350
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class EvScroll {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  public static void Wheel(int delta) { mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero); }
}
"@

$delta = if ($Direction -eq 'down') { -[Math]::Abs($Step) } else { [Math]::Abs($Step) }

while ($true) {
  [EvScroll]::Wheel($delta)
  Start-Sleep -Milliseconds ([Math]::Max(120, $IntervalMs))
}
