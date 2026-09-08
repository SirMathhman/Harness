# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

**Vise** is a local, self-contained LLM coding-agent harness. It runs a coding agent in a
tool-calling loop against any OpenAI-compatible `POST /v1/chat/completions` endpoint
(llama.cpp, OpenRouter, Ollama, vLLM, …). Everything the agent can do — system prompt,
tools, lifecycle hooks, models — is described by TypeScript config files as a graph of
**resources** connected by **edges**.

## Runtime & build

- **Runtime: Bun 1.3+.** Both the harness and its config files execute TypeScript
  directly from source. **There is no build step and no Node runtime.**
- **No runtime dependencies.** Only Node built-ins: `fetch`, `node:child_process`,
  `node:fs`, `node:path`, `node:util`, `node:readline`, `node:os`,
  `node:url`, `node:dns`.
- `src/cli.ts` is the executable entry (`bin: vise`). `src/index.ts` is the
  side-effect-free public API that `.vise/index.ts` imports.

## Commands

| Command             | Purpose                                            |
| ------------------- | -------------------------------------------------- |
| `bun run dev`       | Run the agent from source (`src/cli.ts`)           |
| `bun run start`     | Same as `dev`                                      |
| `bun run gui`       | Start the agent-server and open the GUI            |
| `bun run serve`     | Start the headless agent-server (prints URL)       |
| `bun run gui:dev`   | Run the agent-server + Vite dev server in parallel |
| `bun run test`      | Run the full suite (unit + integration)            |
| `bun run lint`      | Lint with ESLint                                   |
| `bun run lint:fix`  | Lint and auto-fix                                  |
| `bun run typecheck` | Type-check without emitting (`tsc --noEmit`)       |

Run `bun run typecheck` and `bun run test` after making changes. Integration tests drive
the real agent loop against a mock OpenAI-compatible SSE server, so no llama.cpp instance
is required.

**Use `bun run test`, not bare `bun test`.** The script passes
`--conditions=browser`, which makes `solid-js` resolve to the same build the GUI ships;
under Bun's default `node` condition it resolves to the non-reactive SSR build and the
GUI tests assert against a reactivity graph that never updates. `bunfig.toml` separately
confines test discovery to `test/`, keeping the GUI's Playwright specs (which use
`*.spec.ts`, a pattern Bun 1.3 _does_ collect) out of the Bun suite.

The GUI has its own checks, run from `gui/`: `bunx tsc --noEmit -p tsconfig.json`,
`bun run build`, and `bun run test:browser` (Playwright; `bun run test:browser:install`
once to fetch Chromium). The root typecheck does not cover `gui/` — its tsconfig only
includes `src/**/*.ts`.

## TypeScript / lint conventions

- `tsconfig.json`: `strict`, `module: NodeNext`, `moduleResolution: NodeNext`,
  `noEmit`, `target: ES2022`.
- **Import specifiers use the `.js` extension** even though the source files are `.ts`
  (e.g. `import { x } from "./utils.js"`). This is required by `NodeNext` resolution.
  Do not "fix" these to `.ts` — they are correct.
- ESLint uses `typescript-eslint` recommended. `no-explicit-any` is **off**;
  `no-unused-vars` is a **warn** with `^_` prefix ignored.

## Directory layout

