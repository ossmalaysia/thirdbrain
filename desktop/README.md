# Third Brain desktop

A thin desktop app for the Third Brain portal: one window and a tray icon. It does no work itself.
The background service (the `BrainPortal` scheduled task on Windows) runs the portal, the sync, the
nightly Dream, backups and the GBrain server. This app never starts, stops or owns any of them.

- The window shows the portal at `http://127.0.0.1:58432` (change it with the `THIRDBRAIN_URL` environment variable).
- If nothing answers there, the window shows "Third Brain is not running on this computer" with a Retry button.
- Only portal pages open in the window. Other links (Obsidian, Claude.ai, GitHub, sign-in pages, the GBrain
  admin link) open in the default browser or app, and only for `http`, `https` and `obsidian` links.
- Closing the window hides it in the tray. **Quit** in the tray menu ends the app.
- The tray menu: Open Third Brain, the sync state (from `GET /api/status`, every 60 seconds and when the
  menu opens), Sync now, Open at sign-in (starts hidden in the tray), Quit. A failed sync run shows one notice.
- The window size and position are kept in `window-state.json` in the app's user data folder.

## Run

```sh
cd desktop
bun install
bun run start
```

Checks: `bun test` (URL and status rules), `bun run smoke` (loads the window, prints the page title and the
tray status, then quits). `THIRDBRAIN_URL=http://127.0.0.1:58999 bun run smoke` shows the "not running" page.

## Start menu shortcut (for now)

There is no installer yet. To start the app from the Start menu on Windows, run this once in PowerShell
from the `desktop` folder:

```powershell
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Third Brain.lnk")
$lnk.TargetPath = (Resolve-Path .\node_modules\electron\dist\electron.exe).Path
$lnk.Arguments = '"' + (Get-Location).Path + '"'
$lnk.WorkingDirectory = (Get-Location).Path
$lnk.Save()
```

"Open at sign-in" in the tray menu adds the sign-in entry by itself.

## Later (Phase 2)

An installer with electron-builder (Windows, macOS and Linux), a proper `.ico`/`.icns` icon and auto-update.

`bun run icons` renders the tray icons (`assets/tray.png`, `assets/tray@2x.png`) from `assets/icon.png`,
which is a copy of the portal's `app/portal/icons/icon-512.png`.

## Windows installer

```
cd desktop
bun install
bun run dist
```

This writes `dist/ThirdBrain-Setup-<version>.exe` (one-click, per user, no admin rights; Start menu and desktop shortcuts). The installer is not code-signed yet, so Windows SmartScreen asks once: "More info" -> "Run anyway". Uninstall from Windows Settings -> Apps. The installer contains only the window and tray app; the BrainPortal background service is set up separately.
