import { describe, expect, test } from "bun:test";
import { buildRequestPayload } from "../src/llm/client.js";
import type { Config, Message } from "../src/types.js";

/** Minimal config; buildRequestPayload only reads model/temperature/parallelToolCalls. */
const config = {
  model: "test-model",
  temperature: 0.7,
  parallelToolCalls: true,
} as Config;

describe("buildRequestPayload wire serialization (spec §1.3.1)", () => {
  test("serializes assistant tool_calls to the OpenAI wire shape", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "abc",
            name: "list_dir",
            arguments: { path: ".", recursive: false },
          },
        ],
      },
    ];
    const payload = buildRequestPayload(config, messages, []);
    const wire = payload.messages as Record<string, unknown>[];
    const toolCalls = wire[0].tool_calls as Record<string, unknown>[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].type).toBe("function");
    expect(toolCalls[0].id).toBe("abc");
    const fn = toolCalls[0].function as Record<string, unknown>;
    expect(fn.name).toBe("list_dir");
    // arguments must be a JSON string on the wire, not a parsed object.
    expect(typeof fn.arguments).toBe("string");
    expect(JSON.parse(fn.arguments as string)).toEqual({
      path: ".",
      recursive: false,
    });
  });

  test("preserves null content on a tool-call-only assistant message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "x", name: "finish", arguments: { answer: "done" } },
        ],
      },
    ];
    const payload = buildRequestPayload(config, messages, []);
    const wire = payload.messages as Record<string, unknown>[];
    expect(wire[0].content).toBeNull();
    expect(wire[0].tool_calls).toHaveLength(1);
  });

  test("passes tool result messages through unchanged", () => {
    const messages: Message[] = [
      {
        role: "tool",
        tool_call_id: "abc",
        name: "list_dir",
        content: ".git/",
      },
    ];
    const payload = buildRequestPayload(config, messages, []);
    const wire = payload.messages as Record<string, unknown>[];
    expect(wire[0]).toEqual({
      role: "tool",
      tool_call_id: "abc",
      name: "list_dir",
      content: ".git/",
    });
  });

  test("passes plain user/assistant text messages through unchanged", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const payload = buildRequestPayload(config, messages, []);
    const wire = payload.messages as Record<string, unknown>[];
    expect(wire[0]).toEqual({ role: "user", content: "hello" });
    expect(wire[1]).toEqual({ role: "assistant", content: "hi there" });
  });
});
