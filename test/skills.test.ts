import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LLMResponse, Message, Skill, Tool } from "../src/types.js";
import type { LLMClient } from "../src/llm/client.js";
import {
  loadViseConfig,
  ViseConfigError,
  type ResourceGraph,
} from "../src/profiles/index.js";
import {
  appendSkillIndex,
  buildToolRegistry,
  dispatch,
  skillIndexSection,
  SKILL_INDEX_HEADER,
} from "../src/tools/index.js";
import { CORE_TOOL_NAMES } from "../src/tools/metaTools.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
} from "../src/config/defaults.js";
import { createSession } from "../src/agent/session.js";
import { identitySection, makeSubagentRunner } from "../src/agent/subagent.js";
import {
  findCommand,
  REPL_COMMANDS,
  skillsListing,
} from "../src/cli/commands.js";
import { graphFrom, modelGraph } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MADGE_DESC = "How to use the madge npm package for dependency analysis";
const MADGE_TEXT = "Run `npx madge --circular src/` to find import cycles.";

/** A graph whose default profile has a working model plus two skills. */
function skillGraph(): ResourceGraph {
  return modelGraph("http://localhost:8080", {}, (reg) => {
    reg.createSkill("madge", MADGE_DESC, MADGE_TEXT);
    reg.createSkill("npm-deps", "Managing npm dependencies in this project", "…");
  });
}

/** The skill store of a graph, as the tool layer consumes it. */
function storeOf(graph: ResourceGraph): ReadonlyMap<string, Skill> {
  return graph.skills;
}

/** Two isolated temp directories standing in for `~/.vise` and `./.vise`. */
function twoTierProject(files: {
  global?: Record<string, string>;
  project?: Record<string, string>;
}): { globalRoot: string; root: string; cleanup: () => void } {
  const globalRoot = mkdtempSync(path.join(tmpdir(), "vise-skills-global-"));
  const root = mkdtempSync(path.join(tmpdir(), "vise-skills-project-"));
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

/** The tool named `name` from a registry built over `graph`'s skills. */
function toolFrom(graph: ResourceGraph, name: string): Tool {
  const { registry } = buildToolRegistry(
    { ...DEFAULT_CONFIG },
    { skills: storeOf(graph) },
  );
  const tool = registry.get(name);
  if (!tool) throw new Error(`no tool "${name}"`);
  return tool;
}

const finish = (answer: string): LLMResponse => ({
  content: "",
  toolCalls: [{ id: "f1", name: "finish", arguments: { answer } }],
  usage: null,
});

// ---------------------------------------------------------------------------
// §3.1, §3.2 — the registry API and the skill store
// ---------------------------------------------------------------------------

describe("reg.createSkill (skills spec §3.1, §3.2)", () => {
  test("adds a skill to the store, keyed by name (AC-1)", () => {
    const graph = graphFrom((reg) => {
      reg.createSkill("madge", MADGE_DESC, MADGE_TEXT);
    });
    expect(graph.skills.get("madge")).toEqual({
      name: "madge",
      description: MADGE_DESC,
      text: MADGE_TEXT,
      origin: "project",
    });
  });

  test("skills are not resource-graph nodes (§2.2, §3.8)", () => {
    const graph = graphFrom((reg) => {
      reg.createSkill("madge", MADGE_DESC, MADGE_TEXT);
    });
    for (const resource of graph.resources.values()) {
      expect(resource.kind).not.toBe("skill" as never);
    }
    expect(graph.connections).toEqual([]);
  });

  test("an empty name is a fatal config error (AC-2)", () => {
    expect(() =>
      graphFrom((reg) => {
        reg.createSkill("", "desc", "text");
      }),
    ).toThrow(ViseConfigError);
    try {
      graphFrom((reg) => {
        reg.createSkill("", "desc", "text");
      });
    } catch (err) {
      expect((err as Error).message).toContain("Skill name must be non-empty.");
    }
  });

  test("a duplicate name in one file is fatal (AC-3)", () => {
    try {
      graphFrom((reg) => {
        reg.createSkill("madge", "a", "1");
        reg.createSkill("madge", "b", "2");
      });
      throw new Error("expected a config error");
    } catch (err) {
      expect(err).toBeInstanceOf(ViseConfigError);
      expect((err as Error).message).toContain(
        'Duplicate skill name "madge". Each skill must have a unique name.',
      );
    }
  });

  test("the same name in both config files is fatal (AC-4)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createSkill("madge", "global", "g");
          };`,
      },
      project: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createSkill("madge", "project", "p");
          };`,
      },
    });
    const err = await loadViseConfig(root, globalRoot).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ViseConfigError);
    expect(err.message).toContain(
      'Config conflict: a skill named "madge" is defined in both the global ' +
        "config (~/.vise/index.ts) and the project config (./.vise/index.ts). " +
        "Remove one or rename it.",
    );
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// §3.3 — the skill index in the system prompt
// ---------------------------------------------------------------------------

