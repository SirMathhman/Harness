# System Specification: Skills (Deferred Context)

**Version:** 0.4.0
**Date:** 2026-09-05
**Builds on:** v0.3.0 (Main-Agent KV Cache Persistence Across Subagent Calls)

---

## 0. Summary of Changes from v0.3.0

This is a **MINOR (feature)** release. It adds a new capability: **skills** —
named bodies of knowledge (deferred context) that the agent discovers and loads
on demand.

Key additions:

- `reg.createSkill(name, description, text)` — a new registry method. Skills are
  a **side-channel** (like providers), not resource-graph nodes.
- Two new built-in, read-only tools: `list_skills` and `read_skill`.
- A compact **skill index** (names + descriptions) injected into the system
  prompt so the model is always aware of available skills without loading their
  bodies.
- A `/skills` REPL command.

No existing invariants are changed. Skills do not participate in the resource
graph: they have no edges, no per-profile scoping, and no `ResourceId`. They are
global to the session and visible to every agent at every depth.

---

## 1. Purpose and Scope

### 1.1 Purpose

Vise's system prompt is fixed at session start. Adding large bodies of
knowledge — library references, domain procedures, project conventions — to the
system prompt bloats the context window and degrades KV-cache reuse, even when
the knowledge is irrelevant to the current task.

**Skills** solve this by making knowledge **deferred context**: a small,
always-visible index (name + one-line description) lives in the system prompt,
while the full body is loaded on demand only when the model decides a skill is
relevant. The model calls `read_skill(name)` to pull the body into the
conversation as a tool result.

The primary use case is storing **bodies of knowledge about libraries and
tools** (e.g., "how to use the `madge` npm package") that the agent may or may
not need in a given session.

### 1.2 Stakeholders

- **The main agent (depth 0):** sees the skill index in its system prompt and
  can call `list_skills` / `read_skill` to load skill bodies.
- **Subagents (depth ≥ 1):** see the same skill index and have the same tools.
  A key use case is **delegation**: the main agent spawns a subagent to read
  and apply a set of skills, keeping the main agent's context clean.
- **The config author:** defines skills in `.vise/index.ts` (global or
  project) via `reg.createSkill()`.

### 1.3 Success Criteria

- A config file calls `reg.createSkill("madge", "How to use the madge npm
  package", "<full reference text>")`. The agent's system prompt contains a
  compact index listing `madge` and its description. The full reference text is
  **not** in the system prompt.
- The model calls `read_skill("madge")` and receives the full reference text as
  a tool result. The text is **not truncated**, regardless of
  `maxToolOutputChars`.
- The model calls `list_skills()` and receives the names and descriptions of
  all available skills.
- A subagent spawned by the main agent sees the same skill index and can call
  `read_skill` to load skill bodies.
- `/skills` in the REPL lists all skills (name + description) to the user.
- If no skills are defined, the skill index section is **omitted** from the
  system prompt, and `list_skills` returns `"No skills available."`
- A duplicate skill name (within the same config file or across global and
  project files) is a **fatal config error**.

### 1.4 Out of Scope

- **Semantic search** over skills. The current mechanism is name + description
  matching by the model. Semantic search is a future enhancement.
- **Dynamic skill loading / hot-reload.** Skills are loaded once at session
  start from the config file. A reload mechanism is a future enhancement.
- **Per-profile skill scoping.** Skills are global. A profile cannot restrict
  which skills are visible. This would require wiring skills into the resource
  graph (a new node/edge type), which is a larger change deferred to a future
  version.
- **Skill scripts or resources.** A skill is a single text blob. It does not
  bundle scripts, reference files, or other resources. If a skill's body
  references a file, the agent uses the existing `read_file` tool.
- **Skill versioning or metadata** beyond `name`, `description`, and `text`.
- **Cross-file skill references.** Skills are identified by name only; there is
  no `getSkill` lookup or `ResourceId`.

---

## 2. Domain Model

### 2.1 Entities

