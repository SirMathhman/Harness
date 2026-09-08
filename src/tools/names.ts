/**
 * The names of the built-in tools, in the order they are registered.
 *
 * This lives in its own module so the profiles layer can enumerate the
 * built-in tool resources (`builtin:<name>`) without importing the tool
 * implementations, which depend on the resolved `Config`.
 */
export const BUILTIN_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "search",
  "run_command",
  "check_command",
  "fetch_webpage",
  "finish",
  "spawn_subagent",
  "list_skills",
  "read_skill",
  "ask_questions",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** The tool the agent loop uses to end a turn cleanly (spec §3.2). */
export const FINISH_TOOL_NAME = "finish";
