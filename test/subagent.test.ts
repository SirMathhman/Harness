import { describe, expect, test } from "bun:test";
import {
  resolveConfig,
  validateConfig,
  ConfigError,
  type CliFlags,
} from "../src/config/index.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { Config, LLMResponse, Session, ToolCall } from "../src/types.js";
import { makeSpawnSubagentTool } from "../src/tools/spawnSubagent.js";
import { makeSubagentRunner } from "../src/agent/subagent.js";
import { createSession } from "../src/agent/session.js";
import { runTurn } from "../src/agent/loop.js";
import { buildToolRegistry, executeToolCalls } from "../src/tools/index.js";
import { ServerUnreachableError } from "../src/llm/errors.js";
import type { LLMClient } from "../src/llm/client.js";

const emptyFlags: CliFlags = {};

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

const finish = (answer: string): LLMResponse => ({
  content: "",
  toolCalls: [{ id: "f1", name: "finish", arguments: { answer } }],
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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, model: "test-model", ...overrides };
}

describe("config: subagent keys (AC 12, §6.1)", () => {
  test("defaults are present", () => {
    const cfg = resolveConfig(emptyFlags, "./does-not-exist.json", {
      HARNESS_MODEL: "m",
    });
    expect(cfg.subagentMaxIterations).toBe(50);
    expect(cfg.maxSubagentDepth).toBe(3);
  });

  test("env values are coerced to numbers", () => {
    const cfg = resolveConfig(emptyFlags, "./does-not-exist.json", {
      HARNESS_MODEL: "m",
      HARNESS_SUBAGENT_MAX_ITER: "12",
      HARNESS_MAX_SUBAGENT_DEPTH: "2",
    });
    expect(cfg.subagentMaxIterations).toBe(12);
    expect(cfg.maxSubagentDepth).toBe(2);
  });

  test("validateConfig rejects non-positive subagentMaxIterations", () => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      model: "m",
      subagentMaxIterations: 0,
    };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
  });

  test("validateConfig rejects negative maxSubagentDepth", () => {
    const cfg: Config = { ...DEFAULT_CONFIG, model: "m", maxSubagentDepth: -1 };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
  });
});

describe("spawn_subagent tool (§3.3 #9, §3.8)", () => {
  test("returns the runner's result verbatim (DONE)", async () => {
    const seen: unknown[] = [];
    const tool = makeSpawnSubagentTool(
      async (opts) => {
        seen.push(opts);
        return "subagent answer";
      },
      0,
      3,
      50,
    );
    const out = await tool.handler({ task: "do it", maxIterations: 10 });
    expect(out).toBe("subagent answer");
    expect(seen[0]).toMatchObject({
      task: "do it",
      maxIterations: 10,
      depth: 1,
    });
  });

  test("caps maxIterations to the configured ceiling (§3.8.4)", async () => {
    const seen: { maxIterations: number }[] = [];
    const tool = makeSpawnSubagentTool(
      async (opts) => {
        seen.push(opts);
        return "ok";
      },
      0,
      3,
      5,
    );
    await tool.handler({ task: "t", maxIterations: 100 });
    expect(seen[0].maxIterations).toBe(5);
  });

  test("clamps maxIterations to at least 1", async () => {
    const seen: { maxIterations: number }[] = [];
    const tool = makeSpawnSubagentTool(
      async (opts) => {
        seen.push(opts);
        return "ok";
      },
      0,
      3,
      50,
    );
    await tool.handler({ task: "t", maxIterations: 0 });
    expect(seen[0].maxIterations).toBe(1);
  });

  test("passes an optional systemPrompt through", async () => {
    const seen: { systemPrompt?: string }[] = [];
    const tool = makeSpawnSubagentTool(
      async (opts) => {
        seen.push(opts);
        return "ok";
      },
      0,
      3,
      50,
    );
    await tool.handler({
      task: "t",
      maxIterations: 5,
      systemPrompt: "be terse",
    });
    expect(seen[0].systemPrompt).toBe("be terse");
  });

  test("depth breach returns an error string, never throws (E20)", async () => {
    let called = false;
    const tool = makeSpawnSubagentTool(
      async () => {
        called = true;
        return "should not run";
      },
      3,
      3,
      50,
    );
    const out = await tool.handler({ task: "t", maxIterations: 5 });
    expect(called).toBe(false);
    expect(out).toContain("max subagent depth reached");
  });
});

