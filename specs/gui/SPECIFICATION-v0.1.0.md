# System Specification: Vise GUI

**Version:** 0.1.0
**Date:** 2026-09-05
**Builds on:** N/A (first GUI specification; builds on the existing Vise harness, `specs/v0.1.0` … `specs/v0.6.0`)

---

## 1. Purpose and Scope

### 1.1 Purpose

Provide a **genuine graphical user interface (GUI)** for Vise — a windowed,
mouse-driven, browser-based front-end — as an **additional** interface alongside
the existing terminal REPL. The GUI lets a user drive a Vise coding-agent session
visually: submit tasks, watch the agent stream its reasoning, tool calls, and
results, switch profiles and models, inspect context usage, skills, and hooks,
and abort or reset the session — all without a terminal.

The GUI is a **separate process** that talks to a new Vise **agent-server** entry
point over a **WebSocket** protocol. The agent-server wraps the existing
side-effect-free session machinery (`createSession` / `runTurn`) and exposes it
as a live, bidirectional event stream.

### 1.2 Stakeholders

- **The developer** running Vise locally, who wants a richer, more discoverable
  interface than the REPL for day-to-day agent work.
- **The Vise codebase**, which must remain a zero-runtime-dependency Bun harness;
  the GUI must not force a build step or runtime dependency onto the core.

### 1.3 Success criteria

- A user can start the GUI with one command, open it in a browser, and complete a
  full agent task (submit → watch → finish) without touching a terminal.
- The GUI presents the **same surface as the REPL**: the live conversation
  (tokens, reasoning, tool calls/results, compaction, nested subagents) plus the
  slash-command controls (profile, model, context, skills, hooks, clear).
- The terminal REPL continues to work unchanged; the two interfaces share the
  same session state (active profile + model).
- The agent-server is a **new, separate entry point**; importing the existing
  public API (`src/index.ts`) still has no side effects and still never starts a
  session.

### 1.4 Explicitly out of scope (this version)

- **Remote / smartphone access.** The server binds to `localhost` only and uses
  no authentication. The protocol is _designed_ so a future version can expose it
  over a network (with auth) and reuse the same UI on a phone, but that is not
  required here.
- **File tree / diff viewer.** The GUI does not show the workspace file tree or
  render diffs of the agent's edits.
- **Multiple concurrent sessions.** One agent-server process hosts exactly one
  session.
- **Initial task on launch.** The first task is always typed into the input box;
  there is no `vise gui "task"` positional or `?task=` URL parameter.

---

## 2. Domain Model

The GUI's domain model is a **projection** of the existing Vise domain model
(`Session`, `Message`, `ToolCall`, `Profile`, `Model`, `Skill`, `Hook` in
`src/types.ts` and `src/profiles/`) plus a small set of GUI/protocol-specific
entities. The GUI never redefines Vise's domain types; it renders them.

### 2.1 Entities

#### 2.1.1 `AgentServer` (server-side)

The long-lived process that owns one session. Responsibilities:

- Load the resource graph (`loadViseConfig`), discover models
  (`discoverAllModels`), and resolve the starting profile/model — the same
  startup sequence as `src/cli.ts`.
- Own the single `SessionHandle` (`createSession`).
- Serve the UI (static assets in production; proxied by Vite in development).
- Accept one WebSocket connection at a time (see §3.2, connection model).
- Translate `AgentCallbacks` / `SubagentRender` events into protocol events and
  push them to the connected client.
- Translate protocol commands into session operations (`runTurn`,
  `switchProfile`, `switchModel`, abort, clear, hooks on/off).

#### 2.1.2 `Connection` (server-side)

The single active WebSocket connection. States:

- `disconnected` — no client connected; the session persists and any in-flight
  turn continues (§4.1).
- `connected` — a client is attached and receiving the live event stream.

There is at most **one** `connected` client at a time. A second client connecting
while one is attached is handled per §4.2.

#### 2.1.3 `Conversation` (client-side view model)

The ordered, rendered sequence of conversation items the UI displays. An item is
one of:

- `userMessage` — a task the user submitted.
- `assistantMessage` — the agent's answer (rendered as Markdown).
- `reasoningBlock` — a collapsible block of the agent's reasoning (rendered as
  Markdown).