```
src/
  cli.ts            # Executable entry: parse args, route serve/gui, start REPL
  index.ts          # Side-effect-free public API (types + LlamaProvider + runCommand)
  startup.ts        # prepareSession() — the shared startup seam (config→models→profile)
  command.ts        # runCommand hook helper + runForeground (shared foreground runner)
  types.ts          # Core domain types (Message, ToolCall, Tool, Config, Session, …)
  utils.ts          # truncate, resolvePath, resolveShell, looksBinary, newId, homeDir
  agent/            # loop.ts (runTurn), session.ts, subagent.ts
  llm/              # client.ts (serialize seam), sse.ts (parse seam), errors.ts
  tools/            # registry, dispatch, execute (ordering), fileTools, commands,
                    # search, finish, spawnSubagent, webTools, metaTools, catalog,
                    # names, skills (list_skills/read_skill + the skill index)
  context/          # compaction.ts (token accounting + recap/truncation)
  hooks/            # manager.ts, types.ts, index.ts (lifecycle dispatch)
  profiles/         # registry, load, resolve, validate, types, index
  sessions/         # store.ts (save/load/list/rename/delete + autoSaveLast), index.ts
  providers/        # llamaProvider.ts, types.ts, index.ts
  config/           # defaults.ts (built-in prompt/runtime/config defaults)
  server/           # agent-server: protocol, server, translate, transport, entry
  cli/              # args, repl, commands, render, color
gui/                # SolidJS + Vite browser client
  src/              # main.tsx, App.tsx, store.ts, Markdown.tsx, client.ts, types.ts, styles.css
    conversation/   # ConversationViewport.tsx, viewModel.ts, eventQueue.ts
  e2e/              # Playwright browser specs + the mock-WebSocket fixture
test/               # *.test.ts (unit + integration), helpers.ts
specs/              # v0.1.0/ … v0.10.0/ + gui/ — the specification documents
.vise/              # project-level config (index.ts) + sessions/ (gitignored)
```

## Architecture: the resource graph

Configuration is a graph. **Resources are nodes; connections are directed edges.**
Resolving a profile means following its outgoing edges.

- **Edge types (only these are valid):** Profile→Hook, Profile→Tool, Profile→Model,
  Hook→Tool. Any other pairing is a fatal config error.
- **Defaults from absence of edges:**
  - Profile with **no tool edges** → gets **every** built-in tool. With tool edges →
    exactly those. A profile that enumerates tools **must** include `finish`, or it is a
    fatal config error.
  - Profile with **no hook edges** → no hooks. Hooks are never global.
  - Profile with **no model edge** → sees every model allowed by its `models` whitelist.

`ResourceId` is opaque — it only comes from a `create*` call, a `get*` lookup, or
`reg.builtins`, so a connection can never point at something that doesn't exist. A `get*`
lookup can return `undefined`; passing that into `createConnection` without checking is a
descriptive error.

## Key invariants (do not break)

- **Error semantics:** tool errors and malformed calls are returned to the model as
  **result strings** (the agent self-corrects). Only LLM/server connectivity errors
  (`LLMError`) abort the turn. Never throw a tool error up to the loop.
- **Tool execution ordering:** mutating tools (`write_file`, `edit_file`, `run_command`)
  run **sequentially** in model order; read-only tools run **concurrently**. Results are
  always returned in the **original tool-call order**. A blocked call still occupies its
  slot. The one exception: `spawn_subagent` is read-only (concurrent) _unless_ the active
  model's provider sets `serializeSubagents` — KV persistence needs one subagent at a
  time (KV spec §3.7).
- **`finish` is terminal** unless a `turn:end` hook rejects it; a rejection becomes the
  finish call's tool result and the loop continues so the model can retry.
- **Hooks are synchronous only**, except the four subagent events — `subagent:before`,
  `subagent:after`, `subagent:turn:start`, `subagent:turn:end` — whose handlers may be
  async and are awaited by `HookManager.dispatchAsync` (KV spec §8.1; v0.6.0 spec §2.3).
  On the other seven events a returned Promise is an unsupported result (a warning).
  The two subagent-side events (`subagent:turn:start` / `subagent:turn:end`) fire on the
  subagent's own hook manager and require `includeSubagents: true` (v0.6.0 spec §3.6).
  A handler that throws blocks the event (or becomes advisory on a non-blocking event),
  is logged to stderr, and does not stop the remaining hooks.
- **Hooks are per-profile**, except those a **provider** contributes via `Provider.hooks()`:
  those are merged into every session at every depth (KV spec §8.2). Providers are still
  config-time conventions, not graph nodes.
- **`src/index.ts` must stay side-effect-free.** Importing it from `.vise/index.ts` must
  never launch a session or touch stdin.
