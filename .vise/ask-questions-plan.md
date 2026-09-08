# Plan: Implement `ask_questions` Tool (v0.7.0)

Implements `specs/v0.7.0/SPECIFICATION-v0.7.0.md`. Adds a built-in `ask_questions`
tool that pauses the turn and asks the human a small batch of structured questions
(1–3), then continues with the answers. A new **user-input channel** is threaded
through the session tree so the tool reaches the human on whichever surface is
active (REPL readline or GUI WebSocket). Several batches may be pending
concurrently (concurrent subagents); each surface presents them one at a time, FIFO.

**Approach:** follow the existing `render`/`client` threading pattern exactly —
add an optional `channel` field to `AgentContext`, thread it through
`SessionOptions` → `createSession` → `ctx`, and register the tool in
`buildToolRegistry` (which `materializeProfile` feeds with `ctx.channel` + `depth`).
Because `AgentContext` is shared by reference across the whole tree, every agent
(main + all subagents, every depth) gets the tool bound to the same channel,
tagged with its own depth — no per-subagent wiring.

---

## Phase 0 — Prerequisites (schema + constants)  [PARALLEL]

1. **Extend `JsonSchemaProperty`** — `src/types.ts:82`. Add `"array"` to the
   `type` union; add optional `items?: JsonSchema` and `maxItems?: number`.
2. **Extend `validateArgs`** — `src/tools/registry.ts:57`. Add array handling per
   spec §2.3. **Refinement:** extract a small recursive `validateValue(prop, value, key)`
   helper so it handles BOTH the top-level `questions` array (array of objects) AND
   each question's nested `options` array (array of strings). Rules: non-array value
   → `parameter "<key>" must be an array`; `maxItems` exceeded → `…must have at most
   <maxItems> items`; when `items.type === "object"`, validate each element against
   `items` (required + properties); when `items.type === "string"`, check each
   element is a string. Existing scalar/enum behavior preserved.
3. **Add the tool name** — `src/tools/names.ts:8` (`BUILTIN_TOOL_NAMES`) and
   `src/tools/metaTools.ts:11` (`CORE_TOOL_NAMES`) both gain `"ask_questions"`.

## Phase 1 — Core types + channel threading  [SEQUENTIAL 4→5→6→7]

4. **Define the domain types** — new file `src/agent/userInput.ts`: `Question`,
   `QuestionAnswer`, `AskResult`, and the `UserInputChannel` interface
   (`ask(questions, { depth }): Promise<AskResult>`; `cancelPending(): void`) —
   verbatim per spec §2.1. Export all four as **types** from `src/index.ts`
   (keep it side-effect-free; add to the type-export block near `src/index.ts:42`).
5. **Add `channel` to `AgentContext`** — `src/agent/subagent.ts:57`:
   `channel?: UserInputChannel`.
6. **Thread through session creation** — `src/agent/session.ts`: add
   `channel?: UserInputChannel` to `SessionOptions` (line 32); in `createSession`
   (line 152) fold it into `ctx` exactly like `render`/`client` (line 160).
7. **Register the tool in the registry** — `src/tools/index.ts:54`: extend
   `buildToolRegistry(config, selection, opts?)` with `opts?: { channel?:
   UserInputChannel; depth?: number }`. **Refinement:** add
   `makeAskQuestionsTool(opts?.channel, opts?.depth ?? 0)` to the `builtins` array
   (line 66) so the existing `wanted(tool.name)` gate (line 83) controls
   registration (A19) AND it appears in the dynamic-mode advertised set (line 99).
   In `materializeProfile` (`src/agent/subagent.ts:165`, the `buildToolRegistry`
   call at line 178) pass `{ channel: ctx.channel, depth }`.

## Phase 2 — The tool  [DEP Phase 1]

