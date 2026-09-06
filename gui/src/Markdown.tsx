// A small Markdown renderer (GUI spec §3.9). Uses `marked` to produce HTML.
import { marked } from "marked";
import { createMemo, Match, Show, Switch, type JSX } from "solid-js";
import type { ConversationItem } from "./types";

marked.setOptions({ breaks: true, gfm: true });

/** Render a Markdown string to sanitized-enough HTML. */
export function Markdown(props: { text: string }) {
  const html = createMemo(() => marked.parse(props.text) as string);
  return <div class="markdown" innerHTML={html()} />;
}

/**
 * A collapsible reasoning block (GUI spec §3.9).
 *
 * `open` is controlled by the conversation view model rather than by the
 * element, so a block the user opened by hand keeps that state when the row
 * scrolls out of the virtual viewport and back. While closed, the body is not
 * mounted and its Markdown is never parsed.
 */
export function ReasoningBlock(props: {
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <details
      class="reasoning"
      open={props.open}
      onToggle={(e) => {
        // Native disclosure keeps keyboard support; the toggle is reported up
        // so the view model stays the single source of truth.
        if (e.currentTarget.open !== props.open) props.onToggle();
      }}
    >
      <summary>reasoning</summary>
      <Show when={props.open}>
        <Markdown text={props.text} />
      </Show>
    </details>
  );
}

/** Format tool-call args as a compact one-line string. */
export function formatArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 117) + "…" : s;
  } catch {
    return "";
  }
}

/** Narrow a conversation item to one variant, for use as a `Match` condition. */
function ofKind<K extends ConversationItem["kind"]>(
  item: ConversationItem,
  kind: K,
): Extract<ConversationItem, { kind: K }> | undefined {
  return item.kind === kind
    ? (item as Extract<ConversationItem, { kind: K }>)
    : undefined;
}

/**
 * Render the inner content of a conversation item.
 *
 * Every read of the item goes through `props`, so replacing or mutating the
 * item updates the mounted component instead of forcing a remount. (The old
 * version captured `props.item` in a local and switched once, which only
 * worked because every update remounted the row.)
 */
function ItemContent(props: {
  item: ConversationItem;
  reasoningOpen: boolean;
  onToggleReasoning: () => void;
}) {
  return (
    <Switch>
      <Match when={ofKind(props.item, "userMessage")}>
        {(it) => <div class="user-bubble">{it().text}</div>}
      </Match>
      <Match when={ofKind(props.item, "assistantMessage")}>
        {(it) => <Markdown text={it().text} />}
      </Match>
      <Match when={ofKind(props.item, "reasoningBlock")}>
        {(it) => (
          <ReasoningBlock
            text={it().text}
            open={props.reasoningOpen}
            onToggle={props.onToggleReasoning}
          />
        )}
      </Match>
      <Match when={ofKind(props.item, "toolCall")}>
        {(it) => (
          <span class="tool-call">
            → {it().name}({formatArgs(it().args)})
          </span>
        )}
      </Match>
      <Match when={ofKind(props.item, "toolResult")}>
        {(it) => (
          <span class={`tool-result ${it().ok ? "ok" : "err"}`}>
            {it().ok ? "✓" : "✗"} {it().name}: {it().summary}
          </span>
        )}
      </Match>
      <Match when={ofKind(props.item, "compactionNotice")}>
        <span class="compacting">compacting…</span>
      </Match>
      <Match when={ofKind(props.item, "systemNotice")}>
        {(it) => <span class="notice">{it().text}</span>}
      </Match>
    </Switch>
  );
}

/** A single conversation row (GUI spec §3.9). */
export function Row(props: {
  depth: number;
  item: ConversationItem;
  /** True when the row is a child of an expanded subagent run. */
  inGroup?: boolean;
  reasoningOpen: boolean;
  onToggleReasoning: () => void;
}) {
  return (
    <div
      class={`row row-${props.item.kind}${props.inGroup ? " row-in-group" : ""}`}
      style={{ "margin-left": `${props.depth * 1.25}rem` }}
    >
      <ItemContent
        item={props.item}
        reasoningOpen={props.reasoningOpen}
        onToggleReasoning={props.onToggleReasoning}
      />
    </div>
  );
}

/**
 * The disclosure control for one subagent run (GUI spec §3.9).
 *
 * A run's rows are flattened into the virtual viewport as sibling render items,
 * so the group cannot be a `<details>` — its children are not its DOM
 * descendants. A native `<button>` with `aria-expanded` gives the same keyboard
 * behaviour without claiming to control an element that may not be mounted;
 * the visual rail and indentation carry the association.
 */
export function SubagentHeader(props: {
  depth: number;
  done: boolean;
  count: number;
  open: boolean;
  onToggle: () => void;
  ref?: (el: HTMLButtonElement) => void;
}): JSX.Element {
  const label = (): string =>
    `subagent ${props.done ? "done" : "running"}, ${props.count} ${
      props.count === 1 ? "row" : "rows"
    }`;
  return (
    <div
      class="subagent-head"
      style={{ "margin-left": `${Math.max(props.depth - 1, 0) * 1.25}rem` }}
    >
      <button
        type="button"
        class="subagent-toggle"
        aria-expanded={props.open}
        ref={props.ref}
        onClick={() => props.onToggle()}
      >
        <span class="subagent-caret" aria-hidden="true">
          {props.open ? "▾" : "▸"}
        </span>
        {label()}
      </button>
    </div>
  );
}
