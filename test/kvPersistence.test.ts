import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent/loop.js";
import { createSession } from "../src/agent/session.js";
import { makeSubagentRunner } from "../src/agent/subagent.js";
import { HookManager, type RegisteredHook } from "../src/hooks/index.js";
import type { LLMClient } from "../src/llm/client.js";
import {
  addDiscoveredModels,
  IMPLICIT_PROFILE_NAME,
  type ResourceGraph,
} from "../src/profiles/index.js";
import { kvCacheFileName, LlamaProvider } from "../src/providers/index.js";
import { executeToolCalls } from "../src/tools/index.js";
import { makeSpawnSubagentTool } from "../src/tools/spawnSubagent.js";
import type { LLMResponse, ToolCall } from "../src/types.js";
import { graphFrom, modelGraph } from "./helpers.js";

// --- fixtures ---------------------------------------------------------------

/** Temp `--slot-save-path` directories, removed after every test. */
const tempDirs: string[] = [];

function slotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vise-kv-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/** A scripted LLM response for the mock server. */
type ScriptedResponse = {
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
};

/** Encode a scripted response as an SSE body (mirrors integration.test.ts). */
function encodeSSE(r: ScriptedResponse): string {
  let sse = "";
  const push = (obj: unknown) => {
    sse += `data: ${JSON.stringify(obj)}\n\n`;
  };
  push({ choices: [{ delta: { role: "assistant" } }] });
  r.toolCalls.forEach((tc, i) => {
    push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: i,
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              },
            ],
          },
        },
      ],
    });
  });
  push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  push({
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  sse += "data: [DONE]\n\n";
  return sse;
}

interface LlamaServerOptions {
  /** Where a successful save "writes" its cache file, as llama.cpp would. */
  dir: string;
  /** Scripted chat completions, for tests that drive the real loop. */
  script?: ScriptedResponse[];
  /** HTTP status for `?action=save`. Default 200. */
  saveStatus?: number;
  /** HTTP status for `?action=restore`. Default 200. */
  restoreStatus?: number;
  /** Whether a successful save actually creates the file. Default true. */
  writeFile?: boolean;
}

/**
 * A mock llama.cpp server: the OpenAI-compatible SSE endpoint plus
 * `POST /slots/{id}?action=save|restore` (KV spec §9, AC 12).
 *
 * `log` records every request in arrival order — `"chat"` for a completion,
 * `"save:<file>"` / `"restore:<file>"` for a slot action — so a test can assert
 * that the save really happened before the subagent's first LLM call.
 */
function createLlamaServer(options: LlamaServerOptions) {
  const { dir, script = [], writeFile = true } = options;
  const log: string[] = [];
  const slots: { action: string; id: string; filename: string }[] = [];
  let callIndex = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/v1/chat/completions") {
        log.push("chat");
        if (script.length === 0) {
          throw new Error("test setup: the mock server has no chat script");
        }
        const scripted = script[Math.min(callIndex, script.length - 1)];
        callIndex++;
        return new Response(encodeSSE(scripted), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      const slotMatch = /^[/]slots[/]([0-9]+)$/.exec(url.pathname);
      if (slotMatch !== null && req.method === "POST") {
        const action = url.searchParams.get("action") ?? "";
        const body = (await req.json()) as { filename?: string };
        const filename = body.filename ?? "";
        slots.push({ action, id: slotMatch[1], filename });
        log.push(`${action}:${filename}`);

        const status =
          action === "save"
            ? (options.saveStatus ?? 200)
            : (options.restoreStatus ?? 200);
        if (status !== 200) {
          return new Response("nope", { status });
        }
        // A real save writes the slot's prompt cache under --slot-save-path;
        // a restore only reads it (the provider does the deleting).
        if (action === "save" && writeFile) {
          Bun.write(join(dir, filename), "kv");
        }
        return Response.json({ id_slot: Number(slotMatch[1]), filename });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    baseUrl: `http://localhost:${server.port}`,
    /** Every slot request, in arrival order. */
    slots,
    /** Every request (chat and slot), in arrival order. */
    log,
  };
}

/** A KV-persistent provider pointed at `baseUrl`, with its warnings captured. */
function kvProvider(
  baseUrl: string,
  dir: string,
  warnings: string[],
): LlamaProvider {
  return new LlamaProvider({
    url: baseUrl,
    kvPersistence: true,
    slotSavePath: dir,
    log: (message) => warnings.push(message),
  });
}

/**
 * A graph whose only model was discovered from `provider`, so every session
 * built from it resolves to that provider (and its contributed hooks).
 */
function providerGraph(provider: LlamaProvider, baseUrl: string): ResourceGraph {
  const graph = graphFrom((reg) => {
    reg.addProvider(provider);
  });
  const providerId = graph.providerNames.get(provider.name);
  if (providerId === undefined) {
    throw new Error("test setup: the provider was never registered");
  }
  return addDiscoveredModels(graph, [
    {
      providerId,
      models: [{ name: "test-model", baseUrl, apiKey: "" }],
    },
  ]);
}

/** A hook manager holding just what `provider` contributes, as a session's would. */
function spawnerHooks(provider: LlamaProvider): HookManager {
  return new HookManager(
    provider.hooks().map((hook) => ({
      hook,
      source: `provider:${provider.name}`,
    })),
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

const spawn = (id: string, task = "sub"): LLMResponse => ({
  content: "",
  toolCalls: [
    { id, name: "spawn_subagent", arguments: { task, maxIterations: 5 } },
  ],
  usage: null,
});

/** The options a subagent run needs, spawned by the main agent (depth 0). */
function runOpts(graph: ResourceGraph) {
  const model = [...graph.resources.values()].find((r) => r.kind === "model");
  return {
    task: "t",
    maxIterations: 5,
    depth: 1,
    profile: IMPLICIT_PROFILE_NAME,
    parentModel: {
      baseUrl: "http://parent:1",
      model: "test-model",
      apiKey: "",
      temperature: 0.2,
      maxContext: 8192,
      modelId: model?.id ?? null,
    },
  };
}

/** The `kv-depth-*.bin` files left in `dir`. */
function cacheFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("kv-depth-"));
}

// --- configuration (§3.1) ---------------------------------------------------

describe("LlamaProvider KV configuration (KV spec §3.1, AC 1, 10)", () => {
  test("kvPersistence without slotSavePath is a fatal config error (AC 10)", () => {
    expect(
      () =>
        new LlamaProvider({
          url: "http://localhost:8080",
          kvPersistence: true,
        }),
    ).toThrow(/slotSavePath/);
  });

  test("kvPersistence off contributes no hooks and no serialization (AC 1)", () => {
    const provider = new LlamaProvider({ url: "http://localhost:8080" });
    expect(provider.hooks()).toEqual([]);
    expect(provider.serializeSubagents).toBe(false);
  });

  test("kvPersistence on contributes one hook for both subagent events", () => {
    const dir = slotDir();
    const provider = kvProvider("http://localhost:8080", dir, []);
    const hooks = provider.hooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0].events).toEqual(["subagent:before", "subagent:after"]);
    expect(hooks[0].includeSubagents).toBe(true);
    expect(provider.serializeSubagents).toBe(true);
    // Every session materializes hooks again; they must be the same objects so
    // the per-depth save bookkeeping is shared.
    expect(provider.hooks()[0]).toBe(hooks[0]);
  });

  test("a provider without KV persistence leaves the session unhooked (AC 1)", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir });
    try {
      const provider = new LlamaProvider({ url: server.baseUrl });
      const graph = providerGraph(provider, server.baseUrl);
      const client = stubClient([spawn("p1"), finish("sub"), finish("parent")]);
      const { session, registry } = createSession({ graph, client });
      expect(session.hooks.active).toBe(false);
      const result = await runTurn(session, "delegate", registry, {}, undefined, client);
      expect(result.answer).toBe("parent");
      expect(server.slots).toEqual([]);
    } finally {
      server.server.stop();
    }
  });
});