| Entity            | Description                                                    | Key Attributes                          |
| ----------------- | -------------------------------------------------------------- | --------------------------------------- |
| **Skill**         | A named body of deferred context.                              | `name: string`, `description: string`, `text: string` |
| **Skill Store**   | The collection of all skills in the session.                   | `ReadonlyMap<string, Skill>` (keyed by name) |
| **Skill Index**   | The compact, always-visible representation injected into the system prompt. | Derived from the Skill Store: one line per skill (`- name: description`) |
| **list_skills**   | A built-in, read-only tool that returns the skill index.       | No parameters. Returns names + descriptions. |
| **read_skill**    | A built-in, read-only tool that returns one skill's full body. | `name: string` (required). Returns the full text, untruncated. |

### 2.2 Relationships

- A **Skill** is created by `reg.createSkill()` in a config file and stored in
  the **Skill Store** on the `ResourceGraph`. Skills are **not** resource-graph
  nodes: they do not appear in `ResourceGraph.resources`, cannot be the source
  or target of a `Connection`, and have no `ResourceId`.
- The **Skill Store** is a side-channel on the `ResourceGraph`, analogous to
  `providers`. It is populated during config loading and is read-only after
  `build()`.
- The **Skill Index** is derived from the Skill Store at materialization time
  (in `materializeProfile`) and appended to the system prompt. It is not stored
  separately.
- **list_skills** and **read_skill** are built-in tools. They are registered in
  `buildToolRegistry` and are always available (they are not subject to the
  Profile→Tool edge rule: a profile with no tool edges gets all built-in tools,
  including these two).
- Skills are **global**: every agent at every depth (main session and all
  subagents) sees the same Skill Store, the same Skill Index, and the same two
  tools.

### 2.3 State Transitions

```
[Session start]
  → Load global config (~/.vise/index.ts)
      → reg.createSkill(...) calls populate the Skill Store (origin: global)
  → Load project config (./.vise/index.ts)
      → reg.createSkill(...) calls populate the Skill Store (origin: project)
      → Name-conflict validation (fatal on duplicate)
  → Build ResourceGraph (Skill Store is frozen)
  → Resolve starting profile
  → materializeProfile:
      → Build Skill Index from Skill Store
      → Append Skill Index to system prompt (if non-empty)
      → Register list_skills and read_skill tools
  → [Running]

[Running]
  → Model calls list_skills()
      → Returns names + descriptions of all skills
  → Model calls read_skill("madge")
      → Returns the full text of the "madge" skill (untruncated)
      → The result stays in the conversation as a tool message (sticky)
  → /skills
      → Lists all skills to the user in the REPL
  → [Running]

[Profile switch]
  → materializeProfile re-runs for the new profile
  → Skill Index is re-appended (same content — skills are global)
  → list_skills / read_skill are re-registered (same behavior)
  → [Running under new profile]

[Subagent spawn]
  → materializeProfile runs for the subagent's profile
  → Subagent gets the same Skill Index and the same two tools
  → Subagent can call read_skill to load skill bodies
  → [Subagent running]
```

---

## 3. Functional Requirements

### 3.1 Registry API

The `Registry` interface gains one method:

```ts
interface Registry {
  // ...existing methods...

  /**
   * Create a skill (deferred context). Skills are a side-channel, not graph
   * nodes: they have no ResourceId and cannot be connected to profiles.
   *
   * @param name        Unique, non-empty name. Any valid string is accepted
   *                    (no character-set restriction).
   * @param description One-line summary shown in the skill index and returned
   *                    by list_skills. The model uses this to decide whether
   *                    to load the skill.
   * @param text        The full body of the skill. Loaded on demand via
   *                    read_skill. Not truncated regardless of
   *                    maxToolOutputChars.
   *
   * @throws if a skill with the same name has already been created (in this
   *   file or in the other config file). The error is fatal and identifies
   *   the duplicate.
   */
  createSkill(name: string, description: string, text: string): void;
}
```

**Return value:** `void`. Skills are identified by name, not by `ResourceId`.
There is no `getSkill` lookup method.

**Name validation:** Any non-empty string is a valid skill name. There is no
character-set restriction (unlike the Agent Skills convention of
lowercase-hyphen). An empty string is rejected with a descriptive error.

**Origin tracking:** Each skill records which config file created it
(`"global"` or `"project"`), consistent with how other resources track origin.
This is used in the name-conflict error message.

### 3.2 Skill Store

The `ResourceGraph` gains a side-channel field:

```ts
interface ResourceGraph {
  // ...existing fields...

  /**
   * Every skill, keyed by name. Populated by reg.createSkill() during config
   * loading. Read-only after build(). Skills are NOT graph nodes: they do not
   * appear in `resources` and cannot be the source or target of a
   * Connection.
   */
  skills: ReadonlyMap<string, Skill>;
}

/** A named body of deferred context (spec §2.1). */
export interface Skill {
  /** Unique, non-empty name. */
  name: string;
  /** One-line summary for the skill index. */
  description: string;
  /** The full body, loaded on demand via read_skill. */
  text: string;
  /** Which config file created this skill. */
  origin: "global" | "project";
}
```

**Storage:** The `ViseRegistry` accumulates skills in a private
`Map<string, Skill>` during config loading. `build()` freezes the map into the
`ResourceGraph.skills` field.

**Name-conflict rule:**

- **Within the same config file:** calling `createSkill("madge", ...)` twice
  in the same file is a **fatal error**:
  ```
  Duplicate skill name "madge". Each skill must have a unique name.
  ```
- **Across config files:** a skill with the same name in both
  `~/.vise/index.ts` and `./.vise/index.ts` is a **fatal error**:
  ```
  Config conflict: a skill named "madge" is defined in both the global config
  (~/.vise/index.ts) and the project config (./.vise/index.ts). Remove one or
  rename it.
  ```

This is consistent with the name-conflict rule for profiles, models, and tools
(config spec §3.3).

### 3.3 Skill Index (System Prompt)

At materialization time (`materializeProfile`), a compact **skill index** is
derived from the Skill Store and appended to the system prompt.

**Format:**

```
## Available Skills
- madge: How to use the madge npm package for dependency analysis
- npm-deps: Managing npm dependencies in this project
```

- One line per skill: `- {name}: {description}`.
- Skills are listed in creation order (global first, then project).
- The section header is `## Available Skills`.

**Injection point:** The skill index is appended to the resolved system prompt
after the profile's own system prompt (or the built-in default). The exact
placement is:

```
{profile system prompt}

## Available Skills
- madge: How to use the madge npm package for dependency analysis
- npm-deps: Managing npm dependencies in this project
```

**Empty store:** If the Skill Store is empty (no skills defined), the skill
index section is **omitted entirely** from the system prompt. No empty
`## Available Skills` header is emitted.

**Stability:** The skill index is stable for the duration of the session (skills
are loaded once at startup and do not change). This keeps the request prefix
stable for KV-cache reuse, consistent with the v0.3.0 KV persistence design.

**Profile switch:** On a profile switch, `materializeProfile` re-runs and the
skill index is re-appended to the new profile's system prompt. The content is
identical (skills are global), so the KV impact is the same as any other
profile switch.

**Append mode:** In `append` profile-switch mode, each switch adds a new system
message. The skill index is included in each new system message, so it appears
once per switch. This is redundant but harmless; the model sees the same index
repeatedly. This is a known limitation of `append` mode and is not addressed in
this version.

### 3.4 `list_skills` Tool

A new built-in, read-only tool:

```ts
{
  name: "list_skills",
  mutating: false,
  description:
    "List all available skills (name and description). Use read_skill to load " +
    "a skill's full content.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async handler() {
    // Returns the skill index (names + descriptions) as a plain-text string.
  }
}
```

**Behavior:**

- Returns the names and descriptions of all skills in the Skill Store, one per
  line, in the same format as the skill index (without the `## Available
  Skills` header):
  ```
  madge: How to use the madge npm package for dependency analysis
  npm-deps: Managing npm dependencies in this project
  ```
- If the Skill Store is empty, returns:
  ```
  No skills available.
  ```
- The tool is **read-only** (`mutating: false`), so it runs concurrently with
  other read-only tools.
- The tool is **always registered** (it is a built-in tool). It is present
  regardless of whether any skills are defined.

**Dynamic tools mode:** In `dynamicTools` mode, `list_skills` is on the
constant advertised surface (alongside `search_tools` and `call_tool`), so the
model can always discover and call it without a `search_tools` round-trip.

### 3.5 `read_skill` Tool

A new built-in, read-only tool:

```ts
{
  name: "read_skill",
  mutating: false,
  description:
    "Load the full content of a skill by name. Use list_skills to see " +
    "available skills.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the skill to load.",
      },
    },
    required: ["name"],
  },
  async handler(args) {
    // Returns the full text of the named skill, untruncated.
  }
}
```

**Behavior:**

- **Known skill:** Returns the full `text` of the named skill. The text is
  **not truncated**, regardless of the `maxToolOutputChars` setting. This is a
  deliberate exemption: a skill body is the knowledge payload, and truncating
  it would defeat the purpose.
- **Unknown skill:** Returns an error string:
  ```
  Unknown skill "X". Available skills: madge, npm-deps.
  ```
  If the Skill Store is empty:
  ```
  Unknown skill "X". No skills available.
  ```
- **Empty name:** If `name` is an empty string, returns:
  ```
  Skill name must be non-empty.
  ```
- The tool is **read-only** (`mutating: false`), so it runs concurrently with
  other read-only tools.
- The tool is **always registered** (it is a built-in tool). It is present
  regardless of whether any skills are defined.

**Truncation exemption:** The `Tool` interface gains an optional field:

```ts
export interface Tool {
  // ...existing fields...

  /**
   * When true, the tool's result is not truncated to maxToolOutputChars.
   * Used by read_skill, which returns the full skill body.
   */
  noTruncate?: boolean;
}
```

The `dispatch` function checks this flag: if `noTruncate` is true, the result
is returned as-is without calling `truncate()`.

**Sticky:** Once `read_skill` returns a skill body, it stays in the
conversation as a normal `tool` message for the rest of the session. It is
subject to compaction like any other message (if the conversation exceeds
`compactThreshold`, the skill body may be summarized or truncated by the
compaction logic). This is consistent with how all tool results are treated.

**Dynamic tools mode:** In `dynamicTools` mode, `read_skill` is on the constant
advertised surface (alongside `search_tools` and `call_tool`), so the model can
always call it without a `search_tools` round-trip.

### 3.6 `/skills` REPL Command

A new REPL command:

| Command   | Effect                                                    |
| --------- | --------------------------------------------------------- |
| `/skills` | List all skills (name + description) to the user.         |

**Output format:**

```
Skills:
  madge       How to use the madge npm package for dependency analysis
  npm-deps    Managing npm dependencies in this project
```

- Skills are listed in creation order (global first, then project).
- If no skills are defined:
  ```
  No skills defined.
  ```
- The command is **read-only**: it does not modify the session state.

### 3.7 Subagent Visibility

Skills are **global**: every agent at every depth (main session and all
subagents) has access to the same Skill Store, the same Skill Index, and the
same `list_skills` / `read_skill` tools.

**Mechanism:** `materializeProfile` is the single place where a profile becomes
a system prompt + tool registry, and it is used for both the main session and
every subagent. The skill index is appended to the system prompt and the two
tools are registered in `materializeProfile`, so subagent visibility falls out
naturally with no additional code.

**Delegation use case:** A primary purpose of subagents is to **offload skill
reading** from the main agent. The main agent can spawn a subagent with a task
like "Read the `madge` and `npm-deps` skills and summarize the key commands."
The subagent loads the skill bodies into its own context, does the work, and
returns a summary. The main agent's context never contains the full skill
bodies, keeping it clean for the primary task.

### 3.8 Business Rules

- **Skills are global:** there is no per-profile scoping. Every profile and
  every subagent sees every skill.
- **Skills are not graph nodes:** they have no `ResourceId`, no edges, and
  cannot be connected to profiles. They are a side-channel on the
  `ResourceGraph`, like providers.
- **Name uniqueness:** skill names must be unique across the combined graph
  (global + project). Duplicates are fatal.
- **No truncation:** `read_skill` returns the full skill body, exempt from
  `maxToolOutputChars`.
- **Sticky results:** a loaded skill body stays in the conversation as a tool
  message and is subject to compaction like any other message.
- **Empty store is valid:** a session with no skills is valid. The skill index
  is omitted from the system prompt, and the two tools return appropriate
  "no skills" messages.
- **No validation of skill text:** the `text` field is an opaque string. Vise
  does not parse, validate, or transform it.

---

## 4. Edge Cases and Error Handling

