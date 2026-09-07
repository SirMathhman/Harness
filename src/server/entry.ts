#!/usr/bin/env bun
/**
 * The agent-server entry point (GUI spec §3.1).
 *
 * `vise serve` / `vise gui` load config, discover models, resolve the
 * starting profile, and start the `AgentServer`. Exits non-zero on the same
 * fatal conditions as the CLI. It never touches stdin and keeps running after
 * the browser disconnects.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c } from "../cli/color.js";
import { prepareSession } from "../startup.js";
import { AgentServer } from "./server.js";
import { DEFAULT_GUI_PORT } from "./protocol.js";

/**
 * The `vise serve` / `vise gui` entry point (GUI spec §3.1).
 *
 * Loads config, discovers models, resolves the starting profile (via the shared
 * `prepareSession` seam), and starts the agent-server. Exits non-zero on the
 * same fatal conditions as the CLI.
 */
export async function runServer(
  port: number,
  openBrowser: boolean,
): Promise<void> {
  const prepared = await prepareSession();
  if (!prepared.ok) return fail(prepared.error);
  const { graph, profile } = prepared.session;

  // Locate the built UI assets (gui/dist), relative to this source file.
  // fileURLToPath handles Windows drive-letter paths correctly.
  const staticDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "gui",
    "dist",
  );

  const server = new AgentServer({
    graph,
    profile,
    staticDir: existsSync(staticDir) ? staticDir : null,
  });

  const actualPort = await server.start(port);
  const url = `http://localhost:${actualPort}`;
  console.log(c.green(`Vise GUI: ${url}`));

  if (openBrowser) {
    try {
      await openInBrowser(url);
    } catch {
      // best-effort; the user can open the URL manually
    }
  }

  // Keep running until the process is stopped (GUI spec §4.1, §6.2).
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.stop().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/** Open a URL in the default browser (best-effort, cross-platform). */
async function openInBrowser(url: string): Promise<void> {
  const args =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  await child.exited;
}

function fail(message: string): void {
  console.error(c.red(message));
  process.exitCode = 1;
}

if (import.meta.main) {
  runServer(DEFAULT_GUI_PORT, false).catch((err) => {
    console.error(c.red(`Fatal: ${(err as Error).message}`));
    process.exitCode = 1;
  });
}
