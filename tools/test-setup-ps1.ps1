# Runs the hosted /setup.ps1 for real under PowerShell, with stub programs, and prints what happened.
# Started by tools/test-setup-ps1.cloudbuild.yaml (PowerShell 7 on Linux). It starts the site itself, so it needs
# the repository with node_modules and a node binary at .pstest/node (the build's first step provides both), or
# the path of one in COMMONS_TEST_NODE.
#
# Every run gets a throw-away home folder and a PATH of stub programs (claude, codex, npm) that write down how they
# were called. The Claude Code installer is replaced by a fake one; nothing else is downloaded from outside.
# What this does not cover: Windows PowerShell 5.1, Windows paths, the commons.cmd file, and a real keyboard.

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Node = $env:COMMONS_TEST_NODE
if (-not $Node) { $Node = Join-Path (Join-Path $Root '.pstest') 'node' }
$Pwsh = (Get-Process -Id $PID).Path
$Port = 8791
$Origin = "http://localhost:$Port"
$Work = Join-Path ([IO.Path]::GetTempPath()) "commons-ps1-test-$PID"
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$script:Failures = 0

function Check([string]$Label, [bool]$Ok, [string]$Detail = '') {
  if ($Ok) { Write-Host "  ok    $Label" }
  else { $script:Failures++; Write-Host "  FAIL  $Label  [$Detail]" }
}

# ---- the site under test ----
$env:STORE = 'local'
$env:DATA_DIR = Join-Path $Work 'data'
$env:PORT = "$Port"
$env:ADMIN_TOKEN = 'test'
$server = Start-Process -FilePath $Node -ArgumentList 'server/index.js' -WorkingDirectory $Root -PassThru -RedirectStandardOutput (Join-Path $Work 'server.log') -RedirectStandardError (Join-Path $Work 'server.err')
$up = $false
foreach ($i in 1..60) {
  try { if ((Invoke-WebRequest -Uri "$Origin/healthz" -UseBasicParsing).StatusCode -eq 200) { $up = $true; break } } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $up) {
  Write-Host 'The site did not start:'
  Get-Content (Join-Path $Work 'server.err') -ErrorAction SilentlyContinue | Write-Host
  exit 1
}
Write-Host "Testing $Origin/setup.ps1 with $Pwsh (PowerShell $($PSVersionTable.PSVersion)) in $Work"

# ---- 0. every variant must at least be valid PowerShell ----
Write-Host ''
Write-Host '0. The scripts parse'
$group = 'group=AI+Safety+K%C3%B6ln&university=Universit%C3%A4t+zu+K%C3%B6ln&city=K%C3%B6ln&color=1f6f5c&accent=c76d7e&font_heading=Fraunces&font_body=Inter&website=aisafety.example.org&join=aisafety.example.org%2Fjoin'
foreach ($query in @('', 'agent=codex', 'agent=claude-code,codex&install=1&cli=1&skill=1', "agent=claude-code,codex&install=1&cli=1&skill=1&$group")) {
  $text = Invoke-RestMethod -Uri "$Origin/setup.ps1?$query"
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors) | Out-Null
  Check "parses: ?$($query.Substring(0, [Math]::Min(48, $query.Length)))" ($errors.Count -eq 0) (($errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) -join '; ')
  Check '  no character outside ASCII (Windows PowerShell 5.1 reads it safely)' (-not ($text -cmatch '[^\x00-\x7F]'))
}

