param(
  [string]$Text = '',
  [string]$Keys = ''
)

Add-Type -AssemblyName System.Windows.Forms

if ($Keys) {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  '{"ok":true,"mode":"keys"}'
  exit 0
}

$escaped = ''
foreach ($character in $Text.ToCharArray()) {
  if ('+^%~(){}[]'.Contains($character)) {
    $escaped += '{' + $character + '}'
  } else {
    $escaped += $character
  }
}

[System.Windows.Forms.SendKeys]::SendWait($escaped)
'{"ok":true,"mode":"text"}'