// --- save / restore around one nested run (§3.4–§3.6) -----------------------

describe("save and restore around a subagent run (KV spec §3.4–§3.6)", () => {
  test("saves before the run and restores + deletes after (AC 2, 3, 6)", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir });
    const warnings: string[] = [];
    try {
      const provider = kvProvider(server.baseUrl, dir, warnings);
      const graph = providerGraph(provider, server.baseUrl);
      const hooks = spawnerHooks(provider);
      const runner = makeSubagentRunner(
        { graph, client: stubClient([finish("sub done")]) },
        { hooks, depth: 0 },
      );

      expect(await runner(runOpts(graph))).toBe("sub done");
      expect(server.slots).toEqual([
        { action: "save", id: "0", filename: "kv-depth-0.bin" },
        { action: "restore", id: "0", filename: "kv-depth-0.bin" },
      ]);
      // AC 6: the owner deleted its own file, so the disk is clean.
      expect(cacheFiles(dir)).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      server.server.stop();
    }
  });

  test("restores after a failed subagent (AC 4)", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir });
    try {
      const provider = kvProvider(server.baseUrl, dir, []);
      const graph = providerGraph(provider, server.baseUrl);
      const client: LLMClient = {
        async chat() {
          throw new Error("boom");
        },
      };
      const runner = makeSubagentRunner(
        { graph, client },
        { hooks: spawnerHooks(provider), depth: 0 },
      );

      expect(await runner(runOpts(graph))).toBe("subagent failed: boom");
      expect(server.slots.map((s) => s.action)).toEqual(["save", "restore"]);
      expect(cacheFiles(dir)).toEqual([]);
    } finally {
      server.server.stop();
    }
  });

  test("restores after an iteration-cap subagent (AC 4)", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir });
    try {
      const provider = kvProvider(server.baseUrl, dir, []);
      const graph = providerGraph(provider, server.baseUrl);
      // Never calls finish: the loop hits the cap.
      const client = stubClient([
        {
          content: "",
          toolCalls: [{ id: "t1", name: "list_dir", arguments: { path: "." } }],
          usage: null,
        },
      ]);
      const runner = makeSubagentRunner(
        { graph, client },
        { hooks: spawnerHooks(provider), depth: 0 },
      );

      await runner({ ...runOpts(graph), maxIterations: 1 });
      expect(server.slots.map((s) => s.action)).toEqual(["save", "restore"]);
      expect(cacheFiles(dir)).toEqual([]);
    } finally {
      server.server.stop();
    }
  });

  test("a failed save is fail-open and no restore follows (AC 7)", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir, saveStatus: 501 });
    const warnings: string[] = [];
    try {
      const provider = kvProvider(server.baseUrl, dir, warnings);
      const graph = providerGraph(provider, server.baseUrl);
      const runner = makeSubagentRunner(
        { graph, client: stubClient([finish("sub done")]) },
        { hooks: spawnerHooks(provider), depth: 0 },
      );

      // The subagent still ran and its answer came back unchanged.
      expect(await runner(runOpts(graph))).toBe("sub done");
      expect(server.slots.map((s) => s.action)).toEqual(["save"]);
      expect(warnings.join("\n")).toContain("501");
      expect(warnings.join("\n")).toContain("--slot-save-path");
      expect(cacheFiles(dir)).toEqual([]);
    } finally {
      server.server.stop();
    }
  });

  test("an unreachable server is fail-open (AC 7)", async () => {
    const dir = slotDir();
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadUrl = `http://localhost:${probe.port}`;
    probe.stop(true);
    const warnings: string[] = [];

    const provider = kvProvider(deadUrl, dir, warnings);
    const graph = providerGraph(provider, deadUrl);
    const runner = makeSubagentRunner(
      { graph, client: stubClient([finish("sub done")]) },
      { hooks: spawnerHooks(provider), depth: 0 },
    );

    expect(await runner(runOpts(graph))).toBe("sub done");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("save of kv-depth-0.bin failed");
  });

  test("a failed restore is fail-open (AC 8)", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir, restoreStatus: 500 });
    const warnings: string[] = [];
    try {
      const provider = kvProvider(server.baseUrl, dir, warnings);
      const graph = providerGraph(provider, server.baseUrl);
      const runner = makeSubagentRunner(
        { graph, client: stubClient([finish("sub done")]) },
        { hooks: spawnerHooks(provider), depth: 0 },
      );

      expect(await runner(runOpts(graph))).toBe("sub done");
      expect(server.slots.map((s) => s.action)).toEqual(["save", "restore"]);
      expect(warnings.join("\n")).toContain("restore of kv-depth-0.bin failed");
      // §3.5.2: deletion only follows a *successful* restore.
      expect(cacheFiles(dir)).toEqual(["kv-depth-0.bin"]);
    } finally {
      server.server.stop();
    }
  });

  test("a failed delete warns and does not affect the turn (§4)", async () => {
    const dir = slotDir();
    // The save reports success but writes nothing, so the unlink has no file.
    const server = createLlamaServer({ dir, writeFile: false });
    const warnings: string[] = [];
    try {
      const provider = kvProvider(server.baseUrl, dir, warnings);
      const graph = providerGraph(provider, server.baseUrl);
      const runner = makeSubagentRunner(
        { graph, client: stubClient([finish("sub done")]) },
        { hooks: spawnerHooks(provider), depth: 0 },
      );

      expect(await runner(runOpts(graph))).toBe("sub done");
      expect(warnings.join("\n")).toContain("could not delete");
    } finally {
      server.server.stop();
    }
  });

  test("nothing happens at all without a spawner context", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir });
    try {
      const provider = kvProvider(server.baseUrl, dir, []);
      const graph = providerGraph(provider, server.baseUrl);
      const runner = makeSubagentRunner({
        graph,
        client: stubClient([finish("sub done")]),
      });
      expect(await runner(runOpts(graph))).toBe("sub done");
      expect(server.slots).toEqual([]);
    } finally {
      server.server.stop();
    }
  });
});