- **The wire seam is one in, one out.** The internal `Message`/`ToolCall` domain model
  (`src/types.ts`) is converted to the OpenAI wire shape at exactly one serialize seam
  (`toWireMessage` in `src/llm/client.ts`) and parsed back at exactly one parse seam
  (`accumulate` in `src/llm/sse.ts`). No other module reads or writes the wire format.
  The wire shape (assistant `tool_calls` as `{ type: "function", id, function: { name,
arguments } }` with `arguments` a JSON _string_) must never leak into the domain model,
  and the domain model must never be sent to the backend verbatim. A new backend plugs in
  by adding a second serialize/parse seam pair behind the `LLMClient` port, not by editing
  the domain types.

## Architecture: the agent-server & GUI

The agent-server (`src/server/`) is a second presentation entry that owns one session and
exposes it over a WebSocket, mirroring the REPL. It reuses the same session machinery
(`createSession` + `runTurn`) and the same startup seam (`prepareSession()` in
`src/startup.ts`) — a UI and a terminal never fork the config/state logic.

- **`src/server/protocol.ts` is a pure wire boundary** — it imports nothing from
  `src/agent` or `src/types`. It owns the `ServerEvent` / `ClientCommand` / `Scope` /
  `ConversationItem` / `UIState` type family. The GUI client (`gui/src/types.ts`) mirrors
  these types **by hand** and is never the source of truth.
- **The protocol is additive-only.** The client ignores unknown event types, so protocol
  extensions must be additive to keep older clients working. When you change the protocol,
  update both `src/server/protocol.ts` and `gui/src/types.ts` together.
- **Single-client eviction:** a second WebSocket client evicts the older one. The session
  keeps running after the browser disconnects; on (re)connect the server sends a
  `snapshot` (built by `buildSnapshot` in `translate.ts`) that splits history at the turn
  boundary so in-flight events don't duplicate committed messages.
- **Subagent scope correlation** mints a stable id per depth (a `Map<number, string>`)
  because the `SubagentRender` callback carries no id. Invariant: at most one concurrent
  subagent per depth (holds because `spawn_subagent` is serialized per depth).
- **Static UI serving:** the server serves `gui/dist` (SPA fallback to `index.html`; 503
  if not built). In dev, Vite (port 5173) proxies `/ws` to the agent-server (port 8787).
- **`gui/AGENTS.md` is required reading before changing the browser client.** It
  documents the five invariants of the bounded-rendering design, the traps that have
  already cost real debugging time (Solid's `<template>` breaking the virtualizer's
  observers, Bun resolving solid-js's non-reactive SSR build, Bun collecting
  `*.spec.ts`), a browser debugging harness, and a failure-signature table.
- **Bounded conversation rendering (v0.7.0).** The client renders the conversation
  through a virtual viewport, so work is bounded by the window and by the rows that
  changed — never by the length of the history, which is kept in full. Three rules hold
  it together, and breaking any one of them silently restores O(history) rendering:
  - `gui/src/store.ts` keeps rows in a **`solid-js/store`** and appends text with a path
    write (`setDoc("rows", i, "item", "text", …)`). It must never copy the rows array or
    replace a row object: doing so changes every row's identity and remounts the history.
    The block sequence is maintained _incrementally_ beside the rows, so a text delta
    cannot invalidate it.
  - `gui/src/conversation/viewModel.ts` flattens blocks into a linear list of render
    items and reads **structure only** — never a row's text. It also owns expand/collapse
    state, keyed by row/run id: virtualized rows unmount, so state stored inside a row
    component would be lost on scroll.
  - `gui/src/conversation/ConversationViewport.tsx` publishes its scroll element from
    `onMount`, **not** from the `ref` callback. Solid builds its DOM inside a
    `<template>`, whose content document has a null `defaultView`; the virtualizer reads
    that to find its target window and silently installs no observers when it is null,
    leaving the list permanently unmeasured and empty.
- **Event scheduling:** `gui/src/conversation/eventQueue.ts` applies incoming events on
  an animation frame. It merges only _adjacent_ stream events of the same scope and kind,
  flushes pending work before any non-stream event, and treats `snapshot`/`cleared` as
  reset barriers that discard superseded pending events. `createStore.applyEvent` stays
  synchronous for direct consumers and tests.
