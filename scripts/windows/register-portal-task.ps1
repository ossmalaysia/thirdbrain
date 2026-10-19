& (Join-Path $PSScriptRoot 'register-hidden-task.ps1') -TaskName 'BrainPortal' -Script 'serve-portal.ps1' `
    -Description 'Local connector portal, vault backup scheduler and Windows job worker for the Docker brain-scheduler'
