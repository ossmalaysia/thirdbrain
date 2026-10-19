// Hides the Claude.ai browser windows completely (not on the taskbar) on Windows, and shows them again for a
// sign-in. The browser keeps running: the launch flags already stop Edge from throttling a window nobody sees
// (cdp.ts launchArgs). Minimising alone left two Edge windows on the taskbar that users did not expect.
// Other platforms: no-op (the window stays minimised).

const CS = `
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class TbWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  public static string Hide(uint pid) {
    var hidden = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { ShowWindow(h, 0); hidden.Add(h.ToInt64().ToString()); }
      return true; }, IntPtr.Zero);
    return string.Join(",", hidden);
  }
  public static int Show(string handles) {
    int n = 0;
    foreach (var s in handles.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) {
      var h = new IntPtr(long.Parse(s)); if (IsWindow(h)) { ShowWindow(h, 9); n++; } }
    return n;
  }
}`;

/** Runs the helper in PowerShell. Returns stdout, or null when not on Windows or on any failure (never throws). */
async function run(expr: string): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const script = `Add-Type -TypeDefinition @'\n${CS}\n'@\n${expr}`;
  try {
    const p = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => p.kill(), 20_000);
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    return code === 0 ? out.trim() : null;
  } catch { return null; }
}

/** Hides every visible top-level window of the browser process; returns the hidden window handles. */
export async function hideBrowserWindows(pid: number | undefined): Promise<string[]> {
  if (!pid || !Number.isSafeInteger(pid)) return [];
  const out = await run(`[TbWin]::Hide([uint32]${pid})`);
  return out ? out.split(",").filter(h => /^\d+$/.test(h)) : [];
}

/** Shows the windows hidden earlier (by handle), e.g. so the user can sign in again. */
export async function showBrowserWindows(handles: string[] | undefined): Promise<number> {
  const safe = (handles ?? []).filter(h => /^\d+$/.test(h));
  if (!safe.length) return 0;
  const out = await run(`[TbWin]::Show('${safe.join(",")}')`);
  return Number(out ?? 0) || 0;
}
