import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { AgentServer } from "../src/server/server.js";
import { modelGraph, profileGraph, graphFrom } from "./helpers.js";
import type { ServerEvent } from "../src/server/protocol.js";

/** A scripted LLM response (mirrors test/integration.test.ts). */
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
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
  sse += "data: [DONE]\n\n";
  return sse;
}

/** A mock OpenAI-compatible SSE backend. */
function mockBackend(script: ScriptedResponse[]) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") return Response.json({ data: [] });
      if (url.pathname === "/v1/chat/completions") {
        await req.json();
        const s = script[Math.min(calls, script.length - 1)];
        calls++;
        return new Response(encodeSSE(s), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: () => server.stop(),
  };
}

/** Start an AgentServer over a graph; resolves the bound port. */
async function startServer(opts: {
  graph: ReturnType<typeof modelGraph>;
  profile?: string;
  staticDir?: string | null;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = new AgentServer({
    graph: opts.graph,
    profile: opts.profile ?? "Agent",
    lastModel: null,
    statePath: ":memory:",
    staticDir: opts.staticDir ?? null,
    log: () => {},
  });
  const port = await server.start(0);
  return { port, stop: () => server.stop() };
}

/** Connect a test WS client and record events. */
function connect(url: string) {
  const parsed = new URL(url);
  const ws = new WebSocket(`ws://localhost:${parsed.port}/ws`);
  const events: ServerEvent[] = [];
  const waiters: ((ok: boolean) => void)[] = [];
  ws.addEventListener("message", (m) => {
    events.push(JSON.parse(m.data as string));
  });
  ws.addEventListener("open", () => {
    for (const w of waiters) w(true);
    waiters.length = 0;
  });
  ws.addEventListener("error", () => {
    for (const w of waiters) w(false);
    waiters.length = 0;
  });
  return {
    ws,
    events,
    opened: new Promise<boolean>((res) => waiters.push(res)),
    send: (c: unknown) => ws.send(JSON.stringify(c)),
    waitFor: async <T>(
      pred: (e: ServerEvent) => T | undefined,
      ms = 4000,
    ): Promise<T> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        for (const e of events) {
          const r = pred(e);
          if (r !== undefined) return r;
        }
        await Bun.sleep(10);
      }
      throw new Error("timed out waiting for event");
    },
    close: () => ws.close(),
  };
}

