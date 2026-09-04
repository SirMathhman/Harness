import { describe, expect, test } from "bun:test";
import { discoverModel } from "../src/llm/client.js";

describe("model auto-discovery (spec §6.1)", () => {
  test("returns the first model reported by GET /v1/models", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          object: "list",
          data: [{ id: "qwen2.5-coder-7b" }, { id: "other-model" }],
        });
      },
    });
    try {
      const model = await discoverModel(`http://127.0.0.1:${server.port}`);
      expect(model).toBe("qwen2.5-coder-7b");
    } finally {
      server.stop();
    }
  });

  test("returns null when the server reports no models", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ object: "list", data: [] });
      },
    });
    try {
      const model = await discoverModel(`http://127.0.0.1:${server.port}`);
      expect(model).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("returns null when the server is unreachable", async () => {
    const model = await discoverModel("http://127.0.0.1:1");
    expect(model).toBeNull();
  });

  test("returns null on a non-OK HTTP response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const model = await discoverModel(`http://127.0.0.1:${server.port}`);
      expect(model).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("returns null on a malformed response body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      },
    });
    try {
      const model = await discoverModel(`http://127.0.0.1:${server.port}`);
      expect(model).toBeNull();
    } finally {
      server.stop();
    }
  });
});
