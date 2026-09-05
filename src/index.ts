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
} from "./hooks/index.js";

/** The tool API, for custom tools created with `reg.createTool()`. */
export type { JsonSchema, JsonSchemaProperty, Tool } from "./types.js";

/**
 * A skill — a named body of deferred context created with
 * `reg.createSkill()` (skills spec §2.1).
 */
export type { Skill } from "./types.js";

/**
 * The provider API (providers spec §3.1, §3.2): `Provider` for a custom
 * backend, `LlamaProvider` for an OpenAI-compatible llama.cpp server.
 */
export type { Provider, LlamaProviderOptions } from "./providers/index.js";
export { LlamaProvider } from "./providers/index.js";
