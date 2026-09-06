import { describe, expect, test } from "bun:test";
import { AgentServer } from "../src/server/server.js";
import { modelGraph, profileGraph } from "./helpers.js";
import type { ServerEvent } from "../src/server/protocol.js";

/** A scripted LLM response (mirrors test/integration.test.ts). */
type ScriptedResponse =
  | { kind: "content"; content: string }
  | {
      kind: "toolCalls";
      toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
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
  return { baseUrl: `http://localhost:${server.port}`, stop: () => server.stop() };
}

/** Start an AgentServer over a graph; resolves the bound port. */
async function startServer(opts: {
  graph: ReturnType<typeof modelGraph>;
  profile?: string;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = new AgentServer({
    graph: opts.graph,
    profile: opts.profile ?? "Agent",
    lastModel: null,
    statePath: ":memory:",
    staticDir: null,
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
    const snap = await client.waitFor((e) => (e.type === "snapshot" ? e : undefined));
    expect(snap.state.activeProfile).toBe("Agent");
    expect(snap.history).toEqual([]);
    client.close();
    await stop();
  });

  test("task round-trip streams token events and ends with turnEnd (AC 3, 7)", async () => {
    const { baseUrl } = mockBackend([{ kind: "content", content: "Hello mock" }]);
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
    expect(client.events.filter((e) => e.type === "token").length).toBeGreaterThan(0);

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