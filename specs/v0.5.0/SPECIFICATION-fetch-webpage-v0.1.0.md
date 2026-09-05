# System Specification: `fetch_webpage` Tool

**Version:** 0.1.0
**Date:** 2025-07-14
**Builds on:** N/A

## 1. Purpose and Scope

Provide the agent a single-purpose tool to retrieve the content of a URL and return it in a form the agent can read. The tool is a thin wrapper over the system's `curl` binary (or equivalent HTTP client). It exists so the agent can inspect web pages, APIs, and other URL-addressable resources without the user having to paste content manually.

**Stakeholders:** The LLM agent (sole consumer of output).

**Success criteria:** The agent receives either the page content inline or a file path to read, in all cases without the tool crashing the agent's turn.

## 2. Domain Model

### 2.1 Entities

| Entity | Attributes | Notes |
|--------|-----------|-------|
| `FetchRequest` | `url: string` | The only input. No headers, no method override, no auth. |
| `FetchResult` | `kind: "inline" \| "file" \| "redirect" \| "error"` | Discriminates the response shape. |
| `InlineResult` | `header: string`, `content: string` | Header is a one-line summary; content is the raw body. |
| `FileResult` | `path: string` | Absolute path to a file in the OS temp directory. |
| `RedirectResult` | `status: number`, `location: string` | The 3xx status code and the `Location` header value. |
| `ErrorResult` | `message: string` | Human-readable error description. |

### 2.2 Relationships

- A `FetchRequest` produces exactly one `FetchResult`.
- A `FileResult` references a file that persists on disk until the OS cleans the temp directory.

### 2.3 State Transitions

N/A — the tool is stateless. Each invocation is independent.

## 3. Functional Requirements

### 3.1 User Actions (Tool Invocation)

The agent calls `fetch_webpage` with a single parameter:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | A full URL including scheme (e.g., `https://example.com`). |

No other parameters. No method override, no custom headers, no auth, no timeout override.

### 3.2 Expected Behaviors

**GET request** is issued to the provided URL using the system's `curl` (or equivalent). Supported schemes are those supported by the underlying fetcher (typically `http`, `https`, `file`, `ftp`, `ftps`). The tool description must state which underlying fetcher is used so the agent understands why certain schemes may fail.

**Timeout:** 30 seconds. On timeout, return an `ErrorResult`.

**User-Agent:** Left to the underlying fetcher's default. No custom UA is set.

**Redirects are NOT followed.** If the server responds with a 3xx status, the tool returns a `RedirectResult` with the status code and the `Location` header value. The agent may then call the tool again with the new URL if it wishes.

**Content-Type routing:**

| Condition | Behavior |
|-----------|----------|
| `Content-Type` is text-like (e.g., `text/*`, `application/json`, `application/xml`, `application/javascript`, `application/x-yaml`, etc.) **and** body size ≤ 65,536 bytes | Return `InlineResult`. |
| `Content-Type` is text-like **and** body size > 65,536 bytes | Save body to a file in the OS temp directory. Return `FileResult` with the absolute path. |
| `Content-Type` is non-text (e.g., `application/pdf`, `image/*`, `application/zip`, `application/octet-stream`, etc.) | Save body to a file in the OS temp directory. Return `FileResult` with the absolute path. |
| `Content-Type` is missing or unrecognized | Treat as text-like (optimistic default). Apply the size rule above. |

**Text-like determination:** A content type is considered text-like if its MIME type starts with `text/`, or is one of: `application/json`, `application/xml`, `application/javascript`, `application/x-javascript`, `application/x-yaml`, `application/yaml`, `application/xhtml+xml`, `application/ld+json`, `application/atom+xml`, `application/rss+xml`, `application/graphql`, `application/sql`. Any other MIME type is non-text.

**HTTP 4xx / 5xx responses:** Return an `ErrorResult` with a message that includes the status code and a brief description (e.g., `"HTTP 404: Not Found"`). The tool must NOT crash or halt the agent's turn. The agent receives the error as a normal tool result and can react.

