# Runs the hosted setup script the way a person would (irm | iex in Windows PowerShell 5.1, scripts disabled as on a
# Windows 10/11 client) with the REAL agents, then checks the result.
param([string]$Label = 'run', [string]$Site = '')
$ErrorActionPreference = 'Continue'
$Q = 'agent=claude-code,codex&install=1&cli=1&skill=1&group=AI+Safety+Nordhaven&university=Nordhaven+University&color=%230b6e4f&font_heading=Fraunces&website=https%3A%2F%2Faisafety-nordhaven.example'
$env:COMMONS_SETUP_MEMORY = 'yes'
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath"
Write-Output "[$Label] PS $($PSVersionTable.PSVersion) node=$((Get-Command node -ErrorAction SilentlyContinue).Source) npm=$((Get-Command npm -ErrorAction SilentlyContinue).Source) git=$((Get-Command git -ErrorAction SilentlyContinue).Source)"
$cmd = "irm '$Site/setup.ps1?$Q' | iex"
Write-Output "[$Label] pasting: $cmd"
& powershell.exe -NoProfile -ExecutionPolicy Restricted -Command $cmd 2>&1 | ForEach-Object { "[$Label] $_" }
Write-Output "[$Label] exit of setup: $LASTEXITCODE"
$env:Path = "$env:USERPROFILE\.local\bin;$env:APPDATA\npm;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
function Try-Run([string]$What, [scriptblock]$Block) { try { $o = (& $Block 2>&1 | Out-String).Trim() } catch { $o = "ERROR $_" }; Write-Output "[$Label] CHECK ${What}: $o" }
Try-Run 'claude' { (Get-Command claude -ErrorAction SilentlyContinue).Source; & claude --version }
Try-Run 'claude mcp list' { & claude mcp list | Select-String -Pattern 'commons' | Select-Object -First 1 }
Try-Run 'codex' { (Get-Command codex -ErrorAction SilentlyContinue).Source; & codex --version }
Try-Run 'codex mcp list' { & codex mcp list | Select-String -Pattern 'commons' | Select-Object -First 1 }
Try-Run 'skill' { (Get-Item "$env:USERPROFILE\.claude\skills\commons\SKILL.md" -ErrorAction SilentlyContinue).Length }
Try-Run 'cli files' { Get-ChildItem "$env:USERPROFILE\.local\bin" -ErrorAction SilentlyContinue | ForEach-Object Name }
Try-Run 'cli search (cmd.exe)' { & cmd.exe /c "`"$env:USERPROFILE\.local\bin\commons.cmd`" search flyer" | Select-Object -First 1 }
Try-Run 'memory' { "CLAUDE.md: " + (Select-String -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Pattern 'Nordhaven' -ErrorAction SilentlyContinue).Count + " lines; AGENTS.md: " + (Select-String -Path "$env:USERPROFILE\.codex\AGENTS.md" -Pattern 'Nordhaven' -ErrorAction SilentlyContinue).Count }
Try-Run 'memory encoding (first bytes of CLAUDE.md)' { ([IO.File]::ReadAllBytes("$env:USERPROFILE\.claude\CLAUDE.md") | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') }) -join ' ' }
Write-Output "[$Label] second run (must be safe to repeat):"
& powershell.exe -NoProfile -ExecutionPolicy Restricted -Command $cmd 2>&1 | Select-String -Pattern '\[done\]|\[problem\]' | ForEach-Object { "[$Label] 2nd $_" }
Try-Run 'marker blocks after 2nd run' { (Select-String -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Pattern 'groups-commons:start' -ErrorAction SilentlyContinue).Count }
