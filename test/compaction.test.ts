import { describe, expect, test } from "bun:test";
import {
  shouldCompact,
  findKeepBoundary,
  partitionForCompaction,
  buildRecapRequest,
  applyRecap,
  truncateCompaction,
} from "../src/context/compaction.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { runTurn } from "../src/agent/loop.js";
import { createSession } from "../src/agent/session.js";
import { LLMHttpError } from "../src/llm/errors.js";
import type { LLMClient } from "../src/llm/client.js";
import { graphFrom } from "./helpers.js";
import type { Config, Message } from "../src/types.js";

const cfg: Config = { ...DEFAULT_CONFIG, model: "m" };

describe("compaction (AC 8)", () => {
  test("shouldCompact is false below threshold", () => {
    expect(shouldCompact(100, cfg)).toBe(false);
  });

  test("shouldCompact is true above threshold", () => {
    // threshold 0.8 * 8192 = 6553.6
    expect(shouldCompact(7000, cfg)).toBe(true);
  });

  test("shouldCompact is false when tokens unknown", () => {
    expect(shouldCompact(null, cfg)).toBe(false);
  });

  test("findKeepBoundary keeps the last N messages", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "2" },
      { role: "assistant", content: "a2" },
    ];
    expect(findKeepBoundary(msgs, 2)).toBe(3);
  });

  test("findKeepBoundary does not split tool_calls from results", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", name: "read_file", arguments: {} }],
      },
      { role: "tool", tool_call_id: "1", name: "read_file", content: "r1" },
      { role: "tool", tool_call_id: "1", name: "read_file", content: "r2" },
      { role: "assistant", content: "done" },
    ];
    // keep=2 naively lands the boundary on a `tool` message (index 4), which
    // would orphan that result from its tool_calls message. The walk-back must
    // move the boundary to the assistant tool_calls message (index 2).
    const boundary = findKeepBoundary(msgs, 2);
    expect(boundary).toBe(2);
    // The kept slice must not start with a `tool` message.
    expect(msgs[boundary].role).not.toBe("tool");
  });

  test("partitionForCompaction splits system/older/recent", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "2" },
      { role: "assistant", content: "a2" },
    ];
    const { system, older, recent } = partitionForCompaction(msgs, {
      ...cfg,
      compactKeepMessages: 2,
    });
    expect(system).toHaveLength(1);
    expect(recent).toHaveLength(2);
    expect(older).toHaveLength(2);
  });

  test("applyRecap rebuilds [system, recap-as-system, recent]", () => {
    const system: Message[] = [{ role: "system", content: "s" }];
    const recent: Message[] = [{ role: "user", content: "2" }];
    const out = applyRecap(system, "the recap", recent);
    expect(out[0].role).toBe("system");
    expect(out[0]).toBe(system[0]); // system carried over verbatim
    expect(out[1].role).toBe("system");
    expect(out[1].content).toBe("Summary of prior work:\nthe recap");
    expect(out[2]).toBe(recent[0]); // recent carried over verbatim
  });

  test("buildRecapRequest appends one instruction to the full history", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      { role: "assistant", content: "a1" },
    ];
    const out = buildRecapRequest(msgs, { ...cfg, compactKeepMessages: 6 });
    // The prefix is the existing conversation, verbatim and in order.
    expect(out.slice(0, msgs.length)).toEqual(msgs);
    // Exactly one appended instruction message.
    expect(out).toHaveLength(msgs.length + 1);
    const instruction = out[out.length - 1];
    expect(instruction.role).toBe("user");
    // Count-based delimiting: interpolates compactKeepMessages.
    expect(instruction.content).toContain("6");
    expect(instruction.content?.toLowerCase()).toContain("summarize");
    // The input array is not mutated (the instruction is transient).
    expect(msgs).toHaveLength(3);
  });

  test("truncateCompaction drops older messages", () => {
    const msgs: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "2" },
      { role: "assistant", content: "a2" },
    ];
    const out = truncateCompaction(msgs, { ...cfg, compactKeepMessages: 2 });
    expect(out).toHaveLength(3); // system + 2 recent
    expect(out[0].role).toBe("system");
  });
});

