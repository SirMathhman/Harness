# System Specification: Main-Agent KV Cache Persistence Across Subagent Calls

**Version:** 0.3.0
**Date:** 2026-09-04
**Builds on:** v0.2.0 (Context Compaction)

---

## 0. Summary of Changes from v0.2.0

This is a **MINOR (feature)** release. It adds a new capability to the `LlamaProvider`
and the subagent runner so that the **main agent's** llama.cpp KV cache is persisted to
disk before a subagent runs and restored afterward, so the main agent never re-prefills
its conversation after a subagent call.

Two existing invariants are deliberately changed, and both are scoped and documented in
§8:

1. **Hooks are synchronous-only** → two new events (`subagent:before`,
   `subagent:after`) permit **async** (Promise-returning) handlers.
2. **Hooks are per-profile, never global** → a **provider** may contribute hooks that
   are merged into every session's `HookManager` at every subagent depth.

Everything else in v0.1.0/v0.2.0 is unchanged.

---

## 1. Purpose and Scope

### 1.1 Purpose

When the main agent calls `spawn_subagent`, the subagent runs against the **same single
llama.cpp slot**, evicting the main agent's KV cache from RAM. Today the main agent
re-prefills its entire conversation on its next turn after the subagent finishes. This
feature persists the main agent's KV cache to disk before the subagent runs and restores
it afterward, so the main agent resumes with its cache intact.

The benefit is **qualitative**: the main agent does not re-prefill its conversation
after a subagent call. No numeric latency target is specified.

### 1.2 Stakeholders

- **The main agent (depth 0):** its KV cache is saved and restored around every
  subagent call it makes.
- **Nested subagents (depth ≥ 1):** each also saves and restores its own KV cache
  around the subagents it spawns, so the optimization applies at **every level**.
- **The llama.cpp server:** must be started with `--slot-save-path DIR`; it performs
  the actual save/restore of the slot's prompt cache.

### 1.3 Success Criteria

- After the main agent's subagent finishes (success, iteration-cap, or failure), the
  main agent's next LLM call resumes from the restored KV cache rather than re-prefilling.
- The optimization applies at every nesting depth: a subagent that spawns its own
  subagent also avoids re-prefilling afterward.
- When the top-level turn ends, no KV cache files remain on disk.
- A llama.cpp server that is **not** started with `--slot-save-path`, or a provider with
  `kvPersistence` disabled, behaves exactly as before (no save/restore, no errors).

### 1.4 Out of Scope

- Persisting the **subagent's** KV cache for reuse in a _later, separate_ session
  (subagent KV is ephemeral; it is saved only to protect the ancestor's cache during
  the nested call).
- Automatic KV persistence on llama.cpp's side (the upstream feature request is closed
  as not planned; this feature drives the API from the client).
- Multi-slot (`-np > 1`) topologies. This spec targets a **single slot**.
- Vision / multimodal models (llama.cpp slot-save does not support mmproj blocks).
- SWA models without `--swa-full` (their saved KV is windowed and incomplete).

---

## 2. Domain Model

### 2.1 Entities

| Entity                               | Description                                                  | Key Attributes                                                                             |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **LlamaProvider (extended)**         | The llama.cpp provider, now optionally KV-persistent.        | `url`, `name?`, `apiKey?`, `kvPersistence?`, `slotId?`, `slotSavePath?`                    |
| **KV Persistence Hook**              | A provider-contributed hook that saves/restores the slot KV. | `events: ["subagent:before", "subagent:after"]`, async `handler`, `includeSubagents: true` |
| **KV Cache File**                    | The on-disk prompt cache for one agent depth.                | filename `kv-depth-{N}.bin`, lives in the server's `--slot-save-path` dir                  |
| **subagent:before / subagent:after** | Two new hook events fired around a nested `runTurn`.         | `HookContext.depth` = the **spawning** agent's depth                                       |

### 2.2 Relationships

- A **LlamaProvider** with `kvPersistence: true` contributes one **KV Persistence
  Hook** (via a new `Provider.hooks()` method) that is merged into the `HookManager`
  of **every** session at **every** depth.
- The **subagent runner** fires `subagent:before` (save) immediately before a nested
  `runTurn` and `subagent:after` (restore + delete) in a `finally` block immediately
  after it.
