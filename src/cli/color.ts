/**
 * Minimal ANSI color helpers for the CLI.
 *
 * Colors are only emitted when the output is a TTY and the user hasn't opted
 * out via `NO_COLOR` (https://no-color.org). `FORCE_COLOR` overrides a
 * non-TTY (e.g. when piping through a pager that understands ANSI). When
 * disabled, every helper returns its input unchanged, so all output stays
 * plain and existing string assertions keep working.
 */

/** Whether ANSI color should be emitted at all. */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") {
    return true;
  }
  return process.stdout.isTTY === true;
}

/** Wrap `text` in an ANSI SGR pair, or return it unchanged when color is off. */
function paint(code: number, text: string): string {
  if (!colorEnabled()) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

/** The palette used across the REPL and startup messages. */
export const c = {
  bold: (t: string) => paint(1, t),
  dim: (t: string) => paint(2, t),
  red: (t: string) => paint(31, t),
  green: (t: string) => paint(32, t),
  yellow: (t: string) => paint(33, t),
  blue: (t: string) => paint(34, t),
  magenta: (t: string) => paint(35, t),
  cyan: (t: string) => paint(36, t),
  gray: (t: string) => paint(90, t),
};
