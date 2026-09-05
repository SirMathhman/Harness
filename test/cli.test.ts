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
import { promptLabel } from "../src/cli/repl.js";
import {
  contextUsageLine,
  findCommand,
  helpText,
  initCommand,
  modelCommand,
  REPL_COMMANDS,
} from "../src/cli/commands.js";
import { CONFIG_STUB, writeConfigStub } from "../src/profiles/index.js";
import { modelGraph } from "./helpers.js";

/**
 * Env overrides that point `os.homedir()` at an empty, isolated directory, so
 * a subprocess test never picks up the real machine's `~/.vise/index.ts`.
 */
function isolatedHomeEnv(): Record<string, string | undefined> {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "vise-fakehome-"));
  return { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
}

describe("CLI startup (AC 1; providers spec §3.6, §4 E-P0)", () => {
  test("exits non-zero when no provider is registered", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-noprovider-"));
    mkdirSync(path.join(dir, ".vise"));
    writeFileSync(
      path.join(dir, ".vise", "index.ts"),
      [
        "export default (reg) => {",
        "  // no reg.addProvider() call",
        "};",
      ].join("\n"),
    );
    const entry = path.resolve("src/cli.ts");
    const proc = Bun.spawn(["bun", "run", entry], {
      cwd: dir,
      env: isolatedHomeEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    rmSync(dir, { recursive: true, force: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No models available");
  });

  test("exits non-zero when every registered provider discovers zero models", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-nomodel-"));
    mkdirSync(path.join(dir, ".vise"));
    writeFileSync(
      path.join(dir, ".vise", "index.ts"),
      [
        "export default (reg) => {",
        "  reg.addProvider({",
        '    name: "empty",',
        "    async discoverModels() { return []; },",
        "  });",
        "};",
      ].join("\n"),
    );
    const entry = path.resolve("src/cli.ts");
    const proc = Bun.spawn(["bun", "run", entry], {
      cwd: dir,
      env: isolatedHomeEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    rmSync(dir, { recursive: true, force: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No models available");
  });

  test("rejects configuration flags, which now live in .vise/index.ts", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--model", "x"], {
      cwd: process.cwd(),
      env: isolatedHomeEnv(),
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
    // A provider that discovers one model with no real network call, so the
    // REPL starts up deterministically with no real LLM server running.
    const dir = mkdtempSync(path.join(tmpdir(), "vise-state-e2e-"));
    mkdirSync(path.join(dir, ".vise"));
    writeFileSync(
      path.join(dir, ".vise", "index.ts"),
      [
        "export default (reg) => {",
        "  reg.addProvider({",
        '    name: "stub",',
        "    async discoverModels() {",
        '      return [{ name: "stub-model", baseUrl: "http://127.0.0.1:1", apiKey: "", maxContext: 8192 }];',
        "    },",
        "  });",
        "};",
      ].join("\n"),
    );
    const entry = path.resolve("src/cli.ts");
    const proc = Bun.spawn(["bun", "run", entry], {
      cwd: dir,
      env: isolatedHomeEnv(),
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
    expect(names).toContain("/clear");
    expect(names).toContain("/profile");
    expect(names).toContain("/model");
    expect(names).toContain("/hooks");
    expect(names).toContain("/init");
    expect(names).toContain("/init-global");
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

describe("/init and /init-global", () => {
  test("writeConfigStub creates .vise/index.ts with the stub", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-init-"));
    try {
      expect(writeConfigStub(dir)).toBe(true);
      const file = path.join(dir, ".vise", "index.ts");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(CONFIG_STUB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfigStub never overwrites an existing config", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-init-exists-"));
    try {
      mkdirSync(path.join(dir, ".vise"));
      const file = path.join(dir, ".vise", "index.ts");
      writeFileSync(file, "existing\n", "utf8");
      expect(writeConfigStub(dir)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("existing\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("initCommand reports creation and refusal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-init-cmd-"));
    try {
      expect(initCommand(dir, "./.vise/index.ts")).toBe(
        "created ./.vise/index.ts.",
      );
      expect(initCommand(dir, "./.vise/index.ts")).toBe(
        "./.vise/index.ts already exists — edit it by hand.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/context command", () => {
  test("reports no LLM call yet when lastPromptTokens is null", () => {
    const { session } = createSession({ graph: modelGraph() });
    expect(contextUsageLine(session)).toBe(
      "context: no LLM call yet (window 8192 tokens)",
    );
  });

  test("reports used vs total with a percentage", () => {
    const { session } = createSession({ graph: modelGraph() });
    session.lastPromptTokens = 4096;
    expect(contextUsageLine(session)).toBe(
      "context: 4096 / 8192 tokens (50.0%)",
    );
  });
});

describe("/clear command", () => {
  test("drops the conversation but keeps the leading system message", () => {
    const handle = createSession({ graph: modelGraph() });
    const systemMsg = handle.session.messages[0];
    expect(systemMsg.role).toBe("system");

    // Simulate a few turns of conversation.
    handle.session.messages.push({ role: "user", content: "hello" });
    handle.session.messages.push({ role: "assistant", content: "hi there" });
    handle.session.lastPromptTokens = 1234;

    const cmd = findCommand("/clear");
    expect(cmd).toBeDefined();
    const out = cmd!.run({ handle }, []);
    expect(out).toBe("conversation cleared.");

    // Only the system message remains; the token counter is reset.
    expect(handle.session.messages).toEqual([systemMsg]);
    expect(handle.session.lastPromptTokens).toBeNull();
  });

  test("is a no-op on an empty conversation", () => {
    const handle = createSession({ graph: modelGraph() });
    const before = handle.session.messages.length;
    const cmd = findCommand("/clear");
    cmd!.run({ handle }, []);
    expect(handle.session.messages.length).toBe(before);
  });
});

describe("/model command", () => {
  // A graph whose default profile uses "test-model", plus a second config
  // model with distinct parameters, so a switch can be verified field-by-field.
  function twoModelGraph() {
    return modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createModel({
        name: "other-model",
        baseUrl: "http://other:9999",
        apiKey: "secret",
        temperature: 0.9,
        maxContext: 4096,
      });
    });
  }

  test("lists every model, marking the active one", () => {
    const handle = createSession({ graph: twoModelGraph() });
    const text = modelCommand(handle);
    expect(text).toContain("Models:");
    expect(text).toContain("* test-model");
    expect(text).toContain("other-model");
  });

  test("switches to a config model, adopting its whole resource", () => {
    const handle = createSession({ graph: twoModelGraph() });
    expect(modelCommand(handle, ["other-model"])).toBe(
      `model: switched to "other-model".`,
    );
    const { config } = handle.session;
    expect(config.model).toBe("other-model");
    expect(config.baseUrl).toBe("http://other:9999");
    expect(config.apiKey).toBe("secret");
    expect(config.temperature).toBe(0.9);
    expect(config.maxContext).toBe(4096);
  });

  test("keeps the conversation and system prompt across a switch", () => {
    const handle = createSession({ graph: twoModelGraph() });
    const before = handle.session.messages.length;
    modelCommand(handle, ["other-model"]);
    expect(handle.session.messages.length).toBe(before);
  });

  test("refuses an unknown model and leaves the session untouched", () => {
    const handle = createSession({ graph: twoModelGraph() });
    const before = handle.session.config;
    const text = modelCommand(handle, ["nope"]);
    expect(text).toContain(`Unknown model "nope"`);
    expect(handle.session.config).toBe(before);
  });

  test("reports usage when given more than one argument", () => {
    const handle = createSession({ graph: twoModelGraph() });
    expect(modelCommand(handle, ["a", "b"])).toBe(
      "Usage: /model [<name>] (model names cannot contain spaces).",
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
