# System Specification: Subagent Lifecycle Hooks & Command Runner

**Version:** 0.6.0
**Date:** 2026-02-26
**Builds on:** v0.5.0 (fetch_webpage tool)

## 1. Purpose and Scope

This specification adds two capabilities to Vise:

1. **Two new subagent-side lifecycle hooks** (`subagent:turn:start`, `subagent:turn:end`) that fire on the *subagent's own* hook manager, complementing the existing spawner-side `subagent:before` / `subagent:after`. Together, the four events give full lifecycle coverage around a subagent run.

2. **A `runCommand` helper** — an async function exported from the package root that runs a shell command in the foreground and returns a structured `CommandOutput`. This enables hook handlers to run external tools (e.g., a linter) and inject their output into a subagent's context before it begins work.

**Primary use case:** A hook connected to the `Analyze` profile runs `bun run lint` in a `subagent:turn:start` handler and returns the formatted output. The runner injects that output as a system message into the subagent's conversation before its first LLM call, so the subagent does not need to call the linter itself.

**Stakeholders:** Vise config authors (who write `.vise/index.ts` hook handlers) and the Vise runtime (which dispatches events and performs injection).

**Success criteria:**
- A hook on a subagent profile can run a command and inject its output into the subagent's context before the first LLM call.
- The four subagent lifecycle events fire in the correct order, on the correct hook managers, at the correct depths.
- `runCommand` never throws; all failures are returned in the `CommandOutput`.

## 2. Domain Model

### 2.1 New Entities

#### `CommandOutput`

A structured result of a foreground command execution.

| Field | Type | Description |
|-------|------|-------------|
| `exitCode` | `number` | Process exit code. `-1` when the process could not be spawned or was killed by a timeout. |
| `stdout` | `string` | Captured standard output. Empty string when none. |
| `stderr` | `string` | Captured standard error. Empty string when none. |
| `timedOut` | `boolean` | `true` when the process was killed because it exceeded the timeout. |
| `display()` | `() => string` | Returns a formatted, LLM-readable string (see §3.2). |

`CommandOutput` is a **type export** from the package root (`src/index.ts`).

#### `RunCommandOptions`