- A **KV Cache File** is named by the **saving agent's depth** and is owned by that
  depth: it is created by that depth's `subagent:before` and deleted by that same
  depth's `subagent:after`.

### 2.3 State Transitions

The save/restore sequence is a **stack**, exactly like a CPU saving registers before a
call and restoring them after. With a single slot, only the **currently-executing**
agent's KV is in RAM; every ancestor's KV is on disk.

```
depth 0 (main) holds its KV in the slot
  → spawn depth 1:
      subagent:before @ depth 0:  SAVE  slot → kv-depth-0.bin   (slot now free)
      depth 1 builds its KV in the slot
        → spawn depth 2:
            subagent:before @ depth 1:  SAVE  slot → kv-depth-1.bin   (slot now free)
            depth 2 builds its KV, runs, finishes
            subagent:after  @ depth 1:  RESTORE kv-depth-1.bin → slot; DELETE kv-depth-1.bin
        depth 1 continues, finishes
      subagent:after  @ depth 0:  RESTORE kv-depth-0.bin → slot; DELETE kv-depth-0.bin
depth 0 continues — it never re-prefilled
```

Invariants of the stack:

- A file is only needed until its **owner** (the same depth) restores it. A depth never
  deletes a file it did not create, and never deletes a file a deeper, still-live
  ancestor needs.
- At any moment, the set of files on disk is exactly the set of **live ancestors** of
  the currently-executing agent. When the top-level turn ends, that set is empty.

---

## 3. Functional Requirements

### 3.1 Provider Configuration

`LlamaProviderOptions` gains three optional fields:

```ts
interface LlamaProviderOptions {
  url: string;
  name?: string;
  apiKey?: string;
  /** Opt in to KV persistence across subagent calls. Default: false. */
  kvPersistence?: boolean;
  /** The llama.cpp slot id to save/restore. Default: 0. */
  slotId?: number;
  /**
   * The directory the llama.cpp server was started with via `--slot-save-path`.
   * REQUIRED when `kvPersistence` is true (used to delete cache files via node:fs).
   * The save/restore HTTP calls themselves need only the filename; this path is
   * needed for deletion because llama.cpp exposes no file-delete endpoint.
   */
  slotSavePath?: string;
}
```

- `kvPersistence` defaults to **false**. A provider without it contributes no KV hooks
  and behaves exactly as before.
- When `kvPersistence` is **true**, `slotSavePath` **must** be provided. If it is
  missing, provider construction is a **fatal config error** (the provider cannot
  delete its cache files, which would leave the disk dirty and violate §1.3).
- `slotId` defaults to **0**. With a single-slot server this is the only slot; the
  value is sent as `id_slot` in the save/restore requests.

### 3.2 Provider-Contributed Hooks

The `Provider` interface gains an optional method:

```ts
interface Provider {
  readonly name: string;
  discoverModels(): Promise<ModelDef[]>;
  /**
   * Optional hooks this provider contributes to every session at every depth.
   * Default: none. Merged into the session's HookManager in addition to the
   * profile's own hooks.
   */
  hooks?(): Hook[];
}
```

- `LlamaProvider.hooks()` returns **one** hook when `kvPersistence` is true, else `[]`:

  ```ts
  {
    events: ["subagent:before", "subagent:after"],
    includeSubagents: true,   // must fire at every depth, not just depth 0
    handler: async (ctx) => { /* save or restore, per ctx.event */ },
  }
  ```

- These hooks are merged into the `HookManager` of **every** materialized session
  (the main session and every subagent), in addition to the profile's own hooks. This
  is the scoped relaxation of the "hooks are never global" invariant (§8.2).
- The handler is **async** and performs the save/restore HTTP call (and, on restore,
  the file deletion). This is the scoped relaxation of the "hooks are synchronous-only"
  invariant (§8.1).

### 3.3 New Hook Events

Two new events are added to `HookEvent`:

| Event             | Fires when                                                                                | Can block? | Handler may be async? |
| ----------------- | ----------------------------------------------------------------------------------------- | ---------- | --------------------- |
| `subagent:before` | Immediately before the runner starts a nested `runTurn`                                   | No         | **Yes**               |
| `subagent:after`  | Immediately after the nested `runTurn` settles (success, cap, or failure), in a `finally` | No         | **Yes**               |