- `toolCall` — `→ name(args)`, optionally with a nested subagent subtree.
- `toolResult` — `✓/✗ name: summary`.
- `compactionNotice` — the "compacting…" marker.
- `subagentBlock` — a nested container for a subagent's items, keyed to its
  parent `spawn_subagent` tool call and its depth.
- `systemNotice` — an error or interrupt notice.

#### 2.1.4 `UIState` (client-side)

The non-conversation state the UI tracks:

- `activeProfile: string`
- `activeModel: string | null`
- `context: { promptTokens: number | null; maxContext: number }`
- `profiles: ProfileEntry[]` (name + origin)
- `models: ModelListEntry[]` (name + origin)
- `skills: Skill[]` (name + description)
- `hooks: HookInfo[]` (active hooks for the current profile)
- `hooksEnabled: boolean`
- `turnActive: boolean` (a turn is currently running)
- `connection: "connected" | "reconnecting" | "disconnected"`

#### 2.1.5 `UIPreferences` (client-side, persisted)

Browser-local preferences, stored in `localStorage` (§6.3):

- `theme: "light" | "dark" | "system"`
- `layout` / panel visibility (e.g. whether the side panel is open)
- `fontSize` (optional)

These are **not** part of the shared state file.

### 2.2 Relationships

- `AgentServer` **owns** one `SessionHandle` and at most one `Connection`.
- `Connection` **carries** a bidirectional stream: protocol **commands**
  (client → server) and protocol **events** (server → client).
- `Conversation` is **derived from** the event stream (and, on reconnect, from
  the snapshot).
- A `subagentBlock` **belongs to** exactly one `toolCall` (the `spawn_subagent`
  call) and is **ordered by** its `depth`.
- `UIState` is **synchronized from** the server via the `snapshot` and `state`
  events.

### 2.3 State Transitions

#### 2.3.1 Turn lifecycle (server)

```
idle ──task──▶ running ──finish/cap/text──▶ idle
                  │
                  ├──abort──▶ idle (turnEnd kind="aborted")
                  └──LLM error──▶ idle (error event, then idle)
```

- `idle`: no turn in progress; the session accepts a `task`.
- `running`: a turn is in progress; `task` and `switchProfile`/`switchModel` are
  rejected (commands run only between turns, matching the REPL — profiles spec
  §4). `abort` is accepted.
- On any terminal transition the server emits `turnEnd` and returns to `idle`.

#### 2.3.2 Connection lifecycle (server)

```
disconnected ──client connects──▶ connected
connected ──client disconnects──▶ disconnected   (session + turn persist)
disconnected ──client reconnects──▶ connected     (snapshot, then live)
```

---

## 3. Functional Requirements

### 3.1 Server: startup

The agent-server entry point (a new executable, e.g. `src/server.ts`, invoked by
`vise serve` / `vise gui`) **must**:

1. Parse its own arguments (`--port`, and the `gui` vs `serve` mode).
2. Load the resource graph via `loadViseConfig()`.
3. Discover models via the same sequential discovery as `src/cli.ts`
   (`discoverAllModels`): a provider that throws or returns no models **warns to
   stderr and continues**; if **zero** models are discovered across all providers,
   the server **exits with a fatal error** (same message and exit code as the CLI).
4. Resolve the starting profile and model from the shared state file
   (`resolveStartingProfile` / `resolveProfile`), applying the same fatal errors
   as the CLI (`MissingMaxContextError`, "no available models").
5. Create the single `SessionHandle` via `createSession`, wiring its
   `AgentCallbacks` and `SubagentRender` to the protocol event emitter (§3.3).
6. Begin serving: the WebSocket endpoint and (in production) the static UI
   assets, on the configured port (§3.5).
7. Print the URL to stdout (e.g. `Vise GUI: http://localhost:8787`).

The server **must not** read from or write to `stdin` (it is not a REPL). It
**must** keep running after the browser disconnects (§4.1).

### 3.2 Server: connection model

