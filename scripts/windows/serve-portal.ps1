$ErrorActionPreference = 'Stop'
$env:Path += ";$env:USERPROFILE\.bun\bin;$env:USERPROFILE\.local\bin"
$env:Path += ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')
Set-Location (Join-Path $PSScriptRoot '..\..\app')
bun run src/portal.ts
exit $LASTEXITCODE
