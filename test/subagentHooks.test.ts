import { describe, expect, test } from "bun:test";
import { makeSubagentRunner } from "../src/agent/subagent.js";
import { HookManager } from "../src/hooks/index.js";
import { IMPLICIT_PROFILE_NAME } from "../src/profiles/index.js";
import type { LLMResponse, Message } from "../src/types.js";
import type { LLMClient } from "../src/llm/client.js";
import { ServerUnreachableError } from "../src/llm/errors.js";
import { modelGraph } from "./helpers.js";

/** A placeholder parent model, for subagent runs that don't care which model. */
const stubParentModel = {
  baseUrl: "http://localhost:8080",
  model: "test-model",
  apiKey: "",
  temperature: 0.2,
  maxContext: 8192,
};

/** A scripted LLM client that records the messages it is asked to chat with. */
function capturingClient(
  responses: LLMResponse[],
  onMessages?: (messages: Message[]) => void,
): LLMClient {
  let i = 0;
  return {
    async chat(opts) {
      onMessages?.(opts.messages);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

const finish = (answer: string, id = "f1"): LLMResponse => ({
  content: "",
  toolCalls: [{ id, name: "finish", arguments: { answer } }],
  usage: null,
});

const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  content: string = "",
): LLMResponse => ({
  content,
  toolCalls: [{ id, name, arguments: args }],
  usage: null,
});

/** The options a bare subagent run needs, under the default profile. */
function runOpts(maxIterations: number) {
  return {
    task: "t",
    maxIterations,
    depth: 1,
    profile: IMPLICIT_PROFILE_NAME,
    parentModel: stubParentModel,
  };
}

/**
 * A graph whose default profile carries the given subagent-side hooks, so a
 * runner built over it fires them on the subagent's own hook manager.
 */
function graphWithSubagentHooks(
  hooks: {
    events: ("subagent:turn:start" | "subagent:turn:end")[];
    handler: (ctx: { depth: number; outcome?: string }) => unknown;
  }[],
) {
  return modelGraph("http://localhost:8080", {}, (reg) => {
    for (const h of hooks) {
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: h.events,
          handler: h.handler,
          includeSubagents: true,
        }),
      );
    }
  });
}

describe("subagent:turn:start injection (v0.6.0 spec §3.3, A6)", () => {
  test("an advisory is injected as a system message after the system prompt", async () => {
    const seen: Message[][] = [];
    const graph = graphWithSubagentHooks([
      {
        events: ["subagent:turn:start"],
        handler: () => "lint output: 3 warnings",
      },
    ]);
    const runner = makeSubagentRunner({
      graph,
      client: capturingClient([finish("done")], (m) => seen.push(m)),
    });
    const out = await runner(runOpts(5));
    expect(out).toBe("done");
    // The first chat call carries the injected advisory at index 1.
    const first = seen[0];
    expect(first[0].role).toBe("system");
    expect(first[1].role).toBe("system");
    expect(first[1].content).toBe("lint output: 3 warnings");
  });

  test("A15: multiple advisories are joined with a newline into one message", async () => {
    const seen: Message[][] = [];
    const graph = graphWithSubagentHooks([
      { events: ["subagent:turn:start"], handler: () => "adv one" },
      { events: ["subagent:turn:start"], handler: () => "adv two" },
    ]);
    const runner = makeSubagentRunner({
      graph,
      client: capturingClient([finish("done")], (m) => seen.push(m)),
    });
    await runner(runOpts(5));
    const first = seen[0];
    // Exactly one injected system message, holding both advisories joined.
    const injected = first.filter((m) => m.content === "adv one\nadv two");
    expect(injected).toHaveLength(1);
    expect(injected[0].role).toBe("system");
    // No separate single-advisory messages.
    expect(first.some((m) => m.content === "adv one")).toBe(false);
    expect(first.some((m) => m.content === "adv two")).toBe(false);
  });

  test("A14: a throwing turn:start hook does not block the run", async () => {
    const endFired: string[] = [];
    const graph = modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: ["subagent:turn:start"],
          handler: () => {
            throw new Error("boom");
          },
          includeSubagents: true,
        }),
      );
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: ["subagent:turn:end"],
          handler: (c) => {
            endFired.push(c.outcome ?? "none");
          },
          includeSubagents: true,
        }),
      );
    });
    const runner = makeSubagentRunner({
      graph,
      client: capturingClient([finish("still done")]),
    });
    const out = await runner(runOpts(5));
    // The run completes normally despite the throwing start hook.
    expect(out).toBe("still done");
    // And turn:end still fired with the terminal outcome.
    expect(endFired).toEqual(["done"]);
  });
});

