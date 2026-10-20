# One-time setup of the automatic sync schedule (every 15 minutes).
# The schedule is a tiny Docker container (app/docker, no network, no ports) that drops a job request into
# <state dir>\scheduler every 15 minutes; the running portal picks it up and starts the sync.
# Needs Docker Desktop. Run from PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-scheduler.ps1
# -NoStart only tells the portal to use the Docker schedule and prints the docker command (nothing is started).
# Afterwards click Resume on the portal: the schedule starts paused.
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$stateDir = if ($env:MAILSYNC_STATE_DIR) { $env:MAILSYNC_STATE_DIR } elseif ($env:THIRDBRAIN_STATE_DIR) { $env:THIRDBRAIN_STATE_DIR } else { Join-Path $env:USERPROFILE '.brain-mailsync' }
$dir = Join-Path $stateDir 'scheduler'
New-Item -ItemType Directory -Force (Join-Path $dir 'requests') | Out-Null
# UTF-8 without a byte order mark: the portal reads this file with JSON.parse.
[IO.File]::WriteAllText((Join-Path $dir 'backend.json'), '{"backend":"docker"}')
$compose = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\app\docker\compose.yaml'))
$env:BRAIN_SCHEDULER_DIR = $dir
if ($NoStart) {
    Write-Host "Portal set to the Docker schedule. To start it:"
    Write-Host "  `$env:BRAIN_SCHEDULER_DIR = '$dir'; docker compose -f '$compose' up -d --build"
    exit 0
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is not installed. Install Docker Desktop, start it, then run this script again.' }
docker compose -f $compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'docker compose failed. Is Docker Desktop running?' }
Write-Host 'Schedule started (paused). Open the portal and click Resume.'
