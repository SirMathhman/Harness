import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultProfileName,
  findConfigEntry,
  loadViseConfig,
  profileNames,
  resolveProfile,
  UnknownProfileError,
  ViseConfigError,
  type Registry,
  type ResourceGraph,
} from "../src/profiles/index.js";
import { createSession } from "../src/agent/session.js";
import { profileCommand, profileListing } from "../src/cli/repl.js";
import { runTurn } from "../src/agent/loop.js";
import { makeSubagentRunner } from "../src/agent/subagent.js";
import { DEFAULT_SYSTEM_PROMPT } from "../src/config/defaults.js";
import { BUILTIN_TOOL_NAMES } from "../src/tools/index.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMResponse, Tool } from "../src/types.js";
import { graphFrom, modelGraph, profileGraph } from "./helpers.js";

/** A scripted LLM client: returns responses in order, repeating the last. */
function stubClient(responses: LLMResponse[]): LLMClient {
  let i = 0;
  return {
    async chat() {
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

const finish = (answer: string, id = "f1"): LLMResponse => ({
  content: "",
  toolCalls: [{ id, name: "finish", arguments: { answer } }],
  usage: null,
});

/** A no-op custom tool, for tool-resource tests. */
function customTool(name: string): Tool {
  return {
    name,
    description: `the ${name} tool`,
    mutating: false,
    parameters: { type: "object", properties: {} },
    async handler() {
      return `${name} ran`;
    },
  };
}

/** A temp project directory holding a `.vise/` config, cleaned up by the caller. */
function makeProject(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "vise-config-"));
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The names of the tools a graph's profile actually exposes to the model. */
function toolsOf(graph: ResourceGraph, profile: string): string[] {
  return createSession({ graph, profile })
    .registry.all()
    .map((t) => t.name)
    .sort();
}

// ---------------------------------------------------------------------------
// §3.1, §3.10 — configuration loading
// ---------------------------------------------------------------------------

describe("config loading (profiles §3.1, §3.10)", () => {
  test("no ./.vise/index.ts runs with built-in defaults (AC 8)", async () => {
    const { dir, cleanup } = makeProject({});
    expect(findConfigEntry(dir)).toBeNull();

    const graph = await loadViseConfig(dir);
    expect(profileNames(graph)).toEqual([]);
    const resolved = resolveProfile(graph, defaultProfileName(graph));
    // Built-in prompt, every built-in tool, no hooks, the default model.
    expect(resolved.config.systemPrompt).toBeNull();
    expect(resolved.builtinTools).toBeNull();
    expect(resolved.hooks).toEqual([]);
    expect(resolved.config.baseUrl).toBe("http://localhost:8080");
    expect(toolsOf(graph, "").sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
    cleanup();
  });

  test("a config that throws is fatal, carrying its message (AC 9)", async () => {
    const { dir, cleanup } = makeProject({
      ".vise/index.ts": `export default () => { throw new Error("bad setup"); };`,
    });
    const err = await loadViseConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViseConfigError);
    expect((err as Error).message).toContain("bad setup");
    cleanup();
  });

  test("a syntax error is fatal", async () => {
    const { dir, cleanup } = makeProject({
      ".vise/index.ts": `export default (reg) => { this is not typescript`,
    });
    await expect(loadViseConfig(dir)).rejects.toThrow(ViseConfigError);
    cleanup();
  });

  test("a missing default export is fatal and says what is needed", async () => {
    const { dir, cleanup } = makeProject({
      ".vise/index.ts": `export const setup = () => {};`,
    });
    const err = await loadViseConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViseConfigError);
    expect((err as Error).message).toContain("no default export");
    cleanup();
  });

  test("a non-function default export is fatal", async () => {
    const { dir, cleanup } = makeProject({
      ".vise/index.ts": `export default { profiles: [] };`,
    });
    const err = await loadViseConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViseConfigError);
    expect((err as Error).message).toContain("must be a function");
    cleanup();
  });

  test("the config is composable across modules (AC 11)", async () => {
    const { dir, cleanup } = makeProject({
      ".vise/hooks/tests.ts": `
        export const setup = (reg) => {
          reg.hookId = reg.createHook({
            events: ["turn:end"],
            handler: () => "tests must pass",
          });
        };`,
      ".vise/index.ts": `
        import { setup as testHooks } from "./hooks/tests.js";
        export default (reg) => {
          testHooks(reg);
          const impl = reg.createProfile({ name: "implement", systemPrompt: "impl" });
          reg.createConnection(impl, reg.hookId);
        };`,
    });
    const graph = await loadViseConfig(dir);
    const resolved = resolveProfile(graph, "implement");
    expect(resolved.hooks).toHaveLength(1);
    expect(resolved.hooks[0].hook.handler({} as never)).toBe(
      "tests must pass",
    );
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// §3.5 — resolution
// ---------------------------------------------------------------------------

describe("profile resolution (profiles §3.5)", () => {
  test("an empty systemPrompt falls back to the built-in default", () => {
    const graph = graphFrom((reg) => {
      reg.createProfile({ name: "bare", systemPrompt: "" });
    });
    expect(createSession({ graph }).session.messages[0].content).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  test("a profile with no tool edges gets every built-in tool (AC 6)", () => {
    const graph = graphFrom((reg) => {
      reg.createProfile({ name: "wide", systemPrompt: "w" });
    });
    expect(toolsOf(graph, "wide")).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  test("a profile with tool edges gets only those tools (AC 7)", () => {
    const graph = graphFrom((reg) => {
      const p = reg.createProfile({ name: "narrow", systemPrompt: "n" });
      reg.createConnection(p, reg.builtins.tools.read_file);
      reg.createConnection(p, reg.builtins.tools.search);
      reg.createConnection(p, reg.builtins.tools.finish);
    });
    expect(toolsOf(graph, "narrow")).toEqual(["finish", "read_file", "search"]);
  });

  test("custom tools appear only when explicitly connected", () => {
    const graph = graphFrom((reg) => {
      const p = reg.createProfile({ name: "custom", systemPrompt: "c" });
      const used = reg.createTool(customTool("deploy"));
      reg.createTool(customTool("unused"));
      reg.createConnection(p, used);
      reg.createConnection(p, reg.builtins.tools.finish);
    });
    expect(toolsOf(graph, "custom")).toEqual(["deploy", "finish"]);
  });

  test("a profile with no hook edges has no hooks active", () => {
    const graph = graphFrom((reg) => {
      const quiet = reg.createProfile({ name: "quiet", systemPrompt: "q" });
      const loud = reg.createProfile({ name: "loud", systemPrompt: "l" });
      reg.createConnection(
        loud,
        reg.createHook({ events: ["turn:end"], handler: () => "no" }),
      );
      void quiet;
    });
    expect(resolveProfile(graph, "quiet").hooks).toEqual([]);
    expect(resolveProfile(graph, "loud").hooks).toHaveLength(1);
  });

  test("a model connection prop overrides the model's own params (AC 12)", () => {
    const graph = graphFrom((reg) => {
      const model = reg.createModel({
        name: "m",
        baseUrl: "http://localhost:9",
        apiKey: "k",
        temperature: 0.9,
        maxContext: 4096,
      });
      const hot = reg.createProfile({ name: "hot", systemPrompt: "h" });
      const cold = reg.createProfile({ name: "cold", systemPrompt: "c" });
      reg.createConnection(hot, model);
      reg.createConnection(cold, model, { temperature: 0.2 });
    });
    expect(resolveProfile(graph, "hot").config.temperature).toBe(0.9);
    expect(resolveProfile(graph, "cold").config.temperature).toBe(0.2);
    // The override is per-profile; the model itself is untouched.
    expect(resolveProfile(graph, "hot").config.maxContext).toBe(4096);
  });

  test("a profile with no model edge uses the global default model", () => {
    const graph = graphFrom((reg) => {
      reg.createProfile({ name: "plain", systemPrompt: "p" });
    });
    expect(resolveProfile(graph, "plain").config.baseUrl).toBe(
      "http://localhost:8080",
    );
  });

  test("setRuntime values reach the resolved config", () => {
    const graph = graphFrom((reg) => {
      reg.setRuntime({ commandTimeoutMs: 1234, dynamicTools: true });
      reg.createProfile({ name: "tuned", systemPrompt: "t" });
    });
    const cfg = resolveProfile(graph, "tuned").config;
    expect(cfg.commandTimeoutMs).toBe(1234);
    expect(cfg.dynamicTools).toBe(true);
    // Unset keys keep their defaults.
    expect(cfg.compactThreshold).toBe(0.8);
  });

  test("the default profile is `default`, else the first one defined", () => {
    const first = graphFrom((reg) => {
      reg.createProfile({ name: "alpha", systemPrompt: "a" });
      reg.createProfile({ name: "default", systemPrompt: "d" });
    });
    expect(defaultProfileName(first)).toBe("default");

    const noDefault = graphFrom((reg) => {
      reg.createProfile({ name: "alpha", systemPrompt: "a" });
      reg.createProfile({ name: "beta", systemPrompt: "b" });
    });
    expect(defaultProfileName(noDefault)).toBe("alpha");

    expect(defaultProfileName(graphFrom(() => {}))).toBe("");
  });

  test("resolving an unknown profile throws, listing the known ones", () => {
    const graph = graphFrom((reg) => {
      reg.createProfile({ name: "one", systemPrompt: "1" });
    });
    const err = (() => {
      try {
        resolveProfile(graph, "nope");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UnknownProfileError);
    expect((err as Error).message).toContain("one");
  });
});

// ---------------------------------------------------------------------------
// §3.11 — validation
// ---------------------------------------------------------------------------

describe("graph validation (profiles §3.11)", () => {
  const invalid = (setup: (reg: Registry) => void) => {
    try {
      graphFrom(setup);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected the config to be rejected");
  };

  test("duplicate profile names are fatal", () => {
    expect(
      invalid((reg) => {
        reg.createProfile({ name: "dup", systemPrompt: "" });
        reg.createProfile({ name: "dup", systemPrompt: "" });
      }),
    ).toContain('Duplicate profile name "dup"');
  });

  test("a custom tool shadowing a built-in is fatal", () => {
    expect(
      invalid((reg) => {
        reg.createTool(customTool("read_file"));
      }),
    ).toContain('Duplicate tool name "read_file"');
  });

  test("two custom tools with the same name are fatal", () => {
    expect(
      invalid((reg) => {
        reg.createTool(customTool("deploy"));
        reg.createTool(customTool("deploy"));
      }),
    ).toContain('Duplicate tool name "deploy"');
  });

  test("an invalid connection type is fatal, naming both ends", () => {
    const message = invalid((reg) => {
      const p = reg.createProfile({ name: "p", systemPrompt: "" });
      // Tool → Profile is not one of the four valid edges.
      reg.createConnection(reg.builtins.tools.read_file, p);
    });
    expect(message).toContain("Invalid connection");
    expect(message).toContain('Tool "read_file"');
    expect(message).toContain('Profile "p"');
  });

  test("a profile that enumerates tools but omits finish is fatal", () => {
    const message = invalid((reg) => {
      const p = reg.createProfile({ name: "stuck", systemPrompt: "" });
      reg.createConnection(p, reg.builtins.tools.read_file);
    });
    expect(message).toContain('Profile "stuck"');
    expect(message).toContain("finish");
  });

  test("subagent.profiles naming an unknown profile is fatal", () => {
    expect(
      invalid((reg) => {
        reg.createProfile({
          name: "boss",
          systemPrompt: "",
          subagent: { profiles: ["ghost"] },
        });
      }),
    ).toContain('unknown profile "ghost"');
  });

  test("an out-of-range setRuntime value is fatal", () => {
    expect(
      invalid((reg) => {
        reg.setRuntime({ compactThreshold: 2 });
      }),
    ).toContain("compactThreshold must be in (0, 1]");
  });

  test("an unknown setRuntime key is fatal, listing the valid ones", () => {
    const message = invalid((reg) => {
      reg.setRuntime({ nope: 1 } as never);
    });
    expect(message).toContain('unknown setting "nope"');
    expect(message).toContain("compactThreshold");
  });

  test("every problem is reported at once", () => {
    const message = invalid((reg) => {
      reg.createProfile({ name: "dup", systemPrompt: "" });
      reg.createProfile({ name: "dup", systemPrompt: "" });
      reg.createTool(customTool("search"));
    });
    expect(message).toContain("Duplicate profile name");
    expect(message).toContain("Duplicate tool name");
  });
});

// ---------------------------------------------------------------------------
// §3.6, §3.9 — profile switching and the /profile command
// ---------------------------------------------------------------------------

describe("/profile command and switching (profiles §3.6, §3.9)", () => {
  /** Two profiles differing in prompt, tool set, hooks, and model. */
  function twoProfiles(): ResourceGraph {
    return graphFrom((reg) => {
      const fast = reg.createModel({
        name: "fast-model",
        baseUrl: "http://localhost:1",
        apiKey: "",
      });
      const def = reg.createProfile({
        name: "default",
        systemPrompt: "you implement",
      });
      const refactor = reg.createProfile({
        name: "refactor",
        systemPrompt: "you refactor",
      });
      // default: all built-in tools, one turn:end hook, the default model.
      reg.createConnection(
        def,
        reg.createHook({ events: ["turn:end"], handler: () => "run tests" }),
      );
      // refactor: read-only tools, no hooks, an explicit model.
      for (const tool of ["read_file", "search", "finish"] as const) {
        reg.createConnection(refactor, reg.builtins.tools[tool]);
      }
      reg.createConnection(refactor, fast, { temperature: 0.1 });
    });
  }

  test("the session starts under the default profile (AC 1)", () => {
    const handle = createSession({ graph: twoProfiles() });
    expect(handle.profile).toBe("default");
    expect(handle.session.messages[0].content).toBe("you implement");
  });

  test("/profile lists both, marking the active one (AC 2)", () => {
    const handle = createSession({ graph: twoProfiles() });
    const listing = profileListing(handle);
    expect(listing).toContain("* default");
    expect(listing).toContain("  refactor");
  });

  test("/profile refactor re-resolves prompt, tools, and model (AC 3)", () => {
    const handle = createSession({ graph: twoProfiles() });
    expect(handle.registry.get("write_file")).toBeDefined();
    expect(handle.session.config.baseUrl).toBe("http://localhost:8080");

    expect(profileCommand(handle, ["refactor"])).toContain("refactor");

    expect(handle.profile).toBe("refactor");
    expect(handle.session.messages[0].content).toBe("you refactor");
    expect(handle.registry.get("write_file")).toBeUndefined();
    expect(handle.registry.get("read_file")).toBeDefined();
    expect(handle.session.config.model).toBe("fast-model");
    expect(handle.session.config.baseUrl).toBe("http://localhost:1");
    expect(handle.session.config.temperature).toBe(0.1);
  });

  test("a hook on one profile does not fire under another (AC 4)", () => {
    const handle = createSession({ graph: twoProfiles() });
    expect(handle.session.hooks.dispatch("turn:end").block).toBe("run tests");
    handle.switchProfile("refactor");
    expect(handle.session.hooks.size).toBe(0);
    expect(handle.session.hooks.dispatch("turn:end").block).toBeNull();
  });

  test("conversation history survives a switch; the prompt is replaced", () => {
    const handle = createSession({ graph: twoProfiles() });
    handle.session.messages.push({ role: "user", content: "earlier work" });
    handle.switchProfile("refactor");
    expect(handle.session.messages[0].content).toBe("you refactor");
    expect(handle.session.messages.map((m) => m.content)).toContain(
      "earlier work",
    );
    expect(
      handle.session.messages.filter((m) => m.role === "system"),
    ).toHaveLength(1);
  });

  test("append mode keeps the old system message and adds the new one", () => {
    const graph = profileGraph((reg, profile) => {
      reg.setProfileSwitchMode("append");
      profile("default", { systemPrompt: "first" });
      profile("second", { systemPrompt: "second" });
    });
    const handle = createSession({ graph });
    handle.switchProfile("second");
    const systems = handle.session.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    expect(systems).toEqual(["first", "second"]);
  });

  test("/profile nonexistent reports the error and does not switch (AC 10)", () => {
    const handle = createSession({ graph: twoProfiles() });
    const out = profileCommand(handle, ["nonexistent"]);
    expect(out).toContain("Unknown profile");
    expect(out).toContain("refactor");
    expect(handle.profile).toBe("default");
    expect(handle.session.messages[0].content).toBe("you implement");
  });

  test("/profile with no profiles defined says so", () => {
    const handle = createSession({ graph: modelGraph() });
    expect(profileListing(handle)).toContain("none defined");
  });

  test("switching to a profile with no usable model is refused (§3.11)", () => {
    const graph = graphFrom((reg) => {
      const model = reg.createModel({
        name: "m",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      });
      const ok = reg.createProfile({ name: "default", systemPrompt: "ok" });
      reg.createConnection(ok, model);
      // "modelless" has no model edge, and the default model has no name
      // until auto-discovery fills one in.
      reg.createProfile({ name: "modelless", systemPrompt: "nope" });
    });
    const handle = createSession({ graph });

    const out = profileCommand(handle, ["modelless"]);

    expect(out).toContain('Profile "modelless" has no model');
    expect(handle.profile).toBe("default");
    expect(handle.session.config.model).toBe("m");
  });
});

// ---------------------------------------------------------------------------
// §3.7 — hook/tool filtering
// ---------------------------------------------------------------------------

describe("hook-tool filtering (profiles §3.7)", () => {
  /** A profile whose only hook is edged to write_file. */
  function filteredGraph(fired: string[]): ResourceGraph {
    return graphFrom((reg) => {
      const p = reg.createProfile({ name: "guarded", systemPrompt: "g" });
      const hook = reg.createHook({
        events: ["tool:before", "tool:after", "turn:end"],
        handler: (ctx) => {
          fired.push(ctx.tool?.name ?? ctx.event);
        },
      });
      reg.createConnection(p, hook);
      reg.createConnection(hook, reg.builtins.tools.write_file);
    });
  }

  test("the hook fires for the connected tool but not others (AC 5)", () => {
    const fired: string[] = [];
    const { session } = createSession({ graph: filteredGraph(fired) });
    session.hooks.dispatch("tool:before", {
      tool: { name: "write_file", args: {} },
    });
    session.hooks.dispatch("tool:before", {
      tool: { name: "read_file", args: {} },
    });
    expect(fired).toEqual(["write_file"]);
  });

  test("non-tool events ignore the filter and fire normally", () => {
    const fired: string[] = [];
    const { session } = createSession({ graph: filteredGraph(fired) });
    session.hooks.dispatch("turn:end");
    expect(fired).toEqual(["turn:end"]);
  });

  test("a hook with no tool edges fires for every tool", () => {
    const fired: string[] = [];
    const graph = graphFrom((reg) => {
      const p = reg.createProfile({ name: "open", systemPrompt: "o" });
      reg.createConnection(
        p,
        reg.createHook({
          events: ["tool:before"],
          handler: (ctx) => {
            fired.push(ctx.tool?.name ?? "?");
          },
        }),
      );
    });
    const { session } = createSession({ graph });
    for (const name of ["write_file", "read_file"]) {
      session.hooks.dispatch("tool:before", { tool: { name, args: {} } });
    }
    expect(fired).toEqual(["write_file", "read_file"]);
  });
});

// ---------------------------------------------------------------------------
// §3.12 — subagent policy
// ---------------------------------------------------------------------------

describe("subagent policy (profiles §3.12)", () => {
  /** The §3.12 worked example: implement → worker / researcher. */
  function policyGraph(): ResourceGraph {
    return graphFrom((reg) => {
      reg.createProfile({
        name: "worker",
        systemPrompt: "You are a focused worker",
        subagent: { maxDepth: 1 },
      });
      reg.createProfile({
        name: "researcher",
        systemPrompt: "You are a research agent",
        subagent: { maxDepth: 0 },
      });
      reg.createProfile({
        name: "default",
        systemPrompt: "You are an implementation agent",
        subagent: { profiles: ["worker", "researcher"], maxDepth: 2 },
      });
    });
  }

  /** Run one spawn_subagent call against a session's registry. */
  async function spawn(
    handle: ReturnType<typeof createSession>,
    args: Record<string, unknown>,
  ): Promise<string> {
    const tool = handle.registry.get("spawn_subagent");
    expect(tool).toBeDefined();
    return tool!.handler({ maxIterations: 3, ...args });
  }

  /**
   * A client that records the system prompt of every agent that calls it, so a
   * test can see which profile a subagent actually ran under.
   */
  function promptRecorder(): { prompts: string[]; client: LLMClient } {
    const prompts: string[] = [];
    return {
      prompts,
      client: {
        async chat(opts) {
          prompts.push(opts.messages[0].content ?? "");
          return finish("sub done");
        },
      },
    };
  }

  test("an allowed profile spawns a subagent under it (AC 13)", async () => {
    const { prompts, client } = promptRecorder();
    const handle = createSession({ graph: policyGraph(), client });

    const out = await spawn(handle, { task: "research it", profile: "researcher" });

    expect(out).toBe("sub done");
    // The subagent ran under the researcher profile's own prompt, tools, and
    // model — not the parent's.
    expect(prompts).toEqual(["You are a research agent"]);
  });

  test("a forbidden profile returns an error listing the allowed ones (AC 14)", async () => {
    const handle = createSession({ graph: policyGraph() });
    const out = await spawn(handle, { task: "t", profile: "default" });
    expect(out).toContain("is not allowed for subagents");
    expect(out).toContain("Allowed: [worker, researcher]");
  });

  test("an unknown profile name is rejected as data, not a throw", async () => {
    const graph = graphFrom((reg) => {
      reg.createProfile({ name: "open", systemPrompt: "o" });
    });
    const handle = createSession({ graph });
    const out = await spawn(handle, { task: "t", profile: "ghost" });
    expect(out).toContain("Unknown profile 'ghost'");
    expect(out).toContain("open");
  });

  test("depth is bounded by the spawning profile's maxDepth (AC 15)", async () => {
    const graph = policyGraph();
    // maxDepth: 1 on "worker". A spawn producing depth 1 succeeds…
    const atZero = createSession({
      graph,
      profile: "worker",
      client: stubClient([finish("ok")]),
    });
    expect(await spawn(atZero, { task: "t" })).toBe("ok");

    // …and one producing depth 2 is refused. The tool a depth-1 worker holds
    // is the one its own runner builds, so drive that path end to end.
    const runner = makeSubagentRunner({
      graph,
      client: stubClient([
        {
          content: "",
          toolCalls: [
            {
              id: "s1",
              name: "spawn_subagent",
              arguments: { task: "deeper", maxIterations: 2 },
            },
          ],
          usage: null,
        },
        finish("gave up"),
      ]),
    });
    const out = await runner({
      task: "t",
      maxIterations: 4,
      depth: 1,
      profile: "worker",
    });
    expect(out).toBe("gave up");
  });

  test("maxDepth: 0 forbids subagents outright (AC 17)", async () => {
    const handle = createSession({ graph: policyGraph(), profile: "researcher" });
    const out = await spawn(handle, { task: "t" });
    expect(out).toBe("Error: Subagent depth limit reached (max: 0)");
  });

  test("no profile param means the subagent inherits the parent's (AC 16)", async () => {
    const { prompts, client } = promptRecorder();
    const handle = createSession({
      graph: policyGraph(),
      profile: "worker",
      client,
    });

    expect(await spawn(handle, { task: "t" })).toBe("sub done");

    expect(prompts).toEqual(["You are a focused worker"]);
  });

  test("without a policy the global maxSubagentDepth backstop applies", async () => {
    const graph = graphFrom((reg) => {
      reg.setRuntime({ maxSubagentDepth: 0 });
      reg.createProfile({ name: "loose", systemPrompt: "l" });
    });
    const handle = createSession({ graph });
    expect(await spawn(handle, { task: "t" })).toContain(
      "Subagent depth limit reached (max: 0)",
    );
  });

  test("a profile without spawn_subagent in its tool set cannot spawn", () => {
    const graph = graphFrom((reg) => {
      const p = reg.createProfile({ name: "sealed", systemPrompt: "s" });
      reg.createConnection(p, reg.builtins.tools.read_file);
      reg.createConnection(p, reg.builtins.tools.finish);
    });
    expect(createSession({ graph }).registry.get("spawn_subagent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a profile's resolved tool set is what the model actually sees
// ---------------------------------------------------------------------------

describe("resolved profiles drive the agent loop", () => {
  test("the model is only offered the active profile's tools", async () => {
    const advertised: string[][] = [];
    const graph = graphFrom((reg) => {
      const p = reg.createProfile({ name: "reader", systemPrompt: "r" });
      reg.createConnection(p, reg.builtins.tools.read_file);
      reg.createConnection(p, reg.builtins.tools.finish);
    });
    const handle = createSession({ graph });
    const client: LLMClient = {
      async chat(opts) {
        advertised.push(opts.tools.map((t) => t.name).sort());
        return finish("done");
      },
    };
    const result = await runTurn(
      handle.session,
      "read something",
      handle.registry,
      {},
      undefined,
      client,
    );
    expect(result.answer).toBe("done");
    expect(advertised[0]).toEqual(["finish", "read_file"]);
  });
});
