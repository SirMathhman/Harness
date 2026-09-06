/**
 * The Vise agent-server (GUI spec §3.1).
 *
 * A separate, long-lived entry point that owns one session and exposes it over
 * a WebSocket protocol (§6.1). It reuses the side-effect-free session machinery
 * (`createSession`, `runTurn`) unchanged and adds no runtime dependency to the
 * core. It never touches stdin.
 *
 * The server surface is split across this module (the `AgentServer` class —
 * session ownership, turn lifecycle, command dispatch, transport wiring) and
 * its siblings, so no single file owns the whole presentation layer:
 * - `protocol.ts`  — the wire types (a pure, shared boundary).
 * - `translate.ts` — pure session→protocol mapping (snapshot/history/UI state).
 * - `transport.ts` — byte-level helpers (MIME typing).
 * - `entry.ts`     — the `serve`/`gui` entry point (startup/shutdown).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createSession, type SessionHandle } from "../agent/session.js";
import { runTurn } from "../agent/loop.js";
import { LLMError } from "../llm/errors.js";
import {
  type SubagentRender,
  type SubagentRenderEvent,
} from "../agent/subagent.js";
import { writeStateFile, type ResourceGraph } from "../profiles/index.js";
import { newId } from "../utils.js";
import {
  DEFAULT_GUI_PORT,
  WS_PATH,
  type ClientCommand,
  type Scope,
  type ServerEvent,
  type UIState,
} from "./protocol.js";
import { buildSnapshot, buildUIState, isTurnEvent } from "./translate.js";
import { mimeOf } from "./transport.js";

/** Options for {@link createAgentServer}. */
export interface AgentServerOptions {
  /** The port to bind. Defaults to {@link DEFAULT_GUI_PORT}. */
  port?: number;
  /** The resource graph (config + discovered models). */
  graph: ResourceGraph;
  /** The profile to start under. */
  profile: string;
  /** The model name saved in the state file, or null. */
  lastModel: string | null;
  /** The state file path (for clean-exit persistence). */
  statePath: string;
  /** The directory of built UI assets to serve, or null (dev mode). */
  staticDir?: string | null;
  /** Where log lines go. Defaults to stderr. */
  log?: (message: string) => void;
}

/**
 * The agent-server: owns one session and one WebSocket connection, translating
 * session events into protocol events and client commands into session
 * operations (GUI spec §2.1.1, §3.3, §3.4).
 */
export class AgentServer {
  private readonly handle: SessionHandle;
  private readonly statePath: string;
  private readonly staticDir: string | null;
  private readonly log: (message: string) => void;

