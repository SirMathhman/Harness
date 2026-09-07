# System Specification: The Runtime Context Window

**Version:** 0.9.0
**Date:** 2026-09-06
**Builds on:** v0.8.0 (session save & load)

---

## 1. Purpose and Scope

### 1.1 Purpose

Move the **context window** out of the resource graph and into observed runtime
state.

Through v0.8.0 the context window was `ModelDef.maxContext`: a declared property
of a Model resource, overridable by a `Profile → Model` connection prop, and
required — a resolved model without one raised the fatal
`MissingMaxContextError` at startup. `LlamaProvider.discoverModels()` supplied it
by reading `meta.n_ctx` off each `GET /v1/models` entry.

That model is wrong, and a current llama.cpp build breaks it outright.

A llama.cpp **router** (`GET /props` → `"role": "router"`, `models_autoload:
true`) lists every model it is _configured_ to serve, loaded or not. An unloaded
entry carries no `meta` at all:

```json
{ "id": "meta-models/Muse-Glimmer-30B-GGUF:17GB", "status": { "value": "unloaded" } }
```

There is no `n_ctx` to read, and no read-only endpoint that can produce one:
`GET /props?model=<id>` _forces a load_, and with `--fit on` the window is not
even chosen until load time, from the memory actually free at that moment.

So discovery reported no window, resolution raised `MissingMaxContextError`, and
`bun run serve` — and with it `bun run gui:dev` — exited before serving anything.

The deeper problem is the domain: a context window is not a property of a _model
definition_. It is a property of a **model as a particular server currently has
it loaded**. The same GGUF loaded on two machines has two different windows. A
value that cannot be known until runtime must not be modelled as configuration.

### 1.2 Scope

**In scope**

- Removing `maxContext` from `ModelDef`, from the `Profile → Model` connection
  props, and from `Config`.
- Deleting `MissingMaxContextError` and every fatal path that raised it.
- `Session.contextWindow` as observed state, and `Provider.contextWindow()` as
  the seam that fills it in.
- Compaction's behavior while the window is unknown.
- `setRuntime({ contextWindow })` as the manual pin.

**Out of scope**

- Any change to how compaction summarizes, to token counting, or to the wire
  protocol beyond widening one field.

---

## 2. Domain Model

### 2.1 What a Model resource is

A **Model** resource describes _where a model lives and how to talk to it_:
`name`, `baseUrl`, `apiKey`, and a default `temperature`. Nothing about the
server's loaded state belongs on it.

`ModelDef.maxContext` is **removed**. So is the `maxContext` connection prop on
a `Profile → Model` edge; `temperature` remains the only prop.

### 2.2 What the context window is

The context window is **observed state of a running session**, held on
`Session`:

```ts
interface Session {
  /** Tokens, or null while the backend has not reported one. */
  contextWindow: number | null;
  /** Asks the active model's provider; absent when there is nobody to ask. */
  probeContextWindow?: () => Promise<number | null>;
}
```

It sits beside `lastPromptTokens`, which is the same kind of thing: a fact about
this run, learned from the backend, meaningless before the first call.

`null` means **unknown**, not zero and not "use a default". There is no default.

### 2.3 The provider seam

`Provider` gains an optional method:

```ts
contextWindow?(model: string): Promise<number | null>;
```

Contract:

- **Read-only.** It must not cause a model to load. `GET /props?model=…` is
  therefore forbidden for `LlamaProvider`.
- **Never throws.** "Cannot say (yet)" is `null`.
- **May be asked more than once.** The answer legitimately changes from `null`
  to a number when the model loads.

`LlamaProvider.contextWindow(model)` reads, in order:

1. `GET /v1/models` → the entry for `model` → `meta.n_ctx`. A router fills this
   in once the model is resident. This is the per-model answer.
2. `GET /props` → `default_generation_settings.n_ctx`, the slot window of a
   plain single-model server. **Skipped when `role === "router"`**, where the
   value describes the router itself and is `0`.

Anything else — unreachable server, non-OK response, unparseable body, a
non-positive or non-integer `n_ctx` — is `null`.

`discoverModels()` no longer reports a window at all, even when the server
happens to expose one: discovery answers _where_, never _how big_.

---

## 3. Behavior