describe("subagent:turn:end outcome (v0.6.0 spec §3.4, A8)", () => {
  test("done: a finished run reports outcome 'done'", async () => {
    const outcomes: string[] = [];
    const graph = graphWithSubagentHooks([
      {
        events: ["subagent:turn:end"],
        handler: (c) => {
          outcomes.push(c.outcome ?? "none");
        },
      },
    ]);
    const runner = makeSubagentRunner({
      graph,
      client: capturingClient([finish("done")]),
    });
    await runner(runOpts(5));
    expect(outcomes).toEqual(["done"]);
  });

  test("cap: a run that hits the iteration cap reports outcome 'cap'", async () => {
    const outcomes: string[] = [];
    const graph = graphWithSubagentHooks([
      {
        events: ["subagent:turn:end"],
        handler: (c) => {
          outcomes.push(c.outcome ?? "none");
        },
      },
    ]);
    const runner = makeSubagentRunner({
      graph,
      client: capturingClient([
        toolCall("1", "read_file", { path: "a" }, "thinking..."),
        toolCall("2", "read_file", { path: "b" }, "still thinking..."),
      ]),
    });
    await runner(runOpts(2));
    expect(outcomes).toEqual(["cap"]);
  });

  test("failed: an LLM error reports outcome 'failed'", async () => {
    const outcomes: string[] = [];
    const graph = graphWithSubagentHooks([
      {
        events: ["subagent:turn:end"],
        handler: (c) => {
          outcomes.push(c.outcome ?? "none");
        },
      },
    ]);
    const client: LLMClient = {
      async chat() {
        throw new ServerUnreachableError("http://localhost:1");
      },
    };
    const runner = makeSubagentRunner({ graph, client });
    const out = await runner(runOpts(5));
    expect(out).toContain("subagent failed:");
    expect(outcomes).toEqual(["failed"]);
  });
});

describe("event ordering (v0.6.0 spec §3.5, A9)", () => {
  test("before -> turn:start -> turn:end -> after, in that order", async () => {
    const order: string[] = [];
    const graph = graphWithSubagentHooks([
      {
        events: ["subagent:turn:start"],
        handler: () => {
          order.push("turn:start");
        },
      },
      {
        events: ["subagent:turn:end"],
        handler: () => {
          order.push("turn:end");
        },
      },
    ]);
    // The spawner's own hook manager fires subagent:before / subagent:after.
    const spawnerHooks = new HookManager(
      [
        {
          hook: {
            events: ["subagent:before"],
            handler: () => order.push("before"),
          },
          source: "inline.ts",
        },
        {
          hook: {
            events: ["subagent:after"],
            handler: () => order.push("after"),
          },
          source: "inline.ts",
        },
      ],
      { log: () => {} },
    );
    const runner = makeSubagentRunner(
      { graph, client: capturingClient([finish("done")]) },
      { hooks: spawnerHooks, depth: 0, model: "parent-model" },
    );
    await runner(runOpts(5));
    expect(order).toEqual(["before", "turn:start", "turn:end", "after"]);
  });
});

describe("turn:end fires in finally (v0.6.0 spec §3.5, A10)", () => {
  test("turn:end fires even when runTurn throws", async () => {
    const outcomes: string[] = [];
    const graph = graphWithSubagentHooks([
      {
        events: ["subagent:turn:end"],
        handler: (c) => {
          outcomes.push(c.outcome ?? "none");
        },
      },
    ]);
    const client: LLMClient = {
      async chat() {
        throw new ServerUnreachableError("http://localhost:1");
      },
    };
    const runner = makeSubagentRunner({ graph, client });
    await runner(runOpts(5));
    // The finally path fired turn:end with the failed outcome.
    expect(outcomes).toEqual(["failed"]);
  });
});

describe("nested subagents (v0.6.0 spec §3.3, A11)", () => {
  test("turn:start and turn:end fire at both depths", async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const graph = modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: ["subagent:turn:start"],
          handler: (c) => {
            starts.push(c.depth);
          },
          includeSubagents: true,
        }),
      );
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: ["subagent:turn:end"],
          handler: (c) => {
            ends.push(c.depth);
          },
          includeSubagents: true,
        }),
      );
    });
    // Outer subagent spawns an inner subagent; both finish.
    const client = capturingClient([
      toolCall("s1", "spawn_subagent", { task: "inner", maxIterations: 5 }),
      finish("inner done"),
      finish("outer done"),
    ]);
    const runner = makeSubagentRunner({ graph, client });
    const out = await runner(runOpts(10));
    expect(out).toBe("outer done");
    // Both the outer (depth 1) and inner (depth 2) subagents fired both events.
    expect(starts.sort((a, b) => a - b)).toEqual([1, 2]);
    expect(ends.sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
