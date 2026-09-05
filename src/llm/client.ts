import type { Config, LLMResponse, Message, Tool } from "../types.js";
import {
  LLMHttpError,
  LLMTimeoutError,
  ServerUnreachableError,
} from "./errors.js";
import { accumulate, streamSSE } from "./sse.js";

/** Callback invoked for each assistant text token as it streams in. */
export type TokenCallback = (token: string) => void;

/** Options for a single LLM call. */
export interface LLMCallOptions {
  config: Config;
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
  onToken?: TokenCallback;
  /** Request timeout in ms (E4). Defaults to a generous value. */
  timeoutMs?: number;
}

/**
 * Port for the LLM backend (spec §1.3). The agent loop depends on this
 * abstraction rather than the concrete `chatCompletion`, so it can be unit
 * tested with a fake client and swapped for other backends.
 */
export interface LLMClient {
  chat(opts: LLMCallOptions): Promise<LLMResponse>;
}

/** The default client, backed by a generic OpenAI-compatible endpoint. */
export const defaultLLMClient: LLMClient = {
  chat: (opts) => chatCompletion(opts),
};

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Build the /v1/chat/completions request payload (spec §1.3.1).
 */
export function buildRequestPayload(
  config: Config,
  messages: Message[],
  tools: Tool[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature,
    tool_choice: "auto",
    parallel_tool_calls: config.parallelToolCalls,
    // Ask the server to include a usage chunk at the end of the stream so
    // compaction can read prompt_tokens (spec §3.5).
    stream_options: { include_usage: true },
  };
  if (tools.length > 0) {
    payload.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
  return payload;
}

/**
 * Call a generic OpenAI-compatible endpoint and stream the response.
 *
 * - Emits assistant text tokens via `onToken` as they arrive.
 * - Accumulates tool_calls and usage into a final LLMResponse.
 * - Throws ServerUnreachableError (E3), LLMTimeoutError (E4), or
 *   LLMHttpError (E5) on connectivity problems. No retries.
 */
export async function chatCompletion(
  opts: LLMCallOptions,
): Promise<LLMResponse> {
  const { config, messages, tools, signal, onToken } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = `${config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  // Combine external abort with a request timeout (E4).
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeoutHandle = setTimeout(
    () => controller.abort("timeout"),
    timeoutMs,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestPayload(config, messages, tools)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onExternalAbort);
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      throw new LLMTimeoutError(timeoutMs);
    }
    // fetch throws TypeError on connection refused / DNS failure.
    throw new ServerUnreachableError(config.baseUrl, err);
  }

  if (!response.ok) {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onExternalAbort);
    const body = await response.text().catch(() => "");
    throw new LLMHttpError(response.status, body);
  }

  if (!response.body) {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onExternalAbort);
    throw new ServerUnreachableError(
      config.baseUrl,
      new Error("empty response body"),
    );
  }

  try {
    const chunks = [];
    for await (const chunk of streamSSE(response.body, controller.signal)) {
      chunks.push(chunk);
      const token = chunk.choices?.[0]?.delta?.content;
      if (typeof token === "string" && token.length > 0 && onToken) {
        onToken(token);
      }
    }
    return accumulate(chunks);
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      throw new LLMTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