| Scenario                                              | Behavior                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `createSkill` called with an empty `name`             | Fatal config error: `"Skill name must be non-empty."`                     |
| `createSkill` called twice with the same name (same file) | Fatal config error: `"Duplicate skill name \"X\". Each skill must have a unique name."` |
| Same skill name in global and project config          | Fatal config error: `"Config conflict: a skill named \"X\" is defined in both the global config (~/.vise/index.ts) and the project config (./.vise/index.ts). Remove one or rename it."` |
| `read_skill` called with an unknown name              | Tool result: `"Unknown skill \"X\". Available skills: a, b, c."` (or `"No skills available."` if the store is empty). The turn is not aborted. |
| `read_skill` called with an empty name                | Tool result: `"Skill name must be non-empty."`                            |
| `list_skills` called when no skills are defined       | Tool result: `"No skills available."`                                     |
| Skill body exceeds `maxToolOutputChars`               | The full body is returned, untruncated. The `noTruncate` flag on the tool exempts it from truncation. |
| Skill body is very large (e.g., 100 KB)               | The full body is returned. The model's context window may be exceeded; this is the config author's responsibility. No size limit is enforced. |
| Skill body is an empty string                         | `read_skill` returns an empty string. This is valid; the config author chose to define a skill with no content. |
| Skill description is an empty string                  | The skill index line is `- name: ` (with a trailing space and no description). This is valid but discouraged. |
| Profile switch in `append` mode                       | The skill index is re-appended to each new system message. Redundant but harmless. |
| Subagent calls `read_skill`                           | Works identically to the main agent. The skill body is loaded into the subagent's context, not the main agent's. |
| Subagent's context is compacted                       | The skill body (as a tool message) is subject to compaction like any other message. |
| `dynamicTools` mode                                   | `list_skills` and `read_skill` are on the constant advertised surface. The skill index is in the system prompt. Behavior is identical to non-dynamic mode. |
| KV persistence active (v0.3.0)                        | The skill index is part of the system prompt, which is part of the KV cache. The index is stable, so it does not invalidate the cache. Skill bodies loaded via `read_skill` are tool messages and are part of the conversation, which is also cached. |

---

## 5. Non-Functional Requirements

- **Performance:** The skill index adds a small, fixed overhead to the system
  prompt (one line per skill). For a typical number of skills (5–50), this is
  negligible. The skill bodies are not in the system prompt, so they do not
  affect the base context size.
- **KV-cache stability:** The skill index is stable for the duration of the
  session (skills are loaded once at startup). It does not invalidate the KV
  cache. This is consistent with the v0.3.0 KV persistence design.
- **Context window:** A skill body loaded via `read_skill` consumes context
  space for the rest of the session (until compaction). The config author is
  responsible for keeping skill bodies a reasonable size. There is no enforced
  size limit.
- **Compatibility:** No new runtime dependencies. Skills use only Node
  built-ins (the skill store is an in-memory `Map`). No changes to the LLM
  client, SSE parser, or provider layer.
- **Backward compatibility:** A config file that does not call
  `reg.createSkill()` behaves exactly as before. The skill index is omitted
  from the system prompt, and the two new tools are present but return
  "no skills" messages. No existing behavior is changed.

---

## 6. Data Requirements

- **Skill storage:** In-memory `Map<string, Skill>` on the `ResourceGraph`.
  No persistent state file. Skills are defined in the config file and loaded
  once at session start.
- **Skill index format:** Plain text, one line per skill:
  `- {name}: {description}`. Preceded by a `## Available Skills` header.
- **`list_skills` output:** Plain text, one line per skill:
  `{name}: {description}`. No header.
- **`read_skill` output:** The raw `text` string of the skill. No wrapping,
  no formatting, no truncation.
- **`/skills` output:** Formatted for the REPL:
  ```
  Skills:
    {name}    {description}
  ```

---

## 7. External Dependencies

- **None.** Skills use only Node built-ins. No new runtime dependencies, no
  new external services, no changes to the LLM server requirements.

---

## 8. Constraints, Assumptions, and Changed Invariants

### 8.1 No changed invariants

This feature does not change any existing invariants. Specifically:

- **Error semantics:** unchanged. Tool errors (including `read_skill` with an
  unknown name) are returned as result strings. Only LLM/server connectivity
  errors abort the turn.
- **Tool execution ordering:** unchanged. `list_skills` and `read_skill` are
  read-only (`mutating: false`), so they run concurrently with other read-only
  tools.
- **Hooks:** unchanged. Skills do not interact with hooks.
- **Resource graph:** unchanged. Skills are not graph nodes. No new edge type.
  No new `ResourceKind`.
- **`finish` is terminal:** unchanged.
- **`src/index.ts` is side-effect-free:** unchanged.

### 8.2 New `Tool` interface field

The `Tool` interface gains an optional `noTruncate?: boolean` field. This is
additive and does not affect existing tools (which do not set the flag). The
`dispatch` function checks the flag and skips truncation when it is true.

### 8.3 Assumptions

- The config author keeps skill bodies a reasonable size. There is no enforced
  limit, but a very large skill body (e.g., several megabytes) could exceed
  the model's context window and cause the LLM call to fail. This is the
  config author's responsibility.
- The model is capable of reading the skill index and deciding which skills
  are relevant. This is a prompt-engineering concern, not a Vise concern. The
  skill index is a hint, not a directive.
- Skills are static for the duration of the session. Dynamic loading /
  hot-reload is a future enhancement.

---

## 9. Acceptance Criteria

Each criterion maps to a test in `test/*.test.ts`.

### 9.1 Registry

- **AC-1:** `reg.createSkill("madge", "desc", "text")` adds a skill to the
  Skill Store. The skill is accessible via `graph.skills.get("madge")`.
- **AC-2:** `reg.createSkill("", "desc", "text")` throws a fatal config error
  with the message `"Skill name must be non-empty."`
- **AC-3:** Calling `reg.createSkill("madge", ...)` twice in the same config
  file throws a fatal config error identifying the duplicate.
- **AC-4:** A skill with the same name in both the global and project config
  files throws a fatal config error identifying the conflict.

### 9.2 Skill Index

- **AC-5:** When skills are defined, the system prompt contains a
  `## Available Skills` section with one line per skill
  (`- {name}: {description}`).
- **AC-6:** When no skills are defined, the system prompt does **not** contain
  a `## Available Skills` section.
- **AC-7:** The skill index is in creation order (global first, then project).

### 9.3 `list_skills` Tool

- **AC-8:** `list_skills` is registered as a built-in tool and is present in
  the tool registry for every profile.
- **AC-9:** `list_skills` returns the names and descriptions of all skills,
  one per line.
- **AC-10:** `list_skills` returns `"No skills available."` when the Skill
  Store is empty.
- **AC-11:** `list_skills` is `mutating: false` (read-only).
- **AC-12:** In `dynamicTools` mode, `list_skills` is on the constant
  advertised surface.

### 9.4 `read_skill` Tool

- **AC-13:** `read_skill` is registered as a built-in tool and is present in
  the tool registry for every profile.
- **AC-14:** `read_skill("madge")` returns the full text of the "madge" skill.
- **AC-15:** `read_skill` does **not** truncate the skill body, even when the
  body exceeds `maxToolOutputChars`.
- **AC-16:** `read_skill("nonexistent")` returns an error string listing the
  available skills.
- **AC-17:** `read_skill("")` returns `"Skill name must be non-empty."`
- **AC-18:** `read_skill` is `mutating: false` (read-only).
- **AC-19:** In `dynamicTools` mode, `read_skill` is on the constant advertised
  surface.

### 9.5 Subagent Visibility

- **AC-20:** A subagent's system prompt contains the same skill index as the
  main agent's.
- **AC-21:** A subagent's tool registry includes `list_skills` and
  `read_skill`.
- **AC-22:** A subagent can call `read_skill` and receive the full skill body.

### 9.6 `/skills` REPL Command

- **AC-23:** `/skills` lists all skills (name + description) in the REPL.
- **AC-24:** `/skills` outputs `"No skills defined."` when no skills are
  defined.

### 9.7 Backward Compatibility

- **AC-25:** A config file that does not call `reg.createSkill()` produces a
  system prompt with no skill index section. The two new tools are present but
  return "no skills" messages. All existing behavior is unchanged.

---

## 10. Open Questions

None.