// --- the depth-keyed stack (§2.3) ------------------------------------------

describe("the save/restore stack at every depth (KV spec §2.3, AC 5, 6)", () => {
  test("a nested spawn saves and restores at each level (AC 5, 6)", async () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir });
    try {
      const provider = kvProvider(server.baseUrl, dir, []);
      const graph = providerGraph(provider, server.baseUrl);
      const client = stubClient([
        spawn("p1"), // depth 0 spawns depth 1
        spawn("s1"), // depth 1 spawns depth 2
        finish("deep done"), // depth 2 finishes
        finish("sub done"), // depth 1 finishes
        finish("parent done"), // depth 0 finishes
      ]);
      const { session, registry } = createSession({ graph, client });

      const result = await runTurn(
        session,
        "delegate",
        registry,
        {},
        undefined,
        client,
      );
      expect(result.answer).toBe("parent done");
      expect(server.log).toEqual([
        "save:kv-depth-0.bin",
        "save:kv-depth-1.bin",
        "restore:kv-depth-1.bin",
        "restore:kv-depth-0.bin",
      ]);
      // AC 6: every owner deleted its own file when the turn ended.
      expect(cacheFiles(dir)).toEqual([]);
    } finally {
      server.server.stop();
    }
  });
});

// --- serialization (§3.7, §8.4) --------------------------------------------

