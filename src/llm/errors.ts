/**
 * LLM/server error types (spec §4 E3–E5).
 * All of these abort the current turn immediately (no retries).
 */

/** Base class for all LLM connectivity errors. */
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** E3: llama.cpp server unreachable / connection refused. */
export class ServerUnreachableError extends LLMError {
  constructor(baseUrl: string, cause?: unknown) {
    super(
      `Cannot reach llama.cpp server at ${baseUrl}. Is it running?` +
        (cause ? ` (${(cause as Error).message})` : ""),
    );
  }
}

/** E4: LLM request timed out. */
export class LLMTimeoutError extends LLMError {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms.`);
  }
}

/** E5: LLM returned an HTTP error (4xx/5xx). */
export class LLMHttpError extends LLMError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`LLM request failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}
