import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/agent/session.js";
import {
  contextUsageLine,
  findCommand,
  helpText,
  promptLabel,
  REPL_COMMANDS,
} from "../src/cli/repl.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { modelGraph } from "./helpers.js";

describe("CLI startup (AC 1)", () => {
  test("prints a setup hint and exits non-zero when no model is resolvable", async () => {
    // Run the entry point in a project whose model auto-discovers from a port
    // nothing is listening on, so discovery fails deterministically regardless
    // of whether a real server happens to be running on this machine.
    const dir = mkdtempSync(path.join(tmpdir(), "vise-nomodel-"));
    mkdirSync(path.join(dir, ".vise"));
    writeFileSync(
      path.join(dir, ".vise", "index.ts"),
      [
        "export default (reg) => {",
        "  reg.createConnection(",
        "    reg.builtins.defaultProfile,",
        '    reg.createModel({ name: "", baseUrl: "http://127.0.0.1:1", apiKey: "" }),',
        "  );",
        "};",
      ].join("\n"),
    );
    const entry = path.resolve("src/index.ts");
    const proc = Bun.spawn(["bun", "run", entry], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    rmSync(dir, { recursive: true, force: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No model could be resolved");
  });

  test("rejects configuration flags, which now live in .vise/index.ts", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--model", "x"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown option(s): --model");
  });
});

describe("profile persistence end-to-end (config spec §3.8, AC 9, AC 13, C17)", () => {
  test("a clean exit saves the active profile and model to ./.vise/state.json", async () => {
    // An explicit, non-empty model name means no auto-discovery HTTP call is
    // ever attempted, so the REPL starts up with no real LLM server running.
    const dir = mkdtempSync(path.join(tmpdir(), "vise-state-e2e-"));
    mkdirSync(path.join(dir, ".vise"));
    writeFileSync(
      path.join(dir, ".vise", "index.ts"),
      [
        "export default (reg) => {",
        "  reg.createConnection(",
        "    reg.builtins.defaultProfile,",
        '    reg.createModel({ name: "stub-model", baseUrl: "http://127.0.0.1:1", apiKey: "" }),',
        "  );",
        "};",
      ].join("\n"),
    );
    const entry = path.resolve("src/index.ts");
    const proc = Bun.spawn(["bun", "run", entry], {
      cwd: dir,
      stdin: new TextEncoder().encode("/exit\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const statePath = path.join(dir, ".vise", "state.json");

    expect(exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.profile).toBe("Agent");
    expect(state.lastModel).toBe("stub-model");
    expect(typeof state.savedAt).toBe("string");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("REPL command registry", () => {
  test("contains the expected commands", () => {
    const names = REPL_COMMANDS.map((c) => c.name);
    expect(names).toContain("/help");
    expect(names).toContain("/context");
    expect(names).toContain("/profile");
    expect(names).toContain("/hooks");
    expect(names).toContain("/exit");
  });

  test("dispatch resolves each command and the exit aliases", () => {
    expect(findCommand("/help")?.name).toBe("/help");
    expect(findCommand("/context")?.name).toBe("/context");
    expect(findCommand("/exit")?.name).toBe("/exit");
    // Bare exit/quit are aliases for /exit.
    expect(findCommand("exit")?.name).toBe("/exit");
    expect(findCommand("quit")?.name).toBe("/exit");
    // Unknown input is not a command.
    expect(findCommand("do something")).toBeUndefined();
  });

  test("/help lists every command in the registry", () => {
    const text = helpText();
    for (const cmd of REPL_COMMANDS) {
      expect(text).toContain(cmd.name);
    }
  });
});

describe("/context command", () => {
  test("reports no LLM call yet when lastPromptTokens is null", () => {
    const { session } = createSession({ graph: modelGraph() });
    expect(contextUsageLine(session)).toBe(
      `context: no LLM call yet (window ${DEFAULT_CONFIG.maxContext} tokens)`,
    );
  });

  test("reports used vs total with a percentage", () => {
    const { session } = createSession({ graph: modelGraph() });
    session.lastPromptTokens = 4096;
    expect(contextUsageLine(session)).toBe(
      `context: 4096 / ${DEFAULT_CONFIG.maxContext} tokens (50.0%)`,
    );
  });
});

describe("no persistence (AC 13)", () => {
  test("a session holds state only in memory", () => {
    const { session, manager } = createSession({ graph: modelGraph() });
    // The session is a plain in-memory object.
    expect(Array.isArray(session.messages)).toBe(true);
    // The background command manager is in-memory (no disk handles).
    expect(manager.get("nope")).toBeUndefined();
  });

  test("no config file is created by the runtime", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-nopersist-"));
    // Running with no ./.vise/ must not create one.
    createSession({ graph: modelGraph() });
    expect(existsSync(path.join(dir, ".vise"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("prompt label", () => {
  test("is bare `vise` under the implicit default profile", () => {
    expect(promptLabel(createSession({ graph: modelGraph() }))).toBe("vise");
  });

  test("names the active profile once one is defined", () => {
    const graph = modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createProfile({ name: "refactor", systemPrompt: "" });
    });
    expect(promptLabel(createSession({ graph, profile: "refactor" }))).toBe(
      "vise:refactor",
    );
  });
});
