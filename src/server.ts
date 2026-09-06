#!/usr/bin/env bun
/**
 * The Vise agent-server (GUI spec §3.1).
 *
 * A separate, long-lived entry point that owns one session and exposes it over
 * a WebSocket protocol (§6.1). It reuses the side-effect-free session machinery
 * (`loadViseConfig`, `createSession`, `runTurn`) unchanged and adds no runtime
 * dependency to the core. It never touches stdin.
 *
 * Invoked by `vise serve` (headless) or `vise gui` (serve + open browser).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c } from "./cli/color.js";
import {
  addDiscoveredModels,
  MissingMaxContextError,
  resolveProfile,
  resolveStartingProfile,
  stateFilePath,
  writeStateFile,
  ViseConfigError,
  loadViseConfig,
  type DiscoveryResult,
  type ModelDef,
  type ResourceGraph,
} from "./profiles/index.js";
import { createSession, type SessionHandle } from "./agent/session.js";
import { runTurn } from "./agent/loop.js";
import { LLMError } from "./llm/errors.js";
import {
  type SubagentRender,
  type SubagentRenderEvent,
} from "./agent/subagent.js";
import { newId } from "./utils.js";
import type { Message } from "./types.js";

/** The default port the agent-server binds to (GUI spec §3.1, §5). */
export const DEFAULT_GUI_PORT = 8787;

/** The WebSocket endpoint path (GUI spec §3.2). */
export const WS_PATH = "/ws";

/**
 * The protocol `Scope` (GUI spec §6.1): which agent produced an event.
 * `main` for the top-level agent; `subagent` carries an `id` that correlates
 * the subagent's events to its parent `spawn_subagent` call and a `depth`.
 */
export type Scope =
  | { kind: "main" }
  | { kind: "subagent"; id: string; depth: number };

/** A protocol event the server pushes to the client (GUI spec §6.1). */
export type ServerEvent =
  | {
      type: "snapshot";
      history: ConversationItem[];
      inflight: ServerEvent[];
      state: UIState;
    }
  | { type: "token"; scope: Scope; text: string }
  | { type: "reasoning"; scope: Scope; text: string }
  | {
      type: "toolCall";
      scope: Scope;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "toolResult";
      scope: Scope;
      name: string;
      ok: boolean;
      summary: string;
    }
  | { type: "compacting"; scope: Scope }
  | {
      type: "subagentEnd";
      scope: Scope;
      ok: boolean;
      label: string;
      depth: number;
    }
  | {
      type: "turnEnd";
      answer: string;
      kind: "finished" | "cap" | "text" | "aborted";
      finished: boolean;
    }
  | { type: "error"; message: string; kind: "llm" | "other" }
  | { type: "state"; patch: Partial<UIState> }
  | {
      type: "commandResult";
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    }
  | { type: "cleared" }
  | { type: "pong" }
  | { type: "serverEvent"; name: string; payload: Record<string, unknown> };

/** A client command (GUI spec §6.1). */
export type ClientCommand =
  | { type: "task"; text: string }
  | { type: "abort" }
  | { type: "switchProfile"; name: string }
  | { type: "switchModel"; ref: string }
  | { type: "clear" }
  | { type: "newSession" }
  | { type: "hooks"; enabled: boolean }
  | { type: "ping" };

/** A rendered conversation item (GUI spec §2.1.3). */
export type ConversationItem =
  | { kind: "userMessage"; text: string }
  | { kind: "assistantMessage"; text: string }
  | { kind: "reasoningBlock"; text: string }
  | { kind: "toolCall"; name: string; args: Record<string, unknown> }
  | { kind: "toolResult"; name: string; ok: boolean; summary: string }
  | { kind: "compactionNotice" }
  | { kind: "systemNotice"; text: string };

