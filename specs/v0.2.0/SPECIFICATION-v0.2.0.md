# System Specification: Context Compaction (Prefix-Preserving)

**Version:** 0.2.0
**Date:** 2026-09-05
**Builds on:** `SPECIFICATION-v0.1.0.md` (§3.5 Context Compaction)

> This document specifies a **refinement of §3.5 (Context Compaction)** from
> `SPECIFICATION-v0.1.0.md`. All other sections of the v0.1.0 specification are
> unchanged and remain in force. Where this document and v0.1.0 §3.5 conflict,
> this document wins.

## 0. What Changed and Why

### 0.1 The problem with v0.1.0 compaction

v0.1.0 compaction produces a recap by calling the LLM with a **fresh
transcript**: it serializes the "older" messages into a single
`user: "Summarize… <transcript>"` message and sends that as a brand-new
conversation. That request shares **no prefix** with the cached main
conversation, so the server must **re-prefill the entire older history** just to
produce a short summary. On a backend that reuses KV cache by longest-common
prefix (e.g. `llama.cpp` `llama-server` with `cache_prompt` / `--cache-reuse`),
this is the dominant cost of compaction.

### 0.2 The optimization

The recap is now produced by **appending a short summary instruction to the
existing, already-cached conversation** and reusing the same request shape as
the main call (same tools, same prefix). The recap request's longest-common
prefix with the cached slot is therefore the **entire prior conversation**, so
only the small instruction is prefilled. The one-time cost is the bounded
re-prefill of the recent tail after the middle is replaced.

### 0.3 The constraint

Compaction must **not change the history "too much"**: the message array is
replaced, but the change is bounded to (a) the middle "older" messages being
collapsed into a single recap message, and (b) the recent tail being preserved
verbatim. The system prompt and the recent tail are never altered.

## 1. Purpose and Scope

- **Purpose:** Reduce the prefill cost of context compaction by making the
  recap (summary) call reuse the server's KV cache, while keeping the
  post-compaction conversation correct and within the context window.
- **Stakeholders:** the agent loop (`runTurn`), the LLM client, and the
  inference backend (llama.cpp `llama-server` and generic OpenAI-compatible
  endpoints).
- **Success criteria:**
  1. The recap call reuses the cached prefix of the main conversation (only the
     appended instruction is newly prefilled).
  2. After compaction, the conversation is `[system…, recap, …recent]` and fits
     the context window.
  3. The recent tail and the system prompt are byte-for-byte unchanged.
  4. Failure modes degrade safely (truncate) or abort (connectivity), never
     silently corrupting history.

## 2. Domain Model

### 2.1 Entities (relevant fields)

- **`Message`** — `{ role, content, tool_calls?, tool_call_id?, name? }`
  (OpenAI chat format; unchanged from v0.1.0 §2).
- **`Session`** — holds `messages: Message[]`, `config: Config`,
  `lastPromptTokens: number | null` (unchanged).
- **`Config`** — relevant fields (unchanged):
  - `maxContext: number`
  - `compactThreshold: number` (default `0.8`)
  - `compactKeepMessages: number` (default `6`)

### 2.2 Relationships

- A `Session` owns an ordered `messages` array. Compaction **replaces** that
  array wholesale; it does not mutate individual messages in place.
- The `ToolRegistry` provides the advertised tool surface used by both the main
  call and the recap call (see §3.3).

### 2.3 State Transitions

Compaction is a single atomic transition on `session.messages`:

```
[system…, older…, recent…]  ──(recap succeeds)──▶  [system…, recap, recent…]
[system…, older…, recent…]  ──(recap fails/empty)──▶  [system…, recent…]   (truncation)
[system…, older…, recent…]  ──(connectivity error)──▶  ABORT TURN
```

Where:

- `system…` = leading `system` messages (never altered).
- `older…` = the middle messages to be summarized (dropped on success/truncation).
- `recent…` = the most recent `compactKeepMessages` messages, boundary-adjusted
  so no `assistant.tool_calls` message is separated from its `tool` results
  (never altered).
- `recap` = a single **`system`** message holding the summary (see §3.4).

## 3. Functional Requirements

### 3.1 Trigger (unchanged from v0.1.0 §3.5)

- After each LLM call, the harness reads `usage.prompt_tokens`.
- **MUST** compact **before the next LLM call** when
  `prompt_tokens > Config.compactThreshold * Config.maxContext`
  (default `0.8 * maxContext`).