describe("subagent serialization (KV spec §3.7, §8.4, AC 9)", () => {
  test("spawn_subagent becomes sequential when KV persistence is active", () => {
    const dir = slotDir();
    const server = createLlamaServer({ dir });
    try {
      const provider = kvProvider(server.baseUrl, dir, []);
      const { registry } = createSession({
        graph: providerGraph(provider, server.baseUrl),
      });
      expect(registry.get("spawn_subagent")?.mutating).toBe(true);
      expect(registry.get("spawn_subagent")?.description).toContain(
        "one at a time",
      );
    } finally {
      server.server.stop();
    }
  });

  test("spawn_subagent stays concurrent without KV persistence", () => {
    const { registry } = createSession({ graph: modelGraph() });
    expect(registry.get("spawn_subagent")?.mutating).toBe(false);
    expect(registry.get("spawn_subagent")?.description).toContain(
      "concurrently",
    );
  });

  test("two spawn calls in one message run one at a time (AC 9)", async () => {
    const overlap = await spawnOverlap(true);
    expect(overlap).toBe(1);
  });

  test("two spawn calls still overlap when KV is inactive (AC 9)", async () => {
    const overlap = await spawnOverlap(false);
    expect(overlap).toBe(2);
  });
});

/** The peak number of concurrently running subagents for one two-call batch. */
async function spawnOverlap(serializeRuns: boolean): Promise<number> {
  let running = 0;
  let peak = 0;
  const runner = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return "ok";
  };

  const { registry } = createSession({ graph: modelGraph() });
  registry.register(
    makeSpawnSubagentTool({
      runner,
      depth: 0,
      parentProfile: "",
      fallbackMaxDepth: 3,
      subagentMaxIterations: 50,
      knownProfiles: [],
      serializeRuns,
      parentModel: {
        baseUrl: "http://parent:1",
        model: "test-model",
        apiKey: "",
        temperature: 0.2,
        maxContext: 8192,
      },
    }),
  );

  const calls: ToolCall[] = ["a", "b"].map((id) => ({
    id,
    name: "spawn_subagent",
    arguments: { task: id, maxIterations: 5 },
  }));
  await executeToolCalls(registry, calls, 20000);
  return peak;
}

