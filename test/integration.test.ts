import { describe, expect, test } from "bun:test";
import { runTurn } from "../src/agent/loop.js";
import { createSession } from "../src/agent/session.js";
import { ServerUnreachableError } from "../src/llm/errors.js";
import { modelGraph } from "./helpers.js";
import type { Usage } from "../src/types.js";

/** A scripted LLM response. */
type ScriptedResponse =
  | { kind: "content"; content: string; usage?: Usage }
  | {
      kind: "toolCalls";
      toolCalls: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }[];
      usage?: Usage;
    };

/** Encode a scripted response as an SSE body. */
function encodeSSE(r: ScriptedResponse): string {
  const usage: Usage = r.usage ?? {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  };
  let sse = "";
  const push = (obj: unknown) => {
    sse += `data: ${JSON.stringify(obj)}\n\n`;
  };
  push({ choices: [{ delta: { role: "assistant" } }] });
  if (r.kind === "content") {
    const half = Math.ceil(r.content.length / 2);
    const parts =
      half > 0 ? [r.content.slice(0, half), r.content.slice(half)] : [""];
    for (const p of parts)
      if (p.length) push({ choices: [{ delta: { content: p } }] });
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
  push({ choices: [], usage });
  sse += "data: [DONE]\n\n";
  return sse;
}

/** Start a mock OpenAI-compatible SSE server with a scripted response sequence. */
function createMockServer(script: ScriptedResponse[]) {
  const requests: Record<string, unknown>[] = [];
  let callIndex = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as Record<string, unknown>;
        requests.push(body);
        const scripted = script[Math.min(callIndex, script.length - 1)];
        callIndex++;
        return new Response(encodeSSE(scripted), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    server,
    requests,
    baseUrl: `http://localhost:${server.port}`,
  };
}

/** A session whose default profile points at the mock server. */
function sessionFor(baseUrl: string, maxIterations: number | null = null) {
  return createSession({ graph: modelGraph(baseUrl, { maxIterations }) });
}

describe("integration: full agent loop (AC 2, 3, 5, 6, 7, 11)", () => {
  test("happy path: model calls finish directly (AC 2)", async () => {
    const { server, baseUrl } = createMockServer([
      {
        kind: "toolCalls",
        toolCalls: [
          { id: "1", name: "finish", arguments: { answer: "All done." } },
        ],
      },
    ]);
    const { session, registry } = sessionFor(baseUrl);
    const result = await runTurn(session, "do the thing", registry);
    expect(result.finished).toBe(true);
    expect(result.answer).toBe("All done.");
    server.stop();
  });

  test("tool round-trip: read_file then finish (AC 2, 11)", async () => {
    const { server, baseUrl, requests } = createMockServer([
      {
        kind: "toolCalls",
        toolCalls: [{ id: "1", name: "list_dir", arguments: { path: "." } }],
      },
      {
        kind: "toolCalls",
        toolCalls: [
          { id: "2", name: "finish", arguments: { answer: "listed" } },
        ],
      },
    ]);
    const { session, registry } = sessionFor(baseUrl);
    const result = await runTurn(session, "list files", registry);
    expect(result.finished).toBe(true);
    // The second request must include the tool result from the first.
    const secondMessages = requests[1].messages as { role: string }[];
    expect(secondMessages.some((m) => m.role === "tool")).toBe(true);
    server.stop();
  });

  test("multi-turn history is retained (AC 3)", async () => {
    const { server, baseUrl, requests } = createMockServer([
      {
        kind: "toolCalls",
        toolCalls: [{ id: "1", name: "finish", arguments: { answer: "one" } }],
      },
      {
        kind: "toolCalls",
        toolCalls: [{ id: "2", name: "finish", arguments: { answer: "two" } }],
      },
    ]);
    const { session, registry } = sessionFor(baseUrl);
    await runTurn(session, "first task", registry);
    await runTurn(session, "second task", registry);
    const firstLen = (requests[0].messages as unknown[]).length;
    const secondLen = (requests[1].messages as unknown[]).length;
    expect(secondLen).toBeGreaterThan(firstLen);
    server.stop();
  });

  test("self-correction: bad args fed back, loop continues (AC 5)", async () => {
    const { server, baseUrl, requests } = createMockServer([
      // First: read_file with a missing required arg -> dispatch returns an error.
      {
        kind: "toolCalls",
        toolCalls: [{ id: "1", name: "read_file", arguments: {} }],
      },
      // Second: model corrects and finishes.
      {
        kind: "toolCalls",
        toolCalls: [
          { id: "2", name: "finish", arguments: { answer: "fixed" } },
        ],
      },
    ]);
    const { session, registry } = sessionFor(baseUrl);
    const result = await runTurn(session, "read a file", registry);
    expect(result.finished).toBe(true);
    // The tool result fed back must be the validation error (no abort).
    const secondMessages = requests[1].messages as {
      role: string;
      content: string | null;
    }[];
    const toolMsg = secondMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("Invalid arguments");
    server.stop();
  });

  test("tool failure does not abort the turn (AC 6)", async () => {
    const { server, baseUrl } = createMockServer([
      // read_file on a missing file -> handler returns an error string.
      {
        kind: "toolCalls",
        toolCalls: [
          {
            id: "1",
            name: "read_file",
            arguments: { path: "/no/such/file.txt" },
          },
        ],
      },
      {
        kind: "toolCalls",
        toolCalls: [
          { id: "2", name: "finish", arguments: { answer: "handled" } },
        ],
      },
    ]);
    const { session, registry } = sessionFor(baseUrl);
    const result = await runTurn(session, "read missing", registry);
    expect(result.finished).toBe(true);
    expect(result.answer).toBe("handled");
    server.stop();
  });

  test("server-down aborts the turn (AC 7)", async () => {
    // Grab a port, then close the server so the port is refused.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadUrl = `http://localhost:${probe.port}`;
    probe.stop();
    const { session, registry } = sessionFor(deadUrl);
    await expect(runTurn(session, "hi", registry)).rejects.toThrow(
      ServerUnreachableError,
    );
  });

  test("maxIterations cap stops the loop (AC 5 / E10)", async () => {
    const { server, baseUrl } = createMockServer([
      // Always request a tool call, never finish.
      {
        kind: "toolCalls",
        toolCalls: [{ id: "1", name: "list_dir", arguments: { path: "." } }],
      },
    ]);
    const { session, registry } = sessionFor(baseUrl, 2);
    const result = await runTurn(session, "loop forever", registry);
    expect(result.finished).toBe(false);
    expect(result.answer).toContain("maxIterations");
    server.stop();
  });
});
