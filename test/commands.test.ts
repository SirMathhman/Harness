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