- Both fire on the **spawning** agent's `HookManager`, with `HookContext.depth` set to
  the **spawning** agent's depth (the depth whose KV is being saved/restored).
- `subagent:before` is fired in the runner's `try` block; `subagent:after` is fired in
  the runner's `finally` block, so it fires **even when the subagent fails**.
- Only these two events permit async handlers. All seven existing events remain
  synchronous-only.

### 3.4 Save Behavior (`subagent:before`)

When the KV hook's handler fires on `subagent:before` at depth `N`:

1. `POST {baseUrl}/slots/{slotId}?action=save` with body `{"filename": "kv-depth-{N}.bin"}`.
2. On success, the slot's prompt cache is written to `kv-depth-{N}.bin` in the server's
   `--slot-save-path` directory. The slot is now free for the subagent.
3. On **failure** (network error, HTTP 500, server not started with `--slot-save-path`
   → HTTP 501, disk full), the handler **logs a warning and proceeds without saving**
   (fail-open). The subagent still runs; the main agent's KV is lost and it will
   re-prefill afterward. The turn is **not** aborted.

### 3.5 Restore + Delete Behavior (`subagent:after`)

When the KV hook's handler fires on `subagent:after` at depth `N`:

1. `POST {baseUrl}/slots/{slotId}?action=restore` with body `{"filename": "kv-depth-{N}.bin"}`.
2. On a **successful restore**, delete the file: `node:fs` `unlink` of
   `{slotSavePath}/kv-depth-{N}.bin`. Deletion failure is logged as a warning and does
   not affect the turn.
3. On a **restore failure** (file missing, corrupt, server error), the handler **logs a
   warning and continues** (fail-open). The agent resumes with an empty/evicted cache
   and re-prefills on its next turn. The turn is **not** aborted.
4. If the corresponding `subagent:before` **failed to save** (no file exists), the
   restore is **skipped** (there is nothing to restore) and no deletion is attempted.
   The handler must track, per depth, whether a save succeeded so it does not attempt a
   restore of a file that was never written.

### 3.6 Subagent Runner Changes

The subagent runner (`makeSubagentRunner`) wraps the nested `runTurn` so that the
spawning agent's KV is saved before and restored after:

```
async run(opts):
  manager = materialize subagent profile
  try:
    await hooks.dispatch("subagent:before", { depth: spawnerDepth })   // save
    result = await runTurn(...)                                        // subagent runs
    return result
  finally:
    await hooks.dispatch("subagent:after", { depth: spawnerDepth })    // restore + delete
    manager.killAll()
```

- `spawnerDepth` is the depth of the agent **making** the `spawn_subagent` call (the
  depth whose KV is being protected). The runner must be given the spawner's
  `HookManager` and depth; today it only receives the subagent's materialized profile.
  This is new plumbing (§8.3).
- The `subagent:after` dispatch is in `finally`, so restore runs on **every** outcome
  (DONE, CAP_REACHED, FAILED, or thrown error).
- The existing "never throws" invariant of the runner is preserved: a save/restore
  failure is a warning, not an exception, so it cannot turn a subagent outcome into a
  control-flow error.

### 3.7 Serialization of Concurrent Subagents

`spawn_subagent` is currently `mutating: false`, so several calls in one assistant
message run **concurrently**. With a single slot and depth-keyed files, concurrent
subagents at the same depth would save/restore the **same** file and corrupt the stack.

- When KV persistence is **active** (the active model's provider has
  `kvPersistence: true`), subagent runs are **serialized**: at most one subagent runs
  at a time, so there is exactly one agent per depth on the active stack and the
  depth-keyed files are safe.
- When KV persistence is **not** active, the existing concurrent behavior is unchanged.
- This is a scoped change to the tool-execution-ordering invariant (§8.4): the
  "read-only tools run concurrently" rule is suspended for `spawn_subagent` only when
  KV persistence is active.

### 3.8 Business Rules

- **Depth-keyed filenames:** the cache file for the agent at depth `N` is always
  `kv-depth-{N}.bin`. No other naming scheme is used.
- **Owner deletes own file:** a depth deletes only the file it created (its own
  `kv-depth-{N}.bin`), and only after a successful restore of that file.
- **Fail-open everywhere:** a save or restore failure never aborts a turn and never
  turns a subagent outcome into an error. The worst case is a re-prefill.