/** The non-conversation UI state (GUI spec §2.1.4). */
export interface UIState {
  activeProfile: string;
  activeModel: string | null;
  context: { promptTokens: number | null; maxContext: number };
  profiles: { name: string; origin: string }[];
  models: { name: string; baseUrl: string; providerName: string | null }[];
  skills: { name: string; description: string }[];
  hooks: { events: string[]; source: string; tools?: string[] }[];
  hooksEnabled: boolean;
  turnActive: boolean;
}

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
    const session = this.handle.session;
    return {
      activeProfile: this.handle.profile,
      activeModel: session.config.model,
      context: {
        promptTokens: session.lastPromptTokens,
        maxContext: session.config.maxContext,
      },
      profiles: this.handle.profileEntries().map((p) => ({
        name: p.name,
        origin: p.origin,
      })),
      models: this.handle.modelEntries().map((m) => ({
        name: m.name,
        baseUrl: m.baseUrl,
        providerName: m.providerName,
      })),
      skills: this.handle.skills().map((s) => ({
        name: s.name,
        description: s.description,
      })),
      hooks: this.handle.session.hooks.list().map((h) => ({
        events: h.hook.events,
        source: h.source,
        tools: h.tools,
      })),
      hooksEnabled: this.handle.session.hooks.isEnabled(),
      turnActive: this.turnActive,
    };
  }

  /** Reconstruct the conversation from session messages (GUI spec §3.8). */
  private buildHistory(): ConversationItem[] {
    const items: ConversationItem[] = [];
    for (const msg of this.handle.session.messages) {
      items.push(...this.messageToItems(msg));
    }
    return items;
  }

  /** Convert one message into zero or more conversation items. */
  private messageToItems(msg: Message): ConversationItem[] {
    switch (msg.role) {
      case "user":
        return [{ kind: "userMessage", text: msg.content ?? "" }];
      case "assistant": {
        const items: ConversationItem[] = [];
        if (msg.content)
          items.push({ kind: "assistantMessage", text: msg.content });
        for (const tc of msg.tool_calls ?? []) {
          items.push({ kind: "toolCall", name: tc.name, args: tc.arguments });
        }
        return items;
      }
      case "tool":
        return [
          {
            kind: "toolResult",
            name: msg.name ?? "tool",
            ok: !(msg.content ?? "").startsWith("Error:"),
            summary: firstLine(msg.content ?? ""),
          },
        ];
      case "system":
        // The system prompt is not part of the conversation (GUI spec §3.8:
        // history is user/assistant/tool messages only).
        return [];
    }
  }

  /** The snapshot sent on (re)connect (GUI spec §3.8). */
  private buildSnapshot(): ServerEvent {
    // Split history at the turn boundary so the in-flight buffer does not
    // duplicate committed messages (GUI spec §3.8, §4.1).
    const end = this.turnActive
      ? this.turnStartMessageCount + 1 // include this turn's user message
      : this.handle.session.messages.length;
    const items: ConversationItem[] = [];
    for (const msg of this.handle.session.messages.slice(0, end)) {
      items.push(...this.messageToItems(msg));
    }
    return {
      type: "snapshot",
      history: items,
      inflight: this.inflightBuffer,
      state: this.buildState(),
    };
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

/** True for events that belong to the in-flight turn buffer. */
function isTurnEvent(e: ServerEvent): boolean {
  return (
    e.type === "token" ||
    e.type === "reasoning" ||
    e.type === "toolCall" ||
    e.type === "toolResult" ||
    e.type === "compacting" ||
    e.type === "subagentEnd"
  );
}

/** The first non-empty line of a string (for tool-result summaries). */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? text).trim();
}

/** A minimal MIME map for the static UI assets. */
function mimeOf(filePath: string): string {
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

/**
 * The `vise serve` / `vise gui` entry point (GUI spec §3.1).
 *
 * Loads config, discovers models, resolves the starting profile, and starts
 * the agent-server. Exits non-zero on the same fatal conditions as the CLI.
 */
export async function runServer(
  port: number,
  openBrowser: boolean,
): Promise<void> {
  let graph: ResourceGraph;
  try {
    graph = await loadViseConfig();
  } catch (err) {
    if (err instanceof ViseConfigError) return fail(err.message);
    throw err;
  }

  if (graph.providers.size === 0) {
    return fail(
      "No models available. Register a provider in .vise/index.ts (e.g., " +
        "reg.addProvider(new LlamaProvider({ url: 'http://localhost:8080' }))).",
    );
  }

  const { results, totalDiscovered } = await discoverAllModels(graph);
  if (totalDiscovered === 0) {
    return fail(
      "No models available. Register a provider in .vise/index.ts (e.g., " +
        "reg.addProvider(new LlamaProvider({ url: 'http://localhost:8080' }))).",
    );
  }

  graph = addDiscoveredModels(graph, results);
  const statePath = stateFilePath();
  const starting = resolveStartingProfile(graph, statePath);
  try {
    resolveProfile(graph, starting.profile, {
      modelNameHint: starting.lastModel,
    });
  } catch (err) {
    if (err instanceof MissingMaxContextError) return fail(err.message);
    throw err;
  }

  // Locate the built UI assets (gui/dist), relative to this source file.
  // fileURLToPath handles Windows drive-letter paths correctly.
  const staticDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "gui",
    "dist",
  );

  const server = new AgentServer({
    graph,
    profile: starting.profile,
    lastModel: starting.lastModel,
    statePath,
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

/** Discover providers sequentially; failed discovery warns and continues. */
async function discoverAllModels(
  graph: ResourceGraph,
): Promise<{ results: DiscoveryResult[]; totalDiscovered: number }> {
  const results: DiscoveryResult[] = [];
  let totalDiscovered = 0;
  for (const [providerId, provider] of graph.providers) {
    let models: ModelDef[];
    try {
      models = await provider.discoverModels();
    } catch (err) {
      console.error(
        c.yellow(
          `Provider "${provider.name}" threw during discovery: ${(err as Error).message}`,
        ),
      );
      models = [];
    }
    if (models.length === 0) {
      const url = (provider as { baseUrl?: unknown }).baseUrl;
      const label =
        typeof url === "string"
          ? `'${provider.name}' (${url})`
          : `'${provider.name}'`;
      console.error(
        c.yellow(
          `Provider ${label} returned no models. Is the server running?`,
        ),
      );
    }
    results.push({ providerId, models });
    totalDiscovered += models.length;
  }
  return { results, totalDiscovered };
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
