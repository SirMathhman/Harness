// The windowed conversation view.
//
// Only the render items inside (or just outside) the viewport are mounted; the
// rest of the history stays in memory, unrendered. Nothing is discarded, no
// last-N limit is imposed and no row is hidden with CSS — a row that is not
// mounted is simply not in the current window.
//
// Known limitation: the browser's own find-in-page and select-all can only see
// what is mounted, so they cover the visible window rather than the whole
// conversation. Full-history search and export are out of scope here.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  createVirtualizer,
  defaultRangeExtractor,
  type Range,
} from "@tanstack/solid-virtual";
import { Row, SubagentHeader } from "../Markdown";
import type { Store } from "../store";
import {
  createViewModel,
  estimateItemSize,
  type ConversationViewModel,
  type GroupBlock,
  type RenderItem,
} from "./viewModel";

/** How far past the viewport to keep items mounted, in items, each side. */
const OVERSCAN = 8;
/** The "close enough to the bottom to keep following" threshold, in pixels. */
const END_THRESHOLD = 40;

type HeaderItem = Extract<RenderItem, { kind: "header" }>;
type RowRenderItem = Extract<RenderItem, { kind: "row" }>;

export function ConversationViewport(props: {
  store: Store;
  /** The user-facing auto-scroll toggle. */
  follow: () => boolean;
  /** True while the agent is producing output. */
  turnActive: () => boolean;
}) {
  const store = props.store;
  const vm = createViewModel(store);
  const items = vm.items;

  // Published on mount, not from the `ref` callback. Solid builds its DOM
  // inside a `<template>`, and elements in a template's content document have
  // `ownerDocument.defaultView === null`. The virtualizer reads that to find
  // its target window, and skips installing its resize and scroll observers
  // when it is null — so handing it the element before the tree is adopted
  // into the live document leaves it permanently unmeasured (a zero-height
  // scroll rect, an empty range and no rendered items).
  let scrollerEl!: HTMLElement;
  const [scroller, setScroller] = createSignal<HTMLElement | null>(null);
  onMount(() => setScroller(scrollerEl));
  // The render item that currently holds focus, kept mounted through the range
  // extractor so tabbing does not drop focus to the document body.
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  // Bumped whenever the measured total height changes, so "follow the latest
  // output" reacts to a row growing, not only to a row being added.
  const [growth, setGrowth] = createSignal(0);
  // Header buttons of the currently mounted subagent runs, so focus can be
  // moved onto a header before its children leave the sequence.
  const headerButtons = new Map<string, HTMLButtonElement>();
  onCleanup(() => headerButtons.clear());

  const focusedIndex = createMemo(() => {
    const id = focusedId();
    return id === null ? -1 : vm.indexOf(id);
  });

  const rangeExtractor = createMemo(() => (range: Range) => {
    const base = defaultRangeExtractor(range);
    const focused = focusedIndex();
    if (focused < 0 || focused >= range.count || base.includes(focused)) {
      return base;
    }
    // Exactly one extra item, so the mounted budget stays bounded.
    return focused < base[0] ? [focused, ...base] : [...base, focused];
  });

  let lastTotal = -1;
  const virtualizer = createVirtualizer({
    get count() {
      return items().length;
    },
    getScrollElement: () => scroller(),
    estimateSize: (index) => estimateItemSize(items()[index]),
    getItemKey: (index) => items()[index]?.id ?? index,
    get rangeExtractor() {
      return rangeExtractor();
    },
    overscan: OVERSCAN,
    // `anchorTo: "end"` is what keeps a reader in place: when the item count or
    // the edge keys change, the virtualizer re-anchors on the first visible
    // item's key and its pixel offset. It is also the switch that keeps the
    // view pinned while an item at the bottom grows.
    anchorTo: "end",
    scrollEndThreshold: END_THRESHOLD,
    get followOnAppend() {
      // Instant, never smooth: item sizes are still streaming in, and a smooth
      // animation would chase a moving target.
      return props.follow() ? ("instant" as const) : false;
    },
    onChange: (instance) => {
      const total = instance.getTotalSize();
      if (total !== lastTotal) {
        lastTotal = total;
        setGrowth((n) => n + 1);
      }
    },
  });

  /** Scroll to the newest output, without animation. */
  const jumpToLatest = (): void => {
    if (items().length === 0) return;
    virtualizer.scrollToEnd({ behavior: "instant" });
  };

  /**
   * The length of the newest row's text — the one text subscription the view
   * keeps. A row growing while the reader is far away is not mounted, so it is
   * never measured and `growth` never fires; without this, following during a
   * turn would stall as soon as the reader scrolled up. Only the *last* row is
   * read, so no historical row is subscribed to.
   */
  const tailLength = createMemo(() => {
    const list = items();
    const last = list[list.length - 1];
    if (last === undefined || last.kind !== "row") return 0;
    const item = last.row.item;
    return "text" in item ? item.text.length : 0;
  });

  // Auto-scroll (GUI spec §3.9). While a turn is streaming and follow is on,
  // pin the view to the newest output even if the reader scrolled up. When
  // idle, `followOnAppend` already covers the "only while at the bottom" case,
  // and with follow off nothing here ever moves the reader.
  createEffect(() => {
    // Three ways the newest output can move: a new row, the newest row growing,
    // and a measurement correcting an already-mounted row.
    void items().length;
    void tailLength();
    void growth();
    if (!props.follow() || !props.turnActive()) return;
    if (virtualizer.isAtEnd(1)) return;
    jumpToLatest();
  });

  // Turning follow on jumps to the latest output immediately.
  createEffect(
    on(
      props.follow,
      (following, wasFollowing) => {
        if (following && wasFollowing === false) jumpToLatest();
      },
      { defer: true },
    ),
  );

  // A new authoritative snapshot (or a clear) is a fresh generation: the
  // previous generation's measurements and element references describe rows
  // that no longer exist. Drop them, then re-establish the reading position —
  // the latest output when following, otherwise the top of the rebuilt
  // conversation. No cross-snapshot identity is claimed: the protocol carries
  // no persistent row ids, so a scrolled-up reader is clamped to the closest
  // logical position rather than to a pretended surviving anchor.
  createEffect(
    on(
      store.generation,
      (_generation, previous) => {
        if (previous === undefined) return;
        virtualizer.measureElement(null);
        virtualizer.measure();
        setFocusedId(null);
        lastTotal = -1;
        queueMicrotask(() => {
          if (props.follow()) jumpToLatest();
          else virtualizer.scrollToOffset(0, { behavior: "instant" });
        });
      },
      { defer: true },
    ),
  );

  // Re-measure when the viewport width changes: rows wrap differently, so every
  // cached height is suspect. The virtualizer's own ResizeObserver watches the
  // items; this one watches the container.
  createEffect(() => {
    const el = scroller();
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Defer out of the observer callback so re-measuring cannot re-enter it
      // synchronously and loop.
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        virtualizer.measure();
      });
    });
    observer.observe(el);
    onCleanup(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    });
  });

  /**
   * Toggle a run, moving focus to its header first when the focused item is one
   * of the children that is about to leave the sequence.
   */
  const toggleGroup = (block: GroupBlock, headerId: string): void => {
    if (vm.isGroupOpen(block)) {
      const focused = focusedId();
      if (focused !== null && focused !== headerId) {
        const index = vm.indexOf(focused);
        const item = index >= 0 ? items()[index] : undefined;
        if (item && item.kind === "row" && item.groupId === block.id) {
          headerButtons.get(headerId)?.focus();
        }
      }
    }
    vm.toggleGroup(block);
  };

  return (
    <section
      class="conversation"
      ref={scrollerEl}
      onFocusIn={(e) => {
        const host = (e.target as HTMLElement).closest("[data-item-id]");
        const id = host?.getAttribute("data-item-id");
        if (id) setFocusedId(id);
      }}
    >
      <Show
        when={items().length > 0}
        fallback={
          <div class="empty">
            <p>Connected to Vise. Send a task to begin.</p>
          </div>
        }
      >
        {/* One spacer of the full measured height carries the scrollbar; the
            mounted items are positioned inside it. */}
        <div
          class="conversation-spacer"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(virtualRow) => {
              const item = (): RenderItem | undefined =>
                items()[virtualRow.index];
              const header = (): HeaderItem | undefined => {
                const current = item();
                return current?.kind === "header" ? current : undefined;
              };
              const row = (): RowRenderItem | undefined => {
                const current = item();
                return current?.kind === "row" ? current : undefined;
              };
              return (
                <div
                  class="vitem"
                  data-index={virtualRow.index}
                  data-item-id={item()?.id}
                  ref={(el) =>
                    queueMicrotask(() => virtualizer.measureElement(el))
                  }
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <Switch>
                    <Match when={header()}>
                      {(h) => (
                        <GroupHeader
                          header={h()}
                          vm={vm}
                          buttons={headerButtons}
                          onToggle={toggleGroup}
                        />
                      )}
                    </Match>
                    <Match when={row()}>
                      {(r) => <RowItem item={r()} vm={vm} />}
                    </Match>
                  </Switch>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}

/** The disclosure header of one subagent run. */
function GroupHeader(props: {
  header: HeaderItem;
  vm: ConversationViewModel;
  buttons: Map<string, HTMLButtonElement>;
  onToggle: (block: GroupBlock, headerId: string) => void;
}) {
  return (
    <SubagentHeader
      depth={props.header.depth}
      done={props.header.block.done}
      count={props.header.block.items.length}
      open={props.vm.isGroupOpen(props.header.block)}
      onToggle={() => props.onToggle(props.header.block, props.header.id)}
      ref={(el) => {
        const id = props.header.id;
        props.buttons.set(id, el);
        onCleanup(() => props.buttons.delete(id));
      }}
    />
  );
}

/** One conversation row inside the virtual viewport. */
function RowItem(props: { item: RowRenderItem; vm: ConversationViewModel }) {
  return (
    <Row
      depth={props.item.depth}
      item={props.item.row.item}
      inGroup={props.item.groupId !== undefined}
      reasoningOpen={props.vm.isReasoningOpen(props.item.row)}
      onToggleReasoning={() => props.vm.toggleReasoning(props.item.row)}
    />
  );
}
