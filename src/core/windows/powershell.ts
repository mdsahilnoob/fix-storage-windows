import { execFile } from "node:child_process";

/** One PowerShell process for structured, read-only system queries. */
export function powerShellJson<T>(script: string, timeoutMs = 20_000): Promise<T> {
  return new Promise((done, fail) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 8 << 20, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) return fail(new Error(stderr.trim() || error.message));
        try {
          done(JSON.parse(stdout) as T);
        } catch {
          fail(new Error(`Windows returned an unreadable response${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
        }
      },
    );
  });
}
