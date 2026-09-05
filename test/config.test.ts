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
import {
  IMPLICIT_PROFILE_NAME,
  loadViseConfig,
  profileEntries,
  resolveProfile,
  resolveStartingProfile,
  stateFilePath,
  ViseConfigError,
  ViseRegistry,
  writeStateFile,
  type Registry,
} from "../src/profiles/index.js";
import { createSession } from "../src/agent/session.js";
import { profileCommand, profileListing } from "../src/cli/repl.js";
import { graphFrom, modelGraph } from "./helpers.js";

/** Two isolated temp directories standing in for `~/.vise` and `./.vise`. */
function twoTierProject(files: {
  global?: Record<string, string>;
  project?: Record<string, string>;
}): { globalRoot: string; root: string; cleanup: () => void } {
  const globalRoot = mkdtempSync(path.join(tmpdir(), "vise-global-"));
  const root = mkdtempSync(path.join(tmpdir(), "vise-project-"));
  for (const [base, entries] of [
    [globalRoot, files.global ?? {}],
    [root, files.project ?? {}],
  ] as const) {
    for (const [name, contents] of Object.entries(entries)) {
      const full = path.join(base, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
  }
  return {
    globalRoot,
    root,
    cleanup: () => {
      rmSync(globalRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// §3.2, §3.10 — two-tier loading
// ---------------------------------------------------------------------------

describe("two-tier config loading (config spec §3.2, §3.10)", () => {
  test("global and project resources combine into one graph (AC 1)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createProfile({ name: "local-dev", systemPrompt: "g" });
          };`,
      },
      project: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createProfile({ name: "implement", systemPrompt: "p" });
          };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    expect(graph.profiles.has("local-dev")).toBe(true);
    expect(graph.profiles.has("implement")).toBe(true);
    cleanup();
  });

  test("the project file can reference a global model by name (AC 2)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createModel({ name: "local", baseUrl: "http://localhost:8080", apiKey: "" });
          };`,
      },
      project: {
        ".vise/index.ts": `
          export default (reg) => {
            const local = reg.getModel("local");
            if (!local) throw new Error("global model 'local' not found");
            const impl = reg.createProfile({ name: "implement", systemPrompt: "p" });
            reg.createConnection(impl, local);
          };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    expect(resolveProfile(graph, "implement").config.baseUrl).toBe(
      "http://localhost:8080",
    );
    cleanup();
  });

  test("global-only: resources are available, session starts implicit (AC 4, C18)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createProfile({ name: "local-dev", systemPrompt: "g" });
          };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    expect(graph.profiles.has("local-dev")).toBe(true);
    expect(createSession({ graph }).profile).toBe(IMPLICIT_PROFILE_NAME);
    cleanup();
  });

  test("neither file present runs with built-in defaults (AC 6, C17)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({});
    const graph = await loadViseConfig(root, globalRoot);
    expect(profileEntries(graph)).toEqual([
      { name: IMPLICIT_PROFILE_NAME, origin: "builtin" },
    ]);
    cleanup();
  });

  test("a broken global config is fatal, just like a broken project config (AC 16, C2-C4)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: { ".vise/index.ts": `export default () => { throw new Error("global boom"); };` },
    });
    const err = await loadViseConfig(root, globalRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViseConfigError);
    expect((err as Error).message).toContain("global boom");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// §3.3 — name-conflict rule
// ---------------------------------------------------------------------------

describe("cross-file name conflicts (config spec §3.3, C1)", () => {
  const conflictOf = async (kind: "profile" | "model" | "tool", snippet: {
    global: string;
    project: string;
  }) => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: { ".vise/index.ts": snippet.global },
      project: { ".vise/index.ts": snippet.project },
    });
    const err = await loadViseConfig(root, globalRoot).catch((e: unknown) => e);
    cleanup();
    expect(err).toBeInstanceOf(ViseConfigError);
    expect((err as Error).message).toContain(
      `a ${kind} named "dup" is defined in both the global config`,
    );
    return (err as Error).message;
  };

  test("a duplicate profile name across files is fatal (AC 3)", async () => {
    await conflictOf("profile", {
      global: `export default (reg) => { reg.createProfile({ name: "dup", systemPrompt: "" }); };`,
      project: `export default (reg) => { reg.createProfile({ name: "dup", systemPrompt: "" }); };`,
    });
  });

  test("a duplicate model name across files is fatal (AC 3)", async () => {
    await conflictOf("model", {
      global: `export default (reg) => { reg.createModel({ name: "dup", baseUrl: "http://localhost:8080", apiKey: "" }); };`,
      project: `export default (reg) => { reg.createModel({ name: "dup", baseUrl: "http://localhost:9090", apiKey: "" }); };`,
    });
  });

  test("a duplicate tool name across files is fatal", async () => {
    await conflictOf("tool", {
      global: `export default (reg) => { reg.createTool({ name: "dup", description: "d", mutating: false, parameters: { type: "object", properties: {} }, async handler() { return "g"; } }); };`,
      project: `export default (reg) => { reg.createTool({ name: "dup", description: "d", mutating: false, parameters: { type: "object", properties: {} }, async handler() { return "p"; } }); };`,
    });
  });

  test("hooks are exempt: both files may define hooks freely", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `export default (reg) => { reg.createConnection(reg.builtins.defaultProfile, reg.createHook({ events: ["turn:end"], handler: () => "g" })); };`,
      },
      project: {
        ".vise/index.ts": `export default (reg) => { reg.createConnection(reg.builtins.defaultProfile, reg.createHook({ events: ["turn:end"], handler: () => "p" })); };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    expect(resolveProfile(graph, IMPLICIT_PROFILE_NAME).hooks).toHaveLength(2);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// §3.4 — name-lookup API
// ---------------------------------------------------------------------------

describe("name-lookup API (config spec §3.4)", () => {
  test("getProfile/getModel/getTool find resources by name", () => {
    const reg = new ViseRegistry();
    const model = reg.createModel({ name: "local", baseUrl: "http://x", apiKey: "" });
    const profile = reg.createProfile({ name: "implement", systemPrompt: "" });
    const tool = reg.createTool({
      name: "deploy",
      description: "d",
      mutating: false,
      parameters: { type: "object", properties: {} },
      async handler() {
        return "ok";
      },
    });
    expect(reg.getModel("local")).toBe(model);
    expect(reg.getProfile("implement")).toBe(profile);
    expect(reg.getTool("deploy")).toBe(tool);
    expect(reg.getTool("read_file")).toBe(reg.builtins.tools.read_file);
  });

  test("an unknown name returns undefined", () => {
    const reg = new ViseRegistry();
    expect(reg.getModel("nope")).toBeUndefined();
    expect(reg.getProfile("nope")).toBeUndefined();
    expect(reg.getTool("nope")).toBeUndefined();
  });

  test("an empty-named (auto-discover) model is never matched by getModel", () => {
    const reg = new ViseRegistry();
    reg.createModel({ name: "", baseUrl: "http://x", apiKey: "" });
    expect(reg.getModel("")).toBeUndefined();
  });

  test("passing an unchecked lookup result to createConnection is rejected (C5, C6)", () => {
    expect(() => {
      graphFrom((reg: Registry) => {
        const missing = reg.getModel("does-not-exist");
        const p = reg.createProfile({ name: "p", systemPrompt: "" });
        // @ts-expect-error deliberately passing the unchecked undefined through
        reg.createConnection(p, missing);
      });
    }).toThrow(/not a valid ResourceId/);
  });
});

// ---------------------------------------------------------------------------
// §3.5 — setRuntime merge, including profileSwitchMode
// ---------------------------------------------------------------------------

describe("setRuntime merge across files (config spec §3.5)", () => {
  test("per-key merge: project wins over global (AC 7, C14)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `export default (reg) => { reg.setRuntime({ maxIterations: 40, profileSwitchMode: "append" }); };`,
      },
      project: {
        ".vise/index.ts": `export default (reg) => { reg.setRuntime({ maxIterations: 60 }); };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    expect(graph.runtime.maxIterations).toBe(60);
    // profileSwitchMode was only set by the global file; it survives (AC 8, C15).
    expect(graph.runtime.profileSwitchMode).toBe("append");
    cleanup();
  });

  test("profileSwitchMode is a setRuntime key; setProfileSwitchMode no longer exists (AC 8)", () => {
    const graph = graphFrom((reg) => {
      reg.setRuntime({ profileSwitchMode: "append" });
      expect("setProfileSwitchMode" in reg).toBe(false);
    });
    expect(graph.runtime.profileSwitchMode).toBe("append");
  });

  test("an invalid profileSwitchMode value is a fatal config error", () => {
    expect(() =>
      graphFrom((reg) => {
        reg.setRuntime({ profileSwitchMode: "bogus" as never });
      }),
    ).toThrow(/profileSwitchMode must be "replace" or "append"/);
  });
});

// ---------------------------------------------------------------------------
// §3.7 — the implicit "Agent" profile
// ---------------------------------------------------------------------------

describe("the implicit Agent profile (config spec §3.7)", () => {
  test("its name is reserved and cannot be reused", () => {
    expect(() =>
      graphFrom((reg) => {
        reg.createProfile({ name: "Agent", systemPrompt: "" });
      }),
    ).toThrow(/reserved for the implicit built-in profile/);
  });

  test("/profile Agent switches to the implicit profile (AC 15, C20)", () => {
    const graph = graphFrom((reg) => {
      const model = reg.createModel({ name: "m", baseUrl: "http://localhost:8080", apiKey: "" });
      reg.createConnection(reg.builtins.defaultProfile, model);
      const other = reg.createProfile({ name: "other", systemPrompt: "o" });
      reg.createConnection(other, model);
    });
    const handle = createSession({ graph, profile: "other" });
    expect(profileCommand(handle, ["Agent"])).toContain("Agent");
    expect(handle.profile).toBe("Agent");
  });

  test("a global profile can be switched to from the project session (C21)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `
          export default (reg) => {
            const model = reg.createModel({ name: "m", baseUrl: "http://localhost:8080", apiKey: "" });
            const p = reg.createProfile({ name: "local-dev", systemPrompt: "g" });
            reg.createConnection(p, model);
          };`,
      },
      project: {
        ".vise/index.ts": `
          export default (reg) => {
            const model = reg.createModel({ name: "m2", baseUrl: "http://localhost:8080", apiKey: "" });
            const p = reg.createProfile({ name: "implement", systemPrompt: "p" });
            reg.createConnection(p, model);
          };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    const handle = createSession({ graph, profile: "implement" });
    expect(profileCommand(handle, ["local-dev"])).toContain("local-dev");
    expect(handle.profile).toBe("local-dev");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// §3.9 — /profile listing with origin markers
// ---------------------------------------------------------------------------

describe("/profile listing origin markers (config spec §3.9, AC 14)", () => {
  test("lists builtin, global, and project profiles in creation order", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `export default (reg) => { reg.createProfile({ name: "local-dev", systemPrompt: "" }); };`,
      },
      project: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createProfile({ name: "implement", systemPrompt: "" });
            reg.createProfile({ name: "review", systemPrompt: "" });
          };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    const handle = createSession({ graph });
    const listing = profileListing(handle);
    const lines = listing.split("\n").filter((l) => l.trim() !== "Profiles:");
    expect(lines[0]).toContain("Agent");
    expect(lines[0]).toContain("(builtin)");
    expect(lines[1]).toContain("local-dev");
    expect(lines[1]).toContain("(global)");
    expect(lines[2]).toContain("implement");
    expect(lines[2]).toContain("(project)");
    expect(lines[3]).toContain("review");
    expect(lines[3]).toContain("(project)");
    // Active one (the implicit default here) is marked.
    expect(listing).toContain("* Agent");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// §3.8 — profile persistence (state file)
// ---------------------------------------------------------------------------

describe("state file location (config spec §3.8.1, AC 13)", () => {
  test("with a project config present, state lives under ./.vise", () => {
    const { dir, cleanup } = makeProject({ ".vise/index.ts": "export default () => {};" });
    expect(stateFilePath(dir, "/nonexistent-home")).toBe(
      path.join(dir, ".vise", "state.json"),
    );
    cleanup();
  });

  test("with no project config, state falls back to the global root", () => {
    const { dir, cleanup } = makeProject({});
    const globalRoot = mkdtempSync(path.join(tmpdir(), "vise-globalhome-"));
    expect(stateFilePath(dir, globalRoot)).toBe(
      path.join(globalRoot, ".vise", "state.json"),
    );
    cleanup();
    rmSync(globalRoot, { recursive: true, force: true });
  });
});

describe("starting-profile resolution (config spec §3.7, §3.8.4)", () => {
  const graph = () =>
    modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createProfile({ name: "implement", systemPrompt: "" });
    });

  test("no state file: implicit profile, no warning (C7)", () => {
    const { dir, cleanup } = makeProject({});
    const warnings: string[] = [];
    const result = resolveStartingProfile(
      graph(),
      path.join(dir, ".vise", "state.json"),
      (m) => warnings.push(m),
    );
    expect(result).toEqual({ profile: IMPLICIT_PROFILE_NAME, lastModel: null });
    expect(warnings).toEqual([]);
    cleanup();
  });

  test("malformed JSON warns and falls back (C8)", () => {
    const { dir, cleanup } = makeProject({
      ".vise/state.json": "{ this is not json",
    });
    const warnings: string[] = [];
    const result = resolveStartingProfile(
      graph(),
      path.join(dir, ".vise", "state.json"),
      (m) => warnings.push(m),
    );
    expect(result.profile).toBe(IMPLICIT_PROFILE_NAME);
    expect(warnings[0]).toContain("could not read state file");
    cleanup();
  });

  test("an unexpected shape warns and falls back (C9)", () => {
    const { dir, cleanup } = makeProject({
      ".vise/state.json": JSON.stringify({ profile: 42 }),
    });
    const warnings: string[] = [];
    const result = resolveStartingProfile(
      graph(),
      path.join(dir, ".vise", "state.json"),
      (m) => warnings.push(m),
    );
    expect(result.profile).toBe(IMPLICIT_PROFILE_NAME);
    expect(warnings[0]).toContain("could not read state file");
    cleanup();
  });

  test("a saved profile absent from the graph warns by name and falls back (AC 11, C10)", () => {
    const { dir, cleanup } = makeProject({
      ".vise/state.json": JSON.stringify({
        profile: "ghost",
        savedAt: new Date().toISOString(),
        lastModel: "x",
      }),
    });
    const warnings: string[] = [];
    const result = resolveStartingProfile(
      graph(),
      path.join(dir, ".vise", "state.json"),
      (m) => warnings.push(m),
    );
    expect(result.profile).toBe(IMPLICIT_PROFILE_NAME);
    expect(warnings[0]).toContain('saved profile "ghost" not found');
    cleanup();
  });

  test("a valid saved profile is restored, with its lastModel (AC 10)", () => {
    const { dir, cleanup } = makeProject({
      ".vise/state.json": JSON.stringify({
        profile: "implement",
        savedAt: new Date().toISOString(),
        lastModel: "qwen2.5-coder-32b",
      }),
    });
    const warnings: string[] = [];
    const result = resolveStartingProfile(
      graph(),
      path.join(dir, ".vise", "state.json"),
      (m) => warnings.push(m),
    );
    expect(result).toEqual({
      profile: "implement",
      lastModel: "qwen2.5-coder-32b",
    });
    expect(warnings).toEqual([]);
    cleanup();
  });

  test("a saved profile of \"Agent\" restores the implicit profile without warning (C22)", () => {
    const { dir, cleanup } = makeProject({
      ".vise/state.json": JSON.stringify({
        profile: "Agent",
        savedAt: new Date().toISOString(),
        lastModel: "",
      }),
    });
    const warnings: string[] = [];
    const result = resolveStartingProfile(
      graph(),
      path.join(dir, ".vise", "state.json"),
      (m) => warnings.push(m),
    );
    expect(result.profile).toBe("Agent");
    expect(warnings).toEqual([]);
    cleanup();
  });
});

describe("writing the state file (config spec §3.8.3, AC 9)", () => {
  test("writes profile, timestamp, and model, creating the directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-writestate-"));
    const statePath = path.join(dir, ".vise", "state.json");
    expect(existsSync(statePath)).toBe(false);

    writeStateFile(statePath, "implement", "qwen2.5-coder-32b");

    expect(existsSync(statePath)).toBe(true);
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.profile).toBe("implement");
    expect(saved.lastModel).toBe("qwen2.5-coder-32b");
    expect(typeof saved.savedAt).toBe("string");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a write failure warns and does not throw (C12)", () => {
    // A file where a directory needs to be makes mkdirSync fail.
    const dir = mkdtempSync(path.join(tmpdir(), "vise-writefail-"));
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const statePath = path.join(blocker, "state.json");

    const warnings: string[] = [];
    expect(() =>
      writeStateFile(statePath, "implement", "m", (m) => warnings.push(m)),
    ).not.toThrow();
    expect(warnings[0]).toContain("could not save state");
    rmSync(dir, { recursive: true, force: true });
  });
});

/** A temp project directory holding arbitrary files, cleaned up by the caller. */
function makeProject(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "vise-state-project-"));
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