# ---- stub programs ----
$Pool = Join-Path $Work 'pool'
New-Item -ItemType Directory -Force -Path $Pool | Out-Null
function New-Stub([string]$Path, [string]$Name, [string]$Extra = '') {
  $lines = @('#!/bin/sh', "echo ""$Name `$*"" >> ""`$COMMONS_TEST_LOG""", $Extra, 'exit 0')
  [IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"))
  & chmod +x $Path
}
New-Stub (Join-Path $Pool 'claude') 'claude' 'if [ "$1 $2" = "mcp remove" ]; then echo "No MCP server found with name: commons" >&2; exit 1; fi'
New-Stub (Join-Path $Pool 'codex') 'codex' 'if [ "$1 $2" = "mcp remove" ]; then echo "No MCP server named commons" >&2; exit 1; fi'
# "npm install -g" puts codex into <prefix>/bin, which is not on the PATH, like a fresh npm setup.
New-Stub (Join-Path $Pool 'npm') 'npm' ('if [ "$1" = install ]; then mkdir -p "$COMMONS_TEST_NPM/bin" && cp "$COMMONS_TEST_POOL/codex" "$COMMONS_TEST_NPM/bin/codex"; fi' + "`n" + 'if [ "$1" = prefix ]; then echo "$COMMONS_TEST_NPM"; fi')
[IO.File]::WriteAllText((Join-Path $Pool 'node'), "#!/bin/sh`nexec ""$Node"" ""`$@""`n")
& chmod +x (Join-Path $Pool 'node')

# Loaded into every run before the script: the Claude Code installer becomes a fake that drops the claude stub
# where the real installer puts the program. Everything else goes to the real Invoke-RestMethod.
$Prelude = Join-Path $Work 'prelude.ps1'
@'
function Invoke-RestMethod {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$Uri)
  if ($Uri -eq 'https://claude.ai/install.ps1') {
    return 'Write-Host "(fake Claude Code installer)"; $d = Join-Path (Join-Path $HOME ".local") "bin"; New-Item -ItemType Directory -Force -Path $d | Out-Null; Copy-Item (Join-Path $env:COMMONS_TEST_POOL "claude") (Join-Path $d "claude"); & chmod +x (Join-Path $d "claude")'
  }
  Microsoft.PowerShell.Utility\Invoke-RestMethod -Uri $Uri
}
'@ | Set-Content -LiteralPath $Prelude -Encoding utf8

# One run of "irm <address> | iex" in its own PowerShell, with its own home folder and PATH.
# Returns @{ Out; Calls; Home }.
function Invoke-Setup([string]$Name, [string]$Query, [string[]]$Have = @(), [string]$Memory = '') {
  $box = Join-Path $Work $Name
  $homeDir = Join-Path $box 'home'
  $bin = Join-Path $box 'bin'
  $log = Join-Path $box 'calls.log'
  New-Item -ItemType Directory -Force -Path $homeDir, $bin | Out-Null
  foreach ($tool in $Have) { Copy-Item (Join-Path $Pool $tool) (Join-Path $bin $tool) -Force; & chmod +x (Join-Path $bin $tool) }
  $command = ". '$Prelude'; irm '$Origin/setup.ps1?$Query' | iex"
  $vars = @("HOME=$homeDir", "PATH=${bin}:/usr/bin:/bin", "COMMONS_TEST_LOG=$log", "COMMONS_TEST_POOL=$Pool", "COMMONS_TEST_NPM=$(Join-Path $box 'npm-global')", "COMMONS_SETUP_MEMORY=$Memory")
  $out = (& /usr/bin/env @vars $Pwsh -NoLogo -NoProfile -NonInteractive -Command $command 2>&1 | Out-String)
  Write-Host ''
  Write-Host "----- ${Name}: ?$Query"
  Write-Host $out
  Write-Host '-----'
  $calls = @()
  if (Test-Path -LiteralPath $log) { $calls = @(Get-Content -LiteralPath $log) }
  return @{ Out = $out; Calls = $calls; Home = $homeDir }
}
function Read-Home($Run, [string]$Relative) {
  $path = Join-Path $Run.Home $Relative
  if (Test-Path -LiteralPath $path) { return [IO.File]::ReadAllText($path) }
  return $null
}

$both = 'agent=claude-code,codex'
$mcpClaude = "claude mcp add --transport http -s user commons $Origin/mcp"
$mcpCodex = "codex mcp add commons --url $Origin/mcp"
$start = '<!-- groups-commons:start -->'

