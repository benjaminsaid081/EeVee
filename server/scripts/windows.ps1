
param(
  [string]$Action = 'list',
  [string]$Title = ''
)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class EvWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  public static List<IntPtr> GetVisibleWindows() {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) list.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static string GetTitle(IntPtr hWnd) {
    var text = new StringBuilder(512);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }
}
"@

$windows = @()
foreach ($handle in [EvWindows]::GetVisibleWindows()) {
  $windows += [pscustomobject]@{
    id    = $handle.ToInt64()
    title = [EvWindows]::GetTitle($handle)
  }
}

if ($Action -eq 'list') {
  $windows | ConvertTo-Json -Compress
  exit 0
}

$needle = $Title.ToLowerInvariant()
$target = $windows | Where-Object { $_.title.ToLowerInvariant() -like "*$needle*" } | Select-Object -First 1

if (-not $target) {
  '{"ok":false,"error":"not_found"}'
  exit 0
}

$handle = [IntPtr]$target.id

switch ($Action) {
  'focus' { [EvWindows]::ShowWindow($handle, 9) | Out-Null; [EvWindows]::SetForegroundWindow($handle) | Out-Null }
  'minimize' { [EvWindows]::ShowWindow($handle, 6) | Out-Null }
  'maximize' { [EvWindows]::ShowWindow($handle, 3) | Out-Null }
  'restore' { [EvWindows]::ShowWindow($handle, 9) | Out-Null }
  'close' { [EvWindows]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
}

[pscustomobject]@{ ok = $true; title = $target.title; action = $Action } | ConvertTo-Json -Compress

