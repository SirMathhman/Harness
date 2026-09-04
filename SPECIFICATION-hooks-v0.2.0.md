# System Specification: Hooks System

**Version:** 0.2.0
**Date:** 2026-09-04
**Builds on:** N/A (first spec for this subsystem)

---

## 1. Purpose and Scope

### 1.1 Purpose

Provide a user-extensible hooks system that:

- **Gates agent completion**: prevents the agent from finishing a turn (or executing a
  tool) until user-defined checks pass (e.g., tests, lints, type-checks).
- **Observes lifecycle events**: lets users react to agent lifecycle points
  (session start/end, turn start/end, tool calls, compaction) for logging,
  side-effects, or injecting advisory context.

### 1.2 Stakeholders

- **Primary user:** a developer who wants to enforce quality gates (tests must pass,
  lint must be clean) before the agent is allowed to declare a task done.
- **The agent:** receives hook output (block messages or advisory messages) as
  conversation content and reacts accordingly.

### 1.3 Success Criteria

- A user can write a TypeScript file exporting an array of `Hook` objects, point the
  harness at it via config, and have those hooks fire at the specified lifecycle
  points.
- A blocking hook on `turn:end` prevents the agent from finishing until the
  condition is met; the agent sees the failure and can fix it.
- A blocking hook on `tool:before` prevents a tool from executing; the agent sees
  the rejection and can choose a different approach.
- Non-blocking hooks can inject advisory messages (e.g., lint warnings) into the
  conversation without stopping the agent.
- The system is synchronous, simple, and has no runtime overhead when no hooks are
  configured.

### 1.4 Out of Scope

- Async hooks (no Promise support; hooks must complete synchronously).
- Hook modification of event data (no rewriting tool args or messages).
- Hook-based abort of the turn (hooks can block an event but cannot abort the
  entire turn).
- Remote / network-based hooks (hooks are local TypeScript files only).
- Hook hot-reloading (hooks are loaded once at session start).

---

## 2. Domain Model

### 2.1 Entities

| Entity          | Description                                                | Key Attributes                                                     |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| **Hook**        | A user-defined lifecycle handler.                          | `events: HookEvent[]`, `handler: HookHandler`, `includeSubagents?` |
| **HookEvent**   | A named lifecycle point at which hooks fire.               | One of 7 string literals (see §3.1)                                |
| **HookContext** | The data passed to a hook handler when it fires.           | `event`, `tool?`, `cwd`, `depth`                                   |
| **HookResult**  | The return value of a hook handler.                        | `void` \| `string` \| `{ message: string; block?: boolean }`       |
| **HookManager** | Internal runtime that loads, stores, and dispatches hooks. | Loaded hooks, enabled/disabled state                               |

### 2.2 Relationships

- A **Hook** subscribes to one or more **HookEvent**s.
- A **HookManager** holds zero or more **Hook**s, loaded from user-specified files.
- A **Session** owns one **HookManager** (created at session start from config).
- When an event fires, the **HookManager** invokes all matching **Hook** handlers
  with a **HookContext** and collects **HookResult**s.

### 2.3 State Transitions

The hooks system itself has no state machine. It is a passive dispatcher:

```
[Session start] → load hook files → register hooks → [ready]
[Event fires]   → filter hooks by event (+ depth) → invoke handlers → collect results → apply results
[Session end]   → [done]
```

Runtime toggle:

```
[enabled] → /hooks off → [disabled] → /hooks on → [enabled]
```

When disabled, no hooks fire (the system is a no-op).

---

## 3. Functional Requirements

### 3.1 Events

The system defines exactly 7 hook events:

