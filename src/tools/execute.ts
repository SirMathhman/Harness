import type { ToolCall, ToolResult } from "../types.js";
import { dispatch, ToolRegistry } from "./registry.js";

/**
 * Execute a batch of tool calls with the ordering rules from spec §3.3:
 * - Mutating tools (write_file, edit_file, run_command) run sequentially, in
 *   the order the model gave them, to avoid file/command races.
 * - Read-only tools (read_file, list_dir, search, check_command) run concurrently.
 * - Results are returned in the original tool-call order.
 */
export async function executeToolCalls(
  registry: ToolRegistry,
  calls: ToolCall[],
  maxToolOutputChars: number,
): Promise<ToolResult[]> {
  const results: (ToolResult | undefined)[] = new Array(calls.length).fill(
    undefined,
  );

  // Partition into mutating (serial) and read-only (parallel), preserving order.
  const mutating: { call: ToolCall; index: number }[] = [];
  const readOnly: { call: ToolCall; index: number }[] = [];
  calls.forEach((call, index) => {
    const tool = registry.get(call.name);
    if (tool?.mutating) mutating.push({ call, index });
    else readOnly.push({ call, index });
  });

  // Run read-only tools concurrently.
  const readPromises = readOnly.map(async ({ call, index }) => {
    results[index] = await dispatch(registry, call, maxToolOutputChars);
  });

  // Run mutating tools sequentially.
  for (const { call, index } of mutating) {
    results[index] = await dispatch(registry, call, maxToolOutputChars);
  }

  await Promise.all(readPromises);

  // All slots are filled by construction; coerce for the type system.
  return results as ToolResult[];
}