- The server accepts **one** WebSocket connection at a time.
- On a new connection while one is already attached, the server **must** close
  the **older** connection (so the most recent client wins) and attach to the new
  one, sending it a fresh `snapshot`. This supports the "open in a second tab /
  reconnect" case without data loss.
- The WebSocket endpoint path **must** be stable and documented (e.g.
  `/ws`). The same origin also serves the UI (production) or is proxied by Vite
  (development).

### 3.3 Server: event emission

The server **must** translate the session's live output into protocol events and
push them to the connected client, in order, on the single WebSocket channel:

| Source (existing)                                               | Protocol event                           | Notes                                                |
| --------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `AgentCallbacks.onToken`                                        | `token`                                  | Main-agent streamed answer token.                    |
| `AgentCallbacks.onReasoning`                                    | `reasoning`                              | Main-agent reasoning token (display-only).           |
| `AgentCallbacks.onToolCall`                                     | `toolCall`                               | Main-agent tool call.                                |
| `AgentCallbacks.onToolResult`                                   | `toolResult`                             | Main-agent tool result.                              |
| `AgentCallbacks.onCompacting`                                   | `compacting`                             | Main-agent compaction notice.                        |
| `SubagentRender` (`token`/`toolCall`/`toolResult`/`compacting`) | same-named event with a subagent `scope` | Nested under the parent `spawn_subagent` call.       |
| `SubagentRender` (`end`)                                        | `subagentEnd`                            | Carries `ok`, `label`, `depth`.                      |
| `runTurn` result (`TurnResult`)                                 | `turnEnd`                                | Carries `answer`, `kind`, `finished`.                |
| `LLMError` / other turn error                                   | `error`                                  | Carries `message` and `kind` (`"llm"` \| `"other"`). |
| Abort (Ctrl-C equivalent)                                       | `turnEnd` with `kind: "aborted"`         | The turn is interrupted; foreground command killed.  |
| Profile/model switch, context update, hooks on/off              | `state`                                  | Carries the changed `UIState` fields.                |
| Command that produces a list or a failure                       | `commandResult`                          | e.g. profile/model list, or a switch error.          |
| (Future) background task / background subagent                  | `serverEvent`                            | Reserved extension point (§3.6).                     |

**Scope.** Every streamed event carries a `scope` identifying which agent
produced it:

- Main agent: `scope: { kind: "main" }`.
- Subagent: `scope: { kind: "subagent", id: string, depth: number }`, where
  `id` correlates the subagent's events to the parent `spawn_subagent` `toolCall`
  (the client nests the subagent block under that tool call) and `depth` is the
  nesting depth (1 for a direct child).

**Ordering.** Because all events travel one ordered WebSocket channel, the client
renders them in arrival order. The server **must not** reorder or batch in a way
that changes the observable order of a turn's events.

### 3.4 Server: command handling

The server **must** accept the following commands from the client and act on the
session:

| Command                  | Effect                                                                    | On success                                                                                                                                  | On failure                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `task { text }`          | Start a turn (`runTurn`) with `text`.                                     | Stream events; end with `turnEnd`.                                                                                                          | If a turn is already running → `commandResult` error (rejected).                                                                              |
| `abort`                  | Abort the current turn (AbortController) and kill the foreground command. | `turnEnd` with `kind: "aborted"`.                                                                                                           | If no turn is running → ignored (no-op).                                                                                                      |
| `switchProfile { name }` | `handle.switchProfile(name)`.                                             | `state` with new profile + re-resolved model.                                                                                               | `commandResult` error (`UnknownProfileError` / `ProfileHasNoModelError` / `MissingMaxContextError`); session untouched.                       |
| `switchModel { ref }`    | `handle.switchModel(ref)`.                                                | `state` with new model.                                                                                                                     | `commandResult` error (`UnknownModelError` / `AmbiguousModelError` / `ModelNotAvailableError` / `MissingMaxContextError`); session untouched. |
| `clear`                  | Clear the conversation (drop all messages, keep the system prompt).       | `state` (context reset) + a `cleared` marker event.                                                                                         | —                                                                                                                                             |
| `newSession`             | Reset the conversation in place (clear messages; keep profile/model).     | Same as `clear` (in this version, `newSession` and `clear` are equivalent; the distinction is reserved for future per-session persistence). | —                                                                                                                                             |
| `hooks { enabled }`      | Enable/disable all hooks for the rest of the session (`/hooks off\|on`).  | `state` with `hooksEnabled`.                                                                                                                | —                                                                                                                                             |
| `ping`                   | Keepalive.                                                                | `pong` event.                                                                                                                               | —                                                                                                                                             |

