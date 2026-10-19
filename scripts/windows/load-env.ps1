# Loads the Third Brain settings file (key=value) into the current PowerShell session.
# Which file: $env:THIRDBRAIN_SETTINGS_FILE when set, else the `settingsFile` in config.json, else
# <state dir>\settings.env (state dir: $env:MAILSYNC_STATE_DIR, $env:THIRDBRAIN_STATE_DIR or ~\.brain-mailsync).
# BRAIN_PATH falls back to config.json's vault.path. See docs/configuration.md.
$stateDir = if ($env:MAILSYNC_STATE_DIR) { $env:MAILSYNC_STATE_DIR } elseif ($env:THIRDBRAIN_STATE_DIR) { $env:THIRDBRAIN_STATE_DIR } else { Join-Path $env:USERPROFILE '.brain-mailsync' }
$configFile = if ($env:THIRDBRAIN_CONFIG) { $env:THIRDBRAIN_CONFIG } else { Join-Path $stateDir 'config.json' }
$config = if (Test-Path $configFile) { Get-Content $configFile -Raw | ConvertFrom-Json } else { $null }
$envFile = if ($env:THIRDBRAIN_SETTINGS_FILE) { $env:THIRDBRAIN_SETTINGS_FILE }
    elseif ($config -and $config.settingsFile) { [IO.Path]::GetFullPath((Join-Path (Split-Path $configFile) $config.settingsFile)) }
    else { Join-Path $stateDir 'settings.env' }
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
        $k, $v = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
    }
}
if (-not $env:BRAIN_PATH -and $config -and $config.vault -and $config.vault.path) { $env:BRAIN_PATH = $config.vault.path }
if (-not $env:BRAIN_PATH) { throw "No vault path. Set vault.path in $configFile (see docs/configuration.md)." }
