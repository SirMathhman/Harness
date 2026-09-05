import { describe, expect, test } from "bun:test";
import {
  BackgroundCommandManager,
  makeRunCommandTool,
  makeCheckCommandTool,
} from "../src/tools/commands.js";

const isWin = process.platform === "win32";
const sleepCmd = isWin ? "Start-Sleep -Seconds 5" : "sleep 5";
const echoCmd = isWin ? 'Write-Output "hi"' : 'echo "hi"';

describe("command tools (AC 9, 10)", () => {
  test("run_command foreground returns exit code + stdout", async () => {
    const manager = new BackgroundCommandManager();
    const tool = makeRunCommandTool(manager, 5000, "auto", 10000);
    const out = await tool.handler({ command: echoCmd });
    const parsed = JSON.parse(out) as { exitCode: number; stdout: string };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("hi");
  });

  test("run_command foreground timeout kills + error (E8)", async () => {
    const manager = new BackgroundCommandManager();
    const tool = makeRunCommandTool(manager, 5000, "auto", 10000);
    const out = await tool.handler({ command: sleepCmd, timeoutMs: 300 });
    expect(out).toContain("timed out");
  });

  test("run_command foreground spawn failure is surfaced, not a timeout", async () => {
    // A non-existent *shell*: the child emits `error` and never `close`. The
    // shared primitive must resolve on the spawn error, not hang until the
    // timeout and misreport it as `timedOut`. (A non-existent binary inside a
    // real shell exits non-zero via `close`, which was never the bug.)
    const missingShell = isWin
      ? "definitely-not-a-real-shell.exe"
      : "/nonexistent/definitely-not-a-real-shell";
    const manager = new BackgroundCommandManager();
    const tool = makeRunCommandTool(manager, 5000, missingShell, 10000);
    const out = await tool.handler({ command: "echo hi", timeoutMs: 2000 });
    // Not reported as a timeout.
    expect(out).not.toContain("timed out");
    const parsed = JSON.parse(out) as { exitCode: number; stderr: string };
    expect(parsed.exitCode).toBe(-1);
    // The spawn error is surfaced in stderr.
    expect(parsed.stderr.length).toBeGreaterThan(0);
  });

  test("run_command background returns id; check_command reports it (AC 10)", async () => {
    const manager = new BackgroundCommandManager();
    const run = makeRunCommandTool(manager, 5000, "auto", 10000);
    const check = makeCheckCommandTool(manager, 10000);

    const out = await run.handler({ command: echoCmd, background: true });
    const { id } = JSON.parse(out) as { id: string };
    expect(typeof id).toBe("string");

    // Give the command a moment to finish, then check.
    await new Promise((r) => setTimeout(r, 300));
    const status = JSON.parse(await check.handler({ id })) as {
      status: string;
      stdout: string;
    };
    expect(status.status).toBe("exited");
    expect(status.stdout).toContain("hi");
  });

  test("check_command unknown id -> error (E9)", async () => {
    const manager = new BackgroundCommandManager();
    const check = makeCheckCommandTool(manager, 10000);
    const out = await check.handler({ id: "does-not-exist" });
    expect(out).toContain("Error");
  });

  test("killAll terminates a running background command", async () => {
    const manager = new BackgroundCommandManager();
    const run = makeRunCommandTool(manager, 5000, "auto", 10000);
    const out = await run.handler({ command: sleepCmd, background: true });
    const { id } = JSON.parse(out) as { id: string };
    manager.killAll();
    await new Promise((r) => setTimeout(r, 200));
    const cmd = manager.get(id);
    expect(cmd?.status).toBe("exited");
  });
});
