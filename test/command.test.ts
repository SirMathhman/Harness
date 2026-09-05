import { describe, expect, test } from "bun:test";
import { runCommand } from "../src/command.js";
import * as index from "../src/index.js";

describe("public API exports (v0.6.0 spec §2.1, A12, A13)", () => {
  test("A12: runCommand is a value export from the package root", () => {
    expect(typeof index.runCommand).toBe("function");
    // The root export is the same function the module exports directly.
    expect(index.runCommand).toBe(runCommand);
  });

  test("A13: importing the package root is side-effect-free", () => {
    // Importing src/index.js must not launch a session or touch stdin. The
    // module is already imported at the top of this file; reaching here
    // without a hang or a REPL prompt is the assertion.
    expect(index).toBeDefined();
    expect(typeof index.runCommand).toBe("function");
  });
});

describe("runCommand (v0.6.0 spec §2.1, §3.2)", () => {
  test("A1: a successful command returns exit 0 and its stdout", async () => {
    const out = await runCommand("echo hello");
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("hello");
    expect(out.stderr).toBe("");
    expect(out.timedOut).toBe(false);
  });

  test("A2: a non-zero exit is returned as data, not thrown", async () => {
    const out = await runCommand("exit 1");
    expect(out.exitCode).toBe(1);
    expect(out.timedOut).toBe(false);
  });

  test("A3: a timeout kills the child and reports timedOut", async () => {
    const out = await runCommand("sleep 10", { timeoutMs: 100 });
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBe(-1);
  });

  test("A4: an empty command reports exit -1 and 'empty command'", async () => {
    const out = await runCommand("");
    expect(out.exitCode).toBe(-1);
    expect(out.stderr).toContain("empty command");
    expect(out.stdout).toBe("");
    expect(out.timedOut).toBe(false);
  });

  test("A5: display() formats a successful run", async () => {
    const out = await runCommand("echo hello");
    const d = out.display();
    // Header lines are always present, in order.
    expect(d.startsWith("Command: echo hello\nExit code: 0\n")).toBe(true);
    // A non-empty stdout gets its own section; empty stderr does not.
    expect(d).toContain("--- stdout ---");
    expect(d).toContain("hello");
    expect(d).not.toContain("--- stderr ---");
  });

  test("A5: display() formats a run that writes to stderr", async () => {
    // `Write-Error` (PowerShell) / `echo ... >&2` (sh) both land on stderr.
    const cmd =
      process.platform === "win32" ? "Write-Error boom" : "echo boom >&2";
    const out = await runCommand(cmd);
    const d = out.display();
    expect(d.startsWith(`Command: ${cmd}\n`)).toBe(true);
    expect(d).toContain("--- stderr ---");
    expect(d).toContain("boom");
    // The command produced no stdout, so no stdout section.
    expect(d).not.toContain("--- stdout ---");
  });

  test("A5: display() annotates a timed-out run", async () => {
    const out = await runCommand("sleep 10", { timeoutMs: 100 });
    const d = out.display();
    expect(d.startsWith("Command: sleep 10\n")).toBe(true);
    expect(d).toContain("Exit code: -1 (timed out)");
  });
});