- **MUST NOT** compact when `prompt_tokens` is `null`/`undefined`.
- The trigger is **proactive** (fires before the call that would overflow),
  leaving headroom so the recap call itself does not overflow the window.

### 3.2 Partition (unchanged from v0.1.0 §3.5)

- **MUST** split `session.messages` into `{ system, older, recent }`:
  - `system` = leading `system` messages.
  - `recent` = the most recent `Config.compactKeepMessages` messages, with the
    boundary walked backward so that (a) no `tool` result message is orphaned
    from its originating `assistant.tool_calls` message, and (b) an
    `assistant.tool_calls` message is not separated from its `tool` results.
  - `older` = everything between `system` and `recent`.
- If `older` is empty, compaction **MUST** be a no-op.

### 3.3 Recap call (CHANGED — the core of this spec)

The recap is produced by a single LLM call whose request **reuses the cached
prefix** of the main conversation.

- **Request messages:** the existing conversation **plus one appended
  instruction message**:
  ```
  [...session.messages, { role: "user", content: <instruction> }]
  ```
  The instruction message is **transient**: it is used only for the recap call
  and **MUST NOT** be appended to `session.messages`.
- **Instruction content (count-based delimiting):** a summarization prompt that
  instructs the model to summarize **only the "older" part** of the
  conversation, explicitly excluding the most recent `compactKeepMessages`
  messages (which are retained verbatim). The instruction **MUST** interpolate
  `Config.compactKeepMessages` so the model knows how many trailing messages to
  exclude. Example:
  > "Summarize the work done so far in this coding session, covering only the
  > earlier part of the conversation — everything before the most recent
  > **{N}** messages, which are retained separately and must be excluded from
  > the summary. Include files changed, commands run, and any open issues, in a
  > few concise bullet points."
- **Tools:** the recap call **MUST** send the **same advertised tool surface as
  the main call** (`registry.advertised()`), so the rendered request prefix
  (including tool definitions) matches the cached main request and the prefix
  is reused. The model is instructed to summarize only; **any `tool_calls` in
  the recap response MUST be ignored** (only `content` is used).
- **Streaming:** the recap call **MUST** stream its output to the user
  (forward `onToken` / `onReasoning`), in addition to the existing
  "compacting context…" line.
- **Abort:** the recap call **MUST** honor the turn's `AbortSignal`.
- **Response usage:** only `response.content` is used as the recap.
  `response.toolCalls` and `response.usage` are ignored.

### 3.4 Replacement (CHANGED — recap role)

On a successful, non-empty recap, `session.messages` **MUST** be replaced with:

```
[ ...system, { role: "system", content: "Summary of prior work:\n" + recap }, ...recent ]
```

- The recap is a **`system`** message (changed from a `user` message in
  v0.1.0), placed in the middle of the conversation between the system prompt
  and the recent tail.
- The recent tail and the leading system messages are carried over **verbatim**
  (same objects, same order).

### 3.5 Fallbacks (CHANGED — empty-recap handling added)

- **Connectivity error** (`LLMError`: `ServerUnreachableError`,
  `LLMTimeoutError`, `LLMHttpError`): **MUST** propagate and **abort the turn**
  (unchanged from v0.1.0).
- **Any other recap-call error:** **MUST** fall back to **truncation** — drop
  the `older` messages, keeping `[...system, ...recent]` with tool-call/result
  pairs intact (unchanged from v0.1.0 E7).
- **Empty or whitespace-only recap content:** **MUST** be treated as a recap
  failure and fall back to **truncation** (new in this spec). This covers the
  case where the model emits only tool calls or an empty string.

## 4. Edge Cases and Error Handling

| #    | Case                                                | Required behavior                                                                            |
| ---- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| E-C1 | `older` is empty                                    | No-op; do not call the LLM.                                                                  |
| E-C2 | Recap call throws `LLMError` (network/timeout/HTTP) | Abort the turn (propagate).                                                                  |
| E-C3 | Recap call throws a non-`LLMError`                  | Truncate (`[system…, recent…]`).                                                             |
| E-C4 | Recap content is empty/whitespace-only              | Truncate (`[system…, recent…]`).                                                             |
| E-C5 | Recap response contains `tool_calls`                | Ignore them; use `content` only.                                                             |
| E-C6 | `prompt_tokens` is `null`/`undefined`               | Do not compact.                                                                              |
| E-C7 | Turn aborted during the recap call                  | Propagate the abort.                                                                         |
| E-C8 | Recap call would overflow the window                | Not a concern: the `0.8 * maxContext` trigger leaves headroom. No special handling required. |