Write-Host ''
Write-Host '1. Agents already installed, everything asked for, nobody to ask'
$r = Invoke-Setup 'present' "$both&cli=1&skill=1&$group" @('claude', 'codex', 'npm', 'node')
Check 'claude: old connection removed, then added with the verified syntax' (($r.Calls -contains 'claude mcp remove commons -s user') -and ($r.Calls -contains $mcpClaude)) ($r.Calls -join ' | ')
Check 'codex: old connection removed, then added with the verified syntax' (($r.Calls -contains 'codex mcp remove commons') -and ($r.Calls -contains $mcpCodex)) ($r.Calls -join ' | ')
Check 'skill saved' ("$(Read-Home $r '.claude/skills/commons/SKILL.md')".StartsWith('---'))
Check 'command line tool saved and knows its site' ("$(Read-Home $r '.local/bin/commons.mjs')".Contains($Origin))
Check 'memory text shown' ($r.Out.Contains('| Our group: AI Safety K'))
Check 'nobody to ask: memory files not written, and the script says so' (($null -eq (Read-Home $r '.claude/CLAUDE.md')) -and ($null -eq (Read-Home $r '.codex/AGENTS.md')) -and $r.Out.Contains('nobody at a keyboard'))
Check 'nothing installed' (-not ($r.Calls | Where-Object { $_ -like 'npm install*' }))
Check 'ends with the summary and an example sentence' ($r.Out.Contains('==> Summary') -and $r.Out.Contains('Now open your agent (type: claude'))

Write-Host ''
Write-Host '2. Running it twice gives the same result (memory answered in advance)'
$notes = "# My own notes`n`nAlways answer in German.`n"
$claudeMd = Join-Path (Join-Path (Join-Path (Join-Path $Work 'twice') 'home') '.claude') 'CLAUDE.md'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $claudeMd) | Out-Null
[IO.File]::WriteAllText($claudeMd, $notes)
$r = Invoke-Setup 'twice' "$both&cli=1&skill=1&$group" @('claude', 'codex', 'npm', 'node') 'yes'
$first = Read-Home $r '.claude/CLAUDE.md'
$r = Invoke-Setup 'twice' "$both&cli=1&skill=1&$group" @() 'yes'
$second = Read-Home $r '.claude/CLAUDE.md'
Check 'CLAUDE.md identical after the second run' ($first -ceq $second)
Check 'own notes kept, one block after them' ("$second".StartsWith($notes.TrimEnd()) -and ([regex]::Matches("$second", [regex]::Escape($start)).Count -eq 1) -and "$second".Contains('## Our student group')) "$second"
Check 'second run says it replaced the block' ($r.Out.Contains('Replaced the earlier block'))
Check 'AGENTS.md written for Codex' ("$(Read-Home $r '.codex/AGENTS.md')".Contains($start))
$r = Invoke-Setup 'twice' 'agent=claude-code&group=Another+Group' @() 'yes'
$third = Read-Home $r '.claude/CLAUDE.md'
Check 'other details replace the block, not the notes' ("$third".StartsWith($notes.TrimEnd()) -and "$third".Contains('Another Group') -and -not "$third".Contains('Fraunces')) "$third"

Write-Host ''
Write-Host '3. Agents missing, install not asked for'
$r = Invoke-Setup 'absent' "$both&$group" @('node')
Check 'says where to get both and goes on' ($r.Out.Contains('https://claude.com/claude-code') -and $r.Out.Contains('https://github.com/openai/codex') -and $r.Out.Contains('No agent is connected yet'))
Check 'no program was called' ($r.Calls.Count -eq 0) ($r.Calls -join ' | ')

