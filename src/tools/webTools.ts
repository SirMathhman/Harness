/**
 * `fetch_webpage` tool (SPECIFICATION-v0.1.0.md).
 *
 * A thin wrapper over the platform's native `fetch` (Bun/undici): issues a
 * GET request, never follows redirects, and returns either the body inline
 * (text-like, ≤ 65,536 bytes), a temp-file path (larger or binary), a
 * redirect notice (3xx), or a one-line error. It never throws — every
 * failure is reported as a result string the agent can react to.
 */
import dns from "node:dns";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "../types.js";
import { newId } from "../utils.js";

/** Bodies ≤ this many bytes are returned inline (spec §3.3 rule 1). */
const INLINE_LIMIT_BYTES = 65_536;

/** Default request timeout (spec §3.2). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * MIME types treated as text-like beyond the `text/*` prefix
 * (spec §3.2, "Text-like determination").
 */
const TEXT_LIKE_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-yaml",
  "application/yaml",
  "application/xhtml+xml",
  "application/ld+json",
  "application/atom+xml",
  "application/rss+xml",
  "application/graphql",
  "application/sql",
]);

/**
 * Standard HTTP reason phrases (RFC 9110) for the status codes the spec
 * calls out by name. The platform's `Response` does not populate
 * `statusText`, so the phrase is looked up here.
 */
const REASON_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * Decide whether a Content-Type value is text-like (spec §3.2).
 * Missing or empty values are treated as text-like (optimistic default).
 */
export function isTextLike(contentType: string | null): boolean {
  if (!contentType) return true;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime === "") return true;
  return mime.startsWith("text/") || TEXT_LIKE_MIME_TYPES.has(mime);
}

/**
 * A temp-file extension derived from the MIME subtype (e.g. `text/html` →
 * `.html`), or `""` when the subtype is absent or not safely usable.
 */
function fileExtension(contentType: string | null): string {
  if (!contentType) return "";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const subtype = mime.split("/")[1] ?? "";
  const clean = subtype.replace(/[^a-z0-9.+-]/g, "");
  if (clean === "" || clean.length > 10) return "";
  return `.${clean}`;
}

/**
 * Classify a failed fetch into the spec's one-line error message (spec §4).
 * `timedOut` is true when the abort was caused by the request timeout.
 */
export async function describeFetchError(
  err: unknown,
  url: string,
  timedOut: boolean,
  timeoutMs: number,
): Promise<string> {
  if (timedOut) return `timeout after ${timeoutMs / 1000}s`;
  const detail = err instanceof Error ? err.message : String(err);
  if (/cert|tls|ssl/i.test(detail)) {
    return `TLS certificate verification failed: ${detail}`;
  }
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Malformed URL — report the fetcher's own error.
  }
  if (hostname) {
    try {
      await dns.promises.lookup(hostname);
      // The name resolves, so the failure happened at connect time.
      return "connection refused";
    } catch {
      return `DNS resolution failed for ${hostname}`;
    }
  }
  return detail;
}

/**
 * Build the `fetch_webpage` tool. `timeoutMs` is the request timeout
 * (spec default 30 s); it is injectable so tests can use a short value.
 */
export function makeFetchWebpageTool(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Tool {
  return {
    name: "fetch_webpage",
    mutating: false,
    noTruncate: true,
    description:
      "Fetch a URL with GET using the platform's native fetch (http/https only) and return the body inline (text-like, ≤ 64 KiB), a temp-file path (larger or binary), a redirect notice (3xx — redirects are never followed), or a one-line error.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "A full URL including scheme (e.g., https://example.com).",
        },
      },
      required: ["url"],
    },
    async handler(args) {
      const url = typeof args.url === "string" ? args.url : "";
      if (url.trim() === "") return "[error: empty URL]";

      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        // Malformed URL — let the fetcher report its own error.
      }
      if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `[error: unsupported scheme: ${parsed.protocol.replace(/:$/, "")}]`;
      }

      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort("timeout"),
        timeoutMs,
      );
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        const timedOut =
          controller.signal.aborted &&
          controller.signal.reason === "timeout";
        const message = await describeFetchError(err, url, timedOut, timeoutMs);
        return `[error: ${message}]`;
      }
      clearTimeout(timeoutHandle);

      // Redirects are NOT followed (spec §3.2).
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "<missing>";
        return `[redirect: ${response.status} | location: ${location}]`;
      }

      if (response.status >= 400) {
        const phrase =
          response.statusText || REASON_PHRASES[response.status] || "";
        return `[error: HTTP ${response.status}${phrase ? `: ${phrase}` : ""}]`;
      }

      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type");
      const finalUrl = response.url || url;

      // Non-text, or text-like above the inline limit → temp file (spec §3.2).
      if (!isTextLike(contentType) || body.length > INLINE_LIMIT_BYTES) {
        const file = path.join(
          os.tmpdir(),
          `fetch_${newId()}${fileExtension(contentType)}`,
        );
        try {
          writeFileSync(file, body);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
            return `[error: disk full: ${detail}]`;
          }
          return `[error: cannot write to temp directory: ${detail}]`;
        }
        return file;
      }

      // Inline: one-line header + raw body (spec §3.3 rule 5). Invalid UTF-8
      // sequences are replaced with U+FFFD by the non-fatal decoder (spec §6).
      const text = new TextDecoder("utf-8").decode(body);
      return `[url: ${finalUrl} | status: ${response.status} | type: ${contentType ?? "unknown"} | size: ${body.length} bytes]\n${text}`;
    },
  };
}
