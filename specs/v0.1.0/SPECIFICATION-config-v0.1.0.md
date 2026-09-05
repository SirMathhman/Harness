# System Specification: Two-Tier Configuration & Profile Persistence

**Version:** 0.1.0
**Date:** 2026-09-04
**Builds on:** `SPECIFICATION-profiles-v0.1.0.md` (the single-file `.vise/index.ts` resource-graph config)

**Changes from the profiles spec (v0.1.0):**

- Added a **global** config file (`~/.vise/index.ts`) alongside the existing
  **project** config file (`./.vise/index.ts`). Both feed the same `Registry`,
  producing one combined resource graph.
- Added a **name-lookup API** (`reg.getProfile`, `reg.getModel`, `reg.getTool`)
  so the project file can reference resources created by the global file without
  path imports or tsconfig aliases.
- Added **profile persistence**: the active profile (and last-used model) is
  saved to a state file on exit and restored on the next start.
- Merged `setProfileSwitchMode` into `setRuntime` as a `profileSwitchMode` key.
- The session always starts under the **implicit built-in profile** unless a
  valid saved profile exists in the state file.

---

## 1. Purpose and Scope

### 1.1 Purpose

Extend the single-file Vise configuration to a **two-tier** system:

- A **global** file (`~/.vise/index.ts`) holds the user's shared defaults:
  models, hooks, tools, and profiles that apply across all projects.
- A **project** file (`./.vise/index.ts`) holds project-specific overrides and
  additions: profiles, models, hooks, and tools scoped to one repository.

Both files are loaded into the **same `Registry`**, producing one combined
resource graph. The project file can reference global resources by name via a
lookup API, enabling cross-file connections without path imports.

Additionally, the **active profile** (and last-used model) is **persisted** to a
small state file on exit and restored on the next start, so a user does not have
to re-run `/profile <name>` every session.

### 1.2 Stakeholders

- **Primary user:** a developer who works across multiple projects and wants
  their usual models, hooks, and profiles available everywhere, with per-project
  customizations layered on top.
- **The agent:** runs under the combined graph; the active profile determines
  its system prompt, tools, hooks, and model.

### 1.3 Success Criteria

- A user creates `~/.vise/index.ts` with shared models and hooks, and
  `./.vise/index.ts` with project-specific profiles. The agent loads both and
  runs under the combined graph.
- The project file can connect a project profile to a global model via
  `reg.getModel('local')`.
- If both files define a resource with the same name (profile, model, or tool),
  Vise exits with a fatal error identifying the conflict.
- If `~/.vise/index.ts` does not exist, Vise runs with just the project file
  (or built-in defaults if neither file exists) — identical to current behavior.
- If `./.vise/index.ts` does not exist but `~/.vise/index.ts` does, Vise loads
  the global file and runs under the implicit built-in profile.
- On exit, the active profile and last-used model are saved to a state file.
  On the next start, the saved profile is restored (if it still exists in the
  config); otherwise the session starts under the implicit built-in profile.
- `/profile` lists profiles from both files, each marked with its origin
  (`global` or `project`).

### 1.4 Out of Scope

- Hot-reloading of either config file (both are loaded once at session start).
- Per-profile state persistence (only the active profile + last model are saved).
- Cross-file hook references (hooks are nameless; see §3.6).
- A global state file that is shared across projects when a project file exists
  (the state file location is determined by the presence of a project file).
- Environment-variable overrides (Vise has no env-var config; the two files are
  the sole configuration surface).

---

## 2. Domain Model

### 2.1 Entities

| Entity             | Description                                           | Key Attributes                                                       |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------- |
| **GlobalConfig**   | The user-level config file.                           | Path: `~/.vise/index.ts`. Same shape as a project config file.       |
| **ProjectConfig**  | The project-level config file (existing).             | Path: `./.vise/index.ts`. Same shape as a global config file.        |
| **ResourceGraph**  | The combined graph built from both files.             | Same shape as the existing `ResourceGraph` (profiles spec §2.1).     |
| **Registry**       | The factory + store, now fed by two config functions. | Extended with name-lookup methods (§3.4).                            |
| **StateFile**      | The persisted session state.                          | `profile: string`, `savedAt: string` (ISO 8601), `lastModel: string` |
| **ResourceOrigin** | Which file created a resource.                        | `"global"` \| `"project"` \| `"builtin"`                             |