Write-Host ''
Write-Host '4. Agents missing, install=1'
$r = Invoke-Setup 'install' "$both&install=1&cli=1&skill=1" @('npm', 'node')
Check 'Claude Code: the (fake) official installer ran, claude was found afterwards and connected' ($r.Out.Contains('(fake Claude Code installer)') -and ($r.Calls -contains $mcpClaude)) ($r.Calls -join ' | ')
Check 'Codex: npm install -g @openai/codex, found in the npm folder, connected' (($r.Calls -contains 'npm install -g @openai/codex') -and ($r.Calls -contains $mcpCodex)) ($r.Calls -join ' | ')
$r = Invoke-Setup 'install' "$both&install=1&cli=1&skill=1"
Check 'second run installs nothing again' (@($r.Calls | Where-Object { $_ -eq 'npm install -g @openai/codex' }).Count -eq 1 -and -not $r.Out.Contains('Not installed yet'))

Write-Host ''
Write-Host '5. No Node.js on the computer'
$r = Invoke-Setup 'no-node' "$both&install=1&cli=1" @('claude')
Check 'command line tool skipped with a clear note' ($r.Out.Contains('needs Node.js 18 or newer, and Node.js is not on this computer') -and ($null -eq (Read-Home $r '.local/bin/commons.mjs')))
Check 'Codex: says Node.js is needed' ($r.Out.Contains('Install Node.js (https://nodejs.org), then run this command again.'))
Check 'Claude Code still connected' ($r.Calls -contains $mcpClaude)

Write-Host ''
Write-Host '6. Hostile addresses: nothing from the address reaches PowerShell'
$canary = Join-Path $Work 'PWNED'
$hostile = @(
  "group=$([uri]::EscapeDataString("'; New-Item '$canary'; '"))",
  "university=$([uri]::EscapeDataString('$(New-Item ' + $canary + ')'))",
  "city=$([uri]::EscapeDataString('"; New-Item ' + $canary + '; "'))",
  "color=$([uri]::EscapeDataString("ffffff'; New-Item $canary #"))",
  "font_heading=$([uri]::EscapeDataString("Inter`nNew-Item $canary"))",
  "website=$([uri]::EscapeDataString('example.org/$(New-Item ' + $canary + ')'))",
  "join=$([uri]::EscapeDataString("https://example.org/';New-Item $canary;'"))",
  "cli=$([uri]::EscapeDataString('1; New-Item ' + $canary))",
  "evil=$([uri]::EscapeDataString('$(New-Item ' + $canary + ')'))"
) -join '&'
$plain = Invoke-RestMethod -Uri "$Origin/setup.ps1?agent=claude-code"
$crafted = Invoke-RestMethod -Uri "$Origin/setup.ps1?agent=claude-code&$hostile"
$extra = @(($crafted -split "`n") | Where-Object { ($plain -split "`n") -notcontains $_ })
Check 'differs from the plain script only in the comment about left-out fields' ($extra.Count -eq 1 -and -not ($extra | Where-Object { -not $_.StartsWith('#   ') })) ($extra -join ' | ')
Check 'no trace of the values in the script' (-not $crafted.Contains('PWNED') -and -not $crafted.Contains('New-Item ''') -and $crafted.Contains("`$MemoryB64 = ''"))
$r = Invoke-Setup 'hostile' "$both&cli=1&$hostile" @('claude', 'codex', 'npm', 'node') 'yes'
Check 'ran to the end; no canary file' ($r.Out.Contains('==> Summary') -and -not (Test-Path -LiteralPath $canary))
Check 'no memory file written' ($null -eq (Read-Home $r '.claude/CLAUDE.md'))
$tricky = "O'Brien & Sons (Test), St. Mary-Hill"
$r = Invoke-Setup 'hostile' "agent=claude-code&group=$([uri]::EscapeDataString($tricky))" @() 'yes'
Check 'allowed punctuation arrives as plain text' ("$(Read-Home $r '.claude/CLAUDE.md')".Contains("Our group: $tricky.") -and -not (Test-Path -LiteralPath $canary)) "$(Read-Home $r '.claude/CLAUDE.md')"

Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($script:Failures) { Write-Host "$($script:Failures) failed"; exit 1 }
Write-Host 'All checks passed.'
exit 0