describe("subagent runner (§3.8.2, §3.8.5)", () => {
  test("DONE: returns the subagent's finish answer verbatim", async () => {
    const runner = makeSubagentRunner(
      makeConfig(),
      stubClient([finish("done!")]),
      undefined,
    );
    const out = await runner({ task: "t", maxIterations: 10, depth: 1 });
    expect(out).toBe("done!");
  });

  test("CAP_REACHED: returns the last assistant text", async () => {
    // Two iterations of a non-finish tool call, each carrying assistant text.
    const runner = makeSubagentRunner(
      makeConfig({ maxIterations: 2 }),
      stubClient([
        toolCall("1", "read_file", { path: "a" }, "thinking..."),
        toolCall("2", "read_file", { path: "b" }, "still thinking..."),
      ]),
      undefined,
    );
    const out = await runner({ task: "t", maxIterations: 2, depth: 1 });
    expect(out).toBe("still thinking...");
  });

  test("CAP_REACHED with no assistant text returns a fallback note", async () => {
    const runner = makeSubagentRunner(
      makeConfig({ maxIterations: 2 }),
      stubClient([
        toolCall("1", "read_file", { path: "a" }),
        toolCall("2", "read_file", { path: "b" }),
      ]),
      undefined,
    );
    const out = await runner({ task: "t", maxIterations: 2, depth: 1 });
    expect(out).toBe("iteration cap reached");
  });

  test("FAILED: an LLM error is returned as data, not thrown (E18)", async () => {
    const client: LLMClient = {
      async chat() {
        throw new ServerUnreachableError("http://localhost:1");
      },
    };
    const runner = makeSubagentRunner(makeConfig(), client, undefined);
    const out = await runner({ task: "t", maxIterations: 5, depth: 1 });
    expect(out).toContain("subagent failed:");
    expect(out).toContain("Cannot reach llama.cpp server");
  });

  test("typed turn outcome distinguishes cap from plain text (E10 vs E11)", async () => {
    const cfg = makeConfig({ maxIterations: 2 });
    const { registry } = buildToolRegistry(cfg);
    const mkSession = (): Session => ({
      messages: [{ role: "system", content: "sys" }],
      config: cfg,
      lastPromptTokens: null,
    });

    // CAP: two non-finish tool calls exhaust the cap -> kind "cap".
    const capResult = await runTurn(
      mkSession(),
      "t",
      registry,
      {},
      undefined,
      stubClient([
        toolCall("1", "read_file", { path: "a" }, "thinking..."),
        toolCall("2", "read_file", { path: "b" }, "still thinking..."),
      ]),
    );
    expect(capResult.kind).toBe("cap");
    expect(capResult.finished).toBe(false);

    // TEXT: a single plain-text response (no tool calls) -> kind "text".
    const textResult = await runTurn(
      mkSession(),
      "t",
      registry,
      {},
      undefined,
      stubClient([{ content: "just an answer", toolCalls: [], usage: null }]),
    );
    expect(textResult.kind).toBe("text");
    expect(textResult.finished).toBe(false);
    expect(textResult.answer).toBe("just an answer");
  });

  test("emits render events in order (spec §3.8.6)", async () => {
    const events: string[] = [];
    const render = (_depth: number, e: { kind: string }) => events.push(e.kind);
    const runner = makeSubagentRunner(
      makeConfig(),
      stubClient([finish("x")]),
      render,
    );
    await runner({ task: "t", maxIterations: 5, depth: 1 });
    expect(events).toContain("end");
    expect(events[events.length - 1]).toBe("end");
  });
});

describe("concurrency: multiple spawn_subagent calls run in parallel (§3.8.3)", () => {
  test("two spawn calls in one batch overlap", async () => {
    let running = 0;
    let maxRunning = 0;
    const runner = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return "ok";
    };
    const { registry } = createSession(makeConfig());
    const calls: ToolCall[] = [
      {
        id: "a",
        name: "spawn_subagent",
        arguments: { task: "1", maxIterations: 5 },
      },
      {
        id: "b",
        name: "spawn_subagent",
        arguments: { task: "2", maxIterations: 5 },
      },
    ];
    // Re-register a spawn tool backed by the concurrency-tracking runner.
    registry.register(makeSpawnSubagentTool(runner, 0, 3, 50));
    const results = await executeToolCalls(registry, calls, 20000);
    expect(results).toHaveLength(2);
    expect(maxRunning).toBe(2);
  });
});

describe("integration: nested agent loop through createSession (§3.8)", () => {
  test("parent delegates to a subagent and receives its finish answer", async () => {
    // Scripted: parent spawns a subagent; subagent finishes; parent finishes.
    const { server, baseUrl } = createMockServer([
      {
        kind: "toolCalls",
        toolCalls: [
          {
            id: "p1",
            name: "spawn_subagent",
            arguments: { task: "research", maxIterations: 5 },
          },
        ],
      },
      {
        kind: "toolCalls",
        toolCalls: [
          { id: "s1", name: "finish", arguments: { answer: "subagent done" } },
        ],
      },
      {
        kind: "toolCalls",
        toolCalls: [
          { id: "p2", name: "finish", arguments: { answer: "parent done" } },
        ],
      },
    ]);
    const { session, registry } = createSession(makeConfig({ baseUrl }));
    const result = await runTurn(session, "delegate it", registry);
    expect(result.finished).toBe(true);
    expect(result.answer).toBe("parent done");
    // The subagent's finish answer crossed the boundary as a tool result.
    const toolResults = session.messages.filter((m) => m.role === "tool");
    expect(toolResults.some((m) => m.content === "subagent done")).toBe(true);
    server.stop();
  });
});

// --- Mock SSE server (mirrors test/integration.test.ts) ---

type ScriptedResponse =
  | { kind: "content"; content: string }
  | {
      kind: "toolCalls";
      toolCalls: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }[];
    };

function encodeSSE(r: ScriptedResponse): string {
  let sse = "";
  const push = (obj: unknown) => {
    sse += `data: ${JSON.stringify(obj)}\n\n`;
  };
  push({ choices: [{ delta: { role: "assistant" } }] });
  if (r.kind === "content") {
    push({ choices: [{ delta: { content: r.content } }] });
    push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  } else {
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
  }
  push({
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  sse += "data: [DONE]\n\n";
  return sse;
}

function createMockServer(script: ScriptedResponse[]) {
  let callIndex = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        const scripted = script[Math.min(callIndex, script.length - 1)];
        callIndex++;
        return new Response(encodeSSE(scripted), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, baseUrl: `http://localhost:${server.port}` };
}