## 5. Non-Functional Requirements

- **KV-cache reuse:** the recap call's request **MUST** share the longest-common
  prefix of the main conversation with the cached slot, so that only the
  appended instruction is newly prefilled. This is achieved by (a) appending to
  the existing conversation rather than sending a fresh transcript, and (b)
  sending the same advertised tools as the main call.
- **Bounded reprocess:** after replacement, the only newly-prefilled content on
  the next main call is the recent tail (≤ `compactKeepMessages` messages) plus
  the recap message. The system prompt prefix remains cached.
- **Correctness over speed:** on any ambiguity (empty recap, unexpected error),
  the harness **MUST** prefer a safe, window-fitting state (truncation) over an
  unbounded one, and **MUST** abort on connectivity errors rather than proceed
  with a possibly-incomplete conversation.
- **Transparency:** compaction remains visible to the user via the existing
  "compacting context…" line; the recap output is additionally streamed.

## 6. Data Requirements

- **Input:** the current `session.messages` array and `session.config`.
- **Recap request payload:** `{ model, messages: [...session.messages,
{role:"user", content:<instruction>}], tools: <advertised>, stream: true,
stream_options: { include_usage: true }, … }` (same shape as the main call).
- **Output (post-compaction):** `session.messages = [system…, recap-system-msg,
…recent]`.
- **No persistence side effects:** compaction does not write to disk; it only
  replaces the in-memory `session.messages`.

## 7. External Dependencies

- **Inference backend KV-cache semantics:**
  - `llama.cpp` `llama-server`: reuses KV cache by longest-common-prefix per
    slot when `cache_prompt` / `--cache-reuse` is enabled. The design relies on
    this to make the recap call cheap.
  - Generic OpenAI-compatible endpoints: prefix caching is opaque or absent.
    The design **degrades gracefully** — appending to the conversation is still
    correct (it produces a valid recap); it simply may not save prefill on
    backends without prefix caching.
- **`ToolRegistry.advertised()`:** must return the same surface for the recap
  call as for the main call (see §3.3).

## 8. Constraints and Assumptions

- **Assumption:** target backends render a **mid-conversation `system` message**
  correctly (accepted for llama.cpp `--jinja` and the OpenAI-compatible
  backends in use). If a backend cannot, the recap role is the single point to
  revisit.
- **Assumption:** the `0.8 * maxContext` trigger leaves enough headroom that the
  recap call (full conversation + short instruction) does not overflow the
  window (E-C8).
- **Constraint:** the recent tail and the leading system messages are never
  altered by compaction.
- **Constraint:** the recap instruction message is transient and never persisted
  to `session.messages`.

## 9. Acceptance Criteria

1. **Trigger:** `shouldCompact` returns true iff
   `prompt_tokens > compactThreshold * maxContext`; false when `prompt_tokens`
   is null/undefined. (Unchanged; existing tests still pass.)
2. **Partition:** `partitionForCompaction` returns `{ system, older, recent }`
   with the tool-call/result boundary invariant preserved. (Unchanged.)
3. **Recap request shape:** the recap call is issued with
   `messages = [...session.messages, {role:"user", content:<instruction>}]` and
   `tools = registry.advertised()`; the instruction interpolates
   `compactKeepMessages`; the instruction message is **not** appended to
   `session.messages`.
4. **Recap streaming:** the recap call forwards `onToken`/`onReasoning`.
5. **Replacement:** on a non-empty recap, `session.messages` becomes
   `[system…, {role:"system", content:"Summary of prior work:\n"+recap},
…recent]`; the recent tail and system messages are the same objects.
6. **Empty recap:** an empty/whitespace-only recap triggers truncation
   (`[system…, …recent]`).
7. **Error routing:** an `LLMError` from the recap call propagates (turn
   aborts); any other error triggers truncation.
8. **Tool calls ignored:** `tool_calls` in the recap response do not affect the
   result.
9. **KV-cache property (integration, llama-server with `cache_prompt`):** the
   recap call's prefill processes only the appended instruction (verified via
   server logs / `n_past`), not the full older history.

## 10. Open Questions

(None.)