| Event           | Fires when                                              | Can block? | Block effect                                |
| --------------- | ------------------------------------------------------- | ---------- | ------------------------------------------- |
| `tool:before`   | Immediately before a tool is executed                   | **Yes**    | Tool is not executed; message → tool result |
| `tool:after`    | Immediately after a tool completes (success or failure) | No         | —                                           |
| `turn:start`    | When a new user task begins (before the first LLM call) | No         | —                                           |
| `turn:end`      | When the model calls `finish`                           | **Yes**    | `finish` is rejected; message → tool result |
| `session:start` | When the REPL session is created                        | No         | —                                           |
| `session:end`   | When the REPL session is torn down (exit, Ctrl-D)       | No         | —                                           |
| `on:compaction` | Immediately before context compaction runs              | No         | —                                           |

**Blocking is only effective on `tool:before` and `turn:end`.** If a hook on any
other event returns a block, the block is ignored but the message is still injected
as a system message (treated as non-blocking).

### 3.2 Hook Definition (User-Facing API)

A hook file is a TypeScript module with a **default export** of type `Hook[]`:

```ts
import type { Hook } from "harness";

export default [
  {
    events: ["turn:end"],
    handler: (ctx) => {
      // e.g., run tests, check lint
      const result = runTests(ctx.cwd);
      if (!result.passed) {
        return result.output; // string → block
      }
      // void → allow
    },
  },
  {
    events: ["tool:after"],
    handler: (ctx) => {
      if (ctx.tool?.name === "write_file") {
        const warnings = lintFile(ctx.tool.args.path);
        if (warnings.length > 0) {
          return { message: warnings.join("\n"), block: false }; // advisory
        }
      }
    },
    includeSubagents: true, // also fires in subagents
  },
];
```

#### `Hook` interface

```ts
interface Hook {
  /** One or more events this hook subscribes to. */
  events: HookEvent[];
  /** The handler invoked when any subscribed event fires. */
  handler: HookHandler;
  /** If true, the hook also fires in subagent contexts. Default: false. */
  includeSubagents?: boolean;
}
```

#### `HookEvent` type

```ts
type HookEvent =
  | "tool:before"
  | "tool:after"
  | "turn:start"
  | "turn:end"
  | "session:start"
  | "session:end"
  | "on:compaction";
```

#### `HookHandler` type

```ts
type HookHandler = (ctx: HookContext) => HookResult;
```

#### `HookContext` interface

```ts
interface HookContext {
  /** The event that fired. */
  event: HookEvent;
  /** Present for `tool:before` and `tool:after` only. */
  tool?: {
    name: string;
    args: Record<string, unknown>;
    /** Present for `tool:after` only. The tool's result string. */
    result?: string;
  };
  /** The working directory (project root) the agent is operating in. */
  cwd: string;
  /** Subagent depth. 0 = parent session. */
  depth: number;
}
```

#### `HookResult` type

```ts
type HookResult =
  | void // allow; no message
  | string // block; the string is the block reason
  | { message: string; block?: boolean }; // explicit: block or advisory
```

**Semantics:**

| Return value                | Meaning                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `void` / `undefined`        | Allow. No message. Event proceeds normally.                                    |
| `string`                    | Block. The string is the reason. (Shorthand for `{ message: s, block: true }`) |
| `{ message, block: true }`  | Block. `message` is the reason.                                                |
| `{ message, block: false }` | Advisory. `message` is injected as a system message. Event proceeds.           |
| `{ message }` (no `block`)  | Advisory (same as `block: false`).                                             |

### 3.3 Hook Loading

- **Config field:** `hooks: string[]` — an array of file paths (relative to the
  project root or absolute).
- **Loading:** At session creation, each file is imported (dynamic `import()`).
  The default export must be an array of `Hook` objects.
- **Validation:** Each element must have a non-empty `events` array (values must be
  valid `HookEvent` literals) and a `handler` that is a function.
- **Failure:** If a file cannot be loaded, has no default export, or contains
  malformed hook objects, the harness **exits with a fatal error** and a
  descriptive message identifying the file and the problem.
- **Order:** Files are loaded in the order given in the config array. Within a
  file, hooks are in array order.

### 3.4 Hook Dispatch

When an event fires:

1. The **HookManager** filters hooks whose `events` array contains the fired event.
2. If the event is in a subagent context (`depth > 0`), hooks without
   `includeSubagents: true` are excluded.
