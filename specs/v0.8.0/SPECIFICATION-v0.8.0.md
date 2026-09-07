# System Specification: Session Save & Load

**Version:** 0.8.0
**Date:** 2026-02-26
**Builds on:** v0.7.0 (`ask_questions` tool)

---

## 1. Purpose and Scope

### 1.1 Purpose

Add the ability to **save a conversation and load it back later**, so a user can
stop working on a task, come back hours or days later (in a new process), and
**resume the same conversation with its full context**.

Today Vise persists only the active profile and model across runs
(`.vise/state.json`, written by `src/profiles/state.ts` on clean exit). The
conversation itself — `Session.messages` — is ephemeral and lost when the process
ends. This feature makes the conversation durable.

A saved session captures:

- **The conversation** — the message history (every user / assistant / tool
  exchange).
- **The active profile and model** — so the session resumes under the same
  configuration.
- **A human-readable title** — so saved sessions can be told apart.

Sessions are **named** and **multiple** may coexist. A reserved session named
**`last`** is auto-saved on clean exit as a safety net, so the most recent
conversation is always recoverable.

This feature **supersedes** the existing `state.json` mechanism, which is removed
(§3.4, §8).

**Stakeholders:**

- **The user** (REPL or GUI), who saves, lists, loads, renames, and deletes
  sessions.
- **The Vise runtime**, which owns the new persistence layer and the REPL/GUI
  command surface.
- **The model**, which is unaffected — it sees the same `Session.messages` it
  always has; persistence is transparent to it.

### 1.2 Success criteria

- In the **REPL**, the user can `/save` (auto-named) or `/save <name>` to persist
  the current conversation, `/sessions` to list saved sessions, `/load <name>` to
  resume one (replacing the current conversation), `/rename <old> <new>` to
  rename, and `/delete <name>` to remove.
- In the **GUI**, the same operations are available from a sessions panel.
- On **clean exit** (REPL or agent-server), the current non-empty conversation is
  auto-saved under the reserved name `last`.
- A **fresh start** (plain `vise`) begins with an **empty** conversation under the
  built-in `Agent` profile; the user resumes a prior conversation explicitly via
  `/load last` (or `/load <name>`).
- The existing `state.json` mechanism is **removed**; nothing reads or writes it.
- A **corrupt or version-mismatched** session file never crashes Vise; it is
  reported and the user is offered a way to delete it.
- The existing REPL and GUI continue to work unchanged for all commands that are
  not session-related.

### 1.3 Explicitly out of scope (this version)

- **Subagent state.** Only the top-level conversation is saved. Subagent
  conversations (depth > 0) are ephemeral and are not persisted or restored.
- **A `--session` CLI flag.** There is no command-line way to start directly into
  a saved session; resume is REPL/GUI-only (confirmed).
- **A dedicated title-edit command.** `title` defaults to the session name;
  renaming the identifier (`/rename`) is supported, but there is no separate
  command to edit only the title.
- **Cross-machine sync / sharing.** Sessions are local files; there is no
  upload, sync, or share mechanism.
- **Locking / concurrency control.** Two processes in the same project may both
  auto-save `last`; last writer wins (confirmed). No file locking.
- **Compaction state.** `lastPromptTokens` is not persisted; it resets to `null`
  on load and is re-measured on the next LLM call.
- **Migration tooling beyond a version check.** Old `state.json` files are simply
  ignored (and may be left on disk); there is no importer that converts them into
  sessions.

---

## 2. Domain Model

### 2.1 New Entities

#### `SavedSession`

The in-memory representation of one saved session, read from or written to a
session file.

| Field      | Type        | Required | Description                                                                |
| ---------- | ----------- | -------- | -------------------------------------------------------------------------- |
| `version`  | `number`    | Yes      | Format version. `1` for this release. Used for forward-compat checks.      |
| `name`     | `string`    | Yes      | The session identifier. Unique within a store. Equals the filename stem.   |
| `title`    | `string`    | Yes      | Human-readable label shown in listings. Defaults to `name` at save time.   |
| `profile`  | `string`    | Yes      | The profile name active at save time.                                      |
| `model`    | `string`    | Yes      | The model name active at save time. `""` if none was pinned.               |
| `savedAt`  | `string`    | Yes      | ISO 8601 timestamp of when the session was saved.                          |
| `messages` | `Message[]` | Yes      | The conversation, **excluding** all leading system messages (see §3.3 R1). |