### 2.2 Relationships

- A **GlobalConfig** and a **ProjectConfig** each produce resources and
  connections into the same **Registry**.
- The **Registry** builds one **ResourceGraph** from the combined resources.
- Each resource in the graph carries a **ResourceOrigin** tag indicating which
  file created it (used by `/profile` for the origin marker).
- A **StateFile** stores the last-active profile name and last-used model name.
  It is read at startup and written at exit.

### 2.3 State Transitions

```
[Session start]
  → Locate global file (~/.vise/index.ts)
  → If present: load + run config function against Registry
  → Locate project file (./.vise/index.ts)
  → If present: load + run config function against same Registry
  → Validate combined graph (name conflicts, invalid edges, etc.)
  → Determine state file location
  → Read state file (if present)
  → Resolve starting profile:
      saved profile exists in graph → that profile
      else → implicit built-in profile
  → [Running]

[Running]
  → /profile <name> → switch (re-resolve)
  → [Running under new profile]

[Session end]
  → Write state file: { profile, savedAt, lastModel }
  → [Done]
```

---

## 3. Functional Requirements

### 3.1 Configuration Files

| Tier    | Path               | Required | Purpose                                           |
| ------- | ------------------ | -------- | ------------------------------------------------- |
| Global  | `~/.vise/index.ts` | No       | Shared defaults: models, hooks, tools, profiles.  |
| Project | `./.vise/index.ts` | No       | Project-specific: profiles, models, hooks, tools. |

- **Shape:** Identical to the existing config file shape (profiles spec §3.1):
  a TypeScript ES module with a default export of type `(reg: Registry) => void`.
- **Optional:** Either or both files may be absent.
  - Both absent → built-in defaults (all built-in tools, default model, no hooks,
    built-in system prompt). Identical to current behavior.
  - Global absent, project present → project file only. Identical to current
    behavior.
  - Global present, project absent → global file only. The session runs under
    the implicit built-in profile; global resources (models, hooks, tools,
    profiles) are available in the graph.
  - Both present → combined graph (§3.2).
- **Entry points:** Same as the existing config: `index.ts`, `index.js`,
  `index.mjs` tried in order. The global file uses the same entry-point
  convention under `~/.vise/`.
- **Loading:** Dynamic `import()` at session start, same as the existing config
  loader. The global file is loaded **before** the project file (§3.2).

### 3.2 Load Order and Combined Graph

1. **Global first:** If `~/.vise/index.ts` (or `.js`/`.mjs`) exists, it is
   imported and its default export is called with a fresh `Registry`. All
   resources it creates are tagged with origin `"global"`.
2. **Project second:** If `./.vise/index.ts` (or `.js`/`.mjs`) exists, it is
   imported and its default export is called with the **same** `Registry`
   instance. All resources it creates are tagged with origin `"project"`.
   Because the global file ran first, the project file can look up global
   resources by name (§3.4).
3. **Validation:** After both files have run, the combined graph is validated
   (existing validation rules from profiles spec §3.10, plus the new name-conflict
   rule in §3.3).
4. **Resolution:** The starting profile is resolved (§3.7).

**Rationale for global-first:** the project file is the "override + specifics"
tier. It needs to be able to reference global resources (e.g., connect a project
profile to a global model). Loading global first makes those resources available
for lookup when the project file runs.

### 3.3 Name-Conflict Rule

When both files create a resource of the **same kind** with the **same name**,
Vise exits with a **fatal error** identifying the conflict:

- **Profiles:** `name` field. (e.g., both files define a profile named
  `"default"`.)
- **Models:** `name` field. (e.g., both files define a model named `"local"`.)
- **Tools:** `name` field. (e.g., both files define a custom tool named
  `"deploy"`.)

**Hooks are exempt.** Hooks have no `name` field and are always additive: all
hooks from both files coexist in the graph. There is no hook-name conflict.

**Built-in resources are exempt.** Built-in tools (e.g., `read_file`) are
pre-registered with IDs of the form `builtin:<tool_name>`. A user-defined tool
with the same name as a built-in tool is a fatal error (this rule already exists
in the current implementation and is unchanged).

**Error message format:**

```
Config conflict: a <kind> named "<name>" is defined in both the global config
(~/.vise/index.ts) and the project config (./.vise/index.ts). Remove one or
rename it.
```