describe("compaction in the agent loop (spec v0.2.0 §3.3–3.5)", () => {
  // A session whose tiny window (maxContext 10, threshold 0.5) makes the very
  // first prompt-token count exceed the threshold, so compaction runs before
  // the second LLM call.
  function compactingSession() {
    return createSession({
      graph: graphFrom((reg) => {
        reg.setRuntime({ compactThreshold: 0.5, compactKeepMessages: 2 });
        reg.createConnection(
          reg.builtins.defaultProfile,
          reg.createModel({
            name: "test-model",
            baseUrl: "http://localhost:8080",
            apiKey: "",
            maxContext: 10,
          }),
        );
      }),
    });
  }

  const usage = { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 };

  test("recap call reuses the cached conversation + advertised tools (AC 3)", async () => {
    const { session, registry } = compactingSession();
    const calls: { messages: Message[]; tools: unknown[] }[] = [];
    const client: LLMClient = {
      async chat(opts) {
        // Snapshot: opts.messages is a live reference to session.messages.
        calls.push({ messages: [...opts.messages], tools: opts.tools });
        if (calls.length === 1) {
          // First main call: report a big prompt_tokens so compaction fires.
          return {
            content: "",
            toolCalls: [
              { id: "t1", name: "list_dir", arguments: { path: "." } },
            ],
            usage,
          };
        }
        if (calls.length === 2)
          return { content: "the summary", toolCalls: [], usage: null };
        return {
          content: "",
          toolCalls: [
            { id: "f1", name: "finish", arguments: { answer: "done" } },
          ],
          usage: null,
        };
      },
    };
    await runTurn(session, "task", registry, {}, undefined, client);
    expect(calls).toHaveLength(3);
    // The recap request is the full conversation (as it stood before the
    // recap, i.e. including the tool result) plus one appended user
    // instruction — not a fresh transcript.
    const recapMessages = calls[1].messages;
    const preRecap = calls[0].messages.length + 2; // + assistant tool_calls + tool result
    expect(recapMessages.length).toBe(preRecap + 1);
    expect(recapMessages.slice(0, preRecap).slice(0, -2)).toEqual(
      calls[0].messages,
    );
    const instruction = recapMessages[recapMessages.length - 1];
    expect(instruction.role).toBe("user");
    expect(instruction.content).toContain("2"); // compactKeepMessages
    // The recap call sends the same advertised tools as the main call.
    expect(calls[1].tools).toEqual(calls[0].tools);
    // The instruction is transient: not persisted to session.messages.
    expect(session.messages).not.toContain(instruction);
  });

  test("successful recap replaces history with [system, recap-system, recent] (AC 5)", async () => {
    const { session, registry } = compactingSession();
    let i = 0;
    const client: LLMClient = {
      async chat() {
        i++;
        if (i === 1)
          return {
            content: "",
            toolCalls: [
              { id: "t1", name: "list_dir", arguments: { path: "." } },
            ],
            usage,
          };
        if (i === 2)
          return { content: "the summary", toolCalls: [], usage: null };
        return {
          content: "",
          toolCalls: [
            { id: "f1", name: "finish", arguments: { answer: "done" } },
          ],
          usage: null,
        };
      },
    };
    await runTurn(session, "task", registry, {}, undefined, client);
    const roles = session.messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    const recapMsg = session.messages[1];
    expect(recapMsg.role).toBe("system");
    expect(recapMsg.content).toBe("Summary of prior work:\nthe summary");
    // The recent tail is preserved verbatim after the recap.
    expect(session.messages[session.messages.length - 1].role).toBe("tool");
  });

  test("empty recap falls back to truncation (AC 6)", async () => {
    const { session, registry } = compactingSession();
    let i = 0;
    const client: LLMClient = {
      async chat() {
        i++;
        if (i === 1)
          return {
            content: "",
            toolCalls: [
              { id: "t1", name: "list_dir", arguments: { path: "." } },
            ],
            usage,
          };
        if (i === 2) return { content: "   \n  ", toolCalls: [], usage: null };
        return {
          content: "",
          toolCalls: [
            { id: "f1", name: "finish", arguments: { answer: "done" } },
          ],
          usage: null,
        };
      },
    };
    await runTurn(session, "task", registry, {}, undefined, client);
    // Truncated: no recap message, no older messages — just system + recent.
    expect(
      session.messages.some((m) =>
        m.content?.includes("Summary of prior work"),
      ),
    ).toBe(false);
    expect(session.messages.length).toBeLessThan(6);
  });

  test("recap tool_calls are ignored; content is used (AC 8)", async () => {
    const { session, registry } = compactingSession();
    let i = 0;
    const client: LLMClient = {
      async chat() {
        i++;
        if (i === 1)
          return {
            content: "",
            toolCalls: [
              { id: "t1", name: "list_dir", arguments: { path: "." } },
            ],
            usage,
          };
        if (i === 2)
          return {
            content: "the summary",
            toolCalls: [
              { id: "r1", name: "list_dir", arguments: { path: "." } },
            ],
            usage: null,
          };
        return {
          content: "",
          toolCalls: [
            { id: "f1", name: "finish", arguments: { answer: "done" } },
          ],
          usage: null,
        };
      },
    };
    await runTurn(session, "task", registry, {}, undefined, client);
    const recapMsg = session.messages[1];
    expect(recapMsg.content).toBe("Summary of prior work:\nthe summary");
    // The recap's tool call was not executed: no extra tool result for "r1".
    expect(session.messages.some((m) => m.tool_call_id === "r1")).toBe(false);
  });

  test("LLMError from the recap call aborts the turn (AC 7)", async () => {
    const { session, registry } = compactingSession();
    let i = 0;
    const client: LLMClient = {
      async chat() {
        i++;
        if (i === 1)
          return {
            content: "",
            toolCalls: [
              { id: "t1", name: "list_dir", arguments: { path: "." } },
            ],
            usage,
          };
        throw new LLMHttpError(500, "boom");
      },
    };
    await expect(
      runTurn(session, "task", registry, {}, undefined, client),
    ).rejects.toThrow(LLMHttpError);
  });

  test("non-LLMError from the recap call falls back to truncation (AC 7)", async () => {
    const { session, registry } = compactingSession();
    let i = 0;
    const client: LLMClient = {
      async chat() {
        i++;
        if (i === 1)
          return {
            content: "",
            toolCalls: [
              { id: "t1", name: "list_dir", arguments: { path: "." } },
            ],
            usage,
          };
        if (i === 2) throw new Error("unexpected");
        return {
          content: "",
          toolCalls: [
            { id: "f1", name: "finish", arguments: { answer: "done" } },
          ],
          usage: null,
        };
      },
    };
    const result = await runTurn(
      session,
      "task",
      registry,
      {},
      undefined,
      client,
    );
    expect(result.finished).toBe(true);
    expect(
      session.messages.some((m) =>
        m.content?.includes("Summary of prior work"),
      ),
    ).toBe(false);
  });

  test("recap output is streamed to the user (AC 4)", async () => {
    const { session, registry } = compactingSession();
    const tokens: string[] = [];
    let i = 0;
    const client: LLMClient = {
      async chat(opts) {
        i++;
        if (i === 1)
          return {
            content: "",
            toolCalls: [
              { id: "t1", name: "list_dir", arguments: { path: "." } },
            ],
            usage,
          };
        if (i === 2) {
          opts.onToken?.("sum");
          opts.onToken?.("mary");
          return { content: "summary", toolCalls: [], usage: null };
        }
        return {
          content: "",
          toolCalls: [
            { id: "f1", name: "finish", arguments: { answer: "done" } },
          ],
          usage: null,
        };
      },
    };
    await runTurn(
      session,
      "task",
      registry,
      { onToken: (t) => tokens.push(t) },
      undefined,
      client,
    );
    expect(tokens).toContain("sum");
    expect(tokens).toContain("mary");
  });
});
