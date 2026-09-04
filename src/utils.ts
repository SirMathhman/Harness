/**
 * Small shared utilities: string truncation, path resolution, shell detection.
 */
import path from "node:path";
import os from "node:os";

/**
 * Truncate a string to `maxChars`, appending a notice when truncation occurs.
 * Returns the original string unchanged when it fits.
 */
export function truncate(
  text: string,
  maxChars: number,
  notice = "\n…[output truncated]",
): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + notice;
}

/**
 * Resolve a possibly-relative path against the process working directory.
 * Absolute paths are returned as-is.
 */
export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export type ShellKind = "powershell" | "bash" | "sh";

/**
 * Determine the shell to use for `run_command` given a config value.
 * `auto` selects PowerShell on Windows and `sh` elsewhere.
 * Returns `{ command, args }` suitable for `child_process.spawn`.
 */
export function resolveShell(shell: string): {
  command: string;
  args: string[];
} {
  const value = (shell || "auto").toLowerCase();
  if (value === "auto") {
    if (process.platform === "win32") {
      return { command: "powershell", args: ["-NoProfile", "-Command"] };
    }
    return { command: "sh", args: ["-c"] };
  }
  if (value === "powershell") {
    return { command: "powershell", args: ["-NoProfile", "-Command"] };
  }
  if (value === "bash") {
    return { command: "bash", args: ["-c"] };
  }
  if (value === "sh") {
    return { command: "sh", args: ["-c"] };
  }
  // Treat anything else as an explicit shell path.
  return { command: shell, args: ["-c"] };
}

/** Detect whether a buffer looks binary (contains NUL bytes in the head). */
export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** A short, unique id for background commands. */
export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function homeDir(): string {
  return os.homedir();
}