### 3.4 Name-Lookup API

The `Registry` gains three lookup methods so the project file can reference
resources created by the global file (or by the project file itself, or built-in
resources) without path imports:

```ts
interface Registry {
  // ...existing methods...

  /** Look up a profile by name. Returns undefined if not found. */
  getProfile(name: string): ResourceId | undefined;

  /** Look up a model by name. Returns undefined if not found. */
  getModel(name: string): ResourceId | undefined;

  /** Look up a tool by name (built-in or custom). Returns undefined if not found. */
  getTool(name: string): ResourceId | undefined;
}
```

**Scope:** The lookup searches **all** resources in the combined graph — global,
project, and built-in. A call to `reg.getModel('local')` finds a model named
`"local"` whether it was created by the global file, the project file, or is a
built-in.

**Return value:** `ResourceId | undefined`. The caller is responsible for
checking for `undefined` before using the result. If the caller passes
`undefined` to `createConnection`, the registry rejects it with a descriptive
error (a `ResourceId` is opaque and `undefined` is not a valid `ResourceId`).

**No `getHook` method.** Hooks are nameless (§3.3) and cannot be looked up by
name. A project profile cannot connect to a global hook (see §3.6 for the
consequence).

**Example:**

```ts
// ~/.vise/index.ts (global)
export default (reg: Registry) => {
  reg.createModel({
    name: "local",
    baseUrl: "http://localhost:8080",
    apiKey: "",
  });
};

// ./.vise/index.ts (project)
export default (reg: Registry) => {
  const local = reg.getModel("local");
  if (!local) throw new Error("Global model 'local' not found");

  const impl = reg.createProfile({ name: "implement", systemPrompt: "..." });
  reg.createConnection(impl, local); // connect project profile to global model
};
```

### 3.5 `setRuntime` Merge

Both files may call `reg.setRuntime(...)`. The settings are **merged per key**:

- For each key in `RuntimeSettings`, the value is:
  1. The project file's value, if the project file set it.
  2. Else the global file's value, if the global file set it.
  3. Else the built-in default.

**`profileSwitchMode`** is now a key in `RuntimeSettings` (previously a separate
`reg.setProfileSwitchMode()` method). The `setProfileSwitchMode` method is
**removed** from the `Registry` API.

```ts
// In RuntimeSettings:
profileSwitchMode: "replace" | "append"; // default: "replace"
```

**Example:**

```ts
// ~/.vise/index.ts
reg.setRuntime({ maxIterations: 40, profileSwitchMode: "append" });

// ./.vise/index.ts
reg.setRuntime({ maxIterations: 60 }); // overrides global's 40; profileSwitchMode stays "append"
```

### 3.6 Hook Consequence

Because hooks are nameless and `ResourceId`s are opaque, a project profile
**cannot** connect to a hook created by the global file. The project file has no
way to obtain the `ResourceId` of a global hook.

**Consequence:** global hooks are only active for profiles that the global file
itself connects them to (or for the implicit built-in profile, if the global file
connects a hook to it). A project profile that needs a hook must define that hook
in the project file.

This is a deliberate trade-off for simplicity. If cross-file hook references
become a common need, hooks can be given an optional `name` field in a future
version.

### 3.7 Starting Profile Resolution

The session always starts under the **implicit built-in profile** unless a valid
saved profile exists in the state file (§3.8).

**Resolution order:**

1. Read the state file (§3.8).
2. If the state file exists, is well-formed, and its `profile` field names a
   profile that exists in the combined graph → start under that profile.
3. Otherwise → start under the implicit built-in profile.
   - If the state file existed but its `profile` was not found in the graph,
     print a warning to stderr:
     `Warning: saved profile "<name>" not found in config. Starting with the default profile.`
   - If the state file was corrupt or unreadable, print a warning to stderr:
     `Warning: could not read state file (<path>). Starting with the default profile.`

**The implicit built-in profile** is named `"Agent"`. It has the built-in
system prompt, all built-in tools, no hooks, and the default model
(auto-discovered). The name `"Agent"` is **reserved** and cannot be used by a
user-defined profile in either file (a config error if attempted).

### 3.8 Profile Persistence (State File)

#### 3.8.1 State File Location

The state file location depends on whether a project config file exists:

| Condition                         | State file path      |
| --------------------------------- | -------------------- |
| `./.vise/index.ts` exists         | `./.vise/state.json` |
| `./.vise/index.ts` does not exist | `~/.vise/state.json` |

**Rationale:** when a project file exists, the state is project-specific (each
project remembers its own last-used profile). When no project file exists, the
state is global (one last-used profile across all "no-project" sessions).

#### 3.8.2 State File Format

```json
{
  "profile": "implement",
  "savedAt": "2026-09-04T12:00:00.000Z",
  "lastModel": "qwen2.5-coder-32b"
}
```

| Field       | Type   | Description                                                                                                                                          |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`   | string | The name of the active profile at exit. `"Agent"` for the implicit built-in profile.                                                                 |
| `savedAt`   | string | ISO 8601 timestamp of when the state was saved.                                                                                                      |
| `lastModel` | string | The model name that was in use at exit. Pins the auto-discovered model so a restart restores the same model even if the server's model list changes. |

#### 3.8.3 Write (on exit)

- On a clean exit (`/exit`, `exit`, `quit`, or Ctrl-D), Vise writes the state
  file with the current active profile name, the current time, and the current
  model name.
- If the state file's directory does not exist, it is created (e.g., `~/.vise/`
  may not exist if the user has no global config file).
- If the write fails (e.g., directory not writable), a warning is printed to
  stderr and the exit proceeds:
  `Warning: could not save state to <path>: <error>.`
- On an unclean exit (Ctrl-C during a turn, crash), the state file is **not**
  written. The last clean exit's state is retained.

#### 3.8.4 Read (on start)

- At session start, after the combined graph is built, Vise reads the state file
  from the location determined by §3.8.1.
- If the file does not exist → no saved profile; start under the implicit
  built-in profile. No warning.
- If the file exists but is malformed JSON or has an unexpected shape → warn +
  fall back to the implicit built-in profile (§3.7, step 3).
- If the file is valid but `profile` names a profile not in the graph → warn +
  fall back (§3.7, step 3).
- If the file is valid and `profile` names a profile in the graph → start under
  that profile.
- `lastModel` is used to pin the model: if the resolved profile's model is
  auto-discovered (`name: ""`), the saved `lastModel` is used as the model name
  instead of re-discovering. If the profile has an explicit model, `lastModel`
  is ignored (the profile's model wins).

#### 3.8.5 State File and Git

The state file is **per-user session state**, not project configuration. It
should be gitignored. Vise does not automatically add it to `.gitignore`, but
the README should recommend:

```gitignore
# .gitignore (project)
.vise/state.json
```

### 3.9 `/profile` Command (Updated)

`/profile` (no argument) lists all profiles from **both** files, each marked
with its origin:

```
Profiles:
  * Agent          (builtin)
    local-dev      (global)
    implement      (project)
    review         (project)