`Message` is the existing domain type from `src/types.ts`
(`{ role, content, tool_calls?, tool_call_id?, name? }`). It is stored verbatim;
no wire-format conversion is involved (persistence is a domain-level concern, not
a wire concern — the one-in/one-out wire seam is untouched).

#### `SessionFile`

The on-disk JSON document. It is exactly a `SavedSession` serialized to JSON.
There is no wrapper or envelope beyond the fields above.

### 2.2 Storage layout

Sessions are stored as **one JSON file per session** in a `sessions/` directory
that follows the **same project-vs-global rule as `state.json`**
(`findConfigEntry(root) !== null`):

- **Project-local:** `./.vise/sessions/<name>.json` — when a project config
  (`.vise/index.ts`) exists in the working tree.
- **Global:** `~/.vise/sessions/<name>.json` — otherwise.

Rules:

- The `sessions/` directory is created on first write (like `state.json`'s
  `mkdirSync(..., { recursive: true })`).
- The directory and its files are **gitignored** (per-user state, not config).
- `<name>` is the session name, sanitized to a safe filename stem (§3.3, R5).
- The reserved name **`last`** maps to `last.json` in the same store.

### 2.3 State transitions

A session file has no lifecycle of its own; the **conversation** it captures has
this lifecycle:

```
        /save [name]            /load <name>
  (live) ───────────────► (saved) ───────────────► (live, replaces current)
     │                          │
     │  clean exit              │  /delete <name>
     └──────────────► last.json └──────────────────► (removed)
```

- **Live → Saved:** `/save` (named) or auto-save on exit (`last`).
- **Saved → Live:** `/load` replaces the current conversation with the saved one.
- **Saved → removed:** `/delete`.
- **Live → (nothing):** `/clear` empties the conversation (existing command); it
  does not create or touch any session file.

---

## 3. Functional Requirements

### 3.1 REPL commands

Five new slash commands are added to the `REPL_COMMANDS` registry in
`src/cli/commands.ts` (the single source of truth for dispatch and `/help`).
`/clear` already exists and is unchanged.

| Command     | Args          | Behavior                                                                  |
| ----------- | ------------- | ------------------------------------------------------------------------- |
| `/save`     | `[name]`      | Save the current conversation. With no name, auto-generate one (§3.3 R4). |
| `/load`     | `<name>`      | Load a saved session, replacing the current conversation.                 |
| `/sessions` | —             | List all saved sessions (name, title, model, savedAt).                    |
| `/rename`   | `<old> <new>` | Rename a saved session (updates filename and `name`/`title`).             |
| `/delete`   | `<name>`      | Delete a saved session file.                                              |

Command-matching rules (existing `findCommand` semantics) apply: `/save`,
`/load`, `/rename`, `/delete` set `takesArgs: true`; `/sessions` matches its exact
name only.

### 3.2 GUI surface

The GUI gains a **sessions panel** exposing the same five operations:

- **List** — the current sessions (name, title, model, savedAt).
- **Save** — save the current conversation (optionally with a name).
- **Load** — pick a session to load (replaces the current conversation).
- **Rename** and **Delete** — per selected session.

The agent-server exposes these over the existing WebSocket. Per the
**additive-only protocol invariant**, the new client commands and server events
are additions; older clients that ignore them continue to work. The GUI client
types (`gui/src/types.ts`) are updated by hand to mirror the new protocol types,
as with every protocol change.

The agent-server **auto-saves `last` on clean shutdown**, mirroring the REPL
(§3.5, W4). Because the server keeps the session alive after the browser
disconnects, "clean shutdown" means the server process terminating, not the
browser closing.

### 3.3 Expected behaviors & business rules

**R1 — Save captures the conversation minus the system message(s).**
On save, **all leading** `role: "system"` messages are **stripped** from
`Session.messages` before persisting. (In `append` profile-switch mode there can
be more than one leading system message — the same set `clearConversation`
keeps.) The system prompt is **re-derived from the profile at load time** (R2),
so a saved session always resumes with the profile's _current_ system prompt,
not a stale copy. All non-system messages (user, assistant, tool) are stored
verbatim.