// --- async hook events (§3.3, §8.1) ----------------------------------------

describe("async hook events (KV spec §3.3, §8.1, AC 11)", () => {
  const manager = (hooks: RegisteredHook[]) =>
    new HookManager(hooks, { log: () => {} });

  test("a Promise on subagent:before is awaited", async () => {
    const order: string[] = [];
    const m = new HookManager([
      {
        hook: {
          events: ["subagent:before"],
          handler: async () => {
            await new Promise((r) => setTimeout(r, 10));
            order.push("handler");
          },
        },
        source: "t",
      },
    ]);
    await m.dispatchAsync("subagent:before");
    order.push("after dispatch");
    expect(order).toEqual(["handler", "after dispatch"]);
  });

  test("a Promise on a pre-existing event is an unsupported result", () => {
    const logged: string[] = [];
    const m = new HookManager(
      [
        {
          hook: { events: ["turn:end"], handler: async () => "too late" },
          source: "t",
        },
      ],
      { log: (message) => logged.push(message) },
    );
    const out = m.dispatch("turn:end");
    // The synchronous guarantee holds: the Promise is never awaited, so it
    // cannot block, and the session is warned instead.
    expect(out.block).toBeNull();
    expect(logged.join("\n")).toContain("unsupported");
  });

  test("neither subagent event can block; a string is advisory only", async () => {
    for (const event of ["subagent:before", "subagent:after"] as const) {
      const m = new HookManager([
        { hook: { events: [event], handler: () => "no" }, source: "t" },
      ]);
      const out = await m.dispatchAsync(event);
      expect(out.block).toBeNull();
      expect(out.advisory).toBe("no");
    }
  });

  test("a rejected handler is logged and does not stop the others", async () => {
    const logged: string[] = [];
    const fired: string[] = [];
    const m = new HookManager(
      [
        {
          hook: {
            events: ["subagent:after"],
            handler: async () => {
              throw new Error("save failed");
            },
          },
          source: "first",
        },
        {
          hook: {
            events: ["subagent:after"],
            handler: () => {
              fired.push("second");
            },
          },
          source: "second",
        },
      ],
      { log: (message) => logged.push(message) },
    );
    await m.dispatchAsync("subagent:after");
    expect(fired).toEqual(["second"]);
    expect(logged.join("\n")).toContain("save failed");
  });

  test("dispatchAsync on a synchronous event behaves like dispatch", async () => {
    const m = manager([
      { hook: { events: ["turn:end"], handler: () => "stop" }, source: "t" },
    ]);
    expect((await m.dispatchAsync("turn:end")).block).toBe("stop");
  });
});

// --- end-to-end (§9, AC 12) -------------------------------------------------

describe("integration: main agent → subagent → main agent (AC 12)", () => {
  test("save and restore bracket the subagent's LLM calls", async () => {
    const dir = slotDir();
    const server = createLlamaServer({
      dir,
      script: [
        {
          toolCalls: [
            {
              id: "p1",
              name: "spawn_subagent",
              arguments: { task: "research", maxIterations: 5 },
            },
          ],
        },
        {
          toolCalls: [
            { id: "s1", name: "finish", arguments: { answer: "subagent done" } },
          ],
        },
        {
          toolCalls: [
            { id: "p2", name: "finish", arguments: { answer: "parent done" } },
          ],
        },
      ],
    });
    try {
      const provider = kvProvider(server.baseUrl, dir, []);
      const { session, registry } = createSession({
        graph: providerGraph(provider, server.baseUrl),
      });

      const result = await runTurn(session, "delegate it", registry);
      expect(result.answer).toBe("parent done");
      // The save lands before the subagent's first completion, the restore
      // before the main agent's next one.
      expect(server.log).toEqual([
        "chat",
        "save:kv-depth-0.bin",
        "chat",
        "restore:kv-depth-0.bin",
        "chat",
      ]);
      expect(existsSync(join(dir, kvCacheFileName(0)))).toBe(false);
    } finally {
      server.server.stop();
    }
  });
});
