# One-time public HTTPS setup via Tailscale Funnel (no domain needed).
# Prereq: Tailscale installed and logged in; Funnel allowed in the tailnet policy.
# Funnel config persists across reboots; the brain URL is https://<BRAIN_HOSTNAME>/mcp
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-env.ps1')
$ts = 'C:\Program Files\Tailscale\tailscale.exe'

# Public :443 -> http://127.0.0.1:<BRAIN_PORT>. GBrain stays bound to 127.0.0.1.
& $ts funnel --bg $env:BRAIN_PORT
& $ts funnel status
