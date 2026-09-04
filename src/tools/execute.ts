import type { ToolCall, ToolResult } from "../types.js";
import { truncate } from "../utils.js";
import { dispatch, ToolRegistry } from "./registry.js";

/**
 * Observers wrapped around each individual tool call, used by the hooks system
 * to fire `tool:before` / `tool:after` (hooks spec §3.1). Optional: when it is
 * omitted, execution takes exactly the path it did before hooks existed.
 */
export interface ToolLifecycle {
  /**
   * Runs immediately before `call` executes. A non-null return **blocks** the
   * call: the tool is not executed and the returned string becomes its result.
   */
  before(call: ToolCall): string | null;
  /** Runs immediately after `call` produced `result` (success or failure). */
  after(call: ToolCall, result: string): void;
}

/**
 * Execute a batch of tool calls with the ordering rules from spec §3.3:
 * - Mutating tools (write_file, edit_file, run_command) run sequentially, in
 *   the order the model gave them, to avoid file/command races.
 * - Read-only tools (read_file, list_dir, search, check_command) run concurrently.
 * - Results are returned in the original tool-call order.
 *
 * A blocked call (see `ToolLifecycle`) still occupies its slot in both the
 * ordering and the results, so the model always gets one result per call.
 */
export async function executeToolCalls(
  registry: ToolRegistry,
  calls: ToolCall[],
  maxToolOutputChars: number,
  lifecycle?: ToolLifecycle,
): Promise<ToolResult[]> {
  const results: (ToolResult | undefined)[] = new Array(calls.length).fill(
    undefined,
  );

  const runOne = async (call: ToolCall, index: number): Promise<void> => {
    const block = lifecycle?.before(call) ?? null;
    if (block !== null) {
      // hooks §3.5: the tool does not run; the block reason is its result.
      results[index] = {
        tool_call_id: call.id,
        content: truncate(block, maxToolOutputChars),
      };
      return;
    }
    const result = await dispatch(registry, call, maxToolOutputChars);
    lifecycle?.after(call, result.content);
    results[index] = result;
  };

  // Partition into mutating (serial) and read-only (parallel), preserving order.
  const mutating: { call: ToolCall; index: number }[] = [];
  const readOnly: { call: ToolCall; index: number }[] = [];
  calls.forEach((call, index) => {
    const tool = registry.get(call.name);
    if (tool?.mutating) mutating.push({ call, index });
    else readOnly.push({ call, index });
  });

  // Run read-only tools concurrently.
  const readPromises = readOnly.map(({ call, index }) => runOne(call, index));

  // Run mutating tools sequentially.
  for (const { call, index } of mutating) {
    await runOne(call, index);
  }

  await Promise.all(readPromises);

  // All slots are filled by construction; coerce for the type system.
  return results as ToolResult[];
}