3. If the HookManager is disabled (`/hooks off`), no hooks fire.
4. Matching hooks are invoked **sequentially** in registration order, each
   receiving the same `HookContext`.
5. Results are collected from all hooks (all hooks run regardless of earlier
   results — no short-circuit).
6. Results are applied (see §3.5).

### 3.5 Result Application

**Blocking results** (only effective on `tool:before` and `turn:end`):

- All block messages are **concatenated** (joined by `"; "`) into a single string.
- For `tool:before`: the tool is **not executed**. The concatenated message is
  returned as the tool result (as if the tool ran and produced that output).
- For `turn:end`: the `finish` tool call is **rejected**. The concatenated message
  is returned as the tool result for the `finish` call. The agent loop continues
  (the model sees the failure and can retry).

**Advisory results** (any event):

- All advisory messages are concatenated (joined by `"\n"`) and injected as a
  single **system message** appended to the conversation after the event's normal
  processing completes.
- For `tool:after`: the system message is appended after the tool result message.
- For `turn:start`: the system message is appended before the first LLM call.
- For `session:start`: the system message is appended to the initial messages.
- For `on:compaction`: the system message is appended before the compaction LLM
  call.
- For `session:end`: the system message is logged to the terminal (the session is
  ending; there is no further conversation).

**Mixed results** (some hooks block, some are advisory, on a blocking-capable event):

- The event is blocked (any block wins).
- Block messages are concatenated and used as the block reason.
- Advisory messages are also injected as a system message (in addition to the
  block).

### 3.6 Hook Errors

If a hook handler **throws** (synchronously):

- The error is treated as a **block** with the error message as the reason.
- For blocking-capable events: the event is blocked with the error message.
- For non-blocking events: the error message is injected as an advisory system
  message.
- The error is also logged to the terminal (stderr) with the hook's source file
  for debugging.
- Execution continues to the next hook (one hook's crash does not prevent others
  from running).

### 3.7 Subagent Behavior

- By default (`includeSubagents` omitted or `false`), hooks **do not fire** in
  subagent contexts.
- If `includeSubagents: true`, the hook fires in subagent contexts with
  `ctx.depth > 0`.
- Blocking in a subagent context works the same way (rejects the tool call or
  finish within that subagent).
- A subagent's blocked `finish` does not affect the parent; the subagent simply
  gets another iteration.

### 3.8 REPL Commands

| Command      | Effect                                                           |
| ------------ | ---------------------------------------------------------------- |
| `/hooks`     | List all registered hooks: event(s), source file, subagent flag. |
| `/hooks off` | Disable all hooks for the remainder of the session.              |
| `/hooks on`  | Re-enable hooks.                                                 |

When hooks are disabled, the HookManager is a no-op (no dispatch, no overhead).

### 3.9 Configuration

In the harness config (resolved at session creation):

```ts
interface Config {
  // ...existing fields...
  /** Paths to hook files. Relative paths are resolved from the project root. */
  hooks?: string[];
}
```

- If `hooks` is omitted or empty, no hooks are loaded (zero overhead).
- If `hooks` is present, all files are loaded at session start (before
  `session:start` fires).

---

## 4. Edge Cases and Error Handling