- **Opt-in:** none of this happens unless the active model's provider has
  `kvPersistence: true`.

---

## 4. Edge Cases and Error Handling

| Scenario                                                         | Behavior                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Server not started with `--slot-save-path` (save → HTTP 501)     | Save fails → warn, proceed without save. Restore skipped (no file). Main agent re-prefills.     |
| Save fails (network / 500 / disk full)                           | Warn, proceed without save. Restore skipped. Main agent re-prefills.                            |
| Restore fails (file missing / corrupt / server error)            | Warn, continue. Agent re-prefills next turn. Turn not aborted.                                  |
| Delete fails after a successful restore                          | Warn. File may linger until overwritten on the next run at that depth. Turn not affected.       |
| Subagent fails (LLM error / cap / exception)                     | `subagent:after` still fires (finally) → restore + delete run. Main KV recovered.               |
| `kvPersistence` true but `slotSavePath` missing                  | Fatal config error at provider construction.                                                    |
| Non-llama provider, or llama provider with `kvPersistence` false | No KV hooks contributed. No save/restore. Behavior identical to before.                         |
| Multiple concurrent `spawn_subagent` calls with KV active        | Serialized (one at a time).                                                                     |
| Multiple concurrent `spawn_subagent` calls with KV inactive      | Concurrent (unchanged).                                                                         |
| Deeply nested subagents (arbitrary depth)                        | Each level saves/restores/deletes its own `kv-depth-{N}.bin`. Disk bounded to live stack depth. |
| Top-level turn ends                                              | All `kv-depth-*.bin` files have been deleted. Disk clean.                                       |

---

## 5. Non-Functional Requirements

- **Performance (qualitative):** the main agent does not re-prefill its conversation
  after a subagent call. The save/restore cost (tens to ~200 ms for a few-K-token
  cache, per llama.cpp measurements) is far less than a cold re-prefill (tens of
  seconds). No numeric target is mandated.
- **Disk usage:** bounded to the number of **live** ancestor depths (the current stack
  depth). Each file is deleted as soon as its owner restores it. When the top-level
  turn ends, zero KV files remain. File size grows linearly with the cached context
  (≈ 50 MB per 1K tokens in llama.cpp measurements); the operator is responsible for
  ensuring the `--slot-save-path` volume has headroom.
- **Compatibility:** requires a llama.cpp server built with slot save/restore support
  and started with `--slot-save-path DIR`. Text-only models. SWA models require
  `--swa-full` for a complete save.
- **Local-harness assumption:** the provider deletes files via `node:fs`, so the
  llama.cpp server must run on the **same host** as the harness (the `slotSavePath`
  must be a path the harness process can access). This matches Vise's local,
  self-contained design.

---

## 6. Data Requirements

- **Save/restore request body:** `{"filename": "kv-depth-{N}.bin"}`. The client sends
  only the filename; the server reads/writes it under its own `--slot-save-path` dir.
- **Deletion:** `node:fs` `unlink` of `{slotSavePath}/kv-depth-{N}.bin`. This is the
  only place the full path is needed (llama.cpp has no file-delete endpoint; `erase`
  clears the in-RAM cache only).
- **No new persistent state file:** KV cache files are transient and are always cleaned
  up. They are not part of `.vise/state.json`.

---

## 7. External Dependencies

- **llama.cpp server** with:
  - `--slot-save-path DIR` (enables `POST /slots/{id}?action=save|restore`; without it
    these return HTTP 501).
  - A single slot (`-np 1`, the default). The slot id is `0`.
  - Slot save/restore support (current llama.cpp). Text-only model.
- **Node built-ins:** `fetch` (save/restore HTTP), `node:fs` (file deletion). No new
  runtime dependencies.

---

## 8. Constraints, Assumptions, and Changed Invariants

### 8.1 Changed invariant: synchronous-only hooks

The hooks spec (§1.4) states hooks are synchronous-only. This feature adds two events,
`subagent:before` and `subagent:after`, whose handlers **may return a Promise**. The
`HookManager` must `await` handlers for these two events and must not `await` (and must
still treat a returned Promise as an error/warning for) the other seven events. The
synchronous guarantee is preserved for all pre-existing events.

### 8.2 Changed invariant: hooks are never global