Optional parameters for `runCommand`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cwd` | `string` | `process.cwd()` | Working directory for the command. |
| `timeoutMs` | `number` | `60000` | Maximum wall-clock time before the process is killed. |
| `shell` | `string` | `"auto"` | Shell to use. Resolved via the existing `resolveShell` utility. |

`RunCommandOptions` is a **type export** from the package root.

### 2.2 New Hook Events

Two new members are added to the `HookEvent` union:

| Event | Fires on | Depth | Async | Blocking | Purpose |
|-------|----------|-------|-------|----------|---------|
| `subagent:turn:start` | Subagent's own HookManager | Subagent's depth (≥ 1) | Yes | No | Right before the subagent's first LLM call. Handlers may return a string that the runner injects as a system message. |
| `subagent:turn:end` | Subagent's own HookManager | Subagent's depth (≥ 1) | Yes | No | After the subagent's `runTurn` completes (success, cap, or failure), before the result is returned to the spawner. |

The existing events are unchanged:

| Event | Fires on | Depth | Async | Blocking | Purpose |
|-------|----------|-------|-------|----------|---------|
| `subagent:before` | Spawner's HookManager | Spawner's depth | Yes | No | Before the nested run begins. KV cache save. |
| `subagent:after` | Spawner's HookManager | Spawner's depth | Yes | No | After the nested run ends (in `finally`). KV cache restore. |

### 2.3 Updated Constants

- `HOOK_EVENTS` gains `"subagent:turn:start"` and `"subagent:turn:end"`.
- `ASYNC_HOOK_EVENTS` gains `"subagent:turn:start"` and `"subagent:turn:end"`.
- `BLOCKING_HOOK_EVENTS` is unchanged (`["tool:before", "turn:end"]`).

### 2.4 Updated `HookContext`

A new optional field is added:

| Field | Type | Present when | Description |
|-------|------|-------------|-------------|
| `outcome` | `'done' \| 'cap' \| 'failed'` | `subagent:turn:end` only | The subagent's terminal outcome. `'done'` = called `finish`; `'cap'` = hit iteration cap; `'failed'` = LLM/server error or thrown exception. |

All existing `HookContext` fields are unchanged.

### 2.5 State Transitions: Subagent Lifecycle

The four events fire in this order around a subagent run:

```
spawner.hooks: subagent:before          (KV save)
  subagent.hooks: subagent:turn:start   (inject context)
    runTurn(...)                        (the subagent's LLM loop)
  subagent.hooks: subagent:turn:end     (observe outcome)
spawner.hooks: subagent:after           (KV restore, in finally)
```

- `subagent:before` and `subagent:after` fire on the **spawner's** hook manager at the **spawner's** depth.
- `subagent:turn:start` and `subagent:turn:end` fire on the **subagent's** hook manager at the **subagent's** depth.
- `subagent:turn:end` fires in a `finally` block: it fires on every outcome (done, cap, failed).
- `subagent:after` fires in a `finally` block: it fires on every outcome.

## 3. Functional Requirements

### 3.1 `runCommand` API

**Signature:**

```ts
function runCommand(command: string, opts?: RunCommandOptions): Promise<CommandOutput>
```

**Behavior:**

- Spawns a child process running `command` in the resolved shell.
- Captures `stdout` and `stderr` in full (no streaming).
- Resolves with a `CommandOutput` when the process exits.
- If the process exceeds `timeoutMs`, kills it and resolves with `timedOut: true`, `exitCode: -1`.
- If the process cannot be spawned (e.g., shell not found, ENOENT), resolves with `exitCode: -1`, `stderr` containing the error message, `stdout` empty. **Never throws.**
- Uses the same shell resolution as the rest of the system (`resolveShell` from `src/utils.ts`).

**Export:** `runCommand` is a **value export** (a function) from `src/index.ts`. `CommandOutput` and `RunCommandOptions` are **type exports** from `src/index.ts`.

**Constraint:** `runCommand` must be side-effect-free with respect to the session — it does not register background commands, does not interact with the `BackgroundCommandManager`, and does not modify any session state. It is a standalone foreground command runner.

### 3.2 `CommandOutput.display()` Format

`display()` returns a formatted string suitable for injection into an LLM conversation. The format is:

```
Command: {command}
Exit code: {exitCode}
--- stdout ---
{stdout}
--- stderr ---
{stderr}
```

Rules:
- The `Command:` and `Exit code:` lines are always present.
- The `--- stdout ---` section is present only when `stdout` is non-empty.
- The `--- stderr ---` section is present only when `stderr` is non-empty.
- When `timedOut` is `true`, the exit code line reads `Exit code: -1 (timed out)`.
- When the process could not be spawned, `stderr` contains the error message and the format is the same.

**Example (successful lint):**

```
Command: bun run lint
Exit code: 0
--- stdout ---
No lint errors found.
```

**Example (lint with errors):**

```
Command: bun run lint
Exit code: 1
--- stdout ---
src/agent/loop.ts:42:5 — error: unused variable 'x'
--- stderr ---
1 error found.
```

**Example (timeout):**

```
Command: bun run lint
Exit code: -1 (timed out)
```

### 3.3 `subagent:turn:start` — Context Injection

**When it fires:** After `materializeProfile` has built the subagent's session (with its system prompt, tools, and hook manager), but before `runTurn` is called.

**Hook manager:** The subagent's own hook manager (the one built by `materializeProfile` from the subagent's profile hooks + provider hooks).

**Dispatch:** `dispatchAsync("subagent:turn:start", { depth: subagentDepth, model: subagentModel })`.

**Injection mechanism:**
- The runner collects the `advisory` from the `HookOutcome`.
- If `advisory` is non-null and non-empty, the runner prepends a system message to `session.messages` (after the existing system prompt message) with the advisory content.
- The injected message has `role: "system"`.
- If multiple hooks return advisories, they are `"\n"`-joined (same as existing advisory behavior) and injected as a single system message.
- If no hook returns an advisory, no message is injected.

**`includeSubagents` requirement:** A hook that listens to `subagent:turn:start` **must** have `includeSubagents: true`. If a hook is connected to a profile and its `events` array includes `subagent:turn:start` but `includeSubagents` is not `true`, this is a **fatal config error** at startup (same class as "profile enumerates tools but omits `finish`"). The error message must name the hook's source and the offending event.

**Rationale:** `subagent:turn:start` only ever fires at subagent depth (≥ 1). A hook without `includeSubagents` could never fire for this event, which is a config mistake, not a valid configuration.

### 3.4 `subagent:turn:end` — Outcome Observation

**When it fires:** After `runTurn` completes (in a `finally` block, so it fires on every outcome: done, cap, failed).

**Hook manager:** The subagent's own hook manager.

**Dispatch:** `dispatchAsync("subagent:turn:end", { depth: subagentDepth, model: subagentModel, outcome })`.

**`HookContext.outcome`:** Set to `'done'`, `'cap'`, or `'failed'` based on the `runTurn` result:
- `'done'` — the subagent called `finish` (result.kind === `"finished"`).
- `'cap'` — the subagent hit the iteration cap (result.kind === `"cap"`).
- `'failed'` — an `LLMError` or other exception was thrown.

**Return value:** Collected as advisory (same as other events), but **not injected** anywhere — the subagent is being destroyed. The event is an observation point for logging, metrics, or cleanup.

**`includeSubagents` requirement:** Same as `subagent:turn:start` — a hook listening to `subagent:turn:end` **must** have `includeSubagents: true`, or it is a fatal config error.

### 3.5 Event Ordering Guarantee

The runner must guarantee this exact ordering:

1. `spawner.hooks.dispatchAsync("subagent:before", ...)` — awaited.
2. `subagent.hooks.dispatchAsync("subagent:turn:start", ...)` — awaited.
3. If `turn:start` produced an advisory, inject it into `session.messages`.
4. `runTurn(session, task, ...)` — awaited.
5. `subagent.hooks.dispatchAsync("subagent:turn:end", ...)` — awaited (in `finally`).
6. `spawner.hooks.dispatchAsync("subagent:after", ...)` — awaited (in `finally`).

Steps 5 and 6 are both in `finally` blocks. Step 5 fires before step 6. If `runTurn` throws, step 5 still fires (with `outcome: 'failed'`), and step 6 still fires.

### 3.6 Config Validation

At startup, when the resource graph is validated:

- For every hook whose `events` array includes `subagent:turn:start` or `subagent:turn:end`:
  - If `hook.includeSubagents !== true`, emit a **fatal config error**:
    ```
    Config error: hook {source} listens to {event} but does not set includeSubagents: true.
    This event only fires at subagent depth; the hook would never fire.
    ```
- This validation runs alongside the existing validations (e.g., "profile enumerates tools but omits `finish`").

## 4. Edge Cases and Error Handling

| # | Scenario | Behavior |
|---|----------|----------|
| E1 | `runCommand` called with an empty string | Resolves with `exitCode: -1`, `stderr: "empty command"`, `stdout: ""`. |
| E2 | `runCommand` called with a command that exits non-zero | Resolves normally with the actual `exitCode`, `stdout`, `stderr`. No error. |
| E3 | `runCommand` called with a command that times out | Kills the process. Resolves with `exitCode: -1`, `timedOut: true`, partial `stdout`/`stderr` captured so far. |
| E4 | `runCommand` called with a shell that doesn't exist | Resolves with `exitCode: -1`, `stderr` containing the spawn error message. |
| E5 | `runCommand` called with a very large output (e.g., 10 MB stdout) | Captures in full. No truncation. The `maxToolOutputChars` cap does **not** apply to `runCommand` output — it is a hook helper, not a tool. |
| E6 | `subagent:turn:start` hook throws | The dispatcher catches it, logs to stderr, and continues. No injection occurs from that hook. Other hooks still fire. |
| E7 | `subagent:turn:start` hook returns a non-string (e.g., a number) | Treated as an unsupported result (warning logged), same as other events. No injection. |
| E8 | `subagent:turn:start` hook returns `void` | No injection. The subagent starts with only its system prompt. |
| E9 | `subagent:turn:end` hook throws | The dispatcher catches it, logs to stderr. The subagent's result is still returned to the spawner. |
| E10 | Subagent fails (LLM error) | `subagent:turn:end` fires with `outcome: 'failed'`. `subagent:after` fires. The error string is returned to the spawner. |
| E11 | Subagent hits iteration cap | `subagent:turn:end` fires with `outcome: 'cap'`. `subagent:after` fires. The last assistant text is returned to the spawner. |
| E12 | Nested subagents (depth ≥ 2) | Each level fires its own four events. The inner subagent's `turn:start`/`turn:end` fire on the inner subagent's hook manager. The outer subagent's `before`/`after` fire on the outer subagent's hook manager (which is the spawner for the inner run). |
| E13 | Hook with `includeSubagents: true` listens to `subagent:turn:start` but is connected to a profile that is never used as a subagent | No error. The hook simply never fires. This is valid (the profile might be used as a subagent in a future session). |
| E14 | `runCommand` called concurrently from multiple hooks | Each call spawns its own process. No shared state. Results are independent. |
| E15 | `subagent:turn:start` advisory is very large (e.g., full lint output of a large project) | Injected in full. No truncation. The compaction system will handle it on subsequent turns if needed. |

## 5. Non-Functional Requirements

- **Performance:** `runCommand` adds no overhead to the hot path. It is only called when a hook handler explicitly invokes it. The `subagent:turn:start` dispatch adds one async dispatch per subagent spawn (negligible when no hooks are registered — the `active` check short-circuits).
- **Memory:** `runCommand` captures stdout/stderr in memory. For very large outputs, this is bounded by the command's output size. No streaming is required.
- **Security:** `runCommand` runs arbitrary shell commands. This is by design — it is a hook helper, and hooks are trusted config. No sandboxing is applied.
- **Compatibility:** The new events are additive. Existing configs that do not use them are unaffected. The `includeSubagents` validation for the new events only triggers when a hook explicitly listens to them.

## 6. Data Requirements

- **Input:** `runCommand` takes a command string and optional `RunCommandOptions`.
- **Output:** `CommandOutput` with `exitCode`, `stdout`, `stderr`, `timedOut`, and `display()`.
- **Storage:** No persistent storage. `CommandOutput` is ephemeral — it exists only for the duration of the hook handler's execution.
- **Injection:** The advisory string from `subagent:turn:start` is injected as a system message into the subagent's `session.messages` array. It persists for the duration of the subagent's session (subject to compaction).

## 7. External Dependencies

- **`node:child_process`** — for spawning the command process. Already a permitted Node built-in.
- **`resolveShell`** from `src/utils.ts` — for shell resolution. Already exists.
- No new runtime dependencies.

## 8. Constraints and Assumptions

- **`runCommand` is synchronous in effect, asynchronous in mechanism.** It blocks the hook handler until the command completes. This is acceptable because hook handlers are already async for the subagent events.
- **The injection is a system message, not a user message.** This keeps it out of the user/assistant turn structure and consistent with how compaction recaps are injected.
- **`runCommand` does not respect `maxToolOutputChars`.** It is a hook helper, not a tool. The output is injected verbatim. If the output is too large, compaction will handle it.
- **The `includeSubagents` requirement is a hard error, not a warning.** A hook that listens to a subagent-side event without `includeSubagents` is a config bug, not a valid edge case.
- **Provider hooks are merged into the subagent's hook manager** (existing behavior). If a provider contributes a hook that listens to `subagent:turn:start`, it must also set `includeSubagents: true`, or the config validation will fail. Providers are expected to set this flag on their hooks.

## 9. Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| A1 | `runCommand("echo hello")` resolves with `exitCode: 0`, `stdout: "hello\n"`, `stderr: ""`, `timedOut: false`. | Unit test. |
| A2 | `runCommand("exit 1")` resolves with `exitCode: 1`. No throw. | Unit test. |
| A3 | `runCommand("sleep 10", { timeoutMs: 100 })` resolves with `timedOut: true`, `exitCode: -1`. | Unit test. |
| A4 | `runCommand("")` resolves with `exitCode: -1`, `stderr` containing "empty command". | Unit test. |
| A5 | `CommandOutput.display()` produces the specified format for success, error, and timeout cases. | Unit test. |
| A6 | A hook on a subagent profile with `includeSubagents: true` and `events: ["subagent:turn:start"]` fires when a subagent is spawned, and its return value is injected as a system message. | Integration test (mock SSE server). |
| A7 | A hook on a subagent profile with `events: ["subagent:turn:start"]` but **without** `includeSubagents: true` causes a fatal config error at startup. | Unit test (config validation). |
| A8 | `subagent:turn:end` fires with the correct `outcome` for done, cap, and failed cases. | Integration test. |
| A9 | The four events fire in the correct order: `subagent:before` → `subagent:turn:start` → `runTurn` → `subagent:turn:end` → `subagent:after`. | Integration test (event ordering assertion). |
| A10 | `subagent:turn:end` fires in `finally` — it fires even when `runTurn` throws. | Integration test. |
| A11 | Nested subagents: each level fires its own four events on the correct hook managers. | Integration test. |
| A12 | `runCommand` is exported as a value from `src/index.ts`. `CommandOutput` and `RunCommandOptions` are exported as types. | Type-check + import test. |
| A13 | `src/index.ts` remains side-effect-free. Importing it does not launch a session or touch stdin. | Existing invariant test. |
| A14 | A hook that throws in `subagent:turn:start` does not prevent the subagent from starting. The error is logged to stderr. | Integration test. |
| A15 | Multiple hooks returning advisories in `subagent:turn:start` are `"\n"`-joined into a single injected system message. | Integration test. |

## 10. Open Questions

*(None — all design decisions were confirmed with the user.)*
