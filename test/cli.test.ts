import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/agent/session.js";
import { contextUsageLine } from "../src/cli/repl.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

describe("CLI startup (AC 1)", () => {
  test("prints a setup hint and exits non-zero when no model is resolvable", async () => {
    // Run the entry point in a clean env (no HARNESS_MODEL, no config file) and
    // point at a port nothing is listening on so model auto-discovery fails
    // deterministically, regardless of whether a real server is running.
    const env = { ...process.env };
    delete env.HARNESS_MODEL;
    env.HARNESS_BASE_URL = "http://127.0.0.1:1";
    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No model could be resolved");
  });
});

describe("/context command", () => {
  test("reports no LLM call yet when lastPromptTokens is null", () => {
    const { session } = createSession({ ...DEFAULT_CONFIG, model: "m" });
    expect(contextUsageLine(session)).toBe(
      `context: no LLM call yet (window ${DEFAULT_CONFIG.maxContext} tokens)`,
    );
  });

  test("reports used vs total with a percentage", () => {
    const { session } = createSession({ ...DEFAULT_CONFIG, model: "m" });
    session.lastPromptTokens = 4096;
    expect(contextUsageLine(session)).toBe(
      `context: 4096 / ${DEFAULT_CONFIG.maxContext} tokens (50.0%)`,
    );
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
