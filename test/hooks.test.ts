import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHookManager,
  HookLoadError,
  HookManager,
  loadHookFile,
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
  REPL_COMMANDS,
} from "../src/cli/repl.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  resolveConfig,
  validateConfig,
  ConfigError,
  parseCliArgs,
} from "../src/config/index.js";
import type { Config, LLMResponse } from "../src/types.js";
import type { LLMClient } from "../src/llm/client.js";

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

/** A temp directory holding hook files, cleaned up by the caller. */
function makeHookDir(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-hooks-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), contents, "utf8");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Await a promise that must reject and return the error, so a test can assert
 * on both its type and its message.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, model: "test-model", ...overrides };
}

describe("hook loading (hooks §3.3, AC 8)", () => {
  test("loads a file's default export in array order", async () => {
    const { dir, cleanup } = makeHookDir({
      "hooks.ts": `export default [
        { events: ["turn:end"], handler: () => undefined },
        { events: ["tool:after", "tool:before"], handler: () => undefined, includeSubagents: true },
      ];`,
    });
    const loaded = await loadHookFile("hooks.ts", dir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].hook.events).toEqual(["turn:end"]);
    expect(loaded[0].source).toBe("hooks.ts");
    expect(loaded[1].hook.includeSubagents).toBe(true);
    cleanup();
  });

  test("an absolute path is loaded as given", async () => {
    const { dir, cleanup } = makeHookDir({
      "abs.ts": `export default [{ events: ["turn:start"], handler: () => undefined }];`,
    });
    const abs = path.join(dir, "abs.ts");
    const loaded = await loadHookFile(abs, "/definitely/not/here");
    expect(loaded).toHaveLength(1);
    cleanup();
  });

  test("a missing file is fatal and names the file", async () => {
    const err = await rejection(loadHookFile("nope.ts", tmpdir()));
    expect(err).toBeInstanceOf(HookLoadError);
    expect(err.message).toMatch(/Hook file not found: nope\.ts/);
  });

  test("a syntax error is fatal and names the file", async () => {
    const { dir, cleanup } = makeHookDir({ "bad.ts": `export default [ {{{` });
    const err = await rejection(loadHookFile("bad.ts", dir));
    expect(err).toBeInstanceOf(HookLoadError);
    expect(err.message).toMatch(/Failed to load hook file bad\.ts/);
    cleanup();
  });

  test("a missing default export is fatal", async () => {
    const { dir, cleanup } = makeHookDir({ "none.ts": `export const x = 1;` });
    const err = await rejection(loadHookFile("none.ts", dir));
    expect(err.message).toMatch(/Hook file none\.ts has no default export/);
    cleanup();
  });

  test("a non-array default export is fatal", async () => {
    const { dir, cleanup } = makeHookDir({
      "obj.ts": `export default { events: ["turn:end"], handler: () => undefined };`,
    });
    const err = await rejection(loadHookFile("obj.ts", dir));
    expect(err.message).toMatch(
      /must default-export an array of hooks \(got an object\)/,
    );
    cleanup();
  });

  test("a hook without events is fatal and identifies the entry", async () => {
    const { dir, cleanup } = makeHookDir({
      "noev.ts": `export default [{ handler: () => undefined }];`,
    });
    const err = await rejection(loadHookFile("noev.ts", dir));
    expect(err.message).toMatch(
      /Hook #0 in noev\.ts must have a non-empty "events" array/,
    );
    cleanup();
  });

  test("a hook without a handler is fatal", async () => {
    const { dir, cleanup } = makeHookDir({
      "nohandler.ts": `export default [{ events: ["turn:end"] }];`,
    });
    const err = await rejection(loadHookFile("nohandler.ts", dir));
    expect(err.message).toMatch(
      /Hook #0 in nohandler\.ts must have a "handler" function/,
    );
    cleanup();
  });

  test("an invalid event literal is fatal and lists the bad value", async () => {
    const { dir, cleanup } = makeHookDir({
      "badev.ts": `export default [{ events: ["turn:middle"], handler: () => undefined }];`,
    });
    const err = await rejection(loadHookFile("badev.ts", dir));
    expect(err.message).toMatch(/invalid event "turn:middle"/);
    cleanup();
  });

  test("a non-boolean includeSubagents is fatal", async () => {
    const { dir, cleanup } = makeHookDir({
      "flag.ts": `export default [{ events: ["turn:end"], handler: () => undefined, includeSubagents: "yes" }];`,
    });
    const err = await rejection(loadHookFile("flag.ts", dir));
    expect(err.message).toMatch(/non-boolean "includeSubagents"/);
    cleanup();
  });

  test("files load in config order, hooks in array order", async () => {
    const { dir, cleanup } = makeHookDir({
      "a.ts": `export default [{ events: ["turn:end"], handler: () => "a" }];`,
      "b.ts": `export default [{ events: ["turn:end"], handler: () => "b" }];`,
    });
    const m = await createHookManager(["b.ts", "a.ts"], { cwd: dir });
    expect(m.list().map((r) => r.source)).toEqual(["b.ts", "a.ts"]);
    expect(m.dispatch("turn:end").block).toBe("b; a");
    cleanup();
  });

  test("no hooks configured -> an inert manager, no file loading (AC 7)", async () => {
    const empty = await createHookManager(undefined);
    expect(empty.size).toBe(0);
    expect(empty.active).toBe(false);
    // A path that does not exist is never touched when the list is empty.
    expect((await createHookManager([])).active).toBe(false);
  });

  test("the same handler in two files registers twice (no dedup)", async () => {
    const { dir, cleanup } = makeHookDir({
      "shared.ts": `const h = () => "boom"; export default [{ events: ["turn:end"], handler: h }, { events: ["turn:end"], handler: h }];`,
    });
    const m = await createHookManager(["shared.ts"], { cwd: dir });
    expect(m.size).toBe(2);
    expect(m.dispatch("turn:end").block).toBe("boom; boom");
    cleanup();
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
    const hooks = manager([
      {
        events: ["turn:end"],
        handler: () => {
          attempts++;
          return attempts === 1 ? "tsc failed: 1 error" : undefined;
        },
      },
    ]);
    const { session, registry } = createSession(makeConfig(), { hooks });
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
    const hooks = manager([{ events: ["turn:end"], handler: () => "never" }]);
    const { session, registry } = createSession(makeConfig({ maxIterations: 3 }), {
      hooks,
    });
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
    const dir = mkdtempSync(path.join(tmpdir(), "harness-hookblock-"));
    const target = path.join(dir, "bundle.min.js");
    const hooks = manager([
      {
        events: ["tool:before"],
        handler: (ctx) =>
          ctx.tool?.name === "write_file" &&
          String(ctx.tool.args.path).endsWith(".min.js")
            ? "Refusing to write minified files."
            : undefined,
      },
    ]);
    const { session, registry } = createSession(makeConfig(), { hooks });
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
    const hooks = manager([
      {
        events: ["tool:after"],
        handler: (ctx) => ({
          message: `lint: 2 warnings in ${String(ctx.tool?.args.path)}`,
          block: false,
        }),
      },
    ]);
    const { session, registry } = createSession(makeConfig(), { hooks });
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
    const hooks = manager([
      { events: ["tool:after"], handler: (ctx) => { results.push(ctx.tool?.result); } },
    ]);
    const { session, registry } = createSession(makeConfig(), { hooks });
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
    const hooks = manager([
      { events: ["turn:start"], handler: () => ({ message: "branch: main" }) },
    ]);
    const { session, registry } = createSession(makeConfig(), { hooks });
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
    const hooks = manager([
      { events: ["session:start"], handler: () => ({ message: "hooks armed" }) },
    ]);
    const { session } = createSession(makeConfig(), { hooks });
    expect(session.messages.map((m) => m.content)).toContain("hooks armed");
  });

  test("on:compaction fires before the recap call", async () => {
    const fired: string[] = [];
    const hooks = manager([
      { events: ["on:compaction"], handler: (c) => { fired.push(c.event); } },
    ]);
    // A tiny window makes the very first prompt-token count exceed the threshold.
    const cfg = makeConfig({ maxContext: 10, compactThreshold: 0.5 });
    const { session, registry } = createSession(cfg, { hooks });
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
    const hooks = manager([
      { events: ["turn:start"], handler: (c) => { depths.push(c.depth); } },
      { events: ["turn:start"], handler: (c) => { depths.push(100 + c.depth); }, includeSubagents: true },
    ]);
    const runner = makeSubagentRunner(
      makeConfig(),
      stubClient([finish("sub done")]),
      undefined,
      hooks,
    );
    const out = await runner({ task: "t", maxIterations: 5, depth: 1 });
    expect(out).toBe("sub done");
    // Only the includeSubagents hook fired, and it saw depth 1.
    expect(depths).toEqual([101]);
  });

  test("a subagent's blocked finish does not affect the parent (§3.7)", async () => {
    let blocks = 0;
    const hooks = manager([
      {
        events: ["turn:end"],
        handler: (c) => (c.depth > 0 && blocks++ === 0 ? "not yet" : undefined),
        includeSubagents: true,
      },
    ]);
    const runner = makeSubagentRunner(
      makeConfig(),
      stubClient([finish("try one", "s1"), finish("try two", "s2")]),
      undefined,
      hooks,
    );
    expect(await runner({ task: "t", maxIterations: 5, depth: 1 })).toBe(
      "try two",
    );
  });

  test("with no hooks the loop behaves exactly as before (AC 7)", async () => {
    const { session, registry } = createSession(makeConfig());
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

  test("/hooks lists events, subagent flag, and source file", () => {
    const m = new HookManager(
      [
        { hook: { events: ["turn:end"], handler: () => undefined }, source: "gate.ts" },
        {
          hook: { events: ["tool:after", "tool:before"], handler: () => undefined, includeSubagents: true },
          source: "lint.ts",
        },
      ],
      { log: () => {} },
    );
    const out = hooksCommand(m);
    expect(out).toContain("2 registered (enabled)");
    expect(out).toContain("turn:end");
    expect(out).toContain("gate.ts");
    expect(out).toContain("tool:after, tool:before [subagents] — lint.ts");
  });

  test("/hooks reports an empty registry", () => {
    expect(hooksCommand(new HookManager())).toBe("hooks: none registered.");
  });

  test("/hooks off then /hooks on toggles dispatch", () => {
    const m = manager([{ events: ["turn:end"], handler: () => "blocked" }]);
    expect(hooksCommand(m, ["off"])).toContain("disabled");
    expect(m.dispatch("turn:end").block).toBeNull();
    expect(hooksCommand(m, ["on"])).toContain("enabled");
    expect(m.dispatch("turn:end").block).toBe("blocked");
    // The listing reflects the disabled state.
    m.setEnabled(false);
    expect(hooksCommand(m)).toContain("(disabled)");
  });

  test("/hooks rejects an unknown argument with usage", () => {
    expect(hooksCommand(new HookManager(), ["maybe"])).toContain(
      "Usage: /hooks [on|off]",
    );
  });
});

describe("hooks configuration (hooks §3.9, AC 12)", () => {
  test("defaults to an empty list", () => {
    const cfg = resolveConfig({}, "./does-not-exist.json", {
      HARNESS_MODEL: "m",
    });
    expect(cfg.hooks).toEqual([]);
  });

  test("the env var is split on commas and trimmed", () => {
    const cfg = resolveConfig({}, "./does-not-exist.json", {
      HARNESS_MODEL: "m",
      HARNESS_HOOKS: "a.ts, b.ts ,",
    });
    expect(cfg.hooks).toEqual(["a.ts", "b.ts"]);
  });

  test("--hooks is repeatable and overrides the env var", () => {
    const { flags } = parseCliArgs(["--hooks", "x.ts", "--hooks", "y.ts"]);
    expect(flags.hooks).toEqual(["x.ts", "y.ts"]);
    const cfg = resolveConfig(flags, "./does-not-exist.json", {
      HARNESS_MODEL: "m",
      HARNESS_HOOKS: "env.ts",
    });
    expect(cfg.hooks).toEqual(["x.ts", "y.ts"]);
  });

  test("a non-array or empty-string entry is rejected", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, model: "m", hooks: "a.ts" as unknown as string[] }),
    ).toThrow(ConfigError);
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, model: "m", hooks: [""] }),
    ).toThrow(ConfigError);
  });

  test("a malformed hook file is a fatal startup error (AC 8)", async () => {
    const { dir, cleanup } = makeHookDir({
      "broken.ts": `export default [{ events: ["nope"], handler: () => undefined }];`,
    });
    const env = { ...process.env };
    env.HARNESS_MODEL = "test-model";
    env.HARNESS_BASE_URL = "http://127.0.0.1:1";
    env.HARNESS_HOOKS = path.join(dir, "broken.ts");
    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Hook error:");
    expect(stderr).toContain("invalid event");
    expect(stderr).toContain("broken.ts");
    cleanup();
  });
});
