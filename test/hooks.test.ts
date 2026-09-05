import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HookManager,
  type Hook,
  type HookContext,
} from "../src/hooks/index.js";
import { runTurn } from "../src/agent/loop.js";
import { createSession } from "../src/agent/session.js";
import { makeSubagentRunner } from "../src/agent/subagent.js";
import {
  commandArgs,
  findCommand,
  helpText,
  hooksCommand,
  hooksListing,
  REPL_COMMANDS,
} from "../src/cli/repl.js";
import {
  IMPLICIT_PROFILE_NAME,
  ViseConfigError,
  type RuntimeSettings,
} from "../src/profiles/index.js";
import type { LLMResponse } from "../src/types.js";
import type { LLMClient } from "../src/llm/client.js";
import { graphFrom, modelGraph, profileGraph } from "./helpers.js";

/** Register hooks inline (no file), all attributed to `source`. */
function manager(
  hooks: Hook[],
  options: { log?: (m: string) => void; cwd?: string } = {},
): HookManager {
  return new HookManager(
    hooks.map((hook) => ({ hook, source: "inline.ts" })),
    { log: options.log ?? (() => {}), cwd: options.cwd },
  );
}

/** A scripted LLM client: returns responses in order, repeating the last. */
function stubClient(responses: LLMResponse[]): LLMClient {
  let i = 0;
  return {
    async chat() {
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

const call = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): LLMResponse => ({
  content: "",
  toolCalls: [{ id, name, arguments: args }],
  usage: null,
});

/**
 * A session whose default profile carries `hooks`, exactly as a `.vise` config
 * connecting Profile→Hook edges would produce.
 */
function hookSession(hooks: Hook[], runtime: Partial<RuntimeSettings> = {}) {
  return createSession({
    graph: modelGraph("http://localhost:8080", runtime, (reg) => {
      for (const hook of hooks) {
        reg.createConnection(reg.builtins.defaultProfile, reg.createHook(hook));
      }
    }),
  });
}

describe("hook resources in the graph (profiles §3.3, §3.11)", () => {
  test("hooks reach a session through Profile→Hook edges, in creation order", () => {
    const { session } = hookSession([
      { events: ["turn:end"], handler: () => "a" },
      { events: ["turn:end"], handler: () => "b" },
    ]);
    expect(session.hooks.size).toBe(2);
    expect(session.hooks.dispatch("turn:end").block).toBe("a; b");
  });

  test("a profile with no hook edges has no hooks (§3.5 rule 3, AC 7)", () => {
    const { session } = createSession({ graph: modelGraph() });
    expect(session.hooks.size).toBe(0);
    expect(session.hooks.active).toBe(false);
  });

  test("the same handler registered twice registers twice (no dedup)", () => {
    const h = () => "boom";
    const { session } = hookSession([
      { events: ["turn:end"], handler: h },
      { events: ["turn:end"], handler: h },
    ]);
    expect(session.hooks.size).toBe(2);
    expect(session.hooks.dispatch("turn:end").block).toBe("boom; boom");
  });

  test("an invalid event is a fatal config error naming the valid ones", () => {
    let err: unknown;
    try {
      graphFrom((reg) => {
        reg.createHook({
          events: ["nope" as unknown as Hook["events"][number]],
          handler: () => undefined,
        });
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ViseConfigError);
    expect((err as Error).message).toContain("invalid event");
    expect((err as Error).message).toContain("turn:end");
  });

  test("a hook without a handler is a fatal config error", () => {
    expect(() =>
      graphFrom((reg) => {
        reg.createHook({
          events: ["turn:end"],
          handler: undefined as unknown as Hook["handler"],
        });
      }),
    ).toThrow(ViseConfigError);
  });

  test("a hook with no events is a fatal config error", () => {
    expect(() =>
      graphFrom((reg) => {
        reg.createHook({ events: [], handler: () => undefined });
      }),
    ).toThrow(ViseConfigError);
  });
});

describe("hook dispatch and result application (hooks §3.4, §3.5)", () => {
  test("void allows; a string blocks a blocking-capable event", () => {
    const m = manager([
      { events: ["turn:end"], handler: () => undefined },
      { events: ["turn:end"], handler: () => "tests failed" },
    ]);
    const out = m.dispatch("turn:end");
    expect(out.block).toBe("tests failed");
    expect(out.advisory).toBeNull();
  });

  test("multiple blocks are joined with \"; \"", () => {
    const m = manager([
      { events: ["tool:before"], handler: () => "no" },
      { events: ["tool:before"], handler: () => ({ message: "nope", block: true }) },
    ]);
    expect(m.dispatch("tool:before").block).toBe("no; nope");
  });

  test("advisories are joined with a newline", () => {
    const m = manager([
      { events: ["tool:after"], handler: () => ({ message: "warn 1" }) },
      { events: ["tool:after"], handler: () => ({ message: "warn 2", block: false }) },
    ]);
    const out = m.dispatch("tool:after");
    expect(out.advisory).toBe("warn 1\nwarn 2");
    expect(out.block).toBeNull();
  });

  test("a mixed result blocks and still carries the advisory", () => {
    const m = manager([
      { events: ["turn:end"], handler: () => "blocked" },
      { events: ["turn:end"], handler: () => ({ message: "fyi" }) },
    ]);
    const out = m.dispatch("turn:end");
    expect(out.block).toBe("blocked");
    expect(out.advisory).toBe("fyi");
  });

  test("a block on a non-blocking event becomes an advisory (§3.1)", () => {
    for (const event of ["tool:after", "turn:start", "session:start", "session:end", "on:compaction"] as const) {
      const m = manager([{ events: [event], handler: () => "ignored block" }]);
      const out = m.dispatch(event);
      expect(out.block).toBeNull();
      expect(out.advisory).toBe("ignored block");
    }
  });

  test("all hooks run in registration order with no short-circuit", () => {
    const seen: string[] = [];
    const m = manager([
      { events: ["turn:end"], handler: () => { seen.push("first"); return "stop"; } },
      { events: ["turn:end"], handler: () => { seen.push("second"); } },
      { events: ["turn:end"], handler: () => { seen.push("third"); return "also stop"; } },
    ]);
    expect(m.dispatch("turn:end").block).toBe("stop; also stop");
    expect(seen).toEqual(["first", "second", "third"]);
  });

  test("only hooks subscribed to the event fire", () => {
    const fired: string[] = [];
    const m = manager([
      { events: ["turn:start"], handler: () => { fired.push("start"); } },
      { events: ["turn:end", "tool:before"], handler: (c) => { fired.push(c.event); } },
    ]);
    m.dispatch("tool:before");
    expect(fired).toEqual(["tool:before"]);
  });

  test("the context carries event, tool, cwd, and depth", () => {
    const seen: HookContext[] = [];
    const m = manager(
      [{ events: ["tool:after"], handler: (c) => { seen.push(c); } }],
      { cwd: "/proj" },
    );
    m.dispatch("tool:after", {
      tool: { name: "write_file", args: { path: "a.ts" }, result: "ok" },
    });
    expect(seen[0]).toEqual({
      event: "tool:after",
      cwd: "/proj",
      depth: 0,
      tool: { name: "write_file", args: { path: "a.ts" }, result: "ok" },
    });
  });

  test("a throwing handler blocks, is logged, and others still run (§3.6, AC 4)", () => {
    const logs: string[] = [];
    const ran: string[] = [];
    const m = manager(
      [
        { events: ["turn:end"], handler: () => { throw new Error("boom"); } },
        { events: ["turn:end"], handler: () => { ran.push("after"); return "also"; } },
      ],
      { log: (msg) => logs.push(msg) },
    );
    const out = m.dispatch("turn:end");
    expect(out.block).toBe("boom; also");
    expect(ran).toEqual(["after"]);
    expect(logs[0]).toContain("[hook error] inline.ts (turn:end): boom");
  });

  test("a throw on a non-blocking event becomes an advisory (§3.6)", () => {
    const logs: string[] = [];
    const m = manager(
      [{ events: ["tool:after"], handler: () => { throw new Error("lint crashed"); } }],
      { log: (msg) => logs.push(msg) },
    );
    const out = m.dispatch("tool:after");
    expect(out.block).toBeNull();
    expect(out.advisory).toBe("lint crashed");
    expect(logs).toHaveLength(1);
  });

  test("an unsupported return value is ignored with a warning", () => {
    const logs: string[] = [];
    const m = manager(
      [
        { events: ["turn:end"], handler: (() => 42) as unknown as Hook["handler"] },
        { events: ["turn:end"], handler: (() => ({ nope: true })) as unknown as Hook["handler"] },
      ],
      { log: (msg) => logs.push(msg) },
    );
    const out = m.dispatch("turn:end");
    expect(out.block).toBeNull();
    expect(out.advisory).toBeNull();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("[hook warning]");
    expect(logs[0]).toContain("unsupported");
  });

  test("subagent hooks fire only with includeSubagents (§3.7, AC 6)", () => {
    const fired: string[] = [];
    const m = manager([
      { events: ["turn:end"], handler: () => { fired.push("parent-only"); } },
      { events: ["turn:end"], handler: () => { fired.push("subagents"); }, includeSubagents: true },
    ]);
    m.dispatch("turn:end", { depth: 0 });
    expect(fired).toEqual(["parent-only", "subagents"]);

    fired.length = 0;
    m.dispatch("turn:end", { depth: 2 });
    expect(fired).toEqual(["subagents"]);
  });

  test("a disabled manager is a no-op (§3.8, AC 5)", () => {
    let fired = 0;
    const m = manager([{ events: ["turn:end"], handler: () => { fired++; return "no"; } }]);
    m.setEnabled(false);
    expect(m.active).toBe(false);
    expect(m.dispatch("turn:end").block).toBeNull();
    expect(fired).toBe(0);
    m.setEnabled(true);
    expect(m.dispatch("turn:end").block).toBe("no");
    expect(fired).toBe(1);
  });

  test("an empty manager is inactive and dispatches nothing (AC 7)", () => {
    const m = new HookManager();
    expect(m.active).toBe(false);
    expect(m.dispatch("tool:before")).toEqual({ block: null, advisory: null });
  });
});

describe("hooks in the agent loop (hooks §3.5, AC 1, 2, 3)", () => {
  test("a blocking turn:end rejects finish and the agent retries (AC 1)", async () => {
    let attempts = 0;
    const { session, registry } = hookSession([
      {
        events: ["turn:end"],
        handler: () => {
          attempts++;
          return attempts === 1 ? "tsc failed: 1 error" : undefined;
        },
      },
    ]);
    const result = await runTurn(
      session,
      "do it",
      registry,
      {},
      undefined,
      stubClient([finish("first try", "a"), finish("second try", "b")]),
    );

    expect(attempts).toBe(2);
    expect(result.finished).toBe(true);
    expect(result.answer).toBe("second try");
    // The rejection was fed back as the result of the rejected finish call.
    const rejected = session.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "a",
    );
    expect(rejected?.content).toBe("tsc failed: 1 error");
  });

  test("a repeatedly blocking turn:end still honours maxIterations (§4)", async () => {
    const { session, registry } = hookSession(
      [{ events: ["turn:end"], handler: () => "never" }],
      { maxIterations: 3 },
    );
    const result = await runTurn(
      session,
      "do it",
      registry,
      {},
      undefined,
      stubClient([finish("done")]),
    );
    expect(result.kind).toBe("cap");
    expect(result.answer).toContain("maxIterations");
  });

  test("a blocking tool:before prevents execution (AC 2)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-hookblock-"));
    const target = path.join(dir, "bundle.min.js");
    const { session, registry } = hookSession([
      {
        events: ["tool:before"],
        handler: (ctx) =>
          ctx.tool?.name === "write_file" &&
          String(ctx.tool.args.path).endsWith(".min.js")
            ? "Refusing to write minified files."
            : undefined,
      },
    ]);
    await runTurn(
      session,
      "write it",
      registry,
      {},
      undefined,
      stubClient([
        call("t1", "write_file", { path: target, content: "x" }),
        finish("gave up"),
      ]),
    );

    expect(await Bun.file(target).exists()).toBe(false);
    const toolMsg = session.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "t1",
    );
    expect(toolMsg?.content).toBe("Refusing to write minified files.");
    rmSync(dir, { recursive: true, force: true });
  });

  test("tool:after advisory follows the tool result message (AC 3)", async () => {
    const { session, registry } = hookSession([
      {
        events: ["tool:after"],
        handler: (ctx) => ({
          message: `lint: 2 warnings in ${String(ctx.tool?.args.path)}`,
          block: false,
        }),
      },
    ]);
    await runTurn(
      session,
      "look",
      registry,
      {},
      undefined,
      stubClient([call("t1", "list_dir", { path: "." }), finish("looked")]),
    );

    const toolIndex = session.messages.findIndex(
      (m) => m.role === "tool" && m.tool_call_id === "t1",
    );
    expect(toolIndex).toBeGreaterThan(-1);
    const next = session.messages[toolIndex + 1];
    expect(next.role).toBe("system");
    expect(next.content).toContain("lint: 2 warnings");
  });

  test("tool:after sees the tool's result string", async () => {
    const results: (string | undefined)[] = [];
    const { session, registry } = hookSession([
      { events: ["tool:after"], handler: (ctx) => { results.push(ctx.tool?.result); } },
    ]);
    await runTurn(
      session,
      "look",
      registry,
      {},
      undefined,
      stubClient([call("t1", "read_file", { path: "/no/such/file" }), finish("x")]),
    );
    expect(results).toHaveLength(1);
    expect(typeof results[0]).toBe("string");
  });

  test("turn:start advisory is appended before the first LLM call", async () => {
    const { session, registry } = hookSession([
      { events: ["turn:start"], handler: () => ({ message: "branch: main" }) },
    ]);
    let firstCallMessages: string[] = [];
    const client: LLMClient = {
      async chat(opts) {
        if (firstCallMessages.length === 0) {
          firstCallMessages = opts.messages.map((m) => m.content ?? "");
        }
        return finish("ok");
      },
    };
    await runTurn(session, "the task", registry, {}, undefined, client);
    expect(firstCallMessages).toContain("branch: main");
  });

  test("session:start advisory joins the initial messages", () => {
    const { session } = hookSession([
      { events: ["session:start"], handler: () => ({ message: "hooks armed" }) },
    ]);
    expect(session.messages.map((m) => m.content)).toContain("hooks armed");
  });

  test("on:compaction fires before the recap call", async () => {
    const fired: string[] = [];
    // A tiny window makes the very first prompt-token count exceed the
    // threshold. maxContext comes from the model, not setRuntime.
    const { session, registry } = createSession({
      graph: graphFrom((reg) => {
        reg.setRuntime({ compactThreshold: 0.5 });
        reg.createConnection(
          reg.builtins.defaultProfile,
          reg.createModel({
            name: "test-model",
            baseUrl: "http://localhost:8080",
            apiKey: "",
            maxContext: 10,
          }),
        );
        reg.createConnection(
          reg.builtins.defaultProfile,
          reg.createHook({
            events: ["on:compaction"],
            handler: (c) => {
              fired.push(c.event);
            },
          }),
        );
      }),
    });
    const client = stubClient([
      {
        content: "",
        toolCalls: [{ id: "t1", name: "list_dir", arguments: { path: "." } }],
        usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
      },
      finish("done"),
    ]);
    await runTurn(session, "task", registry, {}, undefined, client);
    expect(fired).toEqual(["on:compaction"]);
  });

  test("hooks with includeSubagents fire inside a subagent (AC 6)", async () => {
    const depths: number[] = [];
    const graph = modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: ["turn:start"],
          handler: (c) => {
            depths.push(c.depth);
          },
        }),
      );
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: ["turn:start"],
          handler: (c) => {
            depths.push(100 + c.depth);
          },
          includeSubagents: true,
        }),
      );
    });
    const runner = makeSubagentRunner({
      graph,
      client: stubClient([finish("sub done")]),
    });
    const out = await runner({
      task: "t",
      maxIterations: 5,
      depth: 1,
      profile: IMPLICIT_PROFILE_NAME,
    });
    expect(out).toBe("sub done");
    // Only the includeSubagents hook fired, and it saw depth 1.
    expect(depths).toEqual([101]);
  });

  test("a subagent's blocked finish does not affect the parent (§3.7)", async () => {
    let blocks = 0;
    const graph = modelGraph("http://localhost:8080", {}, (reg) => {
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createHook({
          events: ["turn:end"],
          handler: (c) =>
            c.depth > 0 && blocks++ === 0 ? "not yet" : undefined,
          includeSubagents: true,
        }),
      );
    });
    const runner = makeSubagentRunner({
      graph,
      client: stubClient([finish("try one", "s1"), finish("try two", "s2")]),
    });
    expect(
      await runner({ task: "t", maxIterations: 5, depth: 1, profile: IMPLICIT_PROFILE_NAME }),
    ).toBe("try two");
  });

  test("with no hooks the loop behaves exactly as before (AC 7)", async () => {
    const { session, registry } = createSession({ graph: modelGraph() });
    expect(session.hooks.active).toBe(false);
    const result = await runTurn(
      session,
      "task",
      registry,
      {},
      undefined,
      stubClient([finish("plain")]),
    );
    expect(result.answer).toBe("plain");
    expect(session.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });
});