**R2 — Load re-resolves the system prompt.**
On load, Vise resolves the system prompt for the session's saved `profile` from
the current config graph and **prepends** it as the first message, then appends
the saved non-system messages. If the saved profile no longer exists, the
fallback in R6 applies.

**R3 — Load replaces the current conversation.**
`/load <name>` discards the current `Session.messages` and installs the loaded
conversation (system prompt + saved messages). `lastPromptTokens` is reset to
`null`. The active profile and model are set to the session's saved values
(subject to R6).

**R4 — Auto-generated names.**
`/save` with no argument generates a name from the save timestamp (e.g.
`2026-02-26T12-00-00`) so repeated unnamed saves do not collide. The `title`
defaults to the name.

**R5 — Name sanitization.**
A user-supplied name is sanitized to a safe filename stem: path separators and
other filesystem-unsafe characters are removed or replaced; the result must be
non-empty and must not equal a path. Names are compared case-sensitively. A name
that sanitizes to empty is rejected with a clear error.

**R6 — Stale profile or model: warn and fall back.**
If a loaded session's saved `profile` no longer names a profile in the current
config graph, Vise **warns** (naming the missing profile) and falls back to the
built-in `Agent` profile, re-deriving the system prompt from it. If the saved
`model` is not available, Vise warns and lets normal model resolution proceed for
the (possibly fallen-back) profile. The conversation is still loaded in both
cases.

**R7 — `last` is a snapshot at exit.**
Auto-save on clean exit writes the _current_ conversation under `last`,
overwriting any prior `last`. It is independent of named sessions: loading a
named session, editing, and exiting writes the edited conversation to `last`.

**R8 — Empty conversations are not auto-saved.**
If, at clean exit, the conversation has no non-system messages (the user started
and exited without doing anything), auto-save is **skipped** and no `last.json`
is written (or, if one exists from a prior run, it is left untouched).

### 3.4 Workflows

**W1 — Save a named session (REPL).**

1. User runs `/save auth-refactor` (or `/save` for an auto name).
2. Vise strips the system message, resolves the current profile/model, and writes
   `sessions/<name>.json` (creating `sessions/` if needed).
3. Vise prints confirmation with the saved name.

**W2 — List sessions.**

1. User runs `/sessions`.
2. Vise reads the store directory, parses each file, and prints a table of
   name / title / model / savedAt. Corrupt files are listed as unreadable (§4).

**W3 — Load / resume.**

1. User runs `/load auth-refactor` (or `/load last`).
2. Vise reads and validates the file (§4), resolves the system prompt for the
   saved profile (R2), and replaces the current conversation (R3).
3. Vise prints confirmation (profile, model, message count), with any R6 warnings.

**W4 — Auto-save on clean exit.**

1. On clean exit (REPL `/exit`/Ctrl-D, or agent-server shutdown), if the
   conversation is non-empty (R8), Vise writes `sessions/last.json`.
2. This **replaces** the old `writeStateFile` call in `src/cli/repl.ts` and
   `src/server/server.ts`.

**W5 — Fresh start.**

1. Plain `vise` starts with an **empty** conversation under the built-in `Agent`
   profile. No session is auto-loaded.
2. The user resumes a prior conversation with `/load last` or `/load <name>`.
3. `/clear` (existing) empties the current conversation without touching any file.

### 3.5 Removal of `state.json`

The existing `state.json` mechanism is **removed entirely** (confirmed):

- `src/profiles/state.ts`: the `StateFile` type, `stateFilePath`,
  `resolveStartingProfile`, `writeStateFile`, and `isStateFile` are removed.
- `src/startup.ts` (`prepareSession`): no longer calls `stateFilePath` /
  `resolveStartingProfile`. A fresh session always starts under the built-in
  `Agent` profile with no saved-model pin.
- `src/cli/repl.ts` and `src/server/server.ts`: the `writeStateFile` calls are
  replaced by the session auto-save (W4).
- The "pin auto-discovery on restart" behavior that `lastModel` provided
  (config spec §3.8.4) is **superseded**: a fresh start performs normal model
  resolution with no pin.
- Any existing `state.json` files on disk are **ignored** (not read, not
  migrated, not deleted by Vise).

---

## 4. Edge Cases and Error Handling

