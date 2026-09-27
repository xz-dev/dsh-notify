import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function defaultIsExecutable(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultWhich(command, env, isExecutable) {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function windowsPathToWsl(windowsPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath.replaceAll("/", "\\"));
  if (!match) return undefined;
  const drive = match[1].toLowerCase();
  const rest = match[2].replaceAll("\\", "/");
  return `/mnt/${drive}/${rest}`.replace(/\/+$/, "");
}

/**
 * Resolve bare powershell.exe for toast/shell use.
 * WSL order: PATH, SystemRoot/WINDIR-derived WSL path, canonical /mnt/c/... path.
 * Native Windows keeps normal powershell.exe when not found on PATH.
 */
export function resolvePowerShell(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const which = options.which ?? ((command) => defaultWhich(command, env, isExecutable));

  const fromPath = which("powershell.exe");
  if (fromPath) return fromPath;

  if (platform === "win32") {
    return "powershell.exe";
  }

  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? env.windir;
  if (systemRoot) {
    const wslRoot = windowsPathToWsl(systemRoot);
    if (wslRoot) {
      const candidate = `${wslRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`;
      if (isExecutable(candidate)) return candidate;
    }
  }

  const canonical = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  if (isExecutable(canonical)) return canonical;
  return undefined;
}

/** Auto-resolve only the exact bare name powershell.exe (case-insensitive). Paths stay exact. */
export function isBarePowerShellExe(interpreter) {
  return interpreter.toLowerCase() === "powershell.exe";
}
