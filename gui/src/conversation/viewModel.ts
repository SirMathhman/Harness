// The conversation view model: flattens the store's block structure into a
// linear list of *render items* with stable ids, and owns the disclosure state
// that must outlive the components it controls.
//
// Why a flat list: the viewport virtualizes render items. Nesting a whole
// subagent group inside one render item would put an unbounded subtree behind a
// single measured row, which is exactly the cost this work removes. So a group
// contributes one header item plus — only while it is expanded — one item per
// child row.
//
// Why disclosure state lives here: virtualized rows unmount when they scroll
// out of view. State stored inside a row component would be lost, so a group
// the user opened by hand would silently snap shut on scroll. Keyed by
// row/run id, it survives unmount and remount.

import { createMemo, createSignal } from "solid-js";
import type { Block, Row, Store } from "../store";

/** The subagent-run variant of a block. */
export type GroupBlock = Extract<Block, { kind: "subagent" }>;

/** One unit of rendering and measurement in the virtual viewport. */
export type RenderItem =
  | {
      kind: "row";
      /** Stable within the generation; also the virtualizer's item key. */
      id: string;
      row: Row;
      /** The row's index in `store.rows()` (its reasoning-open key). */
      index: number;
      depth: number;
      /** Set when the row belongs to an expanded subagent group. */
      groupId?: string;
    }
  | {
      kind: "header";
      id: string;
      groupId: string;
      block: GroupBlock;
      depth: number;
    };

/** Per-disclosure state: the last domain value seen, and the user's override. */
interface Disclosure {
  /** The user's explicit choice, or null while the domain fact governs. */
  manual: boolean | null;
  /** The domain fact (`!done` for groups, `active` for reasoning) last seen. */
  domain: boolean;
}

export interface ConversationViewModel {
  /** The flattened render-item sequence. */
  items: () => RenderItem[];
  /** Index of a render item id, or -1. */
  indexOf: (id: string) => number;
  /**
   * Whether a subagent run is expanded. Takes the block, not just its id, so
   * the read subscribes to the run's `done` flag: completion must reach a
   * mounted header, and a plain map lookup would not be reactive.
   */
  isGroupOpen: (block: GroupBlock) => boolean;
  /** Toggle a subagent run (a manual choice; survives text updates). */
  toggleGroup: (block: GroupBlock) => void;
  /** Whether a reasoning row's body is shown. */
  isReasoningOpen: (row: Row) => boolean;
  /** Toggle a reasoning row (a manual choice; survives text updates). */
  toggleReasoning: (row: Row) => void;
}

/**
 * Build the view model for a store.
 *
 * Everything here reads *structure* only — block identity, `done`, group
 * membership — and never a row's text. A streamed token therefore cannot
 * invalidate the render-item sequence.
 */