- **`src/startup.ts` `prepareSession()` is the single startup seam** both `src/cli.ts`
  `main()` and `src/server/entry.ts` `runServer()` call. It owns every fatal condition
  (no provider, no models, unresolvable profile). A new presentation surface calls it,
  never re-copies the startup prefix.

## Testing

- `bun run test` runs everything. Tests live in `test/*.test.ts` with shared `helpers.ts`.
- Integration tests spin up a **mock OpenAI-compatible SSE server** (fixture responses)
  and drive the full agent loop — no real model needed.
- The README maps each acceptance criterion (spec §9) to a specific test file. When adding
  behavior, add or extend the corresponding test.

## Gotchas

- **No provider → fatal at startup.** A config must register at least one provider
  (e.g. `reg.addProvider(new LlamaProvider({ url: "http://localhost:8080" }))`), or Vise
  exits with "No models available". There is no built-in default model.
- **The context window is observed state, not config.** It is not on `ModelDef`, not on
  `Config`, and not resolvable from the graph — a llama.cpp router lists models it has
  never loaded, and `--fit on` only picks a window at load time, so nothing can know it
  before the first completion. `Session.contextWindow` starts `null`, the agent loop
  fills it in from `Provider.contextWindow(model)` after each completion while it is
  still unknown, and **compaction is off while it is `null`** — never guess a default.
  `setRuntime({ contextWindow: N })` pins it for a backend that never reports one; a
  pinned value is never probed. Changing the session's model (`/model`, `/profile`,
  `/load`) drops what was learned and re-probes.
- **Skills are global and always available:** `reg.createSkill(name, description, text)`
  puts a one-line index entry in every system prompt (main agent and subagents alike)
  and registers `list_skills`/`read_skill` in every profile's registry — outside the
  Profile→Tool edge rule. `read_skill` sets `Tool.noTruncate`, so its result skips the
  `maxToolOutputChars` cap. Skills are a side-channel like providers: no `ResourceId`,
  no edges.
- **Config conflicts are fatal:** a profile/model/tool/skill defined with the same name in both
  `~/.vise/index.ts` and `./.vise/index.ts` is a "Config conflict" error. Hooks have no
  name and never conflict.
- **`setRuntime` merges per key** (project file wins over global, which wins over
  built-in defaults).
- **Saved sessions** (`.vise/sessions/` or `~/.vise/sessions/`) are per-user conversation
  state, not config — the directory is gitignored. A session is one JSON file
  (`<name>.json`, `version: 1`) holding the domain `Message[]` (system messages stripped),
  the profile, and the model. The REPL exposes `/save`, `/load`, `/sessions`, `/rename`,
  `/delete`; the agent-server exposes the same over the WebSocket (additive protocol).
  On a clean exit the REPL and server auto-save the current conversation to `last.json`
  (only if non-empty). A bad/missing/corrupt session file never blocks startup or a load —
  it is reported as an error string (or listed as unreadable), never a crash.
- **The name `Agent` is reserved** for the implicit built-in profile; a config file cannot
  define a profile by that name.
- **Relative imports in config files use the `.ts` extension** (Bun accepts either, but
  Node's type stripping does not rewrite `.js` back to `.ts`). This is distinct from the
  `.js` convention used inside `src/`.

## Reference

- `README.md` — full user-facing docs: config reference, Registry API, providers, tools,
  hooks, profiles, troubleshooting.
- `gui/AGENTS.md` — the browser client: rendering invariants, known traps, debugging
  recipes, test map, and change recipes. Read it before editing anything in `gui/`.
- `specs/v0.1.0/` … `specs/v0.10.0/` — the specification documents (the
  source of truth for behavior and acceptance criteria). `specs/gui/` is the GUI spec.
- `WBS.md` — work breakdown structure and acceptance-criteria traceability (v0.1.0-era;
  it does not yet cover the GUI, `fetch_webpage`, or the v0.6.0 hooks/`runCommand`).
