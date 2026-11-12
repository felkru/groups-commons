# Puts Node.js LTS and Git for Windows on the machine, as a typical developer laptop has them.
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$v = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version
Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-x64.msi" -OutFile "$env:TEMP\node.msi"
Start-Process msiexec.exe -ArgumentList "/i `"$env:TEMP\node.msi`" /qn /norestart" -Wait
$rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'setup-test' }
$asset = $rel.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
Invoke-WebRequest $asset.browser_download_url -OutFile "$env:TEMP\git.exe"
Start-Process "$env:TEMP\git.exe" -ArgumentList '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES' -Wait
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
Write-Output "node $(& node --version) npm $(& npm.cmd --version) $(& git --version)"
