import type { Tool } from "../types.js";

/**
 * A tool definition as surfaced to the model through the catalog (spec §3.3.1).
 * This is the shape returned by `search_tools` and is what the model reads to
 * learn how to call a tool via `call_tool`.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Tool["parameters"];
}

/** A catalog match: a definition plus its relevance score. */
export interface CatalogMatch {
  tool: ToolDefinition;
  score: number;
}

/**
 * A tool definition without its handler, for JSON serialization.
 */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/**
 * Split a string into lowercase word tokens for matching.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Search a tool catalog by relevance to a free-text query (spec §3.3.1).
 *
 * Scoring is a cheap, dependency-free token-overlap heuristic: each query
 * token that appears in a tool's name is weighted higher than one that appears
 * only in its description. Tools with a score of 0 are omitted. Results are
 * sorted by score (descending), then by name (ascending) for determinism, and
 * truncated to `limit`.
 */
export function searchCatalog(
  tools: Tool[],
  query: string,
  limit = 5,
): CatalogMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const matches: CatalogMatch[] = [];
  for (const tool of tools) {
    const nameTokens = new Set(tokenize(tool.name));
    const descTokens = new Set(tokenize(tool.description));
    let score = 0;
    for (const qt of queryTokens) {
      if (nameTokens.has(qt)) score += 3;
      else if (descTokens.has(qt)) score += 1;
    }
    if (score > 0) {
      matches.push({ tool: toDefinition(tool), score });
    }
  }

  matches.sort(
    (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
  );
  return matches.slice(0, limit);
}