Commands that change profile/model **must** be rejected while a turn is running
(commands run only between turns, matching the REPL).

### 3.5 Server: serving the UI

- **Production:** the agent-server serves the built UI (the Vite output
  directory, e.g. `gui/dist`) as static files and the WebSocket on the **same
  port** (single origin, no CORS).
- **Development:** the Vite dev server (with HMR) serves the UI on its own port
  and **proxies** the WebSocket and any HTTP API to the agent-server. The browser
  sees a single origin (Vite's); there is no CORS.
- The server **must** respond to `GET /` (and the SPA fallback) with the UI's
  `index.html` so the app is a single-page application.

### 3.6 Server: server-initiated events (extension point)

The protocol **must** treat **server-initiated events as first-class**: the
server may push an event at any time without a preceding client request. In this
version the only server-initiated events are the normal turn events (which are
themselves a response to a `task`, but are pushed, not polled). The protocol
**must** reserve a `serverEvent` message type so that future server-initiated
events — a backgrounded/timed-out command, parallel or background subagents —
can be added **without a protocol break**. The client **must** ignore
unrecognized event types gracefully (forward-compatibility).

### 3.7 Client: connection and lifecycle

The browser UI **must**:

1. Connect to the WebSocket on load.
2. On connect/reconnect, receive a `snapshot` (§3.8) and render the full
   conversation + state, then continue rendering live events.
3. On disconnect, set `connection` to `"reconnecting"` and attempt to
   re-establish the WebSocket (with backoff). On successful reconnect, re-render
   from the new `snapshot`.
4. Reflect `connection` state in the UI (e.g. a banner when disconnected).

### 3.8 Client: snapshot (reconnect payload)

On every (re)connect, the server **must** send a `snapshot` event containing:

- `history` — the full conversation, reconstructed from `session.messages`
  (all user/assistant/tool messages, including assistant `tool_calls` and tool
  results). Display-only **reasoning** from before the reconnect is **not**
  recoverable (it was never persisted) and is therefore omitted; reasoning
  resumes live after the snapshot.
- **In-flight turn buffer** — if a turn is running, the events already emitted
  for that turn (tokens/reasoning/tool events so far), so a mid-turn reconnect
  shows the partial output and then continues live.
- `state` — the current `UIState` (active profile/model, context, profiles,
  models, skills, hooks, `hooksEnabled`, `turnActive`).

### 3.9 Client: conversation rendering

The UI **must** render the `Conversation` as a scrollable, structured view:

- **Answer** and **reasoning** are rendered as **Markdown** (code blocks, lists,
  headings, etc.). Reasoning is shown in a **collapsible** block, visually
  distinct from the answer (e.g. dimmed / labeled "thinking").
- **Tool calls** render as `→ name(args)`; **tool results** as `✓/✗ name:
summary`.
- **Subagent** output renders as a nested block under its parent
  `spawn_subagent` tool call, indented by `depth`.
- **Compaction** renders as a notice line.
- **Errors / interrupts** render as a distinct system notice.
- The view auto-scrolls to the newest item while the user is at the bottom; it
  must not yank the view if the user has scrolled up to read.

### 3.10 Client: controls (dedicated UI)

The UI **must** expose the REPL's slash commands as **dedicated controls**
(not a `/command` text box):

- **Profile** — a selector listing `profileEntries()` (name + origin); selecting
  one sends `switchProfile`. The active profile is marked.
- **Model** — a selector listing `modelEntries()` (name + origin); selecting one
  sends `switchModel`. The active model is marked.
- **Context** — a readout of `promptTokens` vs `maxContext` (e.g. a bar or
  `12,340 / 131,072 tokens`), updated after each turn.
- **Skills** — a panel listing `skills()` (name + description).
- **Hooks** — a panel listing the active hooks for the current profile, plus an
  enable/disable toggle (sends `hooks`).
- **Clear / New session** — a button that sends `newSession` (and, equivalently,
  `clear`).
- **Abort** — a button (enabled only while `turnActive`) that sends `abort`.
- **Task input** — a text box + submit that sends `task`. Disabled while a turn
  is running (or shows a "running" state).

### 3.11 Client: preferences

The UI **must** persist `UIPreferences` (theme, layout, panel visibility) in
`localStorage` and restore them on load. Theme **must** support light, dark, and
"system" (follow the OS).

---

## 4. Edge Cases and Error Handling

### 4.1 Browser disconnects mid-turn

- The session and the in-flight turn **continue** server-side, unaffected by the
  browser.
- On reconnect, the client receives a `snapshot` including the in-flight turn
  buffer (§3.8) and resumes live.
- The server **must not** abort, pause, or otherwise alter the turn because the
  client disconnected.

### 4.2 A second client connects while one is attached

- The server closes the **older** connection and attaches to the newer one,
  sending it a fresh `snapshot`. No data is lost (the session persists).

### 4.3 No provider / no models at startup

- Identical to the CLI: a provider that fails discovery warns and continues; if
  **zero** models are discovered, the server exits with a fatal error and a
  non-zero exit code. The UI is never served in this case.

### 4.4 Config conflict / invalid config

- A "Config conflict" or other `ViseConfigError` is fatal at startup, exactly as
  in the CLI (the server exits before serving).

### 4.5 LLM / server error mid-turn

- An `LLMError` (connectivity) is surfaced to the client as an `error` event with
  `kind: "llm"`, the turn ends, and the session returns to `idle`. The
  conversation so far is preserved.
- Any other unexpected turn error is surfaced as `error` with `kind: "other"`.

### 4.6 Abort mid-turn

- `abort` interrupts the current turn and kills any running foreground command
  (the Ctrl-C behavior). The client receives `turnEnd` with `kind: "aborted"`.
- Aborting when no turn is running is a no-op.

### 4.7 Profile/model switch with no available model

- `switchProfile`/`switchModel` that resolves to no model (or an unknown
  profile/model, or an ambiguous model ref) is **rejected**: the server emits a
  `commandResult` error and leaves the session untouched. The UI shows the error
  and keeps the previous selection.

### 4.8 Command sent while a turn is running

- `task`, `switchProfile`, and `switchModel` sent while `turnActive` are
  rejected with a `commandResult` error. `abort` and `ping` are always accepted.

### 4.9 Malformed command from the client

- A command with a missing/invalid field is rejected with a `commandResult`
  error naming the problem. The server **must not** crash on malformed input.

### 4.10 Server restart while the browser is open

- The browser detects the WebSocket close, shows a "disconnected / reconnecting"
  state, and keeps retrying. When the server is back, it reconnects and receives
  a fresh `snapshot` (a new session, since the server process restarted).

### 4.11 Unrecognized event type (forward compatibility)

- The client **must** ignore any event type it does not recognize, so that
  future server-initiated events (§3.6) do not break an older client.

### 4.12 Reasoning not recoverable on reconnect

- Documented behavior: reasoning streamed before a reconnect is not in the
  snapshot (it was never persisted). This is acceptable and must not be treated
  as an error.

---

## 5. Non-Functional Requirements

- **Performance (streaming):** streamed tokens must appear in the UI with low
  perceived latency (no per-token full re-render jank). The UI must batch/coalesce
  high-frequency token events so that a fast stream does not cause layout
  thrash. Target: smooth rendering at typical LLM token rates on a modern laptop.
- **Performance (reconnect):** a reconnect + snapshot render must complete quickly
  for a conversation of at least a few hundred messages.
- **Security:** the server binds to `127.0.0.1` only and uses **no
  authentication**. This is acceptable because the port is not reachable
  off-machine. The spec **must** document this as a known limitation (any local
  process or browser extension can reach the port). No secrets (API keys) are
  sent to the browser; they remain server-side in the session config.
- **Availability:** the server must keep running across browser disconnects
  (§4.1). A single crash of the server ends the session (the user restarts it).
- **Compatibility:** modern evergreen browsers (current Chrome, Edge, Firefox,
  Safari). No legacy-browser support is required.
- **Accessibility:** the UI should meet **WCAG 2.1 AA** for the core flows
  (keyboard-operable controls, sufficient color contrast, focus management on the
  conversation and controls). This is a target, not a hard gate, for v0.1.0.
- **Core purity:** the agent-server and the existing public API must preserve the
  invariant that importing `src/index.ts` has **no side effects** and never starts
  a session. The GUI must not add a runtime dependency to the Bun core; the UI's
  build toolchain (Vite/Solid) is a separate concern from the core.

---

## 6. Data Requirements

### 6.1 Protocol message format

All protocol messages are **JSON objects** sent as WebSocket text frames. Every
message has a `type` string discriminator.

**Client → server (commands):**

```jsonc
{ "type": "task",          "text": string }
{ "type": "abort" }
{ "type": "switchProfile", "name": string }
{ "type": "switchModel",   "ref": string }
{ "type": "clear" }
{ "type": "newSession" }
{ "type": "hooks",         "enabled": boolean }
{ "type": "ping" }
```

**Server → client (events):**

```jsonc
{ "type": "snapshot", "history": ConversationItem[], "inflight": Event[], "state": UIState }
{ "type": "token",      "scope": Scope, "text": string }
{ "type": "reasoning",  "scope": Scope, "text": string }
{ "type": "toolCall",   "scope": Scope, "name": string, "args": object }
{ "type": "toolResult", "scope": Scope, "name": string, "ok": boolean, "summary": string }
{ "type": "compacting", "scope": Scope }
{ "type": "subagentEnd","scope": Scope, "ok": boolean, "label": string, "depth": number }
{ "type": "turnEnd",    "answer": string, "kind": "finished"|"cap"|"text"|"aborted", "finished": boolean }
{ "type": "error",      "message": string, "kind": "llm"|"other" }
{ "type": "state",      "patch": Partial<UIState> }
{ "type": "commandResult", "ok": boolean, "error"?: string, "data"?: object }
{ "type": "cleared" }
{ "type": "pong" }
{ "type": "serverEvent", "name": string, "payload": object }   // reserved (§3.6)
```

Where:

```jsonc
type Scope = { "kind": "main" }
            | { "kind": "subagent", "id": string, "depth": number }
```

The exact field names are normative for the v0.1.0 protocol; adding new fields or
new `type` values is a non-breaking change, and the client must tolerate unknown
types (§4.11).

### 6.2 Shared state file

- The GUI **shares** the existing state file (`.vise/state.json` or
  `~/.vise/state.json`) for **session state**: the active profile and active
  model. The server reads it at startup (`resolveStartingProfile`) and writes it
  back on a clean exit (`writeStateFile`), exactly as the REPL does, so the REPL
  and GUI agree on the active profile/model.
- A clean exit is: the server process is stopped normally (e.g. Ctrl-C in the
  terminal running `vise serve`/`vise gui`). The server must write the state file
  on that path.

### 6.3 Browser-local storage

- `UIPreferences` (theme, layout, panel visibility) are stored in the browser's
  `localStorage`, namespaced (e.g. a `vise.gui.*` key prefix). They are **not**
  written to the shared state file.

### 6.4 Retention

- Conversation history lives only in the server process's memory for the life of
  the session; it is not persisted to disk in this version.
- The shared state file retains only the active profile + model (existing
  behavior).

---

## 7. External Dependencies

- **The LLM server** — a running OpenAI-compatible endpoint, as in the existing
  Vise (no change).
- **Bun 1.3+** — the runtime for the agent-server (no change to the core).
- **Solid.js** — the UI framework (client-side only).
- **Vite** — the UI build tool and dev server (client-side only; provides HMR in
  development).
- **A Markdown renderer** — for rendering answers and reasoning (client-side
  only; a small, standard library).

None of the client-side dependencies are runtime dependencies of the Bun core.

---

## 8. Constraints and Assumptions

- **Runtime:** Bun 1.3+. The agent-server is a new executable entry point in the
  existing TypeScript source tree; it reuses `loadViseConfig`,
  `discoverAllModels`, `createSession`, and `runTurn` unchanged.
- **No build step for the core.** The core remains no-build; only the UI has a
  build step (Vite), and its output is served as static files.
- **localhost only, no auth** (this version). Remote/phone access is a future
  version; the protocol is designed to allow it.
- **One session per server process.**
- **Commands run only between turns** (inherited from the REPL / profiles spec
  §4).
- **The public API stays side-effect-free.** Adding the agent-server must not
  cause `import "vise"` (i.e. `src/index.ts`) to start a session or touch stdin.
- **Assumption:** the user runs the server and the browser on the same machine
  (localhost). The phone scenario is explicitly out of scope.

---

## 9. Acceptance Criteria

Each criterion is verifiable. Integration tests may drive the agent-server against
the existing mock OpenAI-compatible SSE server (as `test/integration.test.ts`
does for the REPL).

1. **Startup:** `vise serve` (and `vise gui`) loads config, discovers models, and
   prints the URL `http://localhost:8787` (or the `--port` override). With no
   provider / zero models, it exits non-zero with the same fatal message as the
   CLI.
2. **Serving:** in production, `GET /` returns the UI's `index.html`; the
   WebSocket endpoint accepts a connection. In development, the Vite dev server
   proxies the WebSocket to the agent-server.
3. **Task round-trip:** sending a `task` produces, in order, the expected
   `token`/`reasoning`/`toolCall`/`toolResult`/`compacting` events and a final
   `turnEnd` with the correct `kind` and `answer` — matching what the REPL would
   render for the same mock response.
4. **Subagent nesting:** a `spawn_subagent` tool call is followed by subagent
   events carrying a subagent `scope` (correct `id` and `depth`) and a
   `subagentEnd`; the client nests them under the parent tool call.
5. **Profile switch:** `switchProfile` to a valid profile emits `state` with the
   new profile and re-resolved model; to an unknown profile emits a
   `commandResult` error and leaves the session untouched.
6. **Model switch:** `switchModel` to a valid ref emits `state` with the new
   model; an ambiguous/unknown ref emits a `commandResult` error.
7. **Context readout:** after a turn, `state` reflects `promptTokens` and
   `maxContext` from the last LLM call.
8. **Abort:** `abort` during a running turn ends the turn with `turnEnd`
   `kind: "aborted"` and kills the foreground command; `abort` when idle is a
   no-op.
9. **Disconnect mid-turn:** closing the WebSocket does not stop the turn; the
   turn completes server-side. On reconnect, the `snapshot` includes the
   in-flight turn buffer and the current `state`.
10. **Reconnect snapshot:** a fresh connection receives a `snapshot` whose
    `history` matches `session.messages` (user/assistant/tool, including
    `tool_calls`) and whose `state` matches the live session; pre-reconnect
    reasoning is absent.
11. **Second client:** a second connection while one is attached closes the older
    connection and serves the newer one a `snapshot`.
12. **Clear / new session:** `newSession` (and `clear`) empties the conversation
    and emits `cleared` + a reset `state`; the profile/model are retained.
13. **Hooks toggle:** `hooks { enabled: false }` disables hooks for the session
    and emits `state` with `hooksEnabled: false`.
14. **Command gating:** `task`/`switchProfile`/`switchModel` sent while a turn is
    running are rejected with a `commandResult` error.
15. **Malformed command:** a command with a missing/invalid field yields a
    `commandResult` error and does not crash the server.
16. **Forward compatibility:** the client ignores an unrecognized event type
    (e.g. a `serverEvent`) without error.
17. **State sharing:** after a clean server exit, the shared state file contains
    the active profile + model, and the REPL starts under the same profile/model.
18. **Core purity:** importing `src/index.ts` starts no session and touches no
    stdin (regression test), and the core has no new runtime dependency.
19. **Preferences:** the UI persists and restores theme/layout in
    `localStorage`; theme supports light/dark/system.

---

## 10. Open Questions

None. All sections are specified. (Items deliberately deferred to a future
version — remote/phone access with authentication, file tree/diff viewer,
multiple concurrent sessions, and concrete server-initiated background events —
are listed in §1.4 as out of scope, not as open questions.)
