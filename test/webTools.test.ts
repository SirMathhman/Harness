import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeFetchError,
  isTextLike,
  makeFetchWebpageTool,
} from "../src/tools/webTools.js";

/**
 * fetch_webpage (SPECIFICATION-v0.1.0.md §9).
 *
 * A local mock HTTP server stands in for the network; the tool under test is
 * built with a short timeout so the timeout path is fast.
 */

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let requests: string[];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vise-webtest-"));
  requests = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      switch (url.pathname) {
        case "/small":
          return new Response("<html>small</html>", {
            headers: { "Content-Type": "text/html" },
          });
        case "/charset":
          return new Response("charset body", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        case "/json":
          return Response.json({ ok: true });
        case "/big":
          return new Response("x".repeat(70_000), {
            headers: { "Content-Type": "text/html" },
          });
        case "/boundary-inline":
          return new Response("y".repeat(65_536), {
            headers: { "Content-Type": "text/plain" },
          });
        case "/boundary-file":
          return new Response("z".repeat(65_537), {
            headers: { "Content-Type": "text/plain" },
          });
        case "/pdf":
          return new Response(
            new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
            { headers: { "Content-Type": "application/pdf" } },
          );
        case "/octet":
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "Content-Type": "application/octet-stream" },
          });
        case "/no-ct":
          return new Response("plain", { headers: { "Content-Type": "" } });
        case "/empty":
          return new Response(null, {
            headers: { "Content-Type": "text/plain" },
          });
        case "/invalid-utf8":
          return new Response(new Uint8Array([0xff, 0xfe, 0x61]), {
            headers: { "Content-Type": "text/plain" },
          });
        case "/redir":
          return new Response(null, {
            status: 301,
            headers: { Location: `${base}/target` },
          });
        case "/redir-noloc":
          return new Response(null, { status: 302 });
        case "/notfound":
          return new Response(null, { status: 404 });
        case "/server-error":
          return new Response(null, { status: 500 });
        case "/slow":
          // A stream that never enqueues: the body read hangs until the
          // tool's timeout aborts it.
          const stream = new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue("slow");
                controller.close();
              }, 2_000);
            },
          });
          return new Response(stream);
        default:
          return new Response("not here", { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const tool = makeFetchWebpageTool(1_000);

describe("fetch_webpage inline (AC 1)", () => {
  test("small text page returns header line + body", async () => {
    const out = await tool.handler({ url: `${base}/small` });
    expect(out).toBe(
      `[url: ${base}/small | status: 200 | type: text/html | size: 18 bytes]\n<html>small</html>`,
    );
  });

  test("Content-Type with parameters is still text-like", async () => {
    const out = await tool.handler({ url: `${base}/charset` });
    expect(out).toContain("type: text/html; charset=utf-8");
    expect(out).toContain("charset body");
  });

  test("application/json is text-like", async () => {
    const out = await tool.handler({ url: `${base}/json` });
    expect(out).toContain('"ok":true');
  });

  test("missing Content-Type is treated as text-like", async () => {
    const out = await tool.handler({ url: `${base}/no-ct` });
    expect(out).toContain("plain");
  });

  test("empty body returns header with size 0 and no content", async () => {
    const out = await tool.handler({ url: `${base}/empty` });
    expect(out).toBe(
      `[url: ${base}/empty | status: 200 | type: text/plain | size: 0 bytes]\n`,
    );
  });

  test("invalid UTF-8 is replaced with U+FFFD", async () => {
    const out = await tool.handler({ url: `${base}/invalid-utf8` });
    expect(out).toContain("\uFFFD");
  });
});

describe("fetch_webpage file results (AC 2, 3)", () => {
  test("text-like body > 65,536 bytes returns a readable file path", async () => {
    const out = await tool.handler({ url: `${base}/big` });
    expect(path.isAbsolute(out)).toBe(true);
    expect(statSync(out).size).toBe(70_000);
    expect(readFileSync(out, "utf-8")).toBe("x".repeat(70_000));
  });

  test("application/pdf returns a file with the exact bytes", async () => {
    const out = await tool.handler({ url: `${base}/pdf` });
    expect(path.isAbsolute(out)).toBe(true);
    expect(readFileSync(out).subarray(0, 4).toString()).toBe("%PDF");
  });

  test("application/octet-stream is non-text and goes to a file", async () => {
    const out = await tool.handler({ url: `${base}/octet` });
    expect(path.isAbsolute(out)).toBe(true);
    expect(readFileSync(out).length).toBe(4);
  });

  test("body of exactly 65,536 bytes is inline (≤ threshold)", async () => {
    const out = await tool.handler({ url: `${base}/boundary-inline` });
    expect(out).toContain("size: 65536 bytes");
    expect(out).toContain("y".repeat(65_536));
  });

  test("body of exactly 65,537 bytes goes to a file (> threshold)", async () => {
    const out = await tool.handler({ url: `${base}/boundary-file` });
    expect(path.isAbsolute(out)).toBe(true);
    expect(statSync(out).size).toBe(65_537);
  });
});

describe("fetch_webpage redirects (AC 4, 8)", () => {
  test("301 returns a redirect notice with the Location header", async () => {
    const out = await tool.handler({ url: `${base}/redir` });
    expect(out).toBe(`[redirect: 301 | location: ${base}/target]`);
  });

  test("redirects are never followed", async () => {
    requests = [];
    await tool.handler({ url: `${base}/redir` });
    expect(requests).toEqual(["/redir"]);
  });

  test("302 without a Location header reports <missing>", async () => {
    const out = await tool.handler({ url: `${base}/redir-noloc` });
    expect(out).toBe("[redirect: 302 | location: <missing>]");
  });
});

describe("fetch_webpage errors (AC 5, 6, 7)", () => {
  test("404 returns the spec's error line", async () => {
    const out = await tool.handler({ url: `${base}/notfound` });
    expect(out).toBe("[error: HTTP 404: Not Found]");
  });

  test("500 returns the spec's error line", async () => {
    const out = await tool.handler({ url: `${base}/server-error` });
    expect(out).toBe("[error: HTTP 500: Internal Server Error]");
  });

  test("unreachable host returns an error string, not a throw", async () => {
    const out = await tool.handler({ url: "http://127.0.0.1:9/" });
    expect(out).toMatch(/^\[error: /);
  });

  test("empty URL returns the spec's error line (AC 7)", async () => {
    expect(await tool.handler({ url: "" })).toBe("[error: empty URL]");
  });

  test("unsupported scheme is reported", async () => {
    const out = await tool.handler({ url: "gopher://example.com" });
    expect(out).toBe("[error: unsupported scheme: gopher]");
  });
});

describe("fetch_webpage timeout (AC 9)", () => {
  test("a slow response aborts with the timeout error", async () => {
    const out = await tool.handler({ url: `${base}/slow` });
    expect(out).toBe("[error: timeout after 1s]");
  });
});

describe("fetch_webpage TLS (AC 10)", () => {
  test("TLS certificate failures are classified, never disabled", async () => {
    const out = await describeFetchError(
      new Error("self-signed certificate in certificate chain"),
      "https://example.com",
      false,
      30_000,
    );
    expect(out).toBe(
      "TLS certificate verification failed: self-signed certificate in certificate chain",
    );
  });
});

describe("isTextLike (spec §3.2)", () => {
  test("text/* prefix", () => {
    expect(isTextLike("text/html")).toBe(true);
    expect(isTextLike("text/plain; charset=utf-8")).toBe(true);
  });
  test("allowlisted application/* types", () => {
    for (const t of [
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
    ]) {
      expect(isTextLike(t)).toBe(true);
    }
  });
  test("everything else is non-text", () => {
    expect(isTextLike("application/pdf")).toBe(false);
    expect(isTextLike("image/png")).toBe(false);
    expect(isTextLike("application/zip")).toBe(false);
  });
  test("missing or empty is text-like (optimistic default)", () => {
    expect(isTextLike(null)).toBe(true);
    expect(isTextLike("")).toBe(true);
  });
});