```

- The active profile is marked with `*`.
- The origin is shown in parentheses: `(builtin)`, `(global)`, or `(project)`.
- Profiles are listed in creation order: built-in first, then global, then
  project.

`/profile <name>` (with argument) works as before: switch to the named profile.
The name can be a profile from either file.

#### 3.9.1 Addressing the Implicit Built-in Profile

The implicit built-in profile is named `"Agent"`. The name is **reserved** and
cannot be used by a user-defined profile in either file. To switch back to it,
the user types `/profile Agent`.

| Command           | Effect                                       |
| ----------------- | -------------------------------------------- |
| `/profile`        | List all profiles (both files), mark active. |
| `/profile <name>` | Switch to the named profile.                 |

### 3.10 Configuration Loading (Updated Sequence)

1. Locate the global config entry (`~/.vise/index.ts` / `.js` / `.mjs`).
2. If present: dynamic `import()`, call the default export with a fresh
   `Registry`. Tag all created resources with origin `"global"`.
   - If the import fails, the default export is missing or not a function, or
     the config function throws → **fatal error**, exit. (Same as the existing
     project-file failure behavior.)
3. Locate the project config entry (`./.vise/index.ts` / `.js` / `.mjs`).
4. If present: dynamic `import()`, call the default export with the **same**
   `Registry`. Tag all created resources with origin `"project"`.
   - Same failure behavior as step 2.
5. Validate the combined graph:
   - Existing validation rules (profiles spec §3.10): invalid edge types,
     missing `finish` in enumerated tool sets, etc.
   - **New:** name-conflict rule (§3.3).
6. Determine the state file location (§3.8.1).
7. Read the state file (§3.8.4).
8. Resolve the starting profile (§3.7).
9. Build the active tool set, hook set, model config, and subagent policy.

### 3.11 Global Load Failure

If `~/.vise/index.ts` fails to load (syntax error, throws, missing or
non-function default export), Vise **exits with a fatal error**, identical in
behavior to the existing project-file failure:

```
Failed to load ~/.vise/index.ts: <error message>
```

There is no "degrade to project-only" mode. A broken global config is a hard
error, consistent with the project-file behavior.

---

## 4. Edge Cases and Error Handling

| #   | Scenario                                                                                   | Required Behavior                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Both files define a profile/model/tool with the same name                                  | Fatal: exit with a conflict message identifying the kind, name, and both file paths (§3.3).                                                                                         |
| C2  | Global file has a syntax error                                                             | Fatal: exit with the import error message (§3.11).                                                                                                                                  |
| C3  | Global file's default export is not a function                                             | Fatal: exit with a descriptive message (§3.11).                                                                                                                                     |
| C4  | Global file's config function throws                                                       | Fatal: exit with the thrown error message (§3.11).                                                                                                                                  |
| C5  | Project file references a global resource by name that doesn't exist                       | `reg.getModel('x')` returns `undefined`. If the project file passes `undefined` to `createConnection`, the registry rejects it with a descriptive error.                            |
| C6  | Project file calls `reg.getModel('x')` and gets `undefined`, then uses it without checking | Runtime error: `createConnection` rejects the invalid `ResourceId`. The error message should name the lookup that returned `undefined`.                                             |
| C7  | State file does not exist                                                                  | No saved profile. Start under the implicit built-in profile. No warning.                                                                                                            |
| C8  | State file is malformed JSON                                                               | Warn to stderr. Start under the implicit built-in profile.                                                                                                                          |
| C9  | State file has an unexpected shape (missing fields, wrong types)                           | Warn to stderr. Start under the implicit built-in profile.                                                                                                                          |
| C10 | State file's `profile` names a profile not in the graph                                    | Warn to stderr (naming the missing profile). Start under the implicit built-in profile.                                                                                             |
| C11 | State file's `lastModel` names a model not on the server                                   | The model name is used as-is (the LLM client will fail with a server error if the model doesn't exist). No special handling.                                                        |
| C12 | State file directory is not writable                                                       | Warn to stderr. Exit proceeds without saving.                                                                                                                                       |
| C13 | Ctrl-C during a turn (unclean exit)                                                        | State file is not written. Last clean exit's state is retained.                                                                                                                     |
| C14 | Both files call `setRuntime` with overlapping keys                                         | Per-key merge: project wins (§3.5). No error.                                                                                                                                       |
| C15 | Both files call `setRuntime` with `profileSwitchMode`                                      | Per-key merge: project wins (§3.5). No error.                                                                                                                                       |
| C16 | Global file defines a hook; project file defines a profile                                 | The hook is in the graph but not connected to the project profile (no cross-file hook refs, §3.6). The hook is only active for profiles the global file connects it to.             |
| C17 | Neither file exists                                                                        | Built-in defaults. Identical to current behavior.                                                                                                                                   |
| C18 | Global file exists, project file does not                                                  | Global resources are in the graph. Session starts under the implicit built-in profile (or a saved profile from `~/.vise/state.json`).                                               |
| C19 | Project file exists, global file does not                                                  | Project resources are in the graph. Session starts under the implicit built-in profile (or a saved profile from `./.vise/state.json`). Identical to current behavior + persistence. |
| C20 | User types `/profile Agent`                                                                | Switch to the implicit built-in profile.                                                                                                                                            |
| C21 | User types `/profile <name>` where `<name>` is a global profile                            | Switch succeeds. The profile is re-resolved from the combined graph.                                                                                                                |
| C22 | State file's `profile` is `"Agent"` (the implicit built-in)                                | Start under the implicit built-in profile. No warning.                                                                                                                              |

---

## 5. Non-Functional Requirements

- **Performance:** Loading two files instead of one adds one dynamic `import()`
  and one config-function call. This is negligible (both are local files). The
  name-lookup methods are O(1) hash-map lookups.
- **Backward compatibility:** A project with only `./.vise/index.ts` and no
  `~/.vise/index.ts` behaves identically to the current single-file behavior,
  except for the new profile persistence (state file). The `setProfileSwitchMode`
  method is removed; configs that use it
  must migrate to `setRuntime({ profileSwitchMode: ... })`.
- **Transparency:** `/profile` shows the origin of each profile, making it clear
  which file a profile came from.
- **No global state leakage:** The state file is the only persistent artifact.
  It is small (a few hundred bytes) and contains no secrets.

---

## 6. Data Requirements

- **Input:** Two TypeScript ES modules (global + project), same shape as the
  existing config file.
- **Output:** None (config affects the agent in-place).
- **Storage:** The state file (`state.json`) is the only persistent storage.
  It is a small JSON file with three string fields.

---

## 7. External Dependencies

- None new. The two-tier config uses the same dynamic `import()` mechanism as
  the existing config. The state file uses `node:fs` (already a dependency).

---

## 8. Constraints and Assumptions

- **Global-first load order is mandatory.** The project file depends on global
  resources being available for lookup. Loading project first would break
  cross-file references.
- **Hooks are nameless.** This is a deliberate constraint for simplicity. It
  means project profiles cannot connect to global hooks (§3.6). If this becomes
  a problem, hooks can be given an optional `name` field in a future version.
- **The state file is not a config file.** It is session state, not
  configuration. It does not define resources or connections. It only records
  the last-active profile and model.
- **The state file is per-user.** It is not shared across users on the same
  machine. (On a shared machine, each user has their own `~/.vise/` and their
  own `./.vise/state.json` is in the project directory, which may be shared —
  this is a known limitation; the state file should be gitignored.)
- **No env-var overrides.** Vise has no environment-variable configuration. The
  two files are the sole configuration surface. (This is unchanged from the
  current design.)
- **`~` resolution.** The global file path `~/.vise/index.ts` uses the user's
  home directory, resolved via `os.homedir()` (Node built-in). On Windows, this
  is `%USERPROFILE%`. The state file uses the same resolution.

---

## 9. Acceptance Criteria

1. **Two-file load:** With both `~/.vise/index.ts` and `./.vise/index.ts`
   present, Vise loads both into one Registry and builds a combined graph.
   Resources from both files are available.
2. **Cross-file reference:** The project file can connect a project profile to
   a global model via `reg.getModel('local')`.
3. **Name conflict:** If both files define a model named `"local"`, Vise exits
   with a fatal error identifying the conflict.
4. **Global-only:** With only `~/.vise/index.ts` present, Vise loads the global
   file and runs under the implicit built-in profile. Global resources are
   available.
5. **Project-only:** With only `./.vise/index.ts` present, Vise behaves
   identically to the current single-file behavior (plus profile persistence).
6. **No files:** With neither file present, Vise runs with built-in defaults.
   Identical to current behavior.
7. **setRuntime merge:** If both files call `setRuntime`, the settings are
   merged per key with project winning.
8. **profileSwitchMode in setRuntime:** `reg.setRuntime({ profileSwitchMode:
"append" })` sets the switch mode. The old `reg.setProfileSwitchMode()`
   method is removed.
9. **Profile persistence (write):** On a clean exit, the active profile name,
   timestamp, and last model are saved to the state file.
10. **Profile persistence (read):** On the next start, the saved profile is
    restored if it exists in the config.
11. **Missing saved profile:** If the saved profile no longer exists, Vise
    warns and starts under the implicit built-in profile.
12. **Corrupt state file:** If the state file is malformed, Vise warns and
    starts under the implicit built-in profile.
13. **State file location:** With a project file, the state file is at
    `./.vise/state.json`. Without a project file, it is at `~/.vise/state.json`.
14. **`/profile` origin marker:** `/profile` lists profiles from both files,
    each marked with `(global)`, `(project)`, or `(builtin)`.
15. **`/profile Agent`:** Switches to the implicit built-in profile.
16. **Global load failure:** If `~/.vise/index.ts` fails to load, Vise exits
    with a fatal error.
17. **Unclean exit:** Ctrl-C during a turn does not write the state file.

---

## 10. Open Questions

(None — all questions resolved during the specification process.)