describe("skill index (skills spec §3.3)", () => {
  test("the system prompt carries one line per skill (AC-5)", () => {
    const prompt = createSession({ graph: skillGraph() }).session.messages[0]
      .content;
    expect(prompt).toContain(`${SKILL_INDEX_HEADER}\n- madge: ${MADGE_DESC}`);
    expect(prompt).toContain(
      "- npm-deps: Managing npm dependencies in this project",
    );
  });

  test("the skill bodies stay out of the system prompt (§1.1)", () => {
    const prompt = createSession({ graph: skillGraph() }).session.messages[0]
      .content;
    expect(prompt).not.toContain(MADGE_TEXT);
  });

  test("the section is omitted entirely when no skills exist (AC-6)", () => {
    const prompt = createSession({ graph: modelGraph() }).session.messages[0]
      .content;
    expect(prompt).not.toContain(SKILL_INDEX_HEADER);
    expect(skillIndexSection(new Map())).toBe("");
    expect(appendSkillIndex("prompt", new Map())).toBe("prompt");
  });

  test("the index follows the profile's own prompt (§3.3)", () => {
    const graph = modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createSkill("madge", MADGE_DESC, MADGE_TEXT);
    });
    const identity = identitySection(
      {
        ...DEFAULT_CONFIG,
        model: "test-model",
        baseUrl: "http://localhost:8080",
      },
      undefined,
    );
    expect(createSession({ graph }).session.messages[0].content).toBe(
      `${DEFAULT_SYSTEM_PROMPT}\n\n${identity}\n\n${SKILL_INDEX_HEADER}\n- madge: ${MADGE_DESC}`,
    );
  });

  test("skills are listed global-first, then project (AC-7)", async () => {
    const { globalRoot, root, cleanup } = twoTierProject({
      global: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createSkill("g-one", "from global", "g1");
          };`,
      },
      project: {
        ".vise/index.ts": `
          export default (reg) => {
            reg.createSkill("p-one", "from project", "p1");
          };`,
      },
    });
    const graph = await loadViseConfig(root, globalRoot);
    expect([...graph.skills.values()].map((s) => [s.name, s.origin])).toEqual([
      ["g-one", "global"],
      ["p-one", "project"],
    ]);
    expect(skillIndexSection(graph.skills)).toBe(
      `${SKILL_INDEX_HEADER}\n- g-one: from global\n- p-one: from project`,
    );
    cleanup();
  });

  test("an empty description still yields a line (§4)", () => {
    const graph = graphFrom((reg) => {
      reg.createSkill("bare", "", "body");
    });
    expect(skillIndexSection(graph.skills)).toBe(
      `${SKILL_INDEX_HEADER}\n- bare: `,
    );
  });

  test("a profile switch re-appends the same index (§3.3)", () => {
    const graph = graphFrom((reg) => {
      const model = reg.createModel({
        name: "test-model",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      });
      const other = reg.createProfile({ name: "other", systemPrompt: "other" });
      reg.createConnection(other, model);
      reg.createConnection(reg.builtins.defaultProfile, model);
      reg.createSkill("madge", MADGE_DESC, MADGE_TEXT);
    });
    const handle = createSession({ graph });
    handle.switchProfile("other");
    const identity = identitySection(
      {
        ...DEFAULT_CONFIG,
        model: "test-model",
        baseUrl: "http://localhost:8080",
      },
      undefined,
    );
    expect(handle.session.messages[0].content).toBe(
      `other\n\n${identity}\n\n${SKILL_INDEX_HEADER}\n- madge: ${MADGE_DESC}`,
    );
  });
});

// ---------------------------------------------------------------------------
// §3.4 — list_skills
// ---------------------------------------------------------------------------

describe("list_skills (skills spec §3.4)", () => {
  test("is present in every profile's registry (AC-8)", () => {
    const graph = graphFrom((reg) => {
      const model = reg.createModel({
        name: "test-model",
        baseUrl: "http://localhost:8080",
        apiKey: "",
      });
      // A profile that enumerates its tools still gets the skill tools.
      const narrow = reg.createProfile({ name: "narrow", systemPrompt: "n" });
      reg.createConnection(narrow, model);
      reg.createConnection(narrow, reg.builtins.tools.finish);
      reg.createConnection(reg.builtins.defaultProfile, model);
      reg.createSkill("madge", MADGE_DESC, MADGE_TEXT);
    });
    for (const profile of ["Agent", "narrow"]) {
      const names = createSession({ graph, profile })
        .registry.all()
        .map((t) => t.name);
      expect(names).toContain("list_skills");
      expect(names).toContain("read_skill");
    }
  });

  test("returns every name and description, one per line (AC-9)", async () => {
    const tool = toolFrom(skillGraph(), "list_skills");
    expect(await tool.handler({})).toBe(
      `madge: ${MADGE_DESC}\n` +
        "npm-deps: Managing npm dependencies in this project",
    );
  });

  test("reports an empty store (AC-10)", async () => {
    const tool = toolFrom(modelGraph(), "list_skills");
    expect(await tool.handler({})).toBe("No skills available.");
  });

  test("is read-only (AC-11)", () => {
    expect(toolFrom(skillGraph(), "list_skills").mutating).toBe(false);
  });

  test("is on the constant advertised surface in dynamic mode (AC-12)", () => {
    const { registry } = buildToolRegistry(
      { ...DEFAULT_CONFIG, dynamicTools: true },
      { skills: storeOf(skillGraph()) },
    );
    const advertised = registry.advertised().map((t) => t.name);
    expect(advertised).toContain("list_skills");
    expect(CORE_TOOL_NAMES).toContain("list_skills");
  });
});

// ---------------------------------------------------------------------------
// §3.5 — read_skill
// ---------------------------------------------------------------------------

describe("read_skill (skills spec §3.5)", () => {
  test("is present in every profile's registry (AC-13)", () => {
    // Covered together with AC-8 above; asserted here on the bare registry.
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
    });
    expect(registry.get("read_skill")).toBeDefined();
  });

  test("returns the full body of a known skill (AC-14)", async () => {
    const tool = toolFrom(skillGraph(), "read_skill");
    expect(await tool.handler({ name: "madge" })).toBe(MADGE_TEXT);
  });

  test("the body is never truncated (AC-15)", async () => {
    const body = "x".repeat(5000);
    const graph = graphFrom((reg) => {
      reg.createSkill("big", "a large skill", body);
    });
    const { registry } = buildToolRegistry(
      { ...DEFAULT_CONFIG, maxToolOutputChars: 100 },
      { skills: storeOf(graph) },
    );
    const result = await dispatch(
      registry,
      { id: "c1", name: "read_skill", arguments: { name: "big" } },
      100,
    );
    expect(result.content).toBe(body);
    expect(result.content).not.toContain("output truncated");
    expect(registry.get("read_skill")?.noTruncate).toBe(true);
  });

  test("an ordinary tool is still truncated (§8.2)", async () => {
    const { registry } = buildToolRegistry({
      ...DEFAULT_CONFIG,
    });
    registry.register({
      name: "loud",
      mutating: false,
      description: "d",
      parameters: { type: "object", properties: {} },
      handler: async () => "y".repeat(500),
    });
    const result = await dispatch(
      registry,
      { id: "c2", name: "loud", arguments: {} },
      100,
    );
    expect(result.content).toContain("output truncated");
  });

  test("an unknown name lists what is available (AC-16)", async () => {
    const tool = toolFrom(skillGraph(), "read_skill");
    expect(await tool.handler({ name: "nope" })).toBe(
      'Unknown skill "nope". Available skills: madge, npm-deps.',
    );
  });

  test("an unknown name with an empty store says so (§4)", async () => {
    const tool = toolFrom(modelGraph(), "read_skill");
    expect(await tool.handler({ name: "nope" })).toBe(
      'Unknown skill "nope". No skills available.',
    );
  });

  test("an empty name is reported, not thrown (AC-17)", async () => {
    const tool = toolFrom(skillGraph(), "read_skill");
    expect(await tool.handler({ name: "" })).toBe(
      "Skill name must be non-empty.",
    );
  });

  test("a skill with an empty body reads back as empty (§4)", async () => {
    const graph = graphFrom((reg) => {
      reg.createSkill("hollow", "nothing to say", "");
    });
    expect(await toolFrom(graph, "read_skill").handler({ name: "hollow" })).toBe(
      "",
    );
  });

  test("is read-only (AC-18)", () => {
    expect(toolFrom(skillGraph(), "read_skill").mutating).toBe(false);
  });

  test("is on the constant advertised surface in dynamic mode (AC-19)", () => {
    const { registry } = buildToolRegistry(
      { ...DEFAULT_CONFIG, dynamicTools: true },
      { skills: storeOf(skillGraph()) },
    );
    expect(registry.advertised().map((t) => t.name)).toContain("read_skill");
    expect(CORE_TOOL_NAMES).toContain("read_skill");
  });
});

// ---------------------------------------------------------------------------
// §3.7 — subagent visibility
// ---------------------------------------------------------------------------

describe("subagent visibility (skills spec §3.7)", () => {
  /** Run one subagent against a scripted client, capturing what it was sent. */
  async function runSubagent(
    graph: ResourceGraph,
    responses: LLMResponse[],
  ): Promise<{ answer: string; seen: { messages: Message[]; tools: Tool[] }[] }> {
    const seen: { messages: Message[]; tools: Tool[] }[] = [];
    let i = 0;
    const client: LLMClient = {
      async chat(opts) {
        seen.push({
          messages: opts.messages.map((m) => ({ ...m })),
          tools: opts.tools,
        });
        return responses[Math.min(i++, responses.length - 1)];
      },
    };
    const runner = makeSubagentRunner({ graph, client });
    const answer = await runner({
      task: "t",
      maxIterations: 5,
      depth: 1,
      profile: "Agent",
      parentModel: {
        baseUrl: "http://localhost:8080",
        model: "test-model",
        apiKey: "",
        temperature: 0.2,
      },
    });
    return { answer, seen };
  }

  test("a subagent's system prompt carries the same index (AC-20)", async () => {
    const graph = skillGraph();
    const { seen } = await runSubagent(graph, [finish("ok")]);
    const prompt = seen[0].messages[0].content ?? "";
    expect(seen[0].messages[0].role).toBe("system");
    expect(prompt).toContain(skillIndexSection(graph.skills));
    // The main agent's index is identical — skills are global.
    expect(createSession({ graph }).session.messages[0].content).toContain(
      skillIndexSection(graph.skills),
    );
  });

  test("a subagent's tool registry has both skill tools (AC-21)", async () => {
    const { seen } = await runSubagent(skillGraph(), [finish("ok")]);
    const names = seen[0].tools.map((t) => t.name);
    expect(names).toContain("list_skills");
    expect(names).toContain("read_skill");
  });

  test("a subagent can load a skill body (AC-22)", async () => {
    const { answer, seen } = await runSubagent(skillGraph(), [
      {
        content: "",
        toolCalls: [
          { id: "r1", name: "read_skill", arguments: { name: "madge" } },
        ],
        usage: null,
      },
      finish("read it"),
    ]);
    expect(answer).toBe("read it");
    const toolMessage = seen[1].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe(MADGE_TEXT);
  });
});

// ---------------------------------------------------------------------------
// §3.6 — the /skills REPL command
// ---------------------------------------------------------------------------

describe("/skills (skills spec §3.6)", () => {
  test("lists every skill, name and description (AC-23)", () => {
    const handle = createSession({ graph: skillGraph() });
    expect(skillsListing(handle.skills())).toBe(
      "Skills:\n" +
        `  madge       ${MADGE_DESC}\n` +
        "  npm-deps    Managing npm dependencies in this project",
    );
  });

  test("reports an empty store (AC-24)", () => {
    const handle = createSession({ graph: modelGraph() });
    expect(skillsListing(handle.skills())).toBe("No skills defined.");
  });

  test("is dispatched by the REPL and listed in /help", () => {
    const command = findCommand("/skills");
    expect(command).toBeDefined();
    expect(REPL_COMMANDS.map((c) => c.name)).toContain("/skills");
    const handle = createSession({ graph: skillGraph() });
    expect(command?.run({ handle }, [])).toContain("madge");
    // Read-only: the conversation is untouched.
    expect(handle.session.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §5 — backward compatibility
// ---------------------------------------------------------------------------

describe("backward compatibility (skills spec §5, AC-25)", () => {
  test("a config with no skills behaves exactly as before", async () => {
    const graph = modelGraph();
    expect(graph.skills.size).toBe(0);

    const handle = createSession({ graph });
    expect(handle.session.messages[0].content).not.toContain(
      SKILL_INDEX_HEADER,
    );

    const listSkills = handle.registry.get("list_skills");
    const readSkill = handle.registry.get("read_skill");
    expect(listSkills).toBeDefined();
    expect(readSkill).toBeDefined();
    expect(await listSkills!.handler({})).toBe("No skills available.");
    expect(await readSkill!.handler({ name: "x" })).toBe(
      'Unknown skill "x". No skills available.',
    );
  });
});