export function createViewModel(store: Store): ConversationViewModel {
  // Disclosure state, keyed by run id / row id. Reset wholesale on a new
  // generation: those ids belong to a conversation that no longer exists, and
  // expansion history is deliberately not persisted anywhere.
  const groups = new Map<string, Disclosure>();
  const reasoning = new Map<string, Disclosure>();
  // Bumped on every manual toggle so the flattened sequence recomputes.
  const [disclosureTick, setDisclosureTick] = createSignal(0);

  let lastGeneration = -1;
  const resetIfNewGeneration = (generation: number): void => {
    if (generation === lastGeneration) return;
    lastGeneration = generation;
    groups.clear();
    reasoning.clear();
  };

  /**
   * Resolve a disclosure against its domain fact.
   *
   * The domain fact wins on a genuine lifecycle transition (a group completes,
   * reasoning starts or ends) and the manual override is dropped at that
   * moment; between transitions the user's choice stands. This is the same
   * rule the old `createEffect(() => node.open = ...)` produced, made explicit
   * so it can survive unmounting.
   */
  const resolve = (
    map: Map<string, Disclosure>,
    key: string,
    domain: boolean,
  ): boolean => {
    const prev = map.get(key);
    if (prev === undefined) {
      map.set(key, { manual: null, domain });
      return domain;
    }
    if (prev.domain !== domain) {
      prev.domain = domain;
      prev.manual = null;
      return domain;
    }
    return prev.manual ?? domain;
  };

  const toggle = (
    map: Map<string, Disclosure>,
    key: string,
    domain: boolean,
  ): void => {
    const current = resolve(map, key, domain);
    const entry = map.get(key);
    if (entry) entry.manual = !current;
    setDisclosureTick((n) => n + 1);
  };

  // Both readers subscribe to `disclosureTick`: the state itself lives in plain
  // maps (it must survive the components it controls being unmounted), so the
  // tick is what makes a manual toggle reach the mounted header and body.
  const isGroupOpen = (block: GroupBlock): boolean => {
    disclosureTick();
    return resolve(groups, block.id, !block.done);
  };

  const isReasoningOpen = (row: Row): boolean => {
    disclosureTick();
    return resolve(reasoning, row.id, store.isActive(row.index));
  };

  const toggleReasoning = (row: Row): void =>
    toggle(reasoning, row.id, store.isActive(row.index));

  // Render items are cached by id so the same object is handed back across
  // rebuilds. Nothing downstream keys on object identity (the virtualizer keys
  // on `id`), but a stable object keeps Solid's `For` from churning and keeps
  // the cache honest about what is still live.
  const cache = new Map<string, RenderItem>();

  const items = createMemo<RenderItem[]>(() => {
    resetIfNewGeneration(store.generation());
    disclosureTick();
    const blocks = store.blocks();
    const out: RenderItem[] = [];
    const live = new Set<string>();
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      if (block.kind === "row") {
        const row = block.row;
        out.push(rowItem(cache, row.id, row, row.index, row.depth, undefined));
        live.add(row.id);
        continue;
      }
      const groupId = block.id;
      const headerId = `h:${groupId}`;
      let header = cache.get(headerId);
      if (
        header === undefined ||
        header.kind !== "header" ||
        header.block !== block
      ) {
        header = {
          kind: "header",
          id: headerId,
          groupId,
          block,
          depth: block.depth,
        };
        cache.set(headerId, header);
      }
      out.push(header);
      live.add(headerId);
      // A completed run collapses; a running one stays open. `resolve` is what
      // lets a manual toggle stand until the run's lifecycle actually changes.
      const open = resolve(groups, groupId, !block.done);
      if (!open) continue;
      // Only read `block.items` for an *expanded* run: a closed group must not
      // subscribe the sequence to its children, or appending to a collapsed
      // subagent would rebuild the list for nothing.
      const children = block.items;
      for (let i = 0; i < children.length; i++) {
        const row = children[i].row;
        out.push(rowItem(cache, row.id, row, row.index, block.depth, groupId));
        live.add(row.id);
      }
    }
    // Drop cache entries for items that left the sequence (a collapsed group's
    // children, or everything on a generation change), so the cache stays
    // bounded by what is actually rendered.
    if (cache.size > live.size) {
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    }
    return out;
  });

  const index = createMemo(() => {
    const map = new Map<string, number>();
    const list = items();
    for (let i = 0; i < list.length; i++) map.set(list[i].id, i);
    return map;
  });

  return {
    items,
    indexOf: (id: string): number => index().get(id) ?? -1,
    isGroupOpen,
    toggleGroup: (block: GroupBlock): void => toggle(groups, block.id, !block.done),
    isReasoningOpen,
    toggleReasoning,
  };
}

/** Get (or mint) the cached render item for a row. */
function rowItem(
  cache: Map<string, RenderItem>,
  id: string,
  row: Row,
  index: number,
  depth: number,
  groupId: string | undefined,
): RenderItem {
  const existing = cache.get(id);
  if (
    existing !== undefined &&
    existing.kind === "row" &&
    existing.row === row &&
    existing.depth === depth &&
    existing.groupId === groupId
  ) {
    return existing;
  }
  const item: RenderItem = { kind: "row", id, row, index, depth, groupId };
  cache.set(id, item);
  return item;
}

/**
 * A coarse height estimate per render item, used before an item has been
 * measured. Being roughly right keeps the scrollbar sane on first paint; the
 * ResizeObserver corrects every item that is actually rendered.
 */
export function estimateItemSize(item: RenderItem | undefined): number {
  if (item === undefined) return 40;
  if (item.kind === "header") return 32;
  switch (item.row.item.kind) {
    case "toolCall":
    case "toolResult":
    case "compactionNotice":
    case "systemNotice":
      return 28;
    case "reasoningBlock":
      return 32;
    default:
      return 72;
  }
}
