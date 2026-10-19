# Re-index the vault after editing notes in Obsidian.
# Sync reads committed files only, so commit first (the portal's vault backup does this hourly).
# Exclusions (life/, private folders, ...) live in the brain config: gbrain config get sync.exclude
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-env.ps1')
gbrain sync --source brain --no-pull --no-embed
gbrain extract --stale