The profiles spec states hooks are per-profile and never global. This feature allows a
**provider** to contribute hooks that are merged into every session's `HookManager` at
every depth. Providers remain **config-time conventions, not graph nodes** — they do not
become nodes and there is no new `Provider→Hook` edge type. The contribution happens via
the new `Provider.hooks()` method at materialization time.

### 8.3 New runner plumbing

The subagent runner must be given the **spawner's** `HookManager` and the spawner's
**depth** so it can fire `subagent:before`/`subagent:after` against the correct manager
at the correct depth. Today it only receives the subagent's materialized profile.

### 8.4 Changed invariant: tool execution ordering

The "read-only tools run concurrently" rule is suspended for `spawn_subagent` **only
when** the active model's provider has `kvPersistence: true`. In that case subagent
runs are serialized. When KV persistence is inactive, `spawn_subagent` remains
concurrent as before.

### 8.5 Assumptions

- Single llama.cpp slot (`-np 1`). Multi-slot topologies are out of scope.
- The llama.cpp server runs on the same host as the harness (local `slotSavePath`).
- The model is text-only (no mmproj) and, if SWA, started with `--swa-full`.

---

## 9. Acceptance Criteria

1. **Opt-in is inert by default.** A `LlamaProvider` constructed without
   `kvPersistence` contributes no hooks; a session using it performs no save/restore and
   behaves identically to v0.2.0.
2. **Save on subagent start.** With `kvPersistence: true`, when the main agent (depth 0)
   calls `spawn_subagent`, a `POST /slots/0?action=save` with
   `{"filename":"kv-depth-0.bin"}` is issued before the subagent's first LLM call.
3. **Restore on subagent end.** When the subagent finishes (any outcome), a
   `POST /slots/0?action=restore` with `{"filename":"kv-depth-0.bin"}` is issued, and
   `kv-depth-0.bin` is then deleted from `slotSavePath`.
4. **Restore on failure.** If the subagent fails (LLM error, iteration cap, or thrown
   error), the restore + delete in step 3 still occur.
5. **Every level.** A subagent at depth 1 that spawns a subagent at depth 2 causes
   `kv-depth-1.bin` to be saved before and restored+deleted after the depth-2 run, and
   `kv-depth-0.bin` to be saved before and restored+deleted after the depth-1 run.
6. **Disk clean at turn end.** After the top-level turn completes, no `kv-depth-*.bin`
   files remain in `slotSavePath`.
7. **Fail-open save.** If the save request fails (e.g., HTTP 501 because the server
   lacks `--slot-save-path`), a warning is logged, the subagent still runs, no restore
   is attempted, and the turn is not aborted.
8. **Fail-open restore.** If the restore request fails, a warning is logged and the turn
   is not aborted.
9. **Serialization.** With `kvPersistence: true`, two `spawn_subagent` calls in one
   assistant message run one at a time. With `kvPersistence` false, they run
   concurrently.
10. **Config validation.** Constructing a `LlamaProvider` with `kvPersistence: true`
    and no `slotSavePath` throws a fatal config error.
11. **Async events only where allowed.** A handler returning a Promise on
    `subagent:before`/`subagent:after` is awaited; a handler returning a Promise on any
    of the seven pre-existing events is treated as an unsupported result (warning),
    preserving the synchronous guarantee.
12. **Integration.** An end-to-end test against the mock OpenAI-compatible SSE server
    (extended to accept `POST /slots/{id}?action=save|restore`) drives a main agent →
    subagent → main agent sequence and asserts the save and restore calls occur in the
    correct order with the correct filenames.

---

## 10. Open Questions

None. All decisions were confirmed with the user:

- Mechanism: async hooks contributed by the provider (`Provider.hooks()`), merged into
  every session at every depth.
- Events: `subagent:before` (save) / `subagent:after` (restore + delete), async, fired
  on the spawner's `HookManager` at the spawner's depth.
- Topology: single slot, every level, depth-keyed stack.
- Files: `kv-depth-{N}.bin`; owner deletes its own file after a successful restore.
- Save path: `slotSavePath` provider option (required when `kvPersistence` is true);
  example value `C:\Users\mathm\AppData\Local\llama-slots`.
- Failures: fail-open for both save and restore; always restore in `finally`.
- Concurrency: serialize subagents when KV persistence is active.
- NFR: qualitative (no re-prefill); no numeric target.
