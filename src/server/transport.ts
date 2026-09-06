/**
 * Transport helpers for the agent-server (GUI spec §3.5).
 *
 * Moves bytes across the wire: static file MIME typing. The Bun.serve wiring
 * (WebSocket upgrade, client eviction, framing) lives on the `AgentServer`
 * class because it shares the instance's send buffer and session snapshot;
 * the pure helpers that do not touch instance state live here so they stay
 * unit-testable.
 */
import path from "node:path";

/** A minimal MIME map for the static UI assets. */
export function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}
