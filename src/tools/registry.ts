import type { JsonSchema, Tool, ToolCall, ToolResult } from "../types.js";
import { truncate } from "../utils.js";

/**
 * A registry of tools keyed by name.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  /**
   * When set, only these tool names are advertised to the LLM (dynamic mode,
   * spec §3.3.1). `dispatch` still resolves against the full catalog.
   */
  private advertisedNames: Set<string> | null = null;

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** Restrict the advertised set to the given names (dynamic mode). */
  setAdvertised(names: string[]): this {
    this.advertisedNames = new Set(names);
    return this;
  }

  /** The tools to advertise to the LLM (all, or the restricted set). */
  advertised(): Tool[] {
    if (this.advertisedNames === null) return this.all();
    return this.all().filter((t) => this.advertisedNames!.has(t.name));
  }

  /** The OpenAI `tools` array to send to the LLM. */
  toOpenAITools(): unknown[] {
    return this.advertised().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

/**
 * Validate arguments against a tool's JSON schema.
 * Returns a list of human-readable problems (empty when valid).
 */
export function validateArgs(
  schema: JsonSchema,
  args: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const required = schema.required ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      problems.push(`${key} is required`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) {
      problems.push(`unknown parameter "${key}"`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const actual =
      typeof value === "number"
        ? Number.isInteger(value)
          ? "integer"
          : "number"
        : typeof value;
    if (prop.type === "integer" && actual !== "number") {
      problems.push(`parameter "${key}" must be an integer`);
    } else if (prop.type === "number" && actual !== "number") {
      problems.push(`parameter "${key}" must be a number`);
    } else if (
      prop.type !== "integer" &&
      prop.type !== "number" &&
      actual !== prop.type
    ) {
      problems.push(`parameter "${key}" must be of type ${prop.type}`);
    }
    if (prop.enum && !prop.enum.includes(value as string | number)) {
      problems.push(
        `parameter "${key}" must be one of: ${prop.enum.join(", ")}`,
      );
    }
  }
  return problems;
}

/**
 * Dispatch a single tool call (spec §1.4.1).
 * Never throws: unknown tools, bad args, and handler exceptions are all
 * converted into descriptive error result strings (E1/E2).
 */
export async function dispatch(
  registry: ToolRegistry,
  call: ToolCall,
  maxToolOutputChars: number,
): Promise<ToolResult> {
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      tool_call_id: call.id,
      content: `Unknown tool "${call.name}". Available tools: ${registry
        .all()
        .map((t) => t.name)
        .join(", ")}.`,
    };
  }

  const problems = validateArgs(tool.parameters, call.arguments);
  if (problems.length > 0) {
    return {
      tool_call_id: call.id,
      content: `Invalid arguments for ${call.name}: ${problems.join("; ")}.`,
    };
  }

  try {
    const raw = await tool.handler(call.arguments);
    return {
      tool_call_id: call.id,
      content: truncate(raw, maxToolOutputChars),
    };
  } catch (err) {
    // E1: wrap handler exceptions into an error result string.
    return {
      tool_call_id: call.id,
      content: `Tool ${call.name} failed: ${(err as Error).message}`,
    };
  }
}
