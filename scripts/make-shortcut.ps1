# Puts a "GaetanDev Git" shortcut on the desktop (and in the Start menu) that starts
# the app from this checkout through `npm run app`, without a console window.
# Run with: powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
)
foreach ($dir in $targets) {
  $link = $shell.CreateShortcut((Join-Path $dir 'GaetanDev Git.lnk'))
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $link.Arguments = "-NoProfile -WindowStyle Hidden -Command `"Set-Location -LiteralPath '$root'; npm run app --silent`""
  $link.WorkingDirectory = $root
  $link.IconLocation = (Join-Path $root 'build\icon.ico') + ',0'
  $link.WindowStyle = 7 # minimized: the PowerShell window never shows
  $link.Description = 'GaetanDev Git'
  $link.Save()
  Write-Output "Shortcut: $($link.FullName)"
}