describe("/hooks REPL command (hooks §3.8, AC 5)", () => {
  test("the command is registered and listed by /help", () => {
    expect(REPL_COMMANDS.map((c) => c.name)).toContain("/hooks");
    expect(helpText()).toContain("/hooks");
  });

  test("dispatch matches both the bare command and its arguments", () => {
    expect(findCommand("/hooks")?.name).toBe("/hooks");
    expect(findCommand("/hooks off")?.name).toBe("/hooks");
    expect(commandArgs("/hooks off")).toEqual(["off"]);
    expect(commandArgs("/hooks")).toEqual([]);
    // Commands that take no arguments still match exactly only.
    expect(findCommand("/context now")).toBeUndefined();
  });

  test("/hooks lists events, subagent flag, tool filter, and source", () => {
    const m = new HookManager(
      [
        { hook: { events: ["turn:end"], handler: () => undefined }, source: "gate.ts" },
        {
          hook: { events: ["tool:after", "tool:before"], handler: () => undefined, includeSubagents: true },
          source: "lint.ts",
          tools: ["write_file"],
        },
      ],
      { log: () => {} },
    );
    const out = hooksListing(m);
    expect(out).toContain("2 active (enabled)");
    expect(out).toContain("turn:end");
    expect(out).toContain("gate.ts");
    expect(out).toContain(
      "tool:after, tool:before [subagents] [tools: write_file] — lint.ts",
    );
  });

  test("/hooks reports a profile with no hooks", () => {
    const handle = createSession({ graph: modelGraph() });
    expect(hooksCommand(handle)).toBe("hooks: none active for this profile.");
  });

  test("/hooks off then /hooks on toggles dispatch", () => {
    const handle = hookSession([
      { events: ["turn:end"], handler: () => "blocked" },
    ]);
    expect(hooksCommand(handle, ["off"])).toContain("disabled");
    expect(handle.session.hooks.dispatch("turn:end").block).toBeNull();
    expect(hooksCommand(handle, ["on"])).toContain("enabled");
    expect(handle.session.hooks.dispatch("turn:end").block).toBe("blocked");
    // The listing reflects the disabled state.
    hooksCommand(handle, ["off"]);
    expect(hooksCommand(handle)).toContain("(disabled)");
  });

  test("/hooks off survives a profile switch (§3.6)", () => {
    const graph = profileGraph((reg, profile) => {
      const hook = reg.createHook({
        events: ["turn:end"],
        handler: () => "blocked",
      });
      for (const name of ["default", "other"]) {
        reg.createConnection(profile(name), hook);
      }
    });
    const handle = createSession({ graph });
    hooksCommand(handle, ["off"]);
    handle.switchProfile("other");
    expect(handle.session.hooks.isEnabled()).toBe(false);
    expect(handle.session.hooks.dispatch("turn:end").block).toBeNull();
  });

  test("/hooks rejects an unknown argument with usage", () => {
    const handle = createSession({ graph: modelGraph() });
    expect(hooksCommand(handle, ["maybe"])).toContain(
      "Usage: /hooks [on|off]",
    );
  });
});
