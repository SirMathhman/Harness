// A browser-owned scheduler for incoming protocol events.
//
// The store applies events synchronously, one at a time. At LLM token rates
// that means one reactive update — and one Markdown parse of the growing row —
// per network delta. This queue bounds the *frequency* of that work to one
// animation frame, without changing what is displayed: every token is kept,
// ordering is exact, and only adjacent stream events of the same scope and kind
// are merged.
//
// It bounds frequency, not the cost of a single parse: one enormous Markdown
// message still costs what it costs to parse once per flush.

import { batch as solidBatch } from "solid-js";
import type { ServerEvent } from "../types";

/** The timing primitives, injected so tests can drive them deterministically. */
export interface Clock {
  requestFrame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
}

/** The default clock: real animation frames and timers. */
export function browserClock(): Clock {
  return {
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle),
  };
}

export interface EventQueueOptions {
  /** Applies one event to the store. Must be synchronous. */
  apply: (event: ServerEvent) => void;
  /**
   * Groups a set of applications into one reactive update. Defaults to Solid's
   * `batch`; tests inject a wrapper to observe how often it is called.
   */
  batch?: <T>(fn: () => T) => T;
  clock?: Clock;
  /**
   * Flush once this many events are pending, whatever the frame situation is.
   * A background tab stops firing animation frames, so without a size bound a
   * long stream would queue without limit.
   */
  maxQueued?: number;
  /** Flush at least this often, as the same background-tab fallback. */
  maxLatencyMs?: number;
  /** Subscribes to page-visibility changes; returns an unsubscribe. */
  onVisibilityChange?: (listener: () => void) => () => void;
}

export interface EventQueue {
  /** Enqueue one server event. */
  push: (event: ServerEvent) => void;
  /**
   * Enqueue a local action (e.g. the optimistic user message). It flushes with
   * the events already queued, so a user message can never overtake output the
   * server already sent.
   */
  pushAction: (action: () => void) => void;
  /** Apply everything pending now. */
  flush: () => void;
  /** Number of pending entries (tests and diagnostics). */
  pending: () => number;
  /** Cancel timers and listeners. Pending work is dropped. */
  dispose: () => void;
}

type Entry = { kind: "event"; event: ServerEvent } | { kind: "action"; run: () => void };

/**
 * Events that must not sit in the queue: they change structure or lifecycle,
 * and the events after them mean something different. They are enqueued in
 * order and then flushed immediately, so ordering is preserved exactly while
 * only token/reasoning runs are ever deferred.
 */
function isBoundary(event: ServerEvent): boolean {
  return event.type !== "token" && event.type !== "reasoning";
}

/** Authoritative resets: everything queued before them is superseded. */
function isReset(event: ServerEvent): boolean {
  return event.type === "snapshot" || event.type === "cleared";
}

/** The scope key an event streams into, or null when it does not stream. */
function streamKey(event: ServerEvent): string | null {
  if (event.type !== "token" && event.type !== "reasoning") return null;
  const scope = event.scope;
  return scope.kind === "main"
    ? `${event.type}|main`
    : `${event.type}|sub:${scope.id}`;
}

export function createEventQueue(options: EventQueueOptions): EventQueue {
  const clock = options.clock ?? browserClock();
  const runBatch = options.batch ?? solidBatch;
  const maxQueued = options.maxQueued ?? 512;
  const maxLatencyMs = options.maxLatencyMs ?? 250;

  let queue: Entry[] = [];
  let frame: number | undefined;
  let timer: number | undefined;
  let disposed = false;

  const cancelSchedule = (): void => {
    if (frame !== undefined) {
      clock.cancelFrame(frame);
      frame = undefined;
    }
    if (timer !== undefined) {
      clock.clearTimer(timer);
      timer = undefined;
    }
  };

  const flush = (): void => {
    cancelSchedule();
    if (queue.length === 0) return;
    const pending = queue;
    queue = [];
    runBatch(() => {
      for (const entry of pending) {
        if (entry.kind === "action") entry.run();
        else options.apply(entry.event);
      }
    });
  };

  const schedule = (): void => {
    if (disposed) return;
    if (frame === undefined) frame = clock.requestFrame(() => {
      frame = undefined;
      flush();
    });
    // The frame callback never runs in a hidden tab, so keep a timer as the
    // floor on latency and on queue growth.
    if (timer === undefined) timer = clock.setTimer(() => {
      timer = undefined;
      flush();
    }, maxLatencyMs);
  };

  /** Merge an incoming stream event into the tail when they are compatible. */
  const coalesce = (event: ServerEvent): boolean => {
    const key = streamKey(event);
    if (key === null) return false;
    const tail = queue[queue.length - 1];
    if (tail === undefined || tail.kind !== "event") return false;
    if (streamKey(tail.event) !== key) return false;
    // Same scope, same kind, adjacent: one longer delta is indistinguishable
    // from two shorter ones.
    const merged = tail.event as { text: string };
    merged.text = merged.text + (event as { text: string }).text;
    return true;
  };

  const push = (event: ServerEvent): void => {
    if (disposed) return;
    if (isReset(event)) {
      // A snapshot or clear supersedes everything queued: those events describe
      // a conversation generation the server has just replaced. They are
      // dropped, never replayed after the reset.
      cancelSchedule();
      queue = [];
      runBatch(() => options.apply(event));
      return;
    }
    if (!coalesce(event)) {
      // Shallow-copy stream events so coalescing never mutates the caller's
      // object (the same event may be observed elsewhere).
      queue.push({
        kind: "event",
        event: isBoundary(event) ? event : ({ ...event } as ServerEvent),
      });
    }
    if (isBoundary(event) || queue.length >= maxQueued) flush();
    else schedule();
  };

  const pushAction = (action: () => void): void => {
    if (disposed) return;
    queue.push({ kind: "action", run: action });
    flush();
  };

  const stopVisibility = options.onVisibilityChange?.(() => flush());

  return {
    push,
    pushAction,
    flush,
    pending: () => queue.length,
    dispose: (): void => {
      disposed = true;
      cancelSchedule();
      queue = [];
      stopVisibility?.();
    },
  };
}

/** The default visibility subscription (flush when the tab is shown/hidden). */
export function documentVisibility(listener: () => void): () => void {
  const handler = (): void => listener();
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