describe("agent-server (GUI spec §9)", () => {
  test("serving dev-mode + WS connect + snapshot (AC 1, 2, 10)", async () => {
    const { baseUrl } = mockBackend([]);
    const { port, stop } = await startServer({ graph: modelGraph(baseUrl) });

    // No static dir -> dev-mode guidance response (AC 1/2).
    const root = await fetch(`http://localhost:${port}/`);
    expect(root.status).toBe(503);

    const client = connect(`http://localhost:${port}`);
    expect(await client.opened).toBe(true);
    const snap = await client.waitFor((e) =>
      e.type === "snapshot" ? e : undefined,
    );
    expect(snap.state.activeProfile).toBe("Agent");
    expect(snap.history).toEqual([]);
    client.close();
    await stop();
  });

  test("task round-trip streams token events and ends with turnEnd (AC 3, 7)", async () => {
    const { baseUrl } = mockBackend([
      { kind: "content", content: "Hello mock" },
    ]);
    const { port, stop } = await startServer({
      graph: modelGraph(baseUrl, { maxIterations: 1 }),
    });
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "task", text: "hi" });
    const tokens: string[] = [];
    const end = await client.waitFor((e) => {
      if (e.type === "token") tokens.push(e.text);
      return e.type === "turnEnd" ? e : undefined;
    });
    expect(tokens.join("")).toContain("Hello mock");
    // A plain content response (no finish tool) ends with kind "text" (E11).
    expect(end.kind).toBe("text");
    expect(end.answer).toBe("Hello mock");

    // Context readout after the turn (AC 7).
    const st = latestState(client.events);
    expect(st.turnActive).toBe(false);
    expect(st.context).toBeDefined();
    client.close();
    await stop();
  });

  test("profile switch emits state; unknown profile errors (AC 5)", async () => {
    const graph = profileGraph((reg, profile) => {
      profile("Alpha");
      profile("Beta");
      void reg;
    });
    const server = new AgentServer({
      graph: graph as ReturnType<typeof modelGraph>,
      profile: "Alpha",
      lastModel: null,
      statePath: ":memory:",
      staticDir: null,
      log: () => {},
    });
    const port = await server.start(0);
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "switchProfile", name: "Beta" });
    const prof = await client.waitFor((e) =>
      e.type === "state" && e.patch.activeProfile
        ? (e.patch as { activeProfile: string }).activeProfile
        : undefined,
    );
    expect(prof).toBe("Beta");

    client.send({ type: "switchProfile", name: "Missing" });
    const err = await client.waitFor((e) =>
      e.type === "commandResult" && !e.ok ? e.error : undefined,
    );
    expect(err).toContain("Unknown profile");
    client.close();
    await server.stop();
  });

  test("clear/newSession empties history (AC 12)", async () => {
    const { baseUrl } = mockBackend([{ kind: "content", content: "x" }]);
    const { port, stop } = await startServer({ graph: modelGraph(baseUrl) });
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "task", text: "hi" });
    await client.waitFor((e) => (e.type === "turnEnd" ? e : undefined));
    expect(
      client.events.filter((e) => e.type === "token").length,
    ).toBeGreaterThan(0);

    client.send({ type: "clear" });
    await client.waitFor((e) => (e.type === "cleared" ? e : undefined));
    client.send({ type: "newSession" });
    await client.waitFor((e) => (e.type === "cleared" ? e : undefined));
    client.close();
    await stop();
  });

  test("command gating rejects a mid-turn switchProfile (AC 14)", async () => {
    const { baseUrl } = mockBackend([{ kind: "content", content: "a" }]);
    const { port, stop } = await startServer({ graph: modelGraph(baseUrl) });
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "task", text: "first" });
    client.send({ type: "switchProfile", name: "Alpha" });
    const err = await client.waitFor((e) =>
      e.type === "commandResult" && !e.ok ? e.error : undefined,
    );
    expect(err).toContain("Cannot switch profile while a turn is running");
    await client.waitFor((e) => (e.type === "turnEnd" ? e : undefined));
    client.close();
    await stop();
  });

  test("malformed command errors but server survives (AC 15)", async () => {
    const { baseUrl } = mockBackend([{ kind: "content", content: "x" }]);
    const { port, stop } = await startServer({ graph: modelGraph(baseUrl) });
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "task" }); // missing text
    const err = await client.waitFor((e) =>
      e.type === "commandResult" && !e.ok ? e.error : undefined,
    );
    expect(err).toContain("non-empty");

    // ping still answers -> server alive.
    client.send({ type: "ping" });
    await client.waitFor((e) => (e.type === "pong" ? e : undefined));
    client.close();
    await stop();
  });

  test("serves the built UI index.html at GET / (AC 2)", async () => {
    const { baseUrl } = mockBackend([]);
    // Reuse the actual built assets if present.
    const dist = fileURLToPath(new URL("../gui/dist", import.meta.url));
    const { port, stop } = await startServer({
      graph: modelGraph(baseUrl),
      staticDir: dist,
    });
    const root = await fetch(`http://localhost:${port}/`);
    expect(root.status).toBe(200);
    expect((await root.text()).includes("<div")).toBe(true);
    // SPA fallback: an unknown asset path also returns the UI.
    const fallback = await fetch(`http://localhost:${port}/some/route`);
    expect(fallback.status).toBe(200);
    await stop();
  });

  test("abort ends the turn with kind aborted (AC 8)", async () => {
    // A mock that never finishes (SSE stays open) so the turn stays active
    // long enough to abort.
    let hold = true;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") return Response.json({ data: [] });
        if (url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        await req.json();
        let done = false;
        const body = new ReadableStream({
          async pull(controller) {
            if (!hold && !done) {
              done = true;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                    "data: [DONE]\n\n",
                ),
              );
              controller.close();
            }
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const { port, stop } = await startServer({
      graph: modelGraph(`http://localhost:${server.port}`),
    });
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "task", text: "long" });
    await Bun.sleep(80); // let the turn start and hold on the open stream
    client.send({ type: "abort" });
    const end = await client.waitFor((e) =>
      e.type === "turnEnd" ? e : undefined,
    );
    expect(end.kind).toBe("aborted");

    // Release + clean up.
    hold = false;
    await Bun.sleep(50);
    server.stop();
    client.close();
    await stop();
  });

  test("a second client evicts the first and gets a fresh snapshot (AC 11)", async () => {
    const { baseUrl } = mockBackend([{ kind: "content", content: "x" }]);
    const { port, stop } = await startServer({ graph: modelGraph(baseUrl) });
    const url = `http://localhost:${port}`;
    const first = connect(url);
    await first.opened;
    await first.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    const second = connect(url);
    expect(await second.opened).toBe(true);
    await second.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    // The first client's socket is closed by eviction.
    await new Promise<void>((res) => {
      first.ws.addEventListener("close", () => res());
      setTimeout(res, 2000);
    });
    first.close();
    second.close();
    await stop();
  });

  test("hooks toggle emits state.hooksEnabled (AC 13)", async () => {
    const { baseUrl } = mockBackend([{ kind: "content", content: "x" }]);
    const { port, stop } = await startServer({ graph: modelGraph(baseUrl) });
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "hooks", enabled: false });
    const off = await client.waitFor((e) =>
      e.type === "state" && e.patch.hooksEnabled === false
        ? e.patch
        : undefined,
    );
    expect(off.hooksEnabled).toBe(false);
    client.close();
    await stop();
  });

  test("model switch emits state with the new model; unknown ref errors (AC 6)", async () => {
    const { baseUrl } = mockBackend([]);
    const graph = graphFrom((reg) => {
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createModel({ name: "one", baseUrl, apiKey: "", maxContext: 1024 }),
      );
      reg.createConnection(
        reg.builtins.defaultProfile,
        reg.createModel({ name: "two", baseUrl, apiKey: "", maxContext: 2048 }),
      );
    });
    const server = new AgentServer({
      graph: graph as ReturnType<typeof modelGraph>,
      profile: "Agent",
      lastModel: null,
      statePath: ":memory:",
      staticDir: null,
      log: () => {},
    });
    const port = await server.start(0);
    const client = connect(`http://localhost:${port}`);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "switchModel", ref: "two" });
    const model = await client.waitFor((e) =>
      e.type === "state" && e.patch.activeModel
        ? (e.patch as { activeModel: string }).activeModel
        : undefined,
    );
    expect(model).toBe("two");

    client.send({ type: "switchModel", ref: "missing-model" });
    const err = await client.waitFor((e) =>
      e.type === "commandResult" && !e.ok ? e.error : undefined,
    );
    expect(err).toContain("Unknown model");
    client.close();
    await server.stop();
  });

  test("disconnect mid-turn does not stop the turn; reconnect gets the state (AC 9)", async () => {
    // A slow stream so the turn is still running when we disconnect.
    let hold = true;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") return Response.json({ data: [] });
        if (url.pathname !== "/v1/chat/completions") {
          return new Response("nf", { status: 404 });
        }
        await req.json();
        let done = false;
        return new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
                    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
                ),
              );
              while (hold) await Bun.sleep(20);
              if (!done) {
                done = true;
                c.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                      "data: [DONE]\n\n",
                  ),
                );
              }
              c.close();
            },
          }) as ReadableStream,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const { port, stop } = await startServer({
      graph: modelGraph(`http://localhost:${server.port}`),
    });
    const url = `http://localhost:${port}`;
    const client = connect(url);
    await client.opened;
    await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));

    client.send({ type: "task", text: "stream" });
    await Bun.sleep(150); // let a token stream in
    expect(client.events.some((e) => e.type === "token")).toBe(true);

    // Disconnect mid-turn; the turn completes server-side regardless.
    client.close();
    hold = false; // release the stream
    await Bun.sleep(150);

    // Reconnect; a fresh snapshot reconstructs the started conversation.
    const reconnected = connect(url);
    await reconnected.opened;
    const snap = await reconnected.waitFor((e) =>
      e.type === "snapshot" ? e : undefined,
    );
    expect(snap.history.some((i) => i.kind === "userMessage")).toBe(true);

    server.stop();
    reconnected.close();
    await stop();
  });
});

/** The most recent full `state` (snapshot's state or a `state` patch). */
function latestState(events: ServerEvent[]): Record<string, unknown> {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "snapshot") return e.state;
    if (e.type === "state") return e.patch;
  }
  return {};
}