| Scenario                                                               | Behavior                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook file has a syntax error                                           | Fatal: harness exits with error message identifying the file.                                                                                                    |
| Hook file default export is not an array                               | Fatal: harness exits with descriptive error.                                                                                                                     |
| Hook object missing `events` or `handler`                              | Fatal: harness exits, identifying the malformed entry.                                                                                                           |
| Hook `events` contains an invalid literal                              | Fatal: harness exits, listing the invalid value.                                                                                                                 |
| Hook handler throws                                                    | Treated as block (see §3.6); logged to stderr; other hooks still run.                                                                                            |
| Hook returns a non-string, non-object, non-void value (e.g., a number) | Treated as `void` (allow); a warning is logged to stderr.                                                                                                        |
| Multiple hooks block the same event                                    | All block messages concatenated with `"; "`.                                                                                                                     |
| Hook blocks `turn:end` repeatedly                                      | The agent loops: finish is rejected each time until the hook allows. No iteration cap is added by the hooks system (the existing `maxIterations` still applies). |
| Hook blocks `tool:before` for a tool the agent retries identically     | The agent will be blocked again; it is the agent's responsibility to change its approach.                                                                        |
| `session:end` hook has a block result                                  | Block is ignored (session is ending); message logged to terminal.                                                                                                |
| Hooks disabled via `/hooks off`                                        | No hooks fire; no overhead.                                                                                                                                      |
| Hook file path does not exist                                          | Fatal: harness exits with "file not found" error.                                                                                                                |
| Two hook files export a hook with the same handler function            | Both are registered independently (no deduplication).                                                                                                            |

---

## 5. Non-Functional Requirements

- **Performance:** When no hooks are configured, the HookManager adds zero
  measurable overhead (no per-event function calls beyond a single boolean check).
  When hooks are configured, dispatch overhead is negligible (synchronous array
  iteration + function calls).
- **Simplicity:** The user-facing API is a single type (`Hook`) and a single
  convention (default export of `Hook[]`). No classes, no decorators, no
  registration calls.
- **Transparency:** The `/hooks` command makes it trivial to verify which hooks
  are active.
- **No global state:** Hooks are scoped to a session. No module-level mutable
  state.
- **Testability:** The HookManager is a pure dispatcher (given hooks + context →
  results). Hook files are user code and are not unit-tested by the harness.

---

## 6. Data Requirements

- **Input:** TypeScript files (ESM) with a default export of `Hook[]`.
- **Output:** None (hooks affect the conversation and tool execution in-place).
- **Storage:** No persistent storage. Hooks are in-memory for the session lifetime.

---

## 7. External Dependencies

- None. Hooks are local TypeScript files executed in-process. No network, no
  child processes (unless the user's hook handler itself spawns processes — that
  is the user's responsibility).

---

## 8. Constraints and Assumptions

- **Synchronous only.** Hook handlers must complete synchronously. If a user needs
  to run an async operation (e.g., a test suite), they must use a synchronous
  wrapper (e.g., `execSync`). This is a deliberate constraint for simplicity.
- **No modification.** Hooks cannot modify tool arguments, messages, or any other
  event data. They can only observe, block, or inject advisory messages.
- **No abort.** A hook cannot abort the entire turn. It can only block individual
  events. (The user can always Ctrl-C to abort.)
- **Trust model.** Hook files are user-authored and run with the same privileges
  as the harness. There is no sandboxing.
- **Load-once.** Hooks are loaded at session start and cannot be added/removed at
  runtime (only enabled/disabled via `/hooks off|on`).
- **ESM only.** Hook files must be ES modules (the harness uses dynamic `import()`).

---

## 9. Acceptance Criteria

1. A user creates `hooks.ts` with a blocking `turn:end` hook that runs `tsc --noEmit`
   and returns the output on failure. Config points to it. The agent cannot finish
   a turn until type-checking passes.
2. A user creates a `tool:before` hook that blocks `write_file` calls to paths
   matching `*.min.js`. The agent sees the rejection and avoids those paths.
3. A user creates a `tool:after` hook that lints written files and returns
   `{ message: warnings, block: false }`. The agent sees the warnings as a system
   message but the write is not undone.
4. A hook handler throws. The event is blocked (or advisory, depending on event),
   the error is logged to stderr, and other hooks still run.
5. `/hooks` lists all active hooks. `/hooks off` disables them. `/hooks on`
   re-enables them.
6. A hook with `includeSubagents: true` fires in subagent contexts; one without it
   does not.
7. With no `hooks` config, the system has zero overhead (no file loading, no
   dispatch).
8. A malformed hook file causes a fatal exit with a clear error message.

---

## 10. Open Questions

(None — specification is complete.)