8. **`makeAskQuestionsTool(channel, depth)`** — new file `src/tools/askQuestions.ts`.
   Factory returns a `Tool` (shape per `src/types.ts:38`):
   - `name: "ask_questions"`, `mutating: false`, `noTruncate: true`.
   - `parameters`: the JSON schema from spec §3.1 (`questions` array, `maxItems: 3`,
     `items` object with `id`/`text` required, `options` string array, `select` enum).
   - `description`: the model-facing text from spec §3.1.
   - `handler`: if `channel === undefined` → return the exact §3.5 "user
     unavailable" string (no `channel.ask` call). Else `await
     channel.ask(questions, { depth })` and return `JSON.stringify(result)`.

## Phase 3 — REPL channel  [DEP Phase 1, PARALLEL w/ 4,5]

9. **`ReplUserInputChannel`** — new file `src/cli/userInput.ts`. Wraps the REPL's
   `readline` `Interface`. Keeps a FIFO queue of pending batches; a single
   presenter loop pulls the front batch and prompts its questions in order
   (choice → numbered options + free text; free → text line), indenting by
   `"  ".repeat(depth) + "  "` (matching `makeSubagentRender`, `src/cli/repl.ts:247`),
   re-prompting on empty (all questions required). `cancelPending()` resolves
   **every** queued batch `cancelled` and clears the pending prompt.
10. **Wire into the REPL** — `src/cli/repl.ts`: **Refinement (ordering):**
    `createSession` is currently called at line 74, *before* `rl` is created at
    line 80. Reorder so `rl` is created first, then the channel (holding a
    reference to `rl`), then `createSession({ ..., channel })`. In the per-turn
    `onSigint` handler (`executeTurn`, line 178) call `channel.cancelPending()` —
    **Refinement:** `executeTurn` currently only receives `handle`, so pass the
    channel into `executeTurn` so the SIGINT handler can cancel pending asks.

## Phase 4 — Server channel + protocol  [DEP Phase 1, PARALLEL w/ 3,5]

11. **Protocol types** — `src/server/protocol.ts`: add the `askQuestions`
    server→client event (`{ id, scope, questions }`) and the `answerQuestions`
    client→server command (`{ id, answers }`) per spec §3.6.
12. **`ServerUserInputChannel`** — on `AgentServer` (`src/server/server.ts`).
    Holds `pendingAsks = new Map<requestId, (r: AskResult) => void>()`.
    - `ask(questions, { depth })`: mint `requestId` via `newId()` (imported at
      server.ts:44), store the resolver, `emit` an `askQuestions` event (scope from
      `subagentIds` depth→id, `{ kind: "main" }` at depth 0), await the resolver.
      *Verified:* `askQuestions` is not in `isTurnEvent` (`src/server/translate.ts:120`),
      so it is sent immediately and not buffered into `inflightBuffer`.
    - `cancelPending()`: resolve **every** pending ask `cancelled`, clear the map.
    - Wire `channel` into `createSession` (server.ts:105).
    - Add `case "answerQuestions"` to `handleCommand` (server.ts:308, before
      `default:` at 347): look up resolver by `id`; if found resolve `answered` +
      delete; else send `commandResult { ok: false, error: "No pending question
      batch with id <id>." }`.
    - Call `cancelPending()` in `doAbort` (server.ts:427) and `onWsClose`
      (server.ts:303).

## Phase 5 — GUI client  [DEP Phase 1, PARALLEL w/ 3,4]

13. **Mirror protocol types** — `gui/src/types.ts`: add `askQuestions` to
    `ServerEvent` (line 7) and `answerQuestions` to `ClientCommand` (line 65).
14. **Store FIFO queue** — `gui/src/store.ts`: add a `pendingQuestions` signal
    (`{ id, scope, questions }[]`) near the other signals (lines 71–80). In
    `applyEvent` (line 304): append on `askQuestions`; the three reset cases
    (`snapshot` line 306, `turnEnd` line 389, `cleared` line 407) clear the whole
    queue. Expose `pendingQuestions` (and a `submitAnswers(id, answers)` helper
    that shifts the queue) in the returned object (line 435). The batch is **not**
    a row — it never enters `rows`/`blocks`. Keep it a plain `createSignal` (like
    `sessions`), not a `solid-js/store` path.
15. **Form overlay** — new `QuestionForm` component in `gui/src/Markdown.tsx`
    (presentational, like `ReasoningBlock` at line 22) + render in `gui/src/App.tsx`
    as a `<Show when={store.pendingQuestions().length > 0}>` overlay above the
    conversation (near `<main class="layout">` at line 229 / `<footer
    class="inputbar">` at 318). Renders only the **front** batch: per question,
    radio (`single`) / checkboxes (`multiple`) + a free-text input, or a text
    input for free questions; a single Submit. Submit builds `answers` (selected in
    presented order + trimmed text), `client.send({ type: "answerQuestions", id,
    answers })`, then shifts the queue. Validation: block submit if any question
    has no selection and no free text. Label the form when `scope.kind ===
    "subagent"`.
16. **CSS** — `gui/src/styles.css`: add `.question-overlay` (fixed, centered card)
    and `.question-form`, reusing `.control` (line 71) for inputs and `.send`
    (line 391) for submit; match the `.subagent-head` card style (line 307).

## Phase 6 — Tests + verification  [DEP Phases 2–5]

17. **Tool unit tests** — `test/askQuestions.test.ts` (new): mock channel injected
    via `makeAskQuestionsTool` / `createSession({ channel })`. Cover: free
    question returns text (A2); single-choice returns `selected` (A3);
    multiple-choice returns all in order (A4); no channel → exact §3.5 string, no
    `channel.ask` (A5); result is `JSON.stringify` and not truncated (A9);
    `cancelPending()` resolves `cancelled` (A10).
18. **Schema validation tests** — extend `test/tools.test.ts`: `validateArgs`
    rejects >3 items (A6), rejects non-array (A7), accepts a valid batch and
    validates each question's `id`/`text`/`options` (A8).
19. **GUI store tests** — extend `test/guiStore.test.ts`: `askQuestions` appends to
    the queue; FIFO order across two batches; submit shifts; `turnEnd`/`cleared`/
    `snapshot` clear the queue (A13, A14).
20. **Server tests** — extend `test/server.test.ts`: `answerQuestions` resolves the
    matching ask; stale/unknown `id` → `commandResult { ok: false }` (A15); abort
    and WS close cancel pending asks (A16); older client ignoring `askQuestions`
    doesn't crash the server (A17).
21. **Integration** — extend `test/subagent.test.ts`: a subagent's `ask_questions`
    calls the **same** channel as the main agent, tagged with the subagent's depth
    (A11).
22. **Manual** — REPL: run a task that triggers `ask_questions`, answer a
    single/multiple/free question, confirm indentation + re-prompt-on-empty; Ctrl-C
    mid-ask cancels cleanly. GUI: same, confirm the form renders, submit returns
    answers, and a subagent's ask is labelled.

---

## Verification

1. `bun run typecheck` — clean.
2. `bun run lint` — clean.
3. `bun run test` — all suites pass (use `bun run test`, not bare `bun test`).
4. Manual REPL + GUI.

## Decisions

- **Registration site:** `buildToolRegistry`, added to the `builtins` array so the
  `wanted()` gate controls it (A19) AND it appears in the dynamic-mode advertised set.
- **Concurrency model:** the channel holds a *set* of pending batches (GUI
  `Map<requestId, resolver>`; REPL FIFO queue); each surface *presents* them one at
  a time, FIFO.
- **`mutating: false` + `noTruncate: true`** — runs in the concurrent partition;
  result is the payload so it is never truncated.
- **Headless:** no channel → exact §3.5 string, a result (not a throw).
- **Scope:** in scope — REPL + GUI surfaces, subagent bubbling, headless fallback,
  abort/disconnect cancellation. Out of scope (spec §1.3): timeouts,
  editing/re-asking, rich option metadata.