**Network errors** (DNS failure, connection refused, TLS error, timeout): Return an `ErrorResult` with a descriptive message.

### 3.3 Business Rules

1. **Size threshold:** 65,536 bytes (64 KiB). Body size ≤ 65,536 → inline. Body size > 65,536 → file.
2. **File location:** OS temp directory (e.g., `/tmp` on Linux/macOS, `%TEMP%` on Windows).
3. **File naming:** Implementation detail. Must be unique per invocation (e.g., UUID or PID-based). The agent does not need to predict or parse the filename.
4. **File response:** Return only the absolute path. No preview, no size, no content-type in the response.
5. **Inline response header:** A single line prepended to the content, containing: final URL, HTTP status code, content-type, and byte size. Format:
   ```
   [url: <final-url> | status: <code> | type: <content-type> | size: <bytes> bytes]
   ```
   Followed by a newline, then the raw body content.
6. **Redirect response:** Return the status code and `Location` header value. Format:
   ```
   [redirect: <status> | location: <url>]
   ```
7. **Error response:** A single-line string. Format:
   ```
   [error: <message>]
   ```

### 3.4 Workflows

**Happy path (small text page):**
1. Agent calls `fetch_webpage("https://example.com")`.
2. Tool issues GET, receives 200, `text/html`, 4,200 bytes.
3. Tool returns: `[url: https://example.com | status: 200 | type: text/html | size: 4200 bytes]\n<html>...</html>`

**Large text page:**
1. Agent calls `fetch_webpage("https://example.com/big-page")`.
2. Tool issues GET, receives 200, `text/html`, 512,000 bytes.
3. Tool writes body to `/tmp/fetch_a3f2b1c9.html`.
4. Tool returns: `/tmp/fetch_a3f2b1c9.html`

**Binary content:**
1. Agent calls `fetch_webpage("https://example.com/report.pdf")`.
2. Tool issues GET, receives 200, `application/pdf`, 2,000,000 bytes.
3. Tool writes body to `/tmp/fetch_7d4e8a21.pdf`.
4. Tool returns: `/tmp/fetch_7d4e8a21.pdf`

**Redirect:**
1. Agent calls `fetch_webpage("http://example.com")`.
2. Tool issues GET, receives 301, `Location: https://example.com`.
3. Tool returns: `[redirect: 301 | location: https://example.com]`
4. Agent may call `fetch_webpage("https://example.com")` if desired.

**Error:**
1. Agent calls `fetch_webpage("https://nonexistent.invalid/page")`.
2. Tool issues GET, DNS resolution fails.
3. Tool returns: `[error: DNS resolution failed for nonexistent.invalid]`

## 4. Edge Cases and Error Handling

| Scenario | Behavior |
|----------|----------|
| URL is empty string | Return `[error: empty URL]` |
| URL has no scheme (e.g., `example.com`) | Pass to underlying fetcher; if it fails, return the fetcher's error. Do NOT auto-prepend `https://`. |
| URL is malformed (e.g., `htp://`) | Pass to underlying fetcher; return its error. |
| Server returns 200 with empty body (0 bytes) | Return inline with header showing `size: 0 bytes` and no content after the newline. |
| Server returns 200 with no `Content-Type` header | Treat as text-like. Apply size rule. |
| Server returns 200 with `Content-Type: text/html; charset=utf-8` | Text-like (starts with `text/`). Apply size rule. |
| Server returns 200 with `Content-Type: application/octet-stream` | Non-text. Save to file. |
| Server returns 200 with `Content-Type: application/json` and body is 70,000 bytes | Text-like but > 65,536 bytes. Save to file. |
| Server returns 301 with no `Location` header | Return `[redirect: 301 | location: <missing>]` |
| Server returns 302, 303, 307, 308 | Same as 301 — return `RedirectResult`. Do not follow. |
| Server returns 404 | Return `[error: HTTP 404: Not Found]` |
| Server returns 500 | Return `[error: HTTP 500: Internal Server Error]` |
| Connection times out (> 30s) | Return `[error: timeout after 30s]` |
| TLS certificate error | Return `[error: TLS certificate verification failed: <detail>]` |
| Connection refused | Return `[error: connection refused]` |
| Unsupported scheme (e.g., `gopher://`) | Pass to underlying fetcher; if unsupported, return `[error: unsupported scheme: gopher]` |
| Body is exactly 65,536 bytes, text-like | Inline (≤ threshold). |
| Body is exactly 65,537 bytes, text-like | File (> threshold). |
| Temp directory is not writable | Return `[error: cannot write to temp directory: <detail>]` |
| Disk is full when writing to temp file | Return `[error: disk full: <detail>]` |

