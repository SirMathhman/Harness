// A small Markdown renderer (GUI spec §3.9). Uses `marked` to produce HTML.
import { marked } from "marked";
import { createMemo } from "solid-js";

marked.setOptions({ breaks: true, gfm: true });

/** Render a Markdown string to sanitized-enough HTML. */
export function Markdown(props: { text: string }) {
  const html = createMemo(() => marked.parse(props.text) as string);
  return <div class="markdown" innerHTML={html()} />;
}

/** A collapsible reasoning block (GUI spec §3.9). */
export function ReasoningBlock(props: { text: string; active?: boolean }) {
  return (
    <details class="reasoning" open={props.active ?? false}>
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
