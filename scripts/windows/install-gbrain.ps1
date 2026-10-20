# One-time install: GBrain + index the vault + wire Claude Code locally.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File <repo>\scripts\windows\install-gbrain.ps1
# Safe to re-run. Run it while the portal is stopped (GBrain's database allows one process).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-env.ps1')
$Brain = $env:BRAIN_PATH

# Pin a version here once you pick one. Note: Claude.ai write scope bug (#5277) since v0.50.2.0.
$GbrainRef = 'master'

# What GBrain must never index. GBRAIN_SYNC_EXCLUDE in the settings file replaces the default: add private folders
# (e.g. clients/) there. life/ is also gitignored; for anything that is not, this is the real guard.
# Stored in the brain's config, so every sync path (CLI, autopilot, dream cycle) honours it.
$SyncExclude = if ($env:GBRAIN_SYNC_EXCLUDE) { $env:GBRAIN_SYNC_EXCLUDE } else { 'life/,_setup/,templates/,AGENTS.md,CLAUDE.md,README.md' }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host 'Installing Bun (winget)...'
    winget install --id Oven-sh.Bun -e --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}

# Bun's global bin dir holds the gbrain shim. winget's Bun doesn't add it to PATH.
$BunBin = Join-Path $env:USERPROFILE '.bun\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (($userPath -split ';') -notcontains $BunBin) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$BunBin", 'User')
}
if (($env:Path -split ';') -notcontains $BunBin) { $env:Path += ";$BunBin" }

# --backend=copyfile: Bun's default on Windows hardlinks files from its cache, and GBrain
# refuses to publish hardlinked skill files (nlink != 1).
Write-Host "Installing GBrain ($GbrainRef)..."
bun install -g --backend=copyfile "github:garrytan/gbrain#$GbrainRef"

# --db-only: skip GBrain's owned content dir + packaged skill bundle. Its publication path
# rejects Windows '\' separators, and this vault (not ~/.gbrain/content) is the truth anyway.
if (-not (Test-Path (Join-Path $env:USERPROFILE '.gbrain\config.json'))) {
    Write-Host 'Initialising brain (PGLite, keyword search only)...'
    gbrain init --pglite --no-embedding --non-interactive --db-only
}

gbrain config set sync.exclude $SyncExclude

# Register the whole vault as one source so slugs keep their folder (inbox/..., notes/...).
if (-not ((gbrain sources list 2>&1) -match '^\s+brain\s')) {
    gbrain sources add brain --path $Brain --name 'Third Brain vault'
}
gbrain sources default brain
gbrain sources federate brain

# Sync reads committed files only. --no-pull: this machine is the only writer.
gbrain sync --source brain --no-pull --no-embed
gbrain extract --stale

gbrain doctor

# Claude Code and Codex: connect them to the ONE GBrain server the portal runs (http://127.0.0.1:<BRAIN_PORT>/mcp).
# Never add a stdio `gbrain serve` per agent: GBrain's database (PGLite) allows one process, so a second server
# locks out the portal's. See docs/install.md, "Connect Claude Code and Codex".
Write-Host ''
Write-Host 'Done. Test with:  gbrain query "brain setup"'
Write-Host 'To connect Claude Code or Codex, see docs/install.md (Connect Claude Code and Codex).'
