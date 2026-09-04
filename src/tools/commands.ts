import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { BackgroundCommand, Tool } from "../types.js";
import { newId, resolveShell, truncate } from "../utils.js";

/**
 * In-memory manager for background commands (spec §1.4.6d).
 * Holds id → handle, captures stdout/stderr, and tracks exit.
 */
export class BackgroundCommandManager {
  private commands = new Map<string, BackgroundCommand>();
  private children = new Map<string, ChildProcess>();
  /** The currently running foreground child, if any (killed on interruption). */
  private foregroundChild: ChildProcess | null = null;

  /** Start a command in the background; returns its id. */
  start(command: string, cwd: string | undefined, shell: string): string {
    const id = newId();
    const { command: shellCmd, args } = resolveShell(shell);
    const child = spawn(shellCmd, [...args, command], {
      cwd: cwd ? resolveCwd(cwd) : process.cwd(),
      env: process.env,
    });
    const record: BackgroundCommand = {
      id,
      status: "running",
      stdout: "",
      stderr: "",
    };
    this.commands.set(id, record);
    this.children.set(id, child);

    child.stdout?.on("data", (d: Buffer) => {
      record.stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      record.stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      record.stderr += `\n${err.message}`;
    });
    child.on("close", (code) => {
      record.status = "exited";
      record.exitCode = code ?? 0;
      this.children.delete(id);
    });
    return id;
  }

  get(id: string): BackgroundCommand | undefined {
    return this.commands.get(id);
  }

  /** Kill a running background command (used on interruption). */
  kill(id: string): void {
    this.children.get(id)?.kill("SIGKILL");
  }

  /** Kill all running background commands and any active foreground command. */
  killAll(): void {
    for (const [id] of this.children) this.kill(id);
    if (this.foregroundChild && !this.foregroundChild.killed) {
      this.foregroundChild.kill("SIGKILL");
    }
  }

  /**
   * Run a command in the foreground with a timeout. The child is tracked so
   * `killAll()` can terminate it on interruption.
   */
  async runForeground(
    command: string,
    cwd: string | undefined,
    shell: string,
    timeoutMs: number,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    const { command: shellCmd, args } = resolveShell(shell);
    const child = spawn(shellCmd, [...args, command], {
      cwd: cwd ? resolveCwd(cwd) : process.cwd(),
      env: process.env,
    });
    this.foregroundChild = child;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    try {
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => (stderr += `\n${err.message}`));
      const code = await new Promise<number>((resolve) => {
        child.on("close", (c) => resolve(c ?? 0));
      });
      return { exitCode: code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
      if (this.foregroundChild === child) this.foregroundChild = null;
    }
  }
}

function resolveCwd(cwd: string): string {
  return path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);
}

/**
 * run_command (spec §3.3 #6).
 * Foreground: runs to completion (or timeout), returns exitCode/stdout/stderr.
 * Background: spawns and returns { id }.
 */
export function makeRunCommandTool(
  manager: BackgroundCommandManager,
  defaultTimeoutMs: number,
  shell: string,
  maxToolOutputChars: number,
): Tool {
  return {
    name: "run_command",
    mutating: true,
    description:
      "Run a shell command. Foreground by default (returns exit code + output); pass background=true to run asynchronously and get an id.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeoutMs: {
          type: "integer",
          description: "Foreground timeout in ms (default from config).",
        },
        background: {
          type: "boolean",
          description: "Run in the background (default false).",
        },
        cwd: {
          type: "string",
          description: "Working directory (default process cwd).",
        },
      },
      required: ["command"],
    },
    async handler(args) {
      const command = String(args.command);
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const background = args.background === true;

      if (background) {
        const id = manager.start(command, cwd, shell);
        return JSON.stringify({ id });
      }

      const timeoutMs =
        typeof args.timeoutMs === "number" ? args.timeoutMs : defaultTimeoutMs;
      const result = await manager.runForeground(
        command,
        cwd,
        shell,
        timeoutMs,
      );
      if (result.timedOut) {
        return `Error: command timed out after ${timeoutMs}ms and was killed.`;
      }
      return JSON.stringify(
        {
          exitCode: result.exitCode,
          stdout: truncate(result.stdout, maxToolOutputChars),
          stderr: truncate(result.stderr, maxToolOutputChars),
        },
        null,
        2,
      );
    },
  };
}

/**
 * check_command (spec §3.3 #7).
 */
export function makeCheckCommandTool(
  manager: BackgroundCommandManager,
  maxToolOutputChars: number,
): Tool {
  return {
    name: "check_command",
    mutating: false,
    description: "Check the status and output of a background command by id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The background command id." },
      },
      required: ["id"],
    },
    async handler(args) {
      const id = String(args.id);
      const cmd = manager.get(id);
      if (!cmd) return `Error: unknown command id "${id}".`;
      return JSON.stringify(
        {
          status: cmd.status,
          exitCode: cmd.exitCode,
          stdout: truncate(cmd.stdout, maxToolOutputChars),
          stderr: truncate(cmd.stderr, maxToolOutputChars),
        },
        null,
        2,
      );
    },
  };
}