| #   | Condition                                                                                                    | Behavior                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `/load <name>` where no such session exists                                                                  | Print a clear "no session named `<name>`" error **and list the sessions that do exist**, so the user can pick one. The current conversation is unchanged. |
| E2  | Session file is corrupt (invalid JSON)                                                                       | Report the file as unreadable (in `/sessions` and on `/load`), **and offer to delete it** (REPL: prompt y/n; GUI: a delete affordance). Never crash.      |
| E3  | Session file has an unsupported `version`                                                                    | Treat as unreadable: warn that the file was written by an incompatible Vise version, and offer to delete it. Do not attempt a partial load.               |
| E4  | Session file is well-formed JSON but missing/invalid required fields (e.g. no `messages`, bad `role` values) | Treat as corrupt (E2). Validate the `SavedSession` shape before use.                                                                                      |
| E5  | Saved profile no longer exists                                                                               | Warn and fall back to `Agent`; re-derive the system prompt from `Agent`; still load the conversation (R6).                                                |
| E6  | Saved model no longer available                                                                              | Warn; proceed with normal model resolution for the (possibly fallen-back) profile (R6).                                                                   |
| E7  | `/save` / `/rename` with a name that sanitizes to empty (R5)                                                 | Reject with a clear error; nothing is written.                                                                                                            |
| E8  | `/save <name>` where `<name>` already exists                                                                 | Overwrite the existing session file (a save is idempotent per name). Confirm the overwrite.                                                               |
| E9  | `/rename <old> <new>` where `<old>` does not exist                                                           | Clear error; list available sessions.                                                                                                                     |
| E10 | `/rename <old> <new>` where `<new>` already exists                                                           | Reject with a clear error (no silent clobber on rename).                                                                                                  |
| E11 | `/delete <name>` where `<name>` does not exist                                                               | Clear "no session named `<name>`" error; list available sessions.                                                                                         |
| E12 | Deleting the reserved `last`                                                                                 | Allowed; `last` is an ordinary session file. A subsequent clean exit re-creates it (W4).                                                                  |
| E13 | Store directory or a file is not writable (permissions, read-only FS)                                        | Report a clear I/O error for the affected operation. A failed auto-save on exit **warns but does not block exit**.                                        |
| E14 | Two processes auto-save `last` concurrently                                                                  | Last writer wins (confirmed). No locking; no error.                                                                                                       |
| E15 | Conversation has tool calls referencing files that no longer exist                                           | No special handling. Tool results are historical text; loading does not re-execute anything. The model sees the prior results as-is.                      |

**General invariant (carried from the harness):** a bad or missing session file
**never blocks startup**. Startup (W5) does not read any session file; only an
explicit `/load` does, and a failed `/load` leaves the current conversation
intact.

---

## 5. Non-Functional Requirements

- **Performance:** Listing sessions (`/sessions`) must scale to at least a few
  hundred session files without perceptible lag (read + parse each file; no
  indexing required for this version). Save and load of a single session must
  complete in well under a second for conversations up to tens of thousands of
  tokens.
- **Scalability / limits:** **No hard cap** on the number of sessions or the size
  of a single session file (confirmed). Disk is the only limit. (A future version
  may add a soft warning; out of scope here.)
- **Reliability:** Persistence failures are non-fatal to the running session and
  to process exit (§4, E13). The conversation in memory is never corrupted by a
  failed save.
- **Security:** Session files may contain sensitive conversation content. They
  are written to the user's own `.vise/` (project) or `~/.vise/` (global)
  directory with default (user-only) permissions and are gitignored. No
  encryption is required for this version.
- **Portability within a machine:** A session file is plain JSON and is
  self-contained (no absolute paths to Vise internals), so it can be copied
  between the project and global stores, or between machines, and loaded — though
  cross-machine sharing is not a tested scenario this version.
- **Compatibility:** The format is **versioned** (`version: 1`). A reader must
  check `version` and reject (E3) rather than misparse an unknown version.

---

## 6. Data Requirements

- **Input formats:** None beyond what the session already holds. Save serializes
  the in-memory `SavedSession` to JSON.
- **Output / storage format:** One JSON file per session at
  `.vise/sessions/<name>.json` or `~/.vise/sessions/<name>.json` (§2.2). UTF-8.
  Shape = `SavedSession` (§2.1).
- **Storage requirements:** Plain files on the local filesystem via `node:fs`
  (`mkdirSync`, `writeFileSync`, `readFileSync`, `readdirSync`, `unlinkSync`,
  `renameSync`). No new runtime dependencies.
