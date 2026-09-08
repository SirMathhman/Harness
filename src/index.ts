/**
 * Side-effect-free public configuration API.
 * CLI startup lives in src/cli.ts; importing this module from .vise/index.ts
 * must never launch an interactive session or process stdin.
 */
export type {
  HookDef,
  ModelDef,
  ModelSelection,
  ProfileDef,
  ProfileSwitchMode,
  Registry,
  ResourceId,
  RuntimeSettings,
  SubagentPolicy,
  ToolDef,
  ViseConfig,
} from "./profiles/index.js";

/**
 * The hooks API, re-exported so a hook can be written against
 * `import type { Hook } from "vise"` (hooks spec §3.2).
 */
export type {
  Hook,
  HookContext,
  HookEvent,
  HookHandler,
  HookResult,
  SubagentOutcome,
} from "./hooks/index.js";

/**
 * The `runCommand` hook helper (v0.6.0 spec §2.1, §3.2): a standalone
 * foreground command runner for hook handlers. `runCommand` is a value export;
 * `CommandOutput` and `RunCommandOptions` are type exports.
 */
export { runCommand } from "./command.js";
export type { CommandOutput, RunCommandOptions } from "./command.js";

/** The tool API, for custom tools created with `reg.createTool()`. */
export type { JsonSchema, JsonSchemaProperty, Tool } from "./types.js";

/**
 * The user-input channel (v0.7.0 spec §2.1): the surface the `ask_questions`
 * tool asks the user through. A presentation layer (REPL, agent-server)
 * implements it and passes it to `createSession`.
 */
export type {
  AskResult,
  Question,
  QuestionAnswer,
  UserInputChannel,
} from "./agent/userInput.js";

/**
 * A skill — a named body of deferred context created with
 * `reg.createSkill()` (skills spec §2.1).
 */
export type { Skill } from "./types.js";

/**
 * The provider API (providers spec §3.1, §3.2): `Provider` for a custom
 * backend, `LlamaProvider` for an OpenAI-compatible llama.cpp server.
 */
export type {
  ModelAdmission,
  Provider,
  LlamaProviderOptions,
} from "./providers/index.js";
export { LlamaProvider } from "./providers/index.js";