  /** The single attached WebSocket, or null when disconnected. */
  private ws: Bun.ServerWebSocket | null = null;
  /** True while a turn is running. */
  private turnActive = false;
  /** The message count before the current turn (for the snapshot split). */
  private turnStartMessageCount = 0;
  /** The live events emitted for the current turn (the in-flight buffer). */
  private inflightBuffer: ServerEvent[] = [];
  /** Active subagent ids keyed by depth (GUI spec §3.3 scope correlation). */
  private subagentIds = new Map<number, string>();
  /** The AbortController for the current turn, or null when idle. */
  private abortController: AbortController | null = null;
  /** The Bun server handle, for shutdown. */
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: AgentServerOptions) {
    this.statePath = options.statePath;
    this.staticDir = options.staticDir ?? null;
    this.log = options.log ?? ((m) => console.error(m));
    this.handle = createSession({
      graph: options.graph,
      profile: options.profile,
      lastModel: options.lastModel,
      render: this.makeSubagentRender(),
      log: this.log,
    });
  }

  /** Start serving. Resolves once the server is listening. */
  async start(port: number = DEFAULT_GUI_PORT): Promise<number> {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (req, server) => this.onRequest(req, server),
      websocket: {
        open: (ws) => this.onWsOpen(ws),
        message: (ws, msg) => this.onWsMessage(ws, msg),
        close: (ws) => this.onWsClose(ws),
      },
    });
    this.server = server;
    return server.port ?? port;
  }

  /** Stop the server and persist the state file (GUI spec §6.2). */
  async stop(): Promise<void> {
    this.handle.manager.killAll();
    this.writeState();
    this.server?.stop(true);
    this.server = null;
  }

  /** The current UI state (GUI spec §2.1.4). */
  private buildState(): UIState {
    return buildUIState(this.handle, this.turnActive);
  }

  /** The snapshot sent on (re)connect (GUI spec §3.8). */
  private buildSnapshot(): ServerEvent {
    return buildSnapshot({
      handle: this.handle,
      turnActive: this.turnActive,
      turnStartMessageCount: this.turnStartMessageCount,
      inflightBuffer: this.inflightBuffer,
      buildState: () => this.buildState(),
    });
  }

  /** Push an event to the attached client and buffer it if mid-turn. */
  private emit(event: ServerEvent): void {
    if (this.turnActive && isTurnEvent(event)) {
      this.inflightBuffer.push(event);
    }
    this.send(event);
  }

  /** Send a raw event to the attached client (no buffering). */
  private send(event: ServerEvent): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /** The SubagentRender bridge (GUI spec §3.3). */
  private makeSubagentRender(): SubagentRender {
    return (depth: number, event: SubagentRenderEvent) => {
      // Assign a stable id to each active subagent at a given depth. The
      // render callback carries no id, so we correlate by depth: a new id is
      // minted when a depth has no active subagent and dropped on `end`.
      // (Assumption: at most one concurrent subagent per depth, which holds
      // because `spawn_subagent` is serialized per depth by the KV provider.)
      let id = this.subagentIds.get(depth);
      if (id === undefined) {
        id = newId();
        this.subagentIds.set(depth, id);
      }
      const scope: Scope = { kind: "subagent", id, depth };
      switch (event.kind) {
        case "token":
          this.emit({ type: "token", scope, text: event.text });
          break;
        case "reasoning":
          this.emit({ type: "reasoning", scope, text: event.text });
          break;
        case "toolCall":
          this.emit({
            type: "toolCall",
            scope,
            name: event.name,
            args: event.args,
          });
          break;
        case "toolResult":
          this.emit({
            type: "toolResult",
            scope,
            name: event.name,
            ok: event.ok,
            summary: event.summary,
          });
          break;
        case "compacting":
          this.emit({ type: "compacting", scope });
          break;
        case "end":
          this.subagentIds.delete(depth);
          this.emit({
            type: "subagentEnd",
            scope,
            ok: event.ok,
            label: event.label,
            depth,
          });
          break;
      }
    };
  }

  /** Handle an HTTP request: WebSocket upgrade or static UI (GUI spec §3.5). */
  private onRequest(req: Request, server: Bun.Server<unknown>): Response {
    const url = new URL(req.url);
    if (
      url.pathname === WS_PATH &&
      req.headers.get("upgrade") === "websocket"
    ) {
      const ws = server.upgrade(req, { data: {} });
      if (!ws) return new Response("WebSocket upgrade failed", { status: 400 });
      return new Response(null, { status: 101 });
    }
    return this.serveStatic(url.pathname);
  }

  /** Serve a static file from the built UI, with an SPA fallback. */
  private serveStatic(pathname: string): Response {
    if (this.staticDir === null) {
      return new Response(
        "GUI assets not built. Run `bun run build` in gui/ (dev: use the Vite dev server).",
        { status: 503 },
      );
    }
    const safePath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.join(this.staticDir, safePath);
    if (existsSync(filePath) && !filePath.includes("..")) {
      const file = Bun.file(filePath);
      return new Response(file, {
        headers: { "content-type": mimeOf(filePath) },
      });
    }
    // SPA fallback: serve index.html for any unknown path.
    const index = path.join(this.staticDir, "index.html");
    if (existsSync(index)) {
      return new Response(Bun.file(index), {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("Not found", { status: 404 });
  }

  /** A new client connected (GUI spec §3.2, §4.2). */
  private onWsOpen(ws: Bun.ServerWebSocket): void {
    // A second client evicts the older one (most recent wins).
    if (this.ws && this.ws !== ws) {
      try {
        this.ws.close(1000, "replaced by a newer client");
      } catch {
        // already closing
      }
    }
    this.ws = ws;
    this.send(this.buildSnapshot());
  }

  /** A client message arrived (GUI spec §3.4). */
  private onWsMessage(ws: Bun.ServerWebSocket, msg: string | Uint8Array): void {
    if (ws !== this.ws) return; // stale connection
    let command: ClientCommand;
    try {
      command = JSON.parse(
        typeof msg === "string" ? msg : new TextDecoder().decode(msg),
      );
    } catch {
      this.send({
        type: "commandResult",
        ok: false,
        error: "Malformed JSON command.",
      });
      return;
    }
    this.handleCommand(command);
  }

  /** A client disconnected (GUI spec §4.1): the session persists. */
  private onWsClose(ws: Bun.ServerWebSocket): void {
    if (ws === this.ws) this.ws = null;
  }

  /** Dispatch a client command (GUI spec §3.4). */
  private handleCommand(command: ClientCommand): void {
    switch (command.type) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "abort":
        this.doAbort();
        return;
      case "task":
        this.doTask(command.text);
        return;
      case "switchProfile":
        this.doSwitchProfile(command.name);
        return;
      case "switchModel":
        this.doSwitchModel(command.ref);
        return;
      case "clear":
      case "newSession":
        this.doClear();
        return;
      case "hooks":
        this.doHooks(command.enabled);
        return;
      default:
        this.send({
          type: "commandResult",
          ok: false,
          error: `Unknown command type: ${(command as { type?: string }).type}`,
        });
    }
  }

  /** Start a turn (GUI spec §3.4, §4.8). */
  private doTask(text: unknown): void {
    if (typeof text !== "string" || text.trim().length === 0) {
      this.send({
        type: "commandResult",
        ok: false,
        error: "task requires a non-empty `text`.",
      });
      return;
    }
    if (this.turnActive) {
      this.send({
        type: "commandResult",
        ok: false,
        error: "A turn is already running.",
      });
      return;
    }
    this.turnActive = true;
    this.turnStartMessageCount = this.handle.session.messages.length;
    this.inflightBuffer = [];
    this.abortController = new AbortController();
    this.send({ type: "state", patch: { turnActive: true } });

    const callbacks = {
      onToken: (t: string) =>
        this.emit({ type: "token", scope: { kind: "main" }, text: t }),
      onReasoning: (t: string) =>
        this.emit({ type: "reasoning", scope: { kind: "main" }, text: t }),
      onToolCall: (name: string, args: Record<string, unknown>) =>
        this.emit({ type: "toolCall", scope: { kind: "main" }, name, args }),
      onToolResult: (name: string, ok: boolean, summary: string) =>
        this.emit({
          type: "toolResult",
          scope: { kind: "main" },
          name,
          ok,
          summary,
        }),
      onCompacting: () =>
        this.emit({ type: "compacting", scope: { kind: "main" } }),
    };

    runTurn(
      this.handle.session,
      text,
      this.handle.registry,
      callbacks,
      this.abortController.signal,
    )
      .then((result) => {
        this.finishTurn(result.answer, result.kind, result.finished);
      })
      .catch((err) => {
        if (this.abortController?.signal.aborted) {
          this.finishTurn("", "aborted", false);
        } else if (err instanceof LLMError) {
          this.send({ type: "error", message: err.message, kind: "llm" });
          this.finishTurn("", "text", false);
        } else {
          this.send({
            type: "error",
            message: (err as Error).message,
            kind: "other",
          });
          this.finishTurn("", "text", false);
        }
      });
  }

  /** Abort the current turn (GUI spec §3.4, §4.6). */
  private doAbort(): void {
    if (!this.turnActive || !this.abortController) return; // no-op when idle
    this.abortController.abort();
    this.handle.manager.killAll();
  }

  /** Switch the active profile (GUI spec §3.4, §4.7, §4.8). */
  private doSwitchProfile(name: unknown): void {
    if (typeof name !== "string" || name.length === 0) {
      this.send({
        type: "commandResult",
        ok: false,
        error: "switchProfile requires a `name`.",
      });
      return;
    }
    if (this.turnActive) {
      this.send({
        type: "commandResult",
        ok: false,
        error: "Cannot switch profile while a turn is running.",
      });
      return;
    }
    try {
      this.handle.switchProfile(name);
      this.send({ type: "state", patch: this.buildState() });
    } catch (err) {
      this.send({
        type: "commandResult",
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  /** Switch the active model (GUI spec §3.4, §4.7, §4.8). */
  private doSwitchModel(ref: unknown): void {
    if (typeof ref !== "string" || ref.length === 0) {
      this.send({
        type: "commandResult",
        ok: false,
        error: "switchModel requires a `ref`.",
      });
      return;
    }
    if (this.turnActive) {
      this.send({
        type: "commandResult",
        ok: false,
        error: "Cannot switch model while a turn is running.",
      });
      return;
    }
    try {
      this.handle.switchModel(ref);
      this.send({ type: "state", patch: this.buildState() });
    } catch (err) {
      this.send({
        type: "commandResult",
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  /** Clear the conversation (GUI spec §3.4, §4.12). */
  private doClear(): void {
    if (this.turnActive) {
      this.send({
        type: "commandResult",
        ok: false,
        error: "Cannot clear while a turn is running.",
      });
      return;
    }
    this.handle.clearConversation();
    this.send({ type: "cleared" });
    this.send({ type: "state", patch: this.buildState() });
  }

  /** Toggle hooks (GUI spec §3.4, §4.13). */
  private doHooks(enabled: unknown): void {
    if (typeof enabled !== "boolean") {
      this.send({
        type: "commandResult",
        ok: false,
        error: "hooks requires a boolean `enabled`.",
      });
      return;
    }
    this.handle.setHooksEnabled(enabled);
    this.send({ type: "state", patch: { hooksEnabled: enabled } });
  }

  /** Mark a turn complete and return to idle (GUI spec §2.3.1). */
  private finishTurn(
    answer: string,
    kind: "finished" | "cap" | "text" | "aborted",
    finished: boolean,
  ): void {
    this.turnActive = false;
    this.inflightBuffer = [];
    this.abortController = null;
    this.subagentIds.clear();
    this.send({ type: "turnEnd", answer, kind, finished });
    this.send({ type: "state", patch: this.buildState() });
  }

  /** Persist the active profile + model to the shared state file. */
  private writeState(): void {
    writeStateFile(
      this.statePath,
      this.handle.profile,
      this.handle.session.config.model ?? "",
      this.log,
    );
  }
}
