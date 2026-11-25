# Registers (first run only), checks, deploys and installs/upgrades ScopeGuard
# on the development environment. The Forge CLI can't use the Windows keychain
# on this machine, so credentials come from FORGE_EMAIL / FORGE_API_TOKEN. If
# they aren't set, this script asks for them (the token prompt is hidden).
param(
  [string]$Site = 'dashtech.atlassian.net'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $env:FORGE_EMAIL) {
  $env:FORGE_EMAIL = Read-Host 'Atlassian email'
}
if (-not $env:FORGE_API_TOKEN) {
  $secure = Read-Host 'Forge API token (hidden)' -AsSecureString
  $env:FORGE_API_TOKEN = [Net.NetworkCredential]::new('', $secure).Password
}

function Step($name, [scriptblock]$cmd) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $name" -ForegroundColor Red; exit $LASTEXITCODE }
}

Step 'whoami' { forge whoami }

if ((Get-Content manifest.yml -Raw) -match 'app/00000000-0000-0000-0000-000000000000') {
  Step 'register' { forge register scopeguard }
}

Step 'typecheck + tests' { npm run typecheck; if ($LASTEXITCODE -eq 0) { npx vitest run } }
Step 'lint' { forge lint }
Step 'deploy' { forge deploy -e development --non-interactive }

# PowerShell 5.1 turns the CLI's "out of date" stderr warning into a terminating
# error under 'Stop', so relax it for this call.
$ErrorActionPreference = 'Continue'
$installs = (forge install list 2>&1 | Out-String)
if ($installs -match [regex]::Escape($Site)) {
  # Already installed: the deploy above is live there. Upgrade picks up any scope changes.
  # Not fatal: the CLI exits non-zero when the install is already up to date.
  Write-Host "`n=== upgrade install (if needed) ===" -ForegroundColor Cyan
  forge install --upgrade --site $Site --product jira -e development --non-interactive --confirm-scopes
} else {
  Step 'install' { forge install --site $Site --product jira -e development --non-interactive --confirm-scopes }
}

Write-Host "`nScopeGuard is deployed to development and installed on $Site." -ForegroundColor Green
