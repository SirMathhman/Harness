import type { LLMResponse, ToolCall, Usage } from "../types.js";

/** A single OpenAI chat-completions stream chunk (subset we care about). */
export interface ChatCompletionChunk {
  choices?: {
    delta?: {
      role?: string;
      content?: string | null;
      /** Reasoning/thinking tokens (e.g. Qwen3 via llama.cpp). */
      reasoning_content?: string | null;
      tool_calls?: StreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
}

/** A tool-call delta within a chunk (accumulated by `index`). */
export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Parse a complete SSE text payload into an array of chunk objects.
 * Handles `data:` lines, multi-line events, and the `[DONE]` sentinel.
 * Used by tests and as the core of the streaming reader.
 */
export function decodeSSE(text: string): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [];
  // SSE events are separated by blank lines; each `data:` line carries a JSON
  // payload. We split on newlines and accumulate `data:` content per event.
  const lines = text.split(/\r?\n/);
  let buffer = "";
  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer === "[DONE]") {
      buffer = "";
      return;
    }
    try {
      chunks.push(JSON.parse(buffer) as ChatCompletionChunk);
    } catch {
      // Ignore malformed data lines (defensive).
    }
    buffer = "";
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trimStart();
      buffer = buffer ? buffer + payload : payload;
    }
    // Other SSE fields (event:, id:, comments) are ignored.
  }
  flush();
  return chunks;
}

/**
 * Stream chunks from a fetch response body (a ReadableStream of bytes).
 * Yields one ChatCompletionChunk per SSE `data:` event.
 */
export async function* streamSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete events (terminated by a blank line).
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const eventText = buffer.slice(0, sep);
        const match = buffer.match(/\r?\n\r?\n/);
        buffer = buffer.slice(sep + (match ? match[0].length : 2));
        for (const chunk of decodeSSE(eventText)) yield chunk;
      }
    }
    // Flush any trailing event without a terminating blank line.
    if (buffer.trim().length > 0) {
      for (const chunk of decodeSSE(buffer)) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Accumulate a sequence of stream chunks into a final LLMResponse.
 * - Concatenates assistant text content.
 * - Accumulates tool_calls by `index`, reconstructing `arguments` JSON.
 * - Captures `usage` from the last chunk that provides it.
 */
export function accumulate(chunks: Iterable<ChatCompletionChunk>): LLMResponse {
  let content = "";
  const ids = new Map<number, string>();
  const names = new Map<number, string>();
  const argFragments = new Map<number, string>();
  let usage: Usage | null = null;

  for (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta) {
      if (typeof delta.content === "string") content += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.id) ids.set(idx, tc.id);
          if (tc.function?.name) {
            names.set(idx, (names.get(idx) ?? "") + tc.function.name);
          }
          if (tc.function?.arguments) {
            // Arguments arrive as incremental JSON string fragments.
            argFragments.set(
              idx,
              (argFragments.get(idx) ?? "") + tc.function.arguments,
            );
          }
        }
      }
    }
    if (chunk.usage) usage = chunk.usage;
  }

  // Finalize tool calls: parse accumulated argument strings into objects.
  const indices = [...argFragments.keys(), ...names.keys(), ...ids.keys()];
  const unique = [...new Set(indices)].sort((a, b) => a - b);
  const ordered: ToolCall[] = unique.map((idx) => {
    const raw = argFragments.get(idx) ?? "";
    let args: Record<string, unknown> = {};
    if (raw.trim().length > 0) {
      try {
        args = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Leave as empty object; the dispatch layer will report bad args.
        args = {};
      }
    }
    return {
      id: ids.get(idx) ?? "",
      name: names.get(idx) ?? "",
      arguments: args,
    };
  });

  return { content, toolCalls: ordered, usage };
}
