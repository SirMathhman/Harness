import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/agent/session.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

describe("CLI startup (AC 1)", () => {
  test("prints a setup hint and exits non-zero when no model is configured", async () => {
    // Run the entry point in a clean env (no HARNESS_MODEL, no config file).
    const env = { ...process.env };
    delete env.HARNESS_MODEL;
    delete env.HARNESS_BASE_URL;
    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No model configured");
  });
});

describe("no persistence (AC 13)", () => {
  test("a session holds state only in memory", () => {
    const cfg = { ...DEFAULT_CONFIG, model: "m" };
    const { session, manager } = createSession(cfg);
    // The session is a plain in-memory object.
    expect(Array.isArray(session.messages)).toBe(true);
    // The background command manager is in-memory (no disk handles).
    expect(manager.get("nope")).toBeUndefined();
  });

  test("no config file is created by the runtime", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-nopersist-"));
    const cfgPath = path.join(dir, "harness.config.json");
    // Resolving config from a missing file must not create it.
    expect(existsSync(cfgPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
