/**
 * The single display seam for live agent output.
 *
 * Both the main agent's callbacks and the subagent renderer build their lines
 * here, so the two can never drift apart. Every formatter is pure and takes an
 * `indent` (empty for the main agent, scaled by depth for subagents), and
 * `writeLine` is the one place a line actually reaches stdout.
 */
import { c } from "./color.js";

/** Condense tool-call arguments into a short one-line summary. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 60 ? s.slice(0, 57) + "…" : s}`);
  }
  return parts.join(", ");
}

/** A tool-call line: `→ name(args)`, indented. */
export function toolCallLine(
  name: string,
  args: Record<string, unknown>,
  indent = "",
): string {
  return `${indent}${c.cyan("→")} ${c.bold(name)}(${c.dim(
    summarizeArgs(args),
  )})`;
}

/** A tool-result line: `✓`/`✗ name: summary`, indented. */
export function toolResultLine(
  name: string,
  ok: boolean,
  summary: string,
  indent = "",
): string {
  const mark = ok ? c.green("✓") : c.red("✗");
  return `${indent}${mark} ${name}: ${c.dim(summary)}`;
}

/** A compaction notice, indented. */
export function compactingLine(indent = ""): string {
  return `${indent}${c.yellow("[compacting context…]")}`;
}

/** A one-time reasoning header: `thinking…`, indented. */
export function reasoningHeaderLine(indent = ""): string {
  return `${indent}${c.gray("thinking…")}`;
}

/** A subagent end-of-run line: `✓`/`✗ label`, indented. */
export function subagentEndLine(
  ok: boolean,
  label: string,
  indent = "",
): string {
  const mark = ok ? c.green("✓") : c.red("✗");
  return `${indent}${mark} ${label}`;
}

/** Write a single line (plus trailing newline) to stdout. */
export function writeLine(text: string): void {
  process.stdout.write(text + "\n");
}