## 5. Non-Functional Requirements

- **Performance:** Tool overhead (beyond network latency) must be < 100 ms. The 30s timeout covers network + TLS + transfer.
- **Scalability:** Single-threaded, one request per invocation. No concurrency requirements.
- **Security:** No credentials are stored or transmitted. The tool does not follow redirects (prevents redirect-based credential leakage). TLS verification is enforced (no `--insecure` / `-k` flag).
- **Availability:** Depends on network. No retry logic — a failed fetch is reported as an error and the agent decides whether to retry.
- **Compatibility:** Must work on Linux, macOS, and Windows. Uses the system's `curl` binary (or equivalent HTTP client available on the platform).
- **Idempotency:** Each call is independent. No caching, no state between calls.

## 6. Data Requirements

- **Input:** A single URL string.
- **Output (inline):** One-line header + raw body text.
- **Output (file):** Absolute file path string.
- **Output (redirect):** One-line status + location.
- **Output (error):** One-line error message.
- **Storage:** Temp files are written to the OS temp directory. No retention policy — the OS manages cleanup. Files are not deleted by the tool.
- **Encoding:** Body is returned as raw bytes interpreted as UTF-8 for inline text. If the body is not valid UTF-8, replace invalid sequences with U+FFFD (replacement character). (Encoding handling may be refined in a future version.)

## 7. External Dependencies

- **`curl`** (or equivalent system HTTP client): Used as the underlying fetcher. The tool description must name this dependency so the agent understands which schemes and features are available.
- **OS temp directory:** Must be writable. Standard paths: `/tmp` (Linux/macOS), `%TEMP%` or `%TMP%` (Windows).

## 8. Constraints and Assumptions

- The tool is a thin wrapper. It does not parse HTML, execute JavaScript, or render pages.
- No authentication (no basic auth, no API keys, no cookies).
- No custom headers.
- No method override (GET only).
- No redirect following.
- No retry logic.
- No caching.
- The underlying fetcher's behavior for edge cases (e.g., chunked transfer encoding, gzip compression) is delegated to `curl`. The tool does not decompress or re-encode.
- The agent is expected to handle errors gracefully — the tool reports them but does not halt execution.

## 9. Acceptance Criteria

1. Calling `fetch_webpage("https://example.com")` returns the HTML content inline with a header line, assuming the page is ≤ 65,536 bytes.
2. Calling `fetch_webpage` on a URL that returns a body > 65,536 bytes returns a file path. Reading that file yields the full body.
3. Calling `fetch_webpage` on a URL that returns a PDF returns a file path. The file is a valid PDF.
4. Calling `fetch_webpage` on a URL that returns a 301 returns `[redirect: 301 | location: <url>]`.
5. Calling `fetch_webpage` on a URL that returns a 404 returns `[error: HTTP 404: Not Found]`.
6. Calling `fetch_webpage` on an unreachable host returns an error string, not a crash.
7. Calling `fetch_webpage` with an empty string returns `[error: empty URL]`.
8. The tool does not follow redirects. A 301 response is never transparently resolved.
9. The tool enforces a 30-second timeout.
10. The tool does not disable TLS verification.

## 10. Open Questions

None.
