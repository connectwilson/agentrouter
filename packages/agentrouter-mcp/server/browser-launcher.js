import { spawn } from "node:child_process";

export async function launchBrowserAuthorization(target, {
  allowedOrigins = [],
  disabled = false,
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 1_000
} = {}) {
  if (disabled) return { attempted: false, opened: false, status: "disabled" };
  const url = approvedUrl(target, allowedOrigins);
  if (!url) return { attempted: false, opened: false, status: "blocked" };
  const launch = platformCommand(platform, url.toString());
  if (!launch) return { attempted: false, opened: false, status: "unsupported_platform" };

  try {
    const child = spawnProcess(launch.command, launch.args, {
      detached: true,
      shell: false,
      stdio: "ignore"
    });
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(50, Number(timeoutMs) || 1_000));
      child.once("spawn", () => { clearTimeout(timer); resolve(true); });
      child.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    child.unref?.();
    return { attempted: true, opened, status: opened ? "opened" : "failed" };
  } catch (error) {
    return { attempted: true, opened: false, status: "failed", error: String(error?.message || error).slice(0, 200) };
  }
}

function approvedUrl(target, allowedOrigins) {
  try {
    const url = new URL(String(target || ""));
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    const origins = new Set((allowedOrigins || []).map((value) => {
      try { return new URL(String(value)).origin; } catch { return ""; }
    }).filter(Boolean));
    if (origins.size && !origins.has(url.origin)) return null;
    return url;
  } catch {
    return null;
  }
}

function platformCommand(platform, target) {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target] };
  if (platform === "linux") return { command: "xdg-open", args: [target] };
  return null;
}
