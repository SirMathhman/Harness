// A small Markdown renderer (GUI spec §3.9). Uses `marked` to produce HTML.
import { marked } from "marked";
import {
  createMemo,
  createEffect,
  createSignal,
  For,
  type JSX,
} from "solid-js";

marked.setOptions({ breaks: true, gfm: true });

/** Render a Markdown string to sanitized-enough HTML. */
export function Markdown(props: { text: string }) {
  const html = createMemo(() => marked.parse(props.text) as string);
  return <div class="markdown" innerHTML={html()} />;
}

/** A collapsible reasoning block (GUI spec §3.9). */
export function ReasoningBlock(props: { text: string; active?: boolean }) {
  const [el, setEl] = createSignal<HTMLDetailsElement>();
  // Open when reasoning starts, collapse when it ends. Reacting only to the
  // `active` transition (not binding `open` continuously) lets the user
  // toggle the block freely while it is streaming.
  createEffect(() => {
    const node = el();
    if (node) node.open = props.active ?? false;
  });
  return (
    <details class="reasoning" ref={setEl}>
      <summary>reasoning</summary>
      <Markdown text={props.text} />
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

/** Render the inner content of a conversation item. */
function ItemContent(props: {
  item: import("./types").ConversationItem;
  active?: boolean;
}) {
  const item = props.item;
  switch (item.kind) {
    case "userMessage":
      return <div class="user-bubble">{item.text}</div>;
    case "assistantMessage":
      return <Markdown text={item.text} />;
    case "reasoningBlock":
      return <ReasoningBlock text={item.text} active={props.active} />;
    case "toolCall":
      return (
        <span class="tool-call">
          → {item.name}({formatArgs(item.args)})
        </span>
      );
    case "toolResult":
      return (
        <span class={`tool-result ${item.ok ? "ok" : "err"}`}>
          {item.ok ? "✓" : "✗"} {item.name}: {item.summary}
        </span>
      );
    case "compactionNotice":
      return <span class="compacting">compacting…</span>;
    case "systemNotice":
      return <span class="notice">{item.text}</span>;
  }
}

/** A single conversation row (GUI spec §3.9). */
export function Row(props: {
  depth: number;
  item: import("./types").ConversationItem;
  active?: boolean;
}) {
  return (
    <div
      class={`row row-${props.item.kind}`}
      style={{ "margin-left": `${props.depth * 1.25}rem` }}
    >
      <ItemContent item={props.item} active={props.active} />
    </div>
  );
}

/**
 * A collapsible subagent block: wraps the rows of one subagent scope in a
 * `<details>` that is open while the subagent runs and collapses when it
 * completes (GUI spec §3.9). The subagent rows retain their own indentation.
 */
export function SubagentBlock(props: {
  depth: number;
  done: boolean;
  items: { index: number; row: import("./store").Row }[];
  isActive: (idx: number) => boolean;
}) {
  const [el, setEl] = createSignal<HTMLDetailsElement>();
  // Open while the subagent is running; collapse it when it completes. Reacting
  // only to the `done` transition (rather than also on each child row) lets the
  // user toggle the block freely while it streams, and a `subagentEnd` closes it.
  createEffect(() => {
    const node = el();
    if (node) node.open = !props.done;
  });
  return (
    <details class="subagent" ref={setEl}>
      <summary>subagent {props.done ? "done" : "..."}</summary>
      <For each={props.items}>
        {(b) => (
          <Row
            depth={props.depth}
            item={b.row.item}
            active={props.isActive(b.index)}
          />
        )}
      </For>
    </details>
  );
}
