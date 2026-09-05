/**
 * `runCommand` — a standalone foreground command runner for hook handlers
 * (v0.6.0 spec §2.1, §3.2).
 *
 * It is a hook helper, not a tool: it spawns a child process in a resolved
 * shell, captures stdout/stderr in full, and resolves on exit. It never throws
 * — every outcome (success, non-zero exit, timeout, spawn failure, empty
 * command) is returned as a `CommandOutput`. It is side-effect-free with
 * respect to the session: it does not register background commands, does not
 * touch the `BackgroundCommandManager`, and does not modify any session state.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveShell } from "./utils.js";

/** Options for `runCommand` (v0.6.0 spec §2.1). */
export interface RunCommandOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Kill the child after this many milliseconds. Defaults to 60000. */
  timeoutMs?: number;
  /** Shell to run in. Defaults to `"auto"` (PowerShell on Windows, `sh` elsewhere). */
  shell?: string;
}

/** The captured result of a `runCommand` call (v0.6.0 spec §2.1). */
export interface CommandOutput {
  /**
   * The child's exit code. `-1` when the process could not be spawned or the
   * command timed out.
   */
  exitCode: number;
  /** Everything the child wrote to stdout, in full (no truncation). */
  stdout: string;
  /** Everything the child wrote to stderr, in full (no truncation). */
  stderr: string;
  /** True when the command was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /**
   * A formatted string suitable for injection into an LLM conversation
   * (v0.6.0 spec §3.2).
   */
  display(): string;
}

/**
 * Run `command` in a resolved shell and capture its output (v0.6.0 spec §2.1).
 *
 * Never throws. An empty command resolves with `exitCode: -1` and
 * `stderr: "empty command"`. A timeout kills the child and resolves with
 * `exitCode: -1`, `timedOut: true`, and whatever output was captured so far.
 * A spawn failure resolves with `exitCode: -1` and the spawn error in
 * `stderr`.
 */
export async function runCommand(
  command: string,
  opts: RunCommandOptions = {},
): Promise<CommandOutput> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 60000;
  const shell = opts.shell ?? "auto";

  if (command === "") {
    return makeOutput(command, {
      exitCode: -1,
      stdout: "",
      stderr: "empty command",
      timedOut: false,
    });
  }

  const { command: shellCmd, args } = resolveShell(shell);
  const resolvedCwd = path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);

  let child: ChildProcess;
  try {
    child = spawn(shellCmd, [...args, command], {
      cwd: resolvedCwd,
      env: process.env,
    });
  } catch (err) {
    // A synchronous throw from spawn (invalid arguments, …).
    return makeOutput(command, {
      exitCode: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    });
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError: string | null = null;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

    // Resolve on whichever settles first: a spawn failure emits `error` (and
    // never `close`), a normal run emits `close`.
    const code = await new Promise<number | null>((resolve) => {
      let settled = false;
      child.on("error", (err) => {
        spawnError = err.message;
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
      child.on("close", (c) => {
        if (!settled) {
          settled = true;
          resolve(c);
        }
      });
    });

    if (timedOut) {
      return makeOutput(command, {
        exitCode: -1,
        stdout,
        stderr,
        timedOut: true,
      });
    }
    if (spawnError !== null) {
      return makeOutput(command, {
        exitCode: -1,
        stdout: "",
        stderr: spawnError,
        timedOut: false,
      });
    }
    return makeOutput(command, {
      exitCode: code ?? 0,
      stdout,
      stderr,
      timedOut: false,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Build a `CommandOutput` with its `display()` method bound to the fields. */
function makeOutput(
  command: string,
  fields: {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  },
): CommandOutput {
  return {
    ...fields,
    display() {
      const lines: string[] = [];
      lines.push(`Command: ${command}`);
      lines.push(
        fields.timedOut
          ? `Exit code: ${fields.exitCode} (timed out)`
          : `Exit code: ${fields.exitCode}`,
      );
      if (fields.stdout !== "") {
        lines.push("--- stdout ---");
        lines.push(fields.stdout);
      }
      if (fields.stderr !== "") {
        lines.push("--- stderr ---");
        lines.push(fields.stderr);
      }
      return lines.join("\n");
    },
  };
}
