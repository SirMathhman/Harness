import { describe, expect, test } from "bun:test";
import {
  accumulate,
  decodeSSE,
  type ChatCompletionChunk,
} from "../src/llm/sse.js";

describe("SSE parser (AC 11, 2)", () => {
  test("decodeSSE parses data lines and ignores [DONE]", () => {
    const text =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      "data: [DONE]\n\n";
    const chunks = decodeSSE(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices?.[0]?.delta?.content).toBe("Hel");
  });

  test("accumulate concatenates content tokens", () => {
    const chunks: ChatCompletionChunk[] = [
      { choices: [{ delta: { content: "Hello " } }] },
      { choices: [{ delta: { content: "world" } }] },
    ];
    const res = accumulate(chunks);
    expect(res.content).toBe("Hello world");
    expect(res.toolCalls).toHaveLength(0);
  });

  test("accumulate reconstructs tool_calls across deltas by index", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
            },
          },
        ],
      },
    ];
    const res = accumulate(chunks);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("read_file");
    expect(res.toolCalls[0].id).toBe("call_1");
    expect(res.toolCalls[0].arguments).toEqual({ path: "a.txt" });
  });

  test("accumulate captures usage from the final chunk", () => {
    const chunks: ChatCompletionChunk[] = [
      { choices: [{ delta: { content: "x" } }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
    ];
    const res = accumulate(chunks);
    expect(res.usage?.prompt_tokens).toBe(10);
    expect(res.usage?.total_tokens).toBe(15);
  });

  test("accumulate handles multiple parallel tool calls", () => {
    const chunks: ChatCompletionChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "a",
                  function: { name: "list_dir", arguments: "{}" },
                },
                {
                  index: 1,
                  id: "b",
                  function: { name: "search", arguments: '{"q":1}' },
                },
              ],
            },
          },
        ],
      },
    ];
    const res = accumulate(chunks);
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0].name).toBe("list_dir");
    expect(res.toolCalls[1].name).toBe("search");
  });
});