- **Retention:** Sessions persist until explicitly deleted. `last` is overwritten
  on each clean exit. Vise does not auto-prune or expire sessions this version.

---

## 7. External Dependencies

- **None new.** The feature uses only Node built-ins already in use by
  `src/profiles/state.ts` (`node:fs`, `node:path`, `node:os`). No network, no
  third-party packages.
- **LLM backend:** unaffected. Persistence is transparent to the model and to the
  wire seam.

---

## 8. Constraints and Assumptions

- **C1 — Domain-level persistence.** Session files store the domain `Message`
  type, not the OpenAI wire shape. The one-in/one-out wire seam
  (`toWireMessage` / `accumulate`) is not involved and must not be.
- **C2 — `src/index.ts` stays side-effect-free.** The new persistence module must
  not be imported by `src/index.ts` in a way that touches the filesystem at
  import time.
- **C3 — Single startup seam.** All startup changes (removing the `state.json`
  read) go through `prepareSession()` in `src/startup.ts`; the REPL and
  agent-server do not each re-implement startup logic.
- **C4 — Additive protocol.** GUI protocol changes are additive-only; `gui/src/types.ts`
  is updated by hand alongside `src/server/protocol.ts`.
- **A1 — Single-user, local.** Vise is a local, single-user tool. Concurrent-use
  semantics are "last writer wins" (E14); no multi-user or locking guarantees.
- **A2 — Top-level conversation only.** Subagent state is out of scope (§1.3); a
  saved session restores only the main conversation.
- **A3 — System prompt tracks the profile.** Because the prompt is re-derived on
  load (R2), editing a profile's prompt changes what a previously-saved session
  resumes with. This is intended (confirmed).

---

## 9. Acceptance Criteria

Each maps to a test in `test/` (new `test/sessions.test.ts`, plus edits to
`test/cli.test.ts`, `test/server.test.ts`, and removal of `state.json` coverage).

1. **Save (named):** `/save foo` writes `.vise/sessions/foo.json` containing
   `version: 1`, the saved profile/model, a `savedAt`, and the conversation
   **without** any leading system messages.
2. **Save (auto):** `/save` with no argument writes a file with a
   timestamp-derived, non-colliding name; `title` equals the name.
3. **List:** `/sessions` lists all saved sessions with name, title, model, and
   savedAt; an empty store prints an empty-state message.
4. **Load:** `/load foo` replaces the current conversation with the saved one,
   **prepends a freshly-resolved system prompt** for the saved profile, resets
   `lastPromptTokens` to `null`, and sets the active profile/model.
5. **Load (missing):** `/load nope` prints a clear error **and** the list of
   existing sessions; the current conversation is unchanged.
6. **Rename:** `/rename a b` renames the file and updates `name`/`title`;
   renaming onto an existing name is rejected (E10).
7. **Delete:** `/delete foo` removes the file; deleting a missing name errors and
   lists sessions (E11).
8. **Auto-save on exit:** a non-empty conversation is written to `last.json` on
   clean REPL exit and on clean agent-server shutdown; an empty conversation is
   not (R8).
9. **Fresh start:** plain startup begins with an empty conversation under the
   built-in `Agent` profile and reads no session file.
10. **state.json removed:** no code path reads or writes `state.json`;
    `resolveStartingProfile`/`writeStateFile`/`StateFile` are gone; a pre-existing
    `state.json` on disk is ignored.
11. **Corrupt file:** a malformed JSON session file is reported as unreadable and
    offers deletion; it never throws out of `/sessions` or `/load` (E2).
12. **Version mismatch:** a file with an unknown `version` is rejected with a
    clear message and offers deletion (E3).
13. **Stale profile:** loading a session whose profile no longer exists warns,
    falls back to `Agent`, re-derives the prompt, and still loads the messages
    (R6, E5).
14. **Name sanitization:** a name with path separators is sanitized (R5); a name
    that sanitizes to empty is rejected (E7).
15. **GUI:** the sessions panel lists, saves, loads, renames, and deletes; the
    new protocol messages are additive and `gui/src/types.ts` mirrors them.
16. **Non-fatal I/O:** a non-writable store causes a clear error on save and a
    warning (not a crash) on exit auto-save (E13).

---

## 10. Open Questions

None.