### 3.1 Startup

Startup **cannot fail for a missing context window**. `resolveProfile()` no
longer throws `MissingMaxContextError`; the class is deleted along with every
`catch` that named it (`startup.ts`, `cli/commands.ts` for `/profile`, `/model`
and `/load`, and the subagent runner).

A session starts with `contextWindow = config.contextWindow` — the pinned value
if the user set one, otherwise `null`.

### 3.2 Learning the window

`runTurn` calls the probe **after each completion**, while the window is still
unknown. That is the earliest correct moment: the completion has just forced the
backend to load the model.

- Already known (learned or pinned) → no probe, ever.
- No `probeContextWindow` (a model with no provider behind it) → stays unknown.
- A probe that throws, despite the contract → treated as `null`; a turn never
  fails because a diagnostic question did.

### 3.3 Compaction while unknown

`shouldCompact(promptTokens, contextWindow, config)` returns `false` when
`contextWindow` is `null`. There is no threshold to compare against and Vise
does not guess one.

This is a deliberate, honest degradation: a session against a backend that never
reports a window does not compact. It is strictly better than the alternatives —
inventing a number (compacting a conversation that had room, or overflowing one
that did not) or refusing to start at all, which is the bug this spec fixes.

### 3.4 Re-learning on a model change

Whatever was learned describes one backend. Any change of the session's model —
`/model`, `/profile`, `/load` — resets `contextWindow` to
`config.contextWindow` and re-points `probeContextWindow` at the new model's
provider. A subagent starts the same way and learns its own window.

### 3.5 The pin

`setRuntime({ contextWindow: N })` (default `null`) pins the window for a
backend that cannot report one. A pinned value wins outright and is never
probed. It lives in `RuntimeSettings` — a session-wide loop setting — not on a
Model, because it configures Vise's behavior, not the server's.

### 3.6 Surfaces

- **Identity paragraph.** The `…, with a N-token context window.` clause is
  dropped. The prompt is built before the first completion, when the window is
  not yet knowable; a sentence that would be a guess is better absent.
- **`/context`.** Reads `session.contextWindow`. Unknown renders as
  `context: <n> tokens used (window not reported by the server yet)`, or
  `context: no LLM call yet (window not reported by the server yet)`.
- **Protocol.** `UIState.context.maxContext` widens to `number | null`; the
  field keeps its name so the change stays additive for the client. The GUI
  renders `null` (and `0`, the sentinel an older agent-server sent) as
  `context: —`, which it already did.

---

## 4. Errors

| Condition                                | Behavior                                                 |
| ---------------------------------------- | -------------------------------------------------------- |
| Provider reports no window               | `contextWindow` stays `null`; compaction off. Not fatal.  |
| Provider has no `contextWindow()` method | Same. Not fatal.                                          |
| `contextWindow()` throws                 | Treated as `null`; the turn is unaffected.                |
| Backend unreachable during a probe       | `null`.                                                   |

There is no error condition in this feature. That is the point of it.

---

## 5. Acceptance Criteria

| #   | Criterion                                                                         | Test                                                                       |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | A provider that reports no window still starts a session                           | `providers.test.ts` "still starts a session (the router case)"              |
| 2   | The window is learned from the provider after the first completion, and only once  | `providers.test.ts` "learned from the provider after the first completion"  |
| 3   | A probe that throws leaves the window unknown, not the turn failed                 | `providers.test.ts` "a probe that throws"                                   |
| 4   | A pinned `setRuntime` window wins and is never probed                              | `providers.test.ts` "a pinned setRuntime window wins"                       |
| 5   | Compaction is off while the window is unknown                                      | `compaction.test.ts` "false when the window is unknown"                     |
| 6   | `LlamaProvider` reads `meta.n_ctx` of the loaded model                             | `providers.test.ts` "reads meta.n_ctx"                                      |
| 7   | `LlamaProvider` falls back to `/props` on a single-model server                    | `providers.test.ts` "falls back to /props"                                  |
| 8   | `LlamaProvider` reports `null` for an unloaded router model                        | `providers.test.ts` "not loaded yet"                                        |
| 9   | Discovery reports only where a model lives, never its window                       | `providers.test.ts` "never its window"                                      |
